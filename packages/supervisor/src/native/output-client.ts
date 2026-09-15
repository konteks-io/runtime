import {
  RemoteDeliveryAcceptanceReceiptSchema,
  RemoteDeliveryOutputCommitRequestSchema,
  RemoteDeliveryOutputPrepareRequestSchema,
  RemoteDeliveryOutputPrepareResultSchema,
  RemoteDeliveryOutputStatusRequestSchema,
  RemoteDeliveryOutputStatusResultSchema,
  RemoteDeliveryResultCandidateSchema,
  RemoteInstanceError,
  createLogger,
  RemoteWorkAssignmentSchema,
  type Clock,
  type FetchFn,
  type Logger,
  type RemoteDeliveryAcceptanceReceipt,
  type RemoteDeliveryResultCandidate,
  type RemoteWorkAssignment,
} from "@konteks/remote-common";
import { NATIVE_TRANSIENT_MAX_ATTEMPTS, logNativeRetryExhausted, transientHttpClassification, waitForNativeRetry,
  type NativeTransientClassification } from "./transient-retry.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const unavailable = () => new RemoteInstanceError("capability_unavailable", "Generated delivery output was not durably accepted.");

export class NativeOutputClient {
  private readonly origin: string;
  private readonly fetchFn: FetchFn;
  private busy = false;
  private readonly logger: Logger;

  constructor(private readonly options: { baseUrl: string; clock: Clock; credential: () => string | null; fetchFn?: FetchFn;
    logger?: Logger; retrySleep?: (delayMs: number) => Promise<void>; retryBaseDelayMs?: number }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw unavailable();
    this.origin = url.origin;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger ?? createLogger({ name: "native-output" });
  }

  async accept(rawAssignment: RemoteWorkAssignment, rawCandidate: RemoteDeliveryResultCandidate): Promise<RemoteDeliveryAcceptanceReceipt> {
    const assignment = RemoteWorkAssignmentSchema.parse(rawAssignment);
    const candidate = RemoteDeliveryResultCandidateSchema.parse(rawCandidate);
    if (assignment.kind !== "delivery" || assignment.source.kind !== "harness_delivery" || candidate.binding.workspaceId !== assignment.workspaceId ||
      candidate.binding.instanceId !== assignment.instanceId || candidate.binding.assignmentId !== assignment.id || candidate.binding.attempt !== assignment.attempt ||
      candidate.binding.sessionId !== assignment.source.executionSessionId) throw unavailable();
    return this.acceptOwned({ instanceId: assignment.instanceId, workspaceId: assignment.workspaceId, assignmentId: assignment.id,
      attempt: assignment.attempt, claimId: candidate.claimId }, candidate);
  }

  /** Restart recovery has no assignment payload to borrow. It may retry only
   * the exact candidate already frozen under the durable local admission. */
  async acceptRetained(owner: { instanceId: string; workspaceId: string; assignmentId: string; attempt: number; claimId: string },
    rawCandidate: RemoteDeliveryResultCandidate): Promise<RemoteDeliveryAcceptanceReceipt> {
    const candidate = RemoteDeliveryResultCandidateSchema.parse(rawCandidate);
    if (candidate.binding.instanceId !== owner.instanceId || candidate.binding.workspaceId !== owner.workspaceId ||
      candidate.binding.assignmentId !== owner.assignmentId || candidate.binding.attempt !== owner.attempt || candidate.claimId !== owner.claimId) throw unavailable();
    return this.acceptOwned(owner, candidate);
  }

  private async acceptOwned(owner: { instanceId: string; workspaceId: string; assignmentId: string; attempt: number; claimId: string },
    candidate: RemoteDeliveryResultCandidate): Promise<RemoteDeliveryAcceptanceReceipt> {
    if (this.busy) throw unavailable();
    this.busy = true;
    try {
      const prepareBody = RemoteDeliveryOutputPrepareRequestSchema.parse({ attempt: owner.attempt, claimId: candidate.claimId,
        invocationRef: candidate.invocationRef, resultId: candidate.resultId, inputSelectionDigest: candidate.inputSelectionDigest,
        baseRevision: candidate.baseRevision, files: candidate.files, deletions: candidate.deletions, resultDigest: candidate.resultDigest });
      const statusBody = RemoteDeliveryOutputStatusRequestSchema.parse({ attempt: owner.attempt, claimId: candidate.claimId,
        invocationRef: candidate.invocationRef, resultId: candidate.resultId, resultDigest: candidate.resultDigest });
      let prepared;
      try { prepared = RemoteDeliveryOutputPrepareResultSchema.parse(await this.request(owner, "prepare", prepareBody)); }
      catch {
        const reconciled = await this.status(owner, statusBody);
        if (reconciled?.state === "accepted" && reconciled.receipt) return this.verifyReceipt(reconciled.receipt, candidate);
        if (reconciled?.state === "rejected") throw unavailable();
        // Missing or staged: identical prepare is the only response that can
        // recover the owner-issued stagedReceiptId without widening status.
        prepared = RemoteDeliveryOutputPrepareResultSchema.parse(await this.request(owner, "prepare", prepareBody));
      }
      if (prepared.resultId !== candidate.resultId || prepared.resultDigest !== candidate.resultDigest || Date.parse(prepared.expiresAt) <= this.options.clock.coreNow()) throw unavailable();
      const commitBody = RemoteDeliveryOutputCommitRequestSchema.parse({ attempt: owner.attempt, claimId: candidate.claimId,
        invocationRef: candidate.invocationRef, resultId: candidate.resultId, resultDigest: candidate.resultDigest, stagedReceiptId: prepared.stagedReceiptId });
      try {
        return this.verifyReceipt(await this.request(owner, "commit", commitBody), candidate);
      } catch {
        const status = await this.status(owner, statusBody);
        if (status?.state === "accepted" && status.receipt) return this.verifyReceipt(status.receipt, candidate);
        if (status?.state !== "staged") throw unavailable();
        try { return this.verifyReceipt(await this.request(owner, "commit", commitBody), candidate); }
        catch {
          const final = await this.status(owner, statusBody);
          if (final?.state !== "accepted" || !final.receipt) throw unavailable();
          return this.verifyReceipt(final.receipt, candidate);
        }
      }
    } catch { throw unavailable(); }
    finally { this.busy = false; }
  }

