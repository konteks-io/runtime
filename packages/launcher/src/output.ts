import { RemoteInstanceError, redactText, redactValue } from "@konteks/remote-common";
import { setupFailureText, setupLocale, setupText, type SetupCopyKey, type SetupLocale } from "./setup-locale.js";

/**
 * Stable, actionable, secret-redacted output. Every line the launcher prints
 * passes through the redactor; `--json` emits one redacted JSON document.
 */
export interface Output {
  json: boolean;
  readonly setupLocale?: SetupLocale;
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

export function createOutput(options: { json: boolean; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; locale?: SetupLocale }): Output {
  const locale = options.locale ?? setupLocale();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  return {
    json: options.json,
    setupLocale: locale,
    line: (text) => {
      if (!options.json) stdout.write(`${redactText(text)}\n`);
    },
    table: (rows) => {
      if (options.json) return;
      const width = Math.max(...rows.map(([key]) => key.length), 0);
      for (const [key, value] of rows) stdout.write(`${redactText(key.padEnd(width))}  ${redactText(value)}\n`);
    },
    result: (value) => {
      if (options.json) stdout.write(`${JSON.stringify(redactValue(value), null, 2)}\n`);
    },
    error: (error) => {
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
