import {
  RemoteAssignmentInputsEnvelopeSchema,
  RemoteAssignmentInputsPrepareRequestSchema,
  RemoteAssignmentInputsReadRequestSchema,
  RemoteRepositoryFetchRequestSchema,
  RemoteWorkAssignmentSchema,
  RemoteFileTreeSchema,
  RemoteInstanceError,
  createLogger,
  computeRemoteTransferManifestDigest,
  validateRemoteTransfer,
  REMOTE_INPUT_METADATA_MAX_BYTES,
  REMOTE_INPUT_TREE_MAX_BYTES,
  REMOTE_REPOSITORY_BUNDLE_MAX_BYTES,
  type Clock,
  type FetchFn,
  type RemoteWorkAssignment,
  type RemoteAssignmentInputsEnvelope,
  type RemoteFileTree,
  type JsonValue,
  type Logger,
} from "@konteks/remote-common";
import type { EmbeddedReleaseRoot } from "@konteks/remote-release";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { NATIVE_TRANSIENT_MAX_ATTEMPTS, logNativeRetryExhausted, transientHttpClassification, waitForNativeRetry,
  type NativeTransientClassification } from "./transient-retry.js";

interface NativeInputClientOptions {
  baseUrl: string;
  roots: readonly EmbeddedReleaseRoot[];
  clock: Clock;
  /** Current runtime lease only. Core independently refuses provisioning/drain-only credentials. */
  credential: () => string | null;
  fetchFn?: FetchFn;
  /** How long a lease rejection waits for the heartbeat's renewal to be adopted locally. */
  renewalWaitMs?: number;
  logger?: Logger;
  retrySleep?: (delayMs: number) => Promise<void>;
  retryBaseDelayMs?: number;
}

// SystemClock learns Core time from HTTP Date, whose wire precision is one
// second. Accept only that quantization uncertainty for a freshly issued
// envelope; expiry and assignment deadlines remain exact.
const CORE_HTTP_DATE_UNCERTAINTY_MS = 1_000;

/** Artifact transport has tighter body/redirect/error rules than ordinary control JSON. */
export class NativeInputClient {
  private readonly verifier: CoreSignatureVerifier;
  private readonly origin: string;
  private readonly fetchFn: FetchFn;
  private readonly logger: Logger;
  private busy = false;

  constructor(private readonly options: NativeInputClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw unavailable("base_url_invalid");
    this.origin = url.origin;
    this.verifier = new CoreSignatureVerifier(options.roots);
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger ?? createLogger({ name: "native-input" });
  }

  async prepare(
    assignment: RemoteWorkAssignment,
    claimId: string,
    selectionDigest?: string,
  ): Promise<RemoteAssignmentInputsEnvelope> {
    return this.exclusive(async () => {
      const current = RemoteWorkAssignmentSchema.parse(assignment);
      const request = RemoteAssignmentInputsPrepareRequestSchema.parse({
        attempt: current.attempt,
        claimId,
        ...(selectionDigest ? { selectionDigest } : {}),
      });
      const response = await this.request(
        current,
        "prepare",
        request,
        REMOTE_INPUT_METADATA_MAX_BYTES,
      );
      const envelope = this.verify(response, current, claimId);
      if (selectionDigest !== undefined && envelope.selectionDigest !== selectionDigest)
        throw unavailable("selection_digest_mismatch");
      return envelope;
    });
  }

