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
        else stderr.write(`${redactText(`error (${error.code}): ${error.message}`)}\n${actions.map((action) => `  → ${action}`).join("\n")}${actions.length > 0 ? "\n" : ""}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) stderr.write(`${JSON.stringify({ error: { code: "internal", message: redactText(message) } })}\n`);
      else stderr.write(`${redactText(`error: ${message}`)}\n`);
    },
  };
}

export function describeAction(action: { kind: string; agentId?: string | undefined }): string {
  switch (action.kind) {
    case "retry":
      return "retry the command";
    case "run_doctor":
      return "run `konteks-remote doctor`";
    case "login_agent":
      return `run \`konteks-remote auth login ${action.agentId ?? "<agent>"}\``;
    case "update":
      return "run `konteks-remote update`";
    case "free_disk":
      return "free disk space and retry";
    case "install_backend":
      return "install and start the supported container backend, then retry";
    case "new_activation":
      return "create a new activation in the Konteks App or MCP and rerun install";
    case "contact_support":
      return "run `konteks-remote doctor` and share the support bundle with Konteks support";
    case "revoke_in_app":
      return "revoke or remove this runtime from the Konteks App or MCP";
    case "reselect_runtime":
      return "select another runtime for the workload";
    default:
      return "";
  }
}
