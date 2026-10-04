import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { affirmative, setupError, setupLocale, setupText, type SetupLocale } from "./setup-locale.js";

/**
 * The secure no-echo prompt. The activation code and an agent's API key are read
 * here and ONLY here: never from an argument, an environment variable, a
 * file the launcher writes, or a log. The readline output is muted so the
 * terminal never renders the characters; the value goes straight to the
 * consumer closure and is not retained by the launcher.
 */
interface SecretPromptOptions {
  label: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  minLength?: number;
  maxLength?: number;
  locale?: SetupLocale;
  labelKey?: "oneTimeCode";
}

function promptLabel(options: SecretPromptOptions, locale: SetupLocale): string {
  return options.labelKey ? setupText(options.labelKey, {}, locale) : options.label;
}

function assertInteractive(input: NodeJS.ReadableStream, options: SecretPromptOptions): void {
  if ((input as NodeJS.ReadStream).isTTY !== true && input === process.stdin) {
    throw setupError("prerequisite_missing", "interactiveInput", locale => ({ label: promptLabel(options, locale) }));
  }
}

export async function promptSecret(options: SecretPromptOptions): Promise<string> {
  const locale = options.locale ?? setupLocale();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  assertInteractive(input, options);
  const muted = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  const rl = createInterface({ input, output: muted, terminal: true });
  output.write(setupText("hiddenInput", { label: promptLabel(options, locale) }, locale));
  let value: string;
  try {
    value = await new Promise<string>((resolve, reject) => {
      let answered = false;
      const interrupted = () => reject(setupError("temporarily_unavailable", "inputInterrupted", locale => ({ label: promptLabel(options, locale) })));
      rl.once("SIGINT", () => { rl.close(); interrupted(); });
      rl.once("close", () => { if (!answered) interrupted(); });
      rl.question("", answer => { answered = true; resolve(answer); });
    });
  } finally {
    rl.close();
    output.write("\n");
  }
  const trimmed = value.trim();
  if (trimmed.length < (options.minLength ?? 8) || trimmed.length > (options.maxLength ?? 4_096)) {
    throw setupError("activation_invalid", "inputLength", locale => ({ label: promptLabel(options, locale) }));
  }
  return trimmed;
}

/** One line typed in the open (a choice from a list, never a secret). */
export async function promptLine(label: string, options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; locale?: SetupLocale } = {}): Promise<string> {
  setupLocale();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const rl = createInterface({ input, output, terminal: false });
  try {
    return await new Promise<string>((resolve, reject) => {
      let answered = false;
      rl.once("close", () => { if (!answered) reject(setupError("temporarily_unavailable", "inputInterrupted", { label })); });
      rl.question(`${label}: `, answer => { answered = true; resolve(answer.trim()); });
    });
  } finally {
    rl.close();
  }
}

/** A plain yes/no confirmation for privileged or destructive steps. Never defaults to yes. */
export async function confirm(question: string, options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; locale?: SetupLocale } = {}): Promise<boolean> {
  const locale = options.locale ?? setupLocale();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const rl = createInterface({ input, output, terminal: false });
  try {
    const answer = await new Promise<string>(resolve => {
      rl.once("close", () => resolve(""));
      rl.question(setupText("confirmation", { question }, locale), resolve);
    });
    return affirmative(answer, locale);
  } finally {
    rl.close();
  }
}