  async read(
    assignment: RemoteWorkAssignment,
    claimId: string,
    authorization: RemoteAssignmentInputsEnvelope,
    transferId: string,
  ): Promise<RemoteFileTree> {
    return this.exclusive(async () => {
      const current = RemoteWorkAssignmentSchema.parse(assignment);
      const envelope = this.verify(authorization, current, claimId);
      const manifest = [
        envelope.selection.source,
        ...envelope.selection.skills.skills.map((skill) => skill.transfer),
      ].find((candidate) => candidate.transferId === transferId);
      if (!manifest) throw unavailable("transfer_not_selected");
      const manifestDigest = computeRemoteTransferManifestDigest(manifest);
      const request = RemoteAssignmentInputsReadRequestSchema.parse({
        attempt: current.attempt,
        claimId,
        selectionDigest: envelope.selectionDigest,
        transferId,
        manifestDigest,
      });
      const tree = await this.request(current, "read", request, REMOTE_INPUT_TREE_MAX_BYTES);
      this.verify(envelope, current, claimId);
      if (
        !validateRemoteTransfer(manifest, tree, {
          binding: envelope.selection.binding,
          manifestDigest,
          now: this.options.clock.coreNow(),
        }).valid
      )
        throw unavailable("transfer_invalid");
      const parsed = RemoteFileTreeSchema.safeParse(tree);
      if (!parsed.success) throw unavailable("transfer_schema_invalid");
      return parsed.data;
    });
  }

