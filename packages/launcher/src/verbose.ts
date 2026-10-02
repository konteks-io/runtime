import { redactText } from "@konteks/remote-common";

/**
 * `konteks-remote --verbose` (or `KONTEKS_REMOTE_VERBOSE=1`): every service
 * and OS command the launcher runs, its exit code and what it printed, and
 * the decisions it takes, on stderr so `--json` stays one document. Off by
 * default; the normal output does not change (D129: a Windows start failed
 * with one generic line and nothing to diagnose it by).
 */
let enabled = fromEnvironment();

function fromEnvironment(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.KONTEKS_REMOTE_VERBOSE ?? "");
}

export function setVerbose(on: boolean): void {
  enabled = on || fromEnvironment();
}

export function isVerbose(): boolean {
  return enabled;
}

export function verbose(text: string, stream: NodeJS.WritableStream = process.stderr): void {
  if (enabled) stream.write(`${redactText(`[verbose] ${text}`)}\n`);
}

const OUTPUT_LIMIT = 2_000;

function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_LIMIT ? `${trimmed.slice(0, OUTPUT_LIMIT)}… (${trimmed.length - OUTPUT_LIMIT} more characters)` : trimmed;
}

/** One service command: what ran, how it ended and what it printed. */
export function verboseCommand(
  command: { command: string; args: readonly string[] },
  result: { code: number | null; stdout?: string; stderr?: string; error?: string; timedOut?: boolean },
  elapsedMs: number,
  stream: NodeJS.WritableStream = process.stderr,
): void {
  if (!enabled) return;
  verbose(`${[command.command, ...command.args].join(" ")}`, stream);
  const ended = result.error ? `could not be run: ${result.error}`
    : result.timedOut ? "did not finish in time"
      : result.code === null ? "ended without an exit code" : `exited ${result.code}`;
  verbose(`  ${ended} after ${elapsedMs} ms`, stream);
  for (const [name, text] of [["stdout", result.stdout], ["stderr", result.stderr]] as const) {
    if (text?.trim()) verbose(`  ${name}: ${bounded(text)}`, stream);
  }
}
