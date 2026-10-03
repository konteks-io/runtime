import {
  RemoteDeliveryAcceptanceReceiptSchema,
  RemoteDeliveryOutputCommitRequestSchema,
  RemoteDeliveryOutputPrepareRequestSchema,
  RemoteDeliveryOutputPrepareResultSchema,
  RemoteDeliveryOutputStatusRequestSchema,
  RemoteDeliveryOutputStatusResultSchema,
  RemoteDeliveryResultCandidateSchema,
  RemoteInstanceError,
  allEqual,
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
import { abortable, coreOrigin, LEASE_REFUSAL_STATUSES, mediaType } from "./core-transport.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const OUTPUT_TRANSFER_MIN_BUDGET_MS = 30_000;
const OUTPUT_TRANSFER_MAX_BUDGET_MS = 120_000;
const OUTPUT_TRANSFER_BYTES_PER_SECOND = 1024 * 1024;
const unavailable = () => new RemoteInstanceError("capability_unavailable", "Generated delivery output was not durably accepted.");
const ASSIGNMENT_NOT_FOUND = "assignment_not_found";
const isNotFound = (error: unknown) => error instanceof RemoteInstanceError && error.diagnostic === "response_refused_404";
/** Core answered "not found" to both the prepare and the status probe: the
 * assignment itself is gone (its plan failed or was superseded while the
 * output waited). No retry can ever accept this output. */
const assignmentGone = () => new RemoteInstanceError("capability_unavailable",
  "Core no longer knows the assignment this generated delivery output belongs to.", { diagnostic: ASSIGNMENT_NOT_FOUND });
export const isAssignmentGone = (error: unknown): boolean =>
  error instanceof RemoteInstanceError && error.diagnostic === ASSIGNMENT_NOT_FOUND;

function outputTransferBudgetMs(candidate: RemoteDeliveryResultCandidate): number {
  const bytes = candidate.files.entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  const transferAllowanceMs = Math.ceil(bytes / OUTPUT_TRANSFER_BYTES_PER_SECOND) * 1_000;
  return Math.min(OUTPUT_TRANSFER_MAX_BUDGET_MS, OUTPUT_TRANSFER_MIN_BUDGET_MS + transferAllowanceMs);
}

type OutputOwner = { instanceId: string; workspaceId: string; assignmentId: string; attempt: number; claimId: string };
type OutputOperation = "prepare" | "commit" | "status";
type OutputTelemetry = { correlationId: string; resultDigest: string; bytes: number };

/** One output transfer: who owns it, its deadline and status probe, and what its log lines carry. */
interface OutputCall {
  owner: OutputOwner;
  candidate: RemoteDeliveryResultCandidate;
  startedAt: number;
  telemetry: OutputTelemetry;
  deadlineAtMs: number;
  statusBody: ReturnType<typeof RemoteDeliveryOutputStatusRequestSchema.parse>;
}

type Prepared =
  | { kind: "accepted"; receipt: RemoteDeliveryAcceptanceReceipt }
  | { kind: "prepared"; result: ReturnType<typeof RemoteDeliveryOutputPrepareResultSchema.parse>; cacheOutcome: string };

/** One request's fixed parts, shared by its attempts. */
interface OutputExchange {
  operation: OutputOperation;
  url: string;
  encoded: string;
  idempotencyKey: string;
  telemetry: OutputTelemetry;
  startedAt: number;
  deadlineAtMs: number;
}

type AttemptOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "retry"; classification: NativeTransientClassification; status?: number };

export class NativeOutputClient {
  private readonly origin: string;
  private readonly fetchFn: FetchFn;
  private busy = false;
  private readonly logger: Logger;