  /** Fetches Git objects through Core. The signed capability is a reference;
   * the runtime lease remains required and no origin credential crosses this boundary. */
  async fetchRepository(
    assignment: RemoteWorkAssignment,
    claimId: string,
    authorization: RemoteAssignmentInputsEnvelope,
    haveRevisions: string[],
  ): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const current = RemoteWorkAssignmentSchema.parse(assignment);
      const envelope = this.verify(authorization, current, claimId);
      const repository = envelope.selection.repository;
      if (!repository) throw unavailable("repository_not_selected");
      const request = RemoteRepositoryFetchRequestSchema.parse({
        attempt: current.attempt,
        claimId,
        selectionDigest: envelope.selectionDigest,
        capabilityId: repository.capabilityId,
        repositoryId: repository.repositoryId,
        revision: repository.revision,
        haveRevisions,
      });
      const bytes = await this.requestBundle(current, request, repository.revision);
      this.verify(envelope, current, claimId);
      return bytes;
    });
  }

  private verify(
    value: unknown,
    assignment: RemoteWorkAssignment,
    claimId: string,
  ): RemoteAssignmentInputsEnvelope {
    const parsed = RemoteAssignmentInputsEnvelopeSchema.safeParse(value);
    if (!parsed.success) throw unavailable("envelope_schema_invalid");
    const envelope = parsed.data;
    const { signature, ...unsigned } = envelope;
    const binding = envelope.selection.binding;
    const now = this.options.clock.coreNow();
    if (!this.verifier.verify(unsigned as unknown as { [key: string]: JsonValue }, signature))
      throw unavailable("envelope_signature_invalid");
    if (!Number.isFinite(now)) throw unavailable("clock_invalid");
    if (Date.parse(envelope.issuedAt) > now + CORE_HTTP_DATE_UNCERTAINTY_MS)
      throw unavailable("envelope_issued_future");
    if (Date.parse(envelope.expiresAt) <= now) throw unavailable("envelope_expired");
    if (Date.parse(envelope.expiresAt) > Date.parse(assignment.expiresAt))
      throw unavailable("envelope_exceeds_assignment");
    if (envelope.selection.claimId !== claimId) throw unavailable("envelope_claim_mismatch");
    if (
      binding.instanceId !== assignment.instanceId ||
      binding.workspaceId !== assignment.workspaceId ||
      binding.assignmentId !== assignment.id ||
      binding.attempt !== assignment.attempt ||
      (assignment.source.kind === "conversation" &&
        binding.sessionId !== assignment.source.sessionId)
    )
      throw unavailable("envelope_binding_mismatch");
    if (
      sourceRevision(assignment) !== undefined &&
      sourceRevision(assignment) !== envelope.selection.source.revision
    )
      throw unavailable("envelope_source_revision_mismatch");
    return envelope;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw unavailable("request_concurrent");
    this.busy = true;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RemoteInstanceError) throw error;
      throw unavailable("request_unexpected");
    } finally {
      this.busy = false;
    }
  }

  private async awaitRenewedCredential(
    current: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const deadline = Date.now() + (this.options.renewalWaitMs ?? 3_000);
    while (!signal.aborted && Date.now() < deadline) {
      await sleep(100, signal);
      const next = this.options.credential();
      if (next !== current) return next;
    }
    return this.options.credential();
  }

  private async request(
    assignment: RemoteWorkAssignment,
    operation: "prepare" | "read",
    body: unknown,
    maxBytes: number,
  ): Promise<unknown> {
    return this.withTransientRetry(`input.${operation}`, () => this.requestAttempt(assignment, operation, body, maxBytes));
  }

  private async requestAttempt(
    assignment: RemoteWorkAssignment,
    operation: "prepare" | "read",
    body: unknown,
    maxBytes: number,
  ): Promise<unknown> {
    let credential = this.options.credential();
    if (!credential) throw unavailable("credential_missing");
    if (!this.verifier.configured) throw unavailable("trust_roots_missing");
    const url = `${this.origin}/api/remote-instances/internal/remote-instances/${encodeURIComponent(assignment.instanceId)}/assignments/${encodeURIComponent(assignment.id)}/inputs/${operation}`;
    const abort = new AbortController();
    // Core's own preparation budget is 90 s (NATIVE_INPUT_REQUEST_TIMEOUT_MS):
    // the delivery Session is materialized and a repository snapshot pinned
    // inside it. The client deadline must outlive that budget, not race it.
    const timer = setTimeout(() => abort.abort(), 100_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let responsePromise: Promise<Response>;
        try {
          responsePromise = this.fetchFn(url, {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            signal: abort.signal,
            headers: {
              authorization: `Bearer ${credential}`,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        } catch {
          throw unavailable("request_transport");
        }
        let response: Response;
        try {
          response = await abortable(responsePromise, abort.signal);
        } catch {
          throw unavailable(abort.signal.aborted ? "request_deadline" : "request_transport");
        }
        // Lease renewal may invalidate the request while Core checks owner inputs.
        // Reauthorize once with the locally renewed lease; never accept stale
        // authority or retry unchanged credentials. Both attempts share a deadline.
        let renewed = this.options.credential();
        // Core rotates the lease on a heartbeat and can refuse a request that
        // raced that rotation before the response carrying the new lease was
        // adopted here. Give the adoption a short, bounded chance rather than
        // failing a whole slow input preparation; unchanged credentials still
        // never retry.
        if (
          attempt === 0 &&
          !response.redirected &&
          [401, 403, 422].includes(response.status) &&
          renewed === credential
        ) {
          renewed = await this.awaitRenewedCredential(credential, abort.signal);
        }
        if (
          attempt === 0 &&
          !response.redirected &&
          [401, 403, 422].includes(response.status) &&
          renewed &&
          renewed !== credential
        ) {
          void response.body?.cancel().catch(() => undefined);
          credential = renewed;
          continue;
        }
        if (
          !response.redirected && transientHttpClassification(response.status)
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable(`response_transient_${response.status}`);
        }
        if (
          !response.ok ||
          response.redirected ||
          response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
            "application/json" ||
          !response.body
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable(
            !response.ok || response.redirected
              ? "response_status_invalid"
              : !response.body
                ? "response_body_missing"
                : "response_content_type_invalid",
          );
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await abortable(reader.read(), abort.signal);
          } catch {
            throw unavailable(
              abort.signal.aborted ? "request_deadline" : "response_body_read_failed",
            );
          }
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) throw unavailable("response_body_too_large");
          chunks.push(chunk.value);
        }
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          throw unavailable("response_decode_invalid");
        }
      }
      throw unavailable("credential_renewal_exhausted");
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (reader) void reader.cancel().catch(() => undefined);
    }
  }

  private async requestBundle(
    assignment: RemoteWorkAssignment,
    body: unknown,
    revision: string,
  ): Promise<Uint8Array> {
    return this.withTransientRetry("input.fetch_repository", () => this.requestBundleAttempt(assignment, body, revision));
  }

  private async requestBundleAttempt(
    assignment: RemoteWorkAssignment,
    body: unknown,
    revision: string,
  ): Promise<Uint8Array> {
    let credential = this.options.credential();
    if (!credential) throw unavailable("credential_missing");
    if (!this.verifier.configured) throw unavailable("trust_roots_missing");
    const url = `${this.origin}/api/remote-instances/internal/remote-instances/${encodeURIComponent(assignment.instanceId)}/assignments/${encodeURIComponent(assignment.id)}/inputs/fetch-repository`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 100_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response: Response;
        try {
          response = await abortable(
            this.fetchFn(url, {
              method: "POST",
              redirect: "error",
              credentials: "omit",
              signal: abort.signal,
              headers: {
                authorization: `Bearer ${credential}`,
                accept: "application/x-git-bundle",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
            abort.signal,
          );
        } catch {
          throw unavailable(abort.signal.aborted ? "request_deadline" : "request_transport");
        }
        let renewed = this.options.credential();
        if (attempt === 0 && !response.redirected && [401, 403, 422].includes(response.status) && renewed === credential)
          renewed = await this.awaitRenewedCredential(credential, abort.signal);
        if (attempt === 0 && !response.redirected && [401, 403, 422].includes(response.status) && renewed && renewed !== credential) {
          void response.body?.cancel().catch(() => undefined);
          credential = renewed;
          continue;
        }
        if (!response.redirected && transientHttpClassification(response.status)) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable(`response_transient_${response.status}`);
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (!response.ok || response.redirected ||
            response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-git-bundle" ||
            response.headers.get("x-konteks-revision") !== revision || !response.body ||
            (Number.isFinite(contentLength) && contentLength > REMOTE_REPOSITORY_BUNDLE_MAX_BYTES)) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable("repository_response_invalid");
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await abortable(reader.read(), abort.signal).catch(() => {
            throw unavailable(abort.signal.aborted ? "request_deadline" : "response_body_read_failed");
          });
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > REMOTE_REPOSITORY_BUNDLE_MAX_BYTES) throw unavailable("response_body_too_large");
          chunks.push(chunk.value);
        }
        return Buffer.concat(chunks);
      }
      throw unavailable("credential_renewal_exhausted");
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (reader) void reader.cancel().catch(() => undefined);
    }
  }

  private async withTransientRetry<T>(operation: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= NATIVE_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
      try { return await run(); }
      catch (error) {
        const classification = nativeInputTransientClassification(error);
        if (!classification) throw error;
        const status = error instanceof RemoteInstanceError && error.diagnostic?.startsWith("response_transient_")
          ? Number(error.diagnostic.slice("response_transient_".length)) : undefined;
        if (attempt === NATIVE_TRANSIENT_MAX_ATTEMPTS) {
          logNativeRetryExhausted({ logger: this.logger, operation, classification, ...(status === undefined ? {} : { status }) });
          throw error;
        }
        await waitForNativeRetry({ logger: this.logger, operation, attempt, classification,
          ...(status === undefined ? {} : { status }), sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
      }
    }
    throw unavailable("retry_exhausted");
  }
}