  private async status(owner: { instanceId: string; assignmentId: string; attempt: number }, body: ReturnType<typeof RemoteDeliveryOutputStatusRequestSchema.parse>) {
    try { return RemoteDeliveryOutputStatusResultSchema.parse(await this.request(owner, "status", body)); }
    catch { return null; }
  }

  private verifyReceipt(value: unknown, candidate: RemoteDeliveryResultCandidate): RemoteDeliveryAcceptanceReceipt {
    const receipt = RemoteDeliveryAcceptanceReceiptSchema.parse(value);
    if (receipt.invocationRef !== candidate.invocationRef || receipt.claimId !== candidate.claimId || receipt.resultId !== candidate.resultId ||
      receipt.resultDigest !== candidate.resultDigest || receipt.inputSelectionDigest !== candidate.inputSelectionDigest || receipt.baseRevision !== candidate.baseRevision ||
      JSON.stringify(receipt.binding) !== JSON.stringify(candidate.binding)) throw unavailable();
    return receipt;
  }

  private async request(owner: { instanceId: string; assignmentId: string; attempt: number }, operation: "prepare" | "commit" | "status", body: unknown): Promise<unknown> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw unavailable();
    const url = `${this.origin}/api/remote-instances/internal/remote-instances/${encodeURIComponent(owner.instanceId)}/assignments/${encodeURIComponent(owner.assignmentId)}/outputs/${operation}`;
    const identity = body as { resultId?: string };
    for (let attempt = 1; attempt <= NATIVE_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
      const credential = this.options.credential();
      if (!credential) throw unavailable();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 30_000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        let response: Response;
        try {
          response = await abortable(Promise.resolve(this.fetchFn(url, { method: "POST", redirect: "error", credentials: "omit", signal: abort.signal,
            headers: { authorization: `Bearer ${credential}`, accept: "application/json", "content-type": "application/json",
              "idempotency-key": `output:${owner.assignmentId}:${owner.attempt}:${identity.resultId ?? "unknown"}:${operation}` }, body: encoded })), abort.signal);
        } catch {
          const classification: NativeTransientClassification = abort.signal.aborted ? "timeout" : "transport";
          if (attempt === NATIVE_TRANSIENT_MAX_ATTEMPTS) { logNativeRetryExhausted({ logger: this.logger, operation: `output.${operation}`, classification }); throw unavailable(); }
          await waitForNativeRetry({ logger: this.logger, operation: `output.${operation}`, attempt, classification,
            sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
          continue;
        }
        const renewed = this.options.credential();
        if (!response.redirected && [401, 403, 422].includes(response.status) && renewed && renewed !== credential) {
          void response.body?.cancel().catch(() => undefined);
          if (attempt === NATIVE_TRANSIENT_MAX_ATTEMPTS) { logNativeRetryExhausted({ logger: this.logger, operation: `output.${operation}`, classification: "credential_rotated", status: response.status }); throw unavailable(); }
          await waitForNativeRetry({ logger: this.logger, operation: `output.${operation}`, attempt, classification: "credential_rotated", status: response.status,
            sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
          continue;
        }
        const transient = transientHttpClassification(response.status);
        if (!response.redirected && transient) {
          void response.body?.cancel().catch(() => undefined);
          if (attempt === NATIVE_TRANSIENT_MAX_ATTEMPTS) { logNativeRetryExhausted({ logger: this.logger, operation: `output.${operation}`, classification: transient, status: response.status }); throw unavailable(); }
          await waitForNativeRetry({ logger: this.logger, operation: `output.${operation}`, attempt, classification: transient, status: response.status,
            sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
          continue;
        }
        if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
          // A non-retryable refusal (413 over the body limit, 422 rejected
          // candidate) was previously indistinguishable from any other
          // "unavailable": record the status and a bounded, secret-free body.
          const body = await response.text().then(text => text.replace(/\s+/gu, " ").slice(0, 300)).catch(() => "");
          this.logger.warn({ event: "native.output.refused", operation: `output.${operation}`, status: response.status,
            redirected: response.redirected, contentType: response.headers.get("content-type") ?? null,
            requestBytes: Buffer.byteLength(encoded), body }, "native delivery output request refused");
          throw new RemoteInstanceError("capability_unavailable", "Generated delivery output was not durably accepted.",
            { diagnostic: `response_refused_${response.status}` });
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await abortable(reader.read(), abort.signal); }
          catch {
            if (attempt === NATIVE_TRANSIENT_MAX_ATTEMPTS) { logNativeRetryExhausted({ logger: this.logger, operation: `output.${operation}`, classification: "response_body" }); throw unavailable(); }
            await waitForNativeRetry({ logger: this.logger, operation: `output.${operation}`, attempt, classification: "response_body",
              sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
            break;
          }
          if (chunk.done) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          size += chunk.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw unavailable(); chunks.push(chunk.value);
        }
      } finally { clearTimeout(timer); abort.abort(); if (reader) void reader.cancel().catch(() => undefined); }
    }
    throw unavailable();
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable());
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
