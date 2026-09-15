import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { RemoteInstanceError } from "@konteks/remote-common";

/**
 * The secure no-echo prompt. The activation code and a gateway key are read
 * here and ONLY here: never from an argument, an environment variable, a
 * file the launcher writes, or a log. The readline output is muted so the
 * terminal never renders the characters; the value goes straight to the
 * consumer closure and is not retained by the launcher.
 */
export interface SecretPromptOptions {
  label: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  minLength?: number;
  maxLength?: number;
}

export async function promptSecret(options: SecretPromptOptions): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const isTty = (input as NodeJS.ReadStream).isTTY === true;
  if (!isTty && input === process.stdin) {
    throw new RemoteInstanceError("prerequisite_missing", `${options.label} must be entered interactively; run this command in a terminal`);
  }
  const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  const rl = createInterface({ input, output: muted, terminal: true });
  output.write(`${options.label} (input hidden): `);
  const value = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  output.write("\n");
  const trimmed = value.trim();
  if (trimmed.length < (options.minLength ?? 8) || trimmed.length > (options.maxLength ?? 4_096)) {
    throw new RemoteInstanceError("activation_invalid", `${options.label} has an unexpected length`);
  }
  return trimmed;
}

/** A plain yes/no confirmation for privileged or destructive steps. Never defaults to yes. */
export async function confirm(question: string, options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const rl = createInterface({ input, output, terminal: false });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