function nativeInputTransientClassification(error: unknown): NativeTransientClassification | null {
  if (!(error instanceof RemoteInstanceError)) return null;
  if (error.diagnostic === "request_deadline") return "timeout";
  if (error.diagnostic === "request_transport") return "transport";
  if (error.diagnostic === "response_body_read_failed") return "response_body";
  if (error.diagnostic?.startsWith("response_transient_")) {
    return transientHttpClassification(Number(error.diagnostic.slice("response_transient_".length)));
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
  });
}

function unavailable(diagnostic?: string) {
  return new RemoteInstanceError(
    "capability_unavailable",
    "Required assignment inputs are unavailable or no longer authorized.",
    diagnostic === undefined ? undefined : { diagnostic },
  );
}

/** The immutable owner revision is source-kind specific; never infer one from a missing union member. */
function sourceRevision(assignment: RemoteWorkAssignment): string | undefined {
  switch (assignment.source.kind) {
    case "planning_intake":
      return assignment.source.inputDigest;
    case "harness_delivery":
      return undefined; // Source is pinned by its owner after the native claim.
    case "harness_task_checkout":
      return assignment.source.revision;
    case "repository_snapshot":
      return assignment.source.revision;
    case "conversation":
      return undefined;
    case "ai_manager_search":
      return String(assignment.source.inputRevision);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable("request_deadline"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