  constructor(private readonly options: { baseUrl: string; clock: Clock; credential: () => string | null; fetchFn?: FetchFn;
    logger?: Logger; retrySleep?: (delayMs: number) => Promise<void>; retryBaseDelayMs?: number }) {
    const origin = coreOrigin(options.baseUrl);
    if (origin === null) throw unavailable();
    this.origin = origin;
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

  private async acceptOwned(owner: OutputOwner, candidate: RemoteDeliveryResultCandidate): Promise<RemoteDeliveryAcceptanceReceipt> {
    if (this.busy) throw unavailable();
    this.busy = true;
    try {
      return await this.transfer(owner, candidate);
    } catch (error) { throw isAssignmentGone(error) ? error : unavailable(); }
    finally { this.busy = false; }
  }

  /** Prepare (reconciled through status when it fails), then commit (reconciled the same way). */
  private async transfer(owner: OutputOwner, candidate: RemoteDeliveryResultCandidate): Promise<RemoteDeliveryAcceptanceReceipt> {
    const call: OutputCall = {
      owner, candidate, startedAt: Date.now(),
      telemetry: { correlationId: candidate.invocationRef, resultDigest: candidate.resultDigest, bytes: candidate.files.entries.reduce((total, entry) => total + entry.sizeBytes, 0) },
      deadlineAtMs: Date.now() + outputTransferBudgetMs(candidate),
      statusBody: RemoteDeliveryOutputStatusRequestSchema.parse({ attempt: owner.attempt, claimId: candidate.claimId,
        invocationRef: candidate.invocationRef, resultId: candidate.resultId, resultDigest: candidate.resultDigest }),
    };
    const prepareBody = RemoteDeliveryOutputPrepareRequestSchema.parse({ attempt: owner.attempt, claimId: candidate.claimId,
      invocationRef: candidate.invocationRef, resultId: candidate.resultId, inputSelectionDigest: candidate.inputSelectionDigest,
      baseRevision: candidate.baseRevision, files: candidate.files, deletions: candidate.deletions, resultDigest: candidate.resultDigest });
    const prepared = await this.prepared(call, prepareBody);
    if (prepared.kind === "accepted") return prepared.receipt;
    if (prepared.result.resultId !== candidate.resultId || prepared.result.resultDigest !== candidate.resultDigest || Date.parse(prepared.result.expiresAt) <= this.options.clock.coreNow()) throw unavailable();
    const commitBody = RemoteDeliveryOutputCommitRequestSchema.parse({ attempt: owner.attempt, claimId: candidate.claimId,
      invocationRef: candidate.invocationRef, resultId: candidate.resultId, resultDigest: candidate.resultDigest, stagedReceiptId: prepared.result.stagedReceiptId });
    try {
      return this.accepted(call, await this.request(owner, "commit", commitBody, call.deadlineAtMs, call.telemetry), prepared.cacheOutcome);
    } catch {
      return this.recoverCommit(call, commitBody);
    }
  }

  private async prepared(call: OutputCall, prepareBody: unknown): Promise<Prepared> {
    try {
      return { kind: "prepared", result: RemoteDeliveryOutputPrepareResultSchema.parse(await this.request(call.owner, "prepare", prepareBody, call.deadlineAtMs, call.telemetry)), cacheOutcome: "miss" };
    } catch (error) {
      return this.reconcilePrepare(call, prepareBody, error);
    }
  }

  /**
   * A prepare that failed: an accepted output's receipt from status, or the
   * identical prepare once more. Missing or staged, only that prepare can
   * recover the owner-issued stagedReceiptId without widening status.
   */
  private async reconcilePrepare(call: OutputCall, prepareBody: unknown, prepareError: unknown): Promise<Prepared> {
    const reconciled = await this.statusAfterPrepare(call, prepareError);
    if (reconciled?.state === "accepted" && reconciled.receipt) return { kind: "accepted", receipt: this.accepted(call, reconciled.receipt, "prepare_status_hit") };
    if (reconciled?.state === "rejected") throw unavailable();
    return { kind: "prepared", result: RemoteDeliveryOutputPrepareResultSchema.parse(await this.request(call.owner, "prepare", prepareBody, call.deadlineAtMs, call.telemetry)), cacheOutcome: "prepare_retried" };
  }

  /** Core answering "not found" to both the prepare and its status means the assignment itself is gone. */
  private async statusAfterPrepare(call: OutputCall, prepareError: unknown): Promise<Awaited<ReturnType<NativeOutputClient["status"]>>> {
    try {
      return await this.status(call.owner, call.statusBody, call.deadlineAtMs, call.telemetry);
    } catch (statusError) {
      if (isNotFound(prepareError) && isNotFound(statusError)) throw assignmentGone();
      return null;
    }
  }

  /** A commit that failed: an accepted output from status, or one more commit while it is still staged. */
  private async recoverCommit(call: OutputCall, commitBody: unknown): Promise<RemoteDeliveryAcceptanceReceipt> {
    const status = await this.status(call.owner, call.statusBody, call.deadlineAtMs, call.telemetry).catch(() => null);
    if (status?.state === "accepted" && status.receipt) return this.accepted(call, status.receipt, "commit_status_hit");
    if (status?.state !== "staged") throw unavailable();
    try {
      return this.accepted(call, await this.request(call.owner, "commit", commitBody, call.deadlineAtMs, call.telemetry), "commit_retried");
    } catch {
      return this.finalStatus(call);
    }
  }

  private async finalStatus(call: OutputCall): Promise<RemoteDeliveryAcceptanceReceipt> {
    const final = await this.status(call.owner, call.statusBody, call.deadlineAtMs, call.telemetry).catch(() => null);
    if (final?.state !== "accepted" || !final.receipt) throw unavailable();
    return this.accepted(call, final.receipt, "commit_status_hit");
  }
  private accepted(call: OutputCall, value: unknown, cacheOutcome: string): RemoteDeliveryAcceptanceReceipt {
    const receipt = this.verifyReceipt(value, call.candidate);
    this.logger.info({ event: "native.output.accept_completed", ...call.telemetry, stage: "accept", outcome: "success", cacheOutcome,
      durationMs: Date.now() - call.startedAt }, "native delivery output accepted");
    return receipt;
  }
  private async status(owner: { instanceId: string; assignmentId: string; attempt: number }, body: ReturnType<typeof RemoteDeliveryOutputStatusRequestSchema.parse>,
    deadlineAtMs: number, telemetry: { correlationId: string; resultDigest: string; bytes: number }) {
    try { return RemoteDeliveryOutputStatusResultSchema.parse(await this.request(owner, "status", body, deadlineAtMs, telemetry)); }
    catch (error) { if (isNotFound(error)) throw error; return null; }
  }

  private verifyReceipt(value: unknown, candidate: RemoteDeliveryResultCandidate): RemoteDeliveryAcceptanceReceipt {
    const receipt = RemoteDeliveryAcceptanceReceiptSchema.parse(value);
    const same = allEqual([
      [receipt.invocationRef, candidate.invocationRef],
      [receipt.claimId, candidate.claimId],
      [receipt.resultId, candidate.resultId],
      [receipt.resultDigest, candidate.resultDigest],
      [receipt.inputSelectionDigest, candidate.inputSelectionDigest],
      [receipt.baseRevision, candidate.baseRevision],
      [JSON.stringify(receipt.binding), JSON.stringify(candidate.binding)],
    ]);
    if (!same) throw unavailable();
    return receipt;
  }
  private async request(owner: { instanceId: string; assignmentId: string; attempt: number }, operation: OutputOperation, body: unknown,
    deadlineAtMs: number, telemetry: OutputTelemetry): Promise<unknown> {
    const startedAt = Date.now();
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw unavailable();
    const exchange: OutputExchange = {
      operation, encoded, telemetry, startedAt, deadlineAtMs,
      url: `${this.origin}/api/remote-instances/internal/remote-instances/${encodeURIComponent(owner.instanceId)}/assignments/${encodeURIComponent(owner.assignmentId)}/outputs/${operation}`,
      idempotencyKey: `output:${owner.assignmentId}:${owner.attempt}:${(body as { resultId?: string }).resultId ?? "unknown"}:${operation}`,
    };
    for (let attempt = 1; attempt <= NATIVE_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.attempt(exchange, attempt);
      if (outcome.kind === "value") return outcome.value;
      await this.retryOrGiveUp(operation, attempt, outcome);
    }
    throw unavailable();
  }

  /** One POST within the remaining deadline: Core's JSON answer, or why it may be retried. */
  private async attempt(exchange: OutputExchange, attempt: number): Promise<AttemptOutcome> {
    const remainingMs = exchange.deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw unavailable();
    const credential = this.options.credential();
    if (!credential) throw unavailable();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.min(30_000, remainingMs));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let response: Response;
      try {
        response = await abortable(Promise.resolve(this.fetchFn(exchange.url, { method: "POST", redirect: "error", credentials: "omit", signal: abort.signal,
          headers: { authorization: `Bearer ${credential}`, accept: "application/json", "content-type": "application/json",
            "idempotency-key": exchange.idempotencyKey }, body: exchange.encoded })), abort.signal, unavailable);
      } catch {
        return { kind: "retry", classification: abort.signal.aborted ? "timeout" : "transport" };
      }
      const retry = this.retryable(response, credential);
      if (retry) {
        void response.body?.cancel().catch(() => undefined);
        return retry;
      }
      reader = this.acceptedBody(response, exchange).getReader();
      return await this.readJson(reader, abort.signal, exchange, attempt);
    } finally { clearTimeout(timer); abort.abort(); if (reader) void reader.cancel().catch(() => undefined); }
  }

  /** A refusal raced by a lease rotation, or a transient status: the request may be sent again. */
  private retryable(response: Response, credential: string): AttemptOutcome | null {
    const renewed = this.options.credential();
    if (response.redirected) return null;
    if (LEASE_REFUSAL_STATUSES.includes(response.status) && renewed && renewed !== credential) return { kind: "retry", classification: "credential_rotated", status: response.status };
    const transient = transientHttpClassification(response.status);
    return transient ? { kind: "retry", classification: transient, status: response.status } : null;
  }

  /**
   * The JSON body of an accepted answer. A non-retryable refusal (413 over
   * the body limit, 422 rejected candidate) records only bounded protocol
   * metadata: a Core body can contain operator text and must never become
   * output telemetry.
   */
  private acceptedBody(response: Response, exchange: OutputExchange): ReadableStream<Uint8Array> {
    if (response.ok && !response.redirected && mediaType(response) === "application/json" && response.body) return response.body;
    void response.body?.cancel().catch(() => undefined);
    this.logger.warn({ event: "native.output.refused", ...exchange.telemetry, stage: exchange.operation, outcome: "refused", status: response.status,
      redirected: response.redirected, contentType: response.headers.get("content-type") ?? null,
      requestBytes: Buffer.byteLength(exchange.encoded), durationMs: Date.now() - exchange.startedAt }, "native delivery output request refused");
    throw new RemoteInstanceError("capability_unavailable", "Generated delivery output was not durably accepted.",
      { diagnostic: `response_refused_${response.status}` });
  }

  private async readJson(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, exchange: OutputExchange, attempt: number): Promise<AttemptOutcome> {
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await abortable(reader.read(), signal, unavailable); }
      catch { return { kind: "retry", classification: "response_body" }; }
      if (chunk.done) {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        this.logger.info({ event: "native.output.request_completed", ...exchange.telemetry, stage: exchange.operation, outcome: "success", attempt,
          requestBytes: Buffer.byteLength(exchange.encoded), responseBytes: size, durationMs: Date.now() - exchange.startedAt }, "native delivery output request completed");
        return { kind: "value", value };
      }
      size += chunk.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw unavailable(); chunks.push(chunk.value);
    }
  }

  private async retryOrGiveUp(operation: OutputOperation, attempt: number, outcome: Extract<AttemptOutcome, { kind: "retry" }>): Promise<void> {
    const retry = { logger: this.logger, operation: `output.${operation}`, classification: outcome.classification, ...(outcome.status === undefined ? {} : { status: outcome.status }) };
    if (attempt === NATIVE_TRANSIENT_MAX_ATTEMPTS) {
      logNativeRetryExhausted(retry);
      throw unavailable();
    }
    await waitForNativeRetry({ ...retry, attempt, sleep: this.options.retrySleep, baseDelayMs: this.options.retryBaseDelayMs });
  }}

