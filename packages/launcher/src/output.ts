import { RemoteInstanceError, redactText, redactValue } from "@konteks/remote-common";

/**
 * Stable, actionable, secret-redacted output. Every line the launcher prints
 * passes through the redactor; `--json` emits one redacted JSON document.
 */
export interface Output {
  json: boolean;
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

export function createOutput(options: { json: boolean; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }): Output {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  return {
    json: options.json,
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
        const actions = error.recoveryActions.map((action) => describeAction(action)).filter((text) => text.length > 0);
        if (options.json) stderr.write(`${JSON.stringify(redactValue({ error: error.toJSON() }))}\n`);
        else if (error instanceof AlreadyToldError) return;
        else stderr.write(`${redactText(`error (${error.code}): ${error.message}`)}\n${actions.map((action) => `  → ${action}`).join("\n")}${actions.length > 0 ? "\n" : ""}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) stderr.write(`${JSON.stringify({ error: { code: "internal", message: redactText(message) } })}\n`);
      else stderr.write(`${redactText(`error: ${message}`)}\n`);
    },
  };
}

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", dsh: "DeepSeek Harness", opencode: "OpenCode 2", antigravity: "Google Antigravity" };

/** What each recovery action asks the person to do. */
const ACTION_WORDS: Readonly<Record<string, (agentId: string | undefined) => string>> = {
  retry: () => "retry the command",
  run_doctor: () => "run `konteks-remote doctor`",
  login_agent: agentId => `run \`konteks-remote auth login ${agentId ?? "<agent>"}\``,
  update: () => "run `konteks-remote update`",
  free_disk: () => "free disk space and retry",
  install_backend: installWords,
  new_activation: () => "create a new activation in the Konteks App or MCP and rerun install",
  contact_support: () => "run `konteks-remote doctor` and share the support bundle with Konteks support",
  revoke_in_app: () => "revoke or remove this runtime from the Konteks App or MCP",
  reselect_runtime: () => "select another runtime for the workload",
};

export function describeAction(action: { kind: string; agentId?: string | undefined }): string {
  return Object.hasOwn(ACTION_WORDS, action.kind) ? ACTION_WORDS[action.kind]!(action.agentId) : "";
}

/**
 * The native connector has no container backend: this names the agent
 * install the message asks for (the person's own DeepSeek Harness or
 * OpenCode; Google Antigravity is downloaded by the connector itself).
 */
function installWords(agentId: string | undefined): string {
  if (agentId === "antigravity") return "run `konteks-remote agent add antigravity`, which downloads Google's copy again after you say yes";
  return agentId
    ? `install a supported ${AGENT_NAMES[agentId] ?? agentId} as the message says, then run the command again`
    : "install what the message names, then run the command again";
}
