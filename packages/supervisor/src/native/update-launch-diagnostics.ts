import type { ChildProcess } from "node:child_process";

const STDERR_LIMIT = 4_096;
const STARTUP_REASONS = [
  ["Invalid environment block", "systemd_environment_invalid"],
  ["Failed to connect to bus", "user_manager_unavailable"],
  ["No such file or directory", "updater_executable_missing"],
  ["Permission denied", "updater_permission_denied"],
  ["already exists", "updater_unit_conflict"],
  ["unrecognized option", "updater_option_unsupported"],
] as const;

export interface NativeUpdateLaunchDiagnostic {
  reason: typeof STARTUP_REASONS[number][1] | "updater_start_failed";
  stderrBytes: number;
  stderrTruncated: boolean;
}

export type NativeUpdaterExitListener = (code: number | null, diagnostic?: NativeUpdateLaunchDiagnostic) => void;

export function nativeUpdaterExitMessage(code: number | null, diagnostic?: NativeUpdateLaunchDiagnostic): string {
  return `update transaction exited with code ${code ?? "null"} before replacing this service${diagnostic ? ` (${diagnostic.reason})` : ""}`;
}

/** Retain only bounded startup stderr until close; return static facts, never raw output. */
export function observeNativeUpdaterExit(child: ChildProcess, captureStderr: boolean): (listener: NativeUpdaterExitListener) => void {
  let prefix = Buffer.alloc(0);
  let bytes = 0;
  let result: { code: number | null; diagnostic?: NativeUpdateLaunchDiagnostic } | undefined;
  let listener: NativeUpdaterExitListener | undefined;
  const piped = captureStderr && child.stderr != null;
  if (piped) child.stderr!.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    prefix = Buffer.concat([prefix, chunk.subarray(0, STDERR_LIMIT - prefix.length)]);
  });
  child.once(piped ? "close" : "exit", (code: number | null) => {
    result = { code };
    if (piped && code !== 0) result.diagnostic = startupDiagnostic(prefix, bytes);
    prefix = Buffer.alloc(0);
    notifyExit(listener, result);
  });
  return observer => {
    listener = observer;
    if (result) notifyExit(observer, result);
  };
}

function startupDiagnostic(prefix: Buffer, bytes: number): NativeUpdateLaunchDiagnostic {
  const text = prefix.toString("utf8");
  const reason = STARTUP_REASONS.find(([message]) => text.includes(message))?.[1] ?? "updater_start_failed";
  return { reason, stderrBytes: bytes, stderrTruncated: bytes > STDERR_LIMIT };
}

function notifyExit(listener: NativeUpdaterExitListener | undefined, result: { code: number | null; diagnostic?: NativeUpdateLaunchDiagnostic }): void {
  if (result.diagnostic) listener?.(result.code, result.diagnostic);
  else listener?.(result.code);
}
