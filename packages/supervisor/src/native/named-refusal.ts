import type { ExecFileException } from "node:child_process";
import { RemoteInstanceError, RuntimeFailureObservationSchema } from "@konteks/remote-common";
import type { RuntimeFailureFact } from "../runtime-failure-types.js";

/**
 * A refusal that names the exact check behind it, shared by the delivery-output
 * and recovery-checkpoint paths. Identifiers only, never paths, file names or
 * Git or provider text.
 */

/** Facts a refusal carries: the Git step it came from, and what Git or the OS reported. */
export interface RefusalFacts {
  gitStep?: string;
  exitCode?: number;
  signal?: string;
  errno?: string;
}

/** The same code and message as an anonymous refusal, plus the check that refused and its facts. */
export class NamedRefusal extends RemoteInstanceError {
  readonly facts: RefusalFacts;

  constructor(code: RemoteInstanceError["code"], message: string, diagnostic: string, facts: RefusalFacts = {}) {
    super(code, message, { diagnostic });
    this.facts = facts;
  }
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** A runtime failure's stage (96) or code (64): a stable snake_case identifier, or nothing. */
export function diagnosticIdentifier(value: string | undefined, max = 64): string | undefined {
  return value !== undefined && value.length <= max && IDENTIFIER.test(value) ? value : undefined;
}

/** Which way a Git call failed: killed at its timeout, past the output cap, unable to start, or a nonzero exit. */
export function gitFailure(error: ExecFileException, killed = "git_timeout"): { diagnostic: string; facts: Omit<RefusalFacts, "gitStep"> } {
  const code = (error as { code?: unknown }).code;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { diagnostic: "git_output_too_large", facts: {} };
  if (error.killed) return { diagnostic: killed, facts: {} };
  if (typeof code === "string") return { diagnostic: "git_spawn_failed", facts: { errno: code } };
  return { diagnostic: "git_failed", facts: { ...(typeof code === "number" ? { exitCode: code } : {}), ...(error.signal ? { signal: error.signal } : {}) } };
}

export function hasSyscall(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === "string";
}

/** An OS refusal by syscall and errno, such as `fs_lstat_enoent`. */
export function filesystemFailure(error: unknown): { diagnostic: string; facts: { errno: string } } | undefined {
  if (!hasSyscall(error) || typeof error.code !== "string") return undefined;
  const diagnostic = diagnosticIdentifier(`fs_${error.syscall}_${error.code}`.toLowerCase()) ?? "filesystem_error";
  return { diagnostic, facts: { errno: error.code } };
}

function refusalFacts(error: unknown): RefusalFacts {
  return error instanceof NamedRefusal ? error.facts : {};
}

function errnoOf(error: unknown): string | undefined {
  return refusalFacts(error).errno ?? (hasSyscall(error) ? (error.code as string | undefined) : undefined);
}

function processExitEvidence(facts: RefusalFacts): RuntimeFailureFact["evidence"] | undefined {
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
export function refusalEvidence(error: unknown): RuntimeFailureFact["evidence"] {
  const exit = processExitEvidence(refusalFacts(error));
  if (exit) return exit;
  const errno = errnoOf(error);
  if (errno !== undefined) return exceptionEvidence(errno);
  return error instanceof RemoteInstanceError ? { kind: "runtime_condition" } : { kind: "runtime_exception" };
}
