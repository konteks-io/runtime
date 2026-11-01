import { RemoteInstanceError, RuntimeFailureObservationSchema } from "@konteks/remote-common";
import type { RuntimeFailureFact } from "../runtime-failure-types.js";

/**
 * Names for every refusal on the delivery-output path (10-30): seven attempts
 * each failed locally between authorization and Core's output client, and the
 * only trace was a bare `capture_unavailable` in a log nobody could read.
 * Identifiers only, never paths, file names or provider text.
 */

/** The Git call a capture refusal came from. */
export type OutputGitStep =
  | "rev_parse" | "baseline_commit" | "read_tree" | "ls_files" | "ls_files_stage" | "add" | "add_accepted"
  | "write_tree" | "diff" | "ls_tree" | "cat_file";

/** The step of one delivery output hand-back that refused. */
export type DeliveryOutputStage =
  | "output_busy" | "output_authorize" | "output_record_read" | "output_record_mismatch" | "output_promote"
  | "output_begin" | "output_source_verify" | "output_previous" | "output_capture" | "output_save"
  | "output_accept" | "output_claim_moved";

export interface OutputRefusalFacts {
  gitStep?: OutputGitStep;
  exitCode?: number;
  signal?: string;
  errno?: string;
}

const CAPTURE_MESSAGE = "Generated delivery output is unavailable or changed during capture.";
const IDENTIFIER = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** A capture refusal: the same code and message as before, plus the check and Git step that refused. */
export class OutputCaptureRefusal extends RemoteInstanceError {
  readonly facts: OutputRefusalFacts;

  constructor(diagnostic: string, facts: OutputRefusalFacts = {}) {
    super("capability_unavailable", CAPTURE_MESSAGE, { diagnostic });
    this.facts = facts;
  }
}

const stages = new WeakMap<object, DeliveryOutputStage>();

/** Record the step an error left from; the innermost step wins, the error itself is unchanged. */
export function tagDeliveryOutputStage(error: unknown, stage: DeliveryOutputStage): void {
  if (error !== null && typeof error === "object" && !stages.has(error)) stages.set(error, stage);
}

function deliveryOutputStage(error: unknown): DeliveryOutputStage | undefined {
  return error !== null && typeof error === "object" ? stages.get(error) : undefined;
}

/** Run one step of the hand-back, naming it on whatever it throws. */
export async function deliveryStep<T>(stage: DeliveryOutputStage, operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    tagDeliveryOutputStage(error, stage);
    throw error;
  }
}

/** A runtime failure's stage (96) or code (64): a stable snake_case identifier, or nothing. */
export function diagnosticIdentifier(value: string | undefined, max = 64): string | undefined {
  return value !== undefined && value.length <= max && IDENTIFIER.test(value) ? value : undefined;
}

function identifier(value: string, max: number, fallback: string): string {
  return diagnosticIdentifier(value, max) ?? fallback;
}

/** The refusal's stable identifier for a log line: its diagnostic when it has one. */
function deliveryOutputCode(error: unknown): string {
  if (error instanceof RemoteInstanceError) return identifier(error.diagnostic ?? error.code, 64, error.code);
  return hasSyscall(error) ? "filesystem_error" : "delivery_output_transfer_failed";
}

function refusalFacts(error: unknown): OutputRefusalFacts {
  return error instanceof OutputCaptureRefusal ? error.facts : {};
}

/** Where the hand-back stopped, down to the Git call when capture refused. */
function deliveryOutputFailureStage(error: unknown): string {
  const gitStep = refusalFacts(error).gitStep;
  const stage = `delivery_${deliveryOutputStage(error) ?? "output_transfer"}${gitStep ? `_git_${gitStep}` : ""}`;
  return identifier(stage, 96, "delivery_output_transfer");
}

function hasSyscall(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === "string";
}

function errnoOf(error: unknown): string | undefined {
  return refusalFacts(error).errno ?? (hasSyscall(error) ? (error.code as string | undefined) : undefined);
}

function processExitEvidence(facts: OutputRefusalFacts): RuntimeFailureFact["evidence"] | undefined {
  if (facts.exitCode === undefined && facts.signal === undefined) return undefined;
  const parsed = RuntimeFailureObservationSchema.shape.evidence.safeParse({ kind: "process_exit",
    ...(facts.exitCode === undefined ? {} : { exitCode: facts.exitCode }), ...(facts.signal === undefined ? {} : { signal: facts.signal }) });
  return parsed.success ? parsed.data : { kind: "runtime_condition" };
}

function exceptionEvidence(errno: string): RuntimeFailureFact["evidence"] {
  const parsed = RuntimeFailureObservationSchema.shape.evidence.safeParse({ kind: "runtime_exception", errno });
  return parsed.success ? parsed.data : { kind: "runtime_exception" };
}

/** Only what was observed: a Git exit, an OS errno, a refused check, or an unexpected exception. */
function deliveryOutputEvidence(error: unknown): RuntimeFailureFact["evidence"] {
  const exit = processExitEvidence(refusalFacts(error));
  if (exit) return exit;
  const errno = errnoOf(error);
  if (errno !== undefined) return exceptionEvidence(errno);
  return error instanceof RemoteInstanceError ? { kind: "runtime_condition" } : { kind: "runtime_exception" };
}

/** The retained retry as a `turn` runtime failure Konteks can read. */
export function deliveryOutputFailure(error: unknown): RuntimeFailureFact {
  return { phase: "turn", stage: deliveryOutputFailureStage(error), code: deliveryOutputCode(error),
    evidence: deliveryOutputEvidence(error), retryable: true };
}
