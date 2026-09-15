import { Command, InvalidArgumentError } from "commander";
import { nativePaths, nativePlatform } from "./service.js";
import { createOutput, type Output } from "../output.js";

export interface NativeCommandContext { root: string; output: Output }
export interface NativeCliActions {
  install(input: NativeCommandContext & { activationId: string; coreUrl: string; relayUrl: string; agents?: string[] }): Promise<void>;
  addAgent(input: NativeCommandContext & { agent: "claude-code" | "codex" | "opencode" | "pi" }): Promise<void>;
  serve(input: NativeCommandContext): Promise<void>;
  start(input: NativeCommandContext): Promise<void>;
  stop(input: NativeCommandContext): Promise<void>;
  update(input: NativeCommandContext & { check: boolean; unattended: boolean }): Promise<void>;
  control(input: NativeCommandContext & { operation: "status" | "agents" | "doctor" | "support" | "auth.status" | "auth.login" | "auth.logout"; agent?: string; organization?: boolean }): Promise<void>;
}

/** One customer architecture. No appliance, provider-key or cloud-agent fallback switch. */
export function createNativeProgram(actions: NativeCliActions): Command {
  const program = new Command("konteks-remote").description("Konteks native agent connector")
    .version(process.env.KONTEKS_LAUNCHER_VERSION ?? "0.1.0")
    .option("--root <path>", "private user-scoped installation root")
    .option("--json", "machine-readable output", false);
  const context = (): NativeCommandContext => {
    const options = program.opts<{ root?: string; json: boolean }>();
    return { root: options.root ?? nativePaths({ os: nativePlatform().os }).root, output: createOutput({ json: options.json }) };
  };
  const id = (value: string): string => {
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) throw new InvalidArgumentError("activation id must be an opaque identifier; the code is prompted securely");
    return value;
  };
  const agent = (value: string): "claude-code" | "codex" | "opencode" | "pi" => {
    if (!["claude-code", "codex", "opencode", "pi"].includes(value)) throw new InvalidArgumentError("unsupported agent family");
    return value as "claude-code" | "codex" | "opencode" | "pi";
  };
  program.command("install").description("activate, verify and install the native connector, then start its user service")
    .requiredOption("--activation-id <id>", "non-secret activation id from App or MCP", id)
    .option("--core-url <url>", "Core HTTPS endpoint", process.env.KONTEKS_CORE_URL ?? "https://core.konteks.example")
    .option("--relay-url <url>", "relay WSS endpoint", process.env.KONTEKS_RELAY_URL ?? "wss://relay.konteks.example/relay/runtime")
    .option("--agents <ids>", "agent families (default: claude-code,codex)", value => value.split(",").map(part => agent(part.trim())))
    .action(async (options: { activationId: string; coreUrl: string; relayUrl: string; agents?: string[] }) => actions.install({ ...context(), ...options }));
  program.command("serve").description("run the native connector in the foreground (used by the background service)").action(async () => actions.serve(context()));
  program.command("start").description("start the installed native user service").action(async () => actions.start(context()));
  program.command("stop").description("stop the native user service, preserving identity and local work").action(async () => actions.stop(context()));
  const agentLifecycle = program.command("agent").description("manage agents installed on this native runtime");
  agentLifecycle.command("add").description("add one signed offline agent package without reactivation")
    .argument("<agent>", "agent family", agent)
    .action(async (value: "claude-code" | "codex" | "opencode" | "pi") => actions.addAgent({ ...context(), agent: value }));
  for (const operation of ["status", "agents", "doctor", "support"] as const) program.command(operation).action(async () => actions.control({ ...context(), operation }));
  const auth = program.command("auth").description("official local agent subscription authentication");
  auth.command("status").argument("[agent]", "agent family", agent).action(async (value?: string) => actions.control({ ...context(), operation: "auth.status", ...(value ? { agent: value } : {}) }));
  auth.command("login").argument("<agent>", "agent family", agent).option("--organization", "attest that the account is organization-owned", false)
    .action(async (value: string, options: { organization: boolean }) => actions.control({ ...context(), operation: "auth.login", agent: value, organization: options.organization }));
  auth.command("logout").argument("<agent>", "agent family", agent).action(async (value: string) => actions.control({ ...context(), operation: "auth.logout", agent: value }));
  program.command("update").description("stage the newest signed native release, drain, swap the user service and verify it; rolls back on a failed health gate")
    .option("--check", "report the available release without installing anything", false)
    .option("--unattended", "launched by the connector itself; recorded as such in the update ledger", false)
    .action(async (options: { check: boolean; unattended: boolean }) => actions.update({ ...context(), ...options }));
  // Rollback/uninstall must acquire the native lifecycle transaction; the old
  // appliance implementations are deliberately not registered here.
  return program;
}
