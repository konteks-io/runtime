import { RemoteInstanceError, redactText, redactValue } from "@konteks/remote-common";
import { setupFailureText, setupLocale, setupText, type SetupCopyKey, type SetupLocale } from "./setup-locale.js";
import {
  ForegroundProgress,
  stopSetupProgress,
  type SetupForeground,
} from "./foreground-progress.js";
import { isVerbose } from "./verbose.js";

/**
 * Stable, actionable, secret-redacted output. Every line the launcher prints
 * passes through the redactor; `--json` emits one redacted JSON document.
 */
export interface Output {
  json: boolean;
  readonly setupLocale?: SetupLocale;
  progress?(text: string): () => void;
  finishProgress?(): void;
  detail?(text: string): void;
  line(text: string): void;
  table(rows: Array<[string, string]>): void;
  result(value: unknown): void;
  error(error: unknown): void;
}

/**
 * A failure whose reason the person has already read (a sign-in flow's own
 * last line): the command still fails, and `--json` still reports it, but a
 * terminal shows no second, coded line after the plain one.
 */
export class AlreadyToldError extends RemoteInstanceError {}

interface OutputOptions { json: boolean; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; locale?: SetupLocale
  foreground?: SetupForeground;
}

function foregroundProgress(
  options: OutputOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  locale: SetupLocale,
): ForegroundProgress | undefined {
  if (options.json || !options.foreground) return undefined;
  const progress = new ForegroundProgress(
    stdout,
    stderr,
    (stdout as NodeJS.WriteStream).isTTY === true,
  );
  if (process.env.KONTEKS_SETUP_HEADER_SHOWN !== "1") {
    stdout.write(
      `\nKONTEKS\n${setupText(options.foreground === "update" ? "foregroundUpdate" : "foregroundInstall", {}, locale)}\n\n`,
    );
  }
  return progress;
}

export function createOutput(options: OutputOptions): Output {
  const locale = options.locale ?? setupLocale();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const progress = foregroundProgress(options, stdout, stderr, locale);
  return {
    json: options.json,
    setupLocale: locale,
    ...(progress
      ? {
          progress: (text: string) => progress.start(redactText(text)),
          finishProgress: () => progress.stop(),
        }
      : {}),
    ...(progress
      ? {
          detail: (text: string) => {
            if (isVerbose()) {
              progress.clear();
              stderr.write(`${redactText(text)}\n`);
            }
          },
        }
      : {}),
    line: (text) => {
      progress?.clear();
      if (!options.json) stdout.write(`${redactText(text)}\n`);
    },
    table: (rows) => {
      progress?.clear();
      if (options.json) return;
      const width = Math.max(...rows.map(([key]) => key.length), 0);
      for (const [key, value] of rows) stdout.write(`${redactText(key.padEnd(width))}  ${redactText(value)}\n`);
    },
    result: (value) => {
      progress?.stop();
      if (options.json) stdout.write(`${JSON.stringify(redactValue(value), null, 2)}\n`);
    },
    error: (error) => {
      stopSetupProgress(stderr);
      if (error instanceof RemoteInstanceError) {
        const actions = error.recoveryActions.map((action) => describeAction(action, locale)).filter((text) => text.length > 0);
        if (options.json) stderr.write(`${JSON.stringify(redactValue({ error: error.toJSON() }))}\n`);
        else if (error instanceof AlreadyToldError) return;
        else stderr.write(`${redactText(setupText("error", { code: error.code, detail: setupFailureText(error, locale) }, locale))}\n${actions.map((action) => `  → ${action}`).join("\n")}${actions.length > 0 ? "\n" : ""}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) stderr.write(`${JSON.stringify({ error: { code: "internal", message: redactText(message) } })}\n`);
      else stderr.write(`${redactText(setupText("unknownError", { detail: message }, locale))}\n`);
    },
  };
}

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", dsh: "DeepSeek Harness", opencode: "OpenCode 2", antigravity: "Google Antigravity" };

/** What each recovery action asks the person to do. */
const ACTION_WORDS: Readonly<Record<string, SetupCopyKey>> = {
  retry: "actionRetry", run_doctor: "actionDoctor", login_agent: "actionLogin", update: "actionUpdate",
  free_disk: "actionDisk", new_activation: "actionActivation", contact_support: "actionSupport",
  revoke_in_app: "actionRevoke", reselect_runtime: "actionReselect",
};

export function describeAction(action: { kind: string; agentId?: string | undefined }, locale: SetupLocale = "en"): string {
  if (action.kind === "install_backend") return installWords(action.agentId, locale);
  return Object.hasOwn(ACTION_WORDS, action.kind) ? setupText(ACTION_WORDS[action.kind]!, { agent: action.agentId ?? "<agent>" }, locale) : "";
}

/**
 * The native connector has no container backend: this names the agent
 * install the message asks for (the person's own DeepSeek Harness or
 * OpenCode; Google Antigravity is downloaded by the connector itself).
 */
function installWords(agentId: string | undefined, locale: SetupLocale): string {
  if (agentId === "antigravity") return setupText("actionAntigravity", {}, locale);
  return agentId
    ? setupText("actionInstallAgent", { name: AGENT_NAMES[agentId] ?? agentId }, locale)
    : setupText("actionInstall", {}, locale);
}
