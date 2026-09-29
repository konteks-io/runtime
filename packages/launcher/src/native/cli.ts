import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { isRetiredAgentId, retiredAgentMessage } from "@konteks/backstage-plugin-common";
import { nativePaths, nativePlatform } from "./service.js";
import { createOutput, type Output } from "../output.js";

/**
 * The agents a native runtime runs: Claude Code and Codex from signed
 * packages, the person's own DeepSeek Harness and OpenCode 2 (Pi is retired;
 * OpenCode 2 is the host agent, not the old bundled one), and Google
 * Antigravity, which the connector downloads from Google on the person's yes.
 */
const NATIVE_AGENT_IDS = ["claude-code", "codex", "dsh", "opencode", "antigravity"] as const;
type NativeAgentId = (typeof NATIVE_AGENT_IDS)[number];

export interface NativeCommandContext { root: string; output: Output }
export interface NativeCliActions {
  install(input: NativeCommandContext & { activationId?: string; enroll?: boolean; coreUrl: string; relayUrl: string; agents?: string[] }): Promise<void>;
  onboard(input: NativeCommandContext & { answer?: string; cwd?: string }): Promise<void>;
  stageEnrollment(input: NativeCommandContext): Promise<void>;
  addAgent(input: NativeCommandContext & { agent: NativeAgentId; yes?: boolean }): Promise<void>;
  removeAgent(input: NativeCommandContext & { agent: NativeAgentId; yes?: boolean }): Promise<void>;
  serve(input: NativeCommandContext): Promise<void>;
  start(input: NativeCommandContext): Promise<void>;
  stop(input: NativeCommandContext): Promise<void>;
  update(input: NativeCommandContext & { check: boolean; unattended: boolean }): Promise<void>;
  uninstall(input: NativeCommandContext): Promise<void>;
  control(input: NativeCommandContext & { operation: "status" | "agents" | "doctor" | "support" | "preview.status" | "auth.status" | "auth.login" | "auth.logout" | "git.key.add" | "git.key.list" | "git.key.remove"; agent?: string; organization?: boolean; provider?: string; method?: string; reuse?: boolean; project?: string; location?: string; title?: string; keyRef?: string }): Promise<void>;
}

/** One customer architecture: the native connector. No provider-key or cloud-agent fallback switch. */
export function createNativeProgram(actions: NativeCliActions): Command {
  const program = new Command("konteks-remote").description("Konteks on this computer: connect it, run its agents, keep it updated")
    .option("--root <path>", "private user-scoped installation root")
    .option("--json", "machine-readable output", false)
    .option("-V, --version", "print the release installed on this machine");
  // The release this machine runs, not the launcher package: after an update
  // the person checks this number, and it must match `status` and the site.
  program.on("option:version", () => {
    const argv = process.argv;
    const at = argv.indexOf("--root");
    const root = at >= 0 && argv[at + 1] ? argv[at + 1]! : nativePaths({ os: nativePlatform().os }).root;
    process.stdout.write(`${installedReleaseVersion(root) ?? process.env.KONTEKS_LAUNCHER_VERSION ?? "0.1.0"}\n`);
    process.exit(0);
  });
  const context = (): NativeCommandContext => {
    const options = program.opts<{ root?: string; json: boolean }>();
    return { root: options.root ?? nativePaths({ os: nativePlatform().os }).root, output: createOutput({ json: options.json }) };
  };
  const id = (value: string): string => {
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) throw new InvalidArgumentError("activation id must be an opaque identifier; the code is prompted securely");
    return value;
  };
  const providerId = (value: string): string => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new InvalidArgumentError("expected an id such as deepseek or chatgpt-headless");
    return value;
  };
  const agent = (value: string): NativeAgentId => {
    if (isRetiredAgentId(value)) throw new InvalidArgumentError(retiredAgentMessage(value));
    if (!(NATIVE_AGENT_IDS as readonly string[]).includes(value)) throw new InvalidArgumentError("unsupported agent family");
    return value as NativeAgentId;
  };
  const project = (value: string): string => {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) throw new InvalidArgumentError("expected a Google Cloud project ID: 6 to 30 lower-case letters, digits or hyphens, starting with a letter");
    return value;
  };
  const location = (value: string): string => {
    if (!["global", "us", "eu"].includes(value)) throw new InvalidArgumentError("expected global, us or eu");
    return value;
  };
  program.command("install").description("install the connector with a one-time code from Konteks, then start it")
    .option("--activation-id <id>", "non-secret activation id from App or MCP", id)
    // Agent-first onboarding (onboarding-simplified OS3): no activation, no
    // prompt, no TTY. The install stops short of an identity; `onboard` binds.
    .option("--enroll", "prepare this machine for `konteks-remote onboard` instead of consuming an activation", false)
    .option("--core-url <url>", "Core HTTPS endpoint", process.env.KONTEKS_CORE_URL ?? "https://api.konteks.io")
    .option("--relay-url <url>", "relay WSS endpoint", process.env.KONTEKS_RELAY_URL ?? "wss://relay.konteks.io/relay/runtime")
    .option("--agents <ids>", "agent families: claude-code, codex, dsh, opencode, antigravity (default: claude-code,codex; antigravity asks before downloading Google Antigravity from Google)", value => value.split(",").map(part => agent(part.trim())))
    .action(async (options: { activationId?: string; enroll: boolean; coreUrl: string; relayUrl: string; agents?: string[] }) => {
      if (!options.activationId && !options.enroll) throw new InvalidArgumentError("install needs either --activation-id or --enroll");
      if (options.activationId && options.enroll) throw new InvalidArgumentError("an activation install and an enrollment install are different doors; choose one");
      await actions.install({ ...context(), ...options });
    });
  // The conversation the person's own coding agent relays (OS2, OS16). One
  // step per invocation; the agent runs what the step says and nothing else.
  program.command("onboard").description("connect this machine to Konteks, one question at a time")
    .option("--answer <text>", "the person's answer to the question the previous step asked")
    .option("--repo <path>", "the repository to register as the first System (default: the working directory)")
    .action(async (options: { answer?: string; repo?: string }) => actions.onboard({ ...context(), ...(options.answer !== undefined ? { answer: options.answer } : {}), ...(options.repo ? { cwd: options.repo } : {}) }));
  // The background half of `install --enroll`; `onboard` waits for it.
  program.command("stage-enrollment", { hidden: true }).description("unpack the agent packages an enrollment install recorded")
    .action(async () => actions.stageEnrollment(context()));
  program.command("serve").description("run the connector in this terminal (the background service uses this)").action(async () => actions.serve(context()));
  program.command("start").description("start the connector's background service").action(async () => actions.start(context()));
  program.command("stop").description("stop the connector's background service; this computer and its work are kept").action(async () => actions.stop(context()));
  const agentLifecycle = program.command("agent").description("add or remove agents on this computer");
  agentLifecycle.command("add").description("add one agent without reactivation: a signed package for Claude Code or Codex, your own DeepSeek Harness or OpenCode 2 install (nothing downloaded), or Google Antigravity, downloaded from Google (dl.google.com, about 110 MB) after you say yes")
    .argument("<agent>", "agent family: claude-code, codex, dsh, opencode or antigravity", agent)
    .option("--yes", "Google Antigravity: you read the download question and agree (it is asked otherwise)", false)
    .action(async (value: NativeAgentId, options: { yes: boolean }) => {
      if (options.yes && value !== "antigravity") throw new InvalidArgumentError("--yes answers Google Antigravity's download question; other agents ask none");
      await actions.addAgent({ ...context(), agent: value, ...(options.yes ? { yes: true } : {}) });
    });
  agentLifecycle.command("remove").description("remove Google Antigravity from this computer: sign it out, delete its download and its sign-ins here; other agents are untouched")
    .argument("<agent>", "antigravity", agent)
    .option("--yes", "you agree to the removal (it is asked otherwise)", false)
    .action(async (value: NativeAgentId, options: { yes: boolean }) => actions.removeAgent({ ...context(), agent: value, ...(options.yes ? { yes: true } : {}) }));
  const CONTROL_HELP = {
    status: "show whether this computer is connected to Konteks and ready for work",
    agents: "list the agents on this computer and whether each one is ready",
    doctor: "check the connector and every agent, and say what to fix",
    support: "collect a support bundle to share with Konteks support",
  } as const;
  for (const operation of ["status", "agents", "doctor", "support"] as const) program.command(operation).description(CONTROL_HELP[operation]).action(async () => actions.control({ ...context(), operation }));
  // Read-only. Whether this computer serves previews is switched per machine
  // in Konteks (Customize → Runtimes), never here.
  const preview = program.command("preview").description("live previews of sessions' work, served from this computer");
  preview.command("status").description("list this computer's session previews and why any of them stopped")
    .action(async () => actions.control({ ...context(), operation: "preview.status" }));
  const auth = program.command("auth").description("sign agents in and out on this computer");
  auth.command("status").argument("[agent]", "agent family", agent).action(async (value?: string) => actions.control({ ...context(), operation: "auth.status", ...(value ? { agent: value } : {}) }));
  auth.command("login").argument("<agent>", "agent family: claude-code, codex, dsh, opencode or antigravity", agent).option("--organization", "attest that the account is organization-owned", false)
    .option("--provider <id>", "OpenCode: the provider to sign in to (asked when omitted)", providerId)
    .option("--method <id>", "OpenCode: the provider's sign-in method, or key for an API key", providerId)
    .option("--reuse", "OpenCode: see which providers your own OpenCode uses, to sign in to the same ones", false)
    .option("--api-key", "Google Antigravity: sign in with a Gemini API key (asked without echo)", false)
    .option("--enterprise", "Google Antigravity: sign in with Gemini Enterprise in the browser on this computer", false)
    .option("--project <id>", "Google Antigravity: the Google Cloud project that holds the Gemini Enterprise licence", project)
    .option("--location <location>", "Google Antigravity: the licence's location, global, us or eu (default global)", location)
    .action(async (value: string, options: { organization: boolean; provider?: string; method?: string; reuse: boolean; apiKey: boolean; enterprise: boolean; project?: string; location?: string }) => {
      if (value !== "antigravity" && (options.apiKey || options.enterprise || options.project || options.location)) throw new InvalidArgumentError("--api-key, --enterprise, --project and --location are for antigravity");
      if (options.apiKey && (options.enterprise || options.project || options.location)) throw new InvalidArgumentError("a Gemini API key and Gemini Enterprise are different sign-ins; choose one");
      if (options.location && !options.project) throw new InvalidArgumentError("--location goes with --project");
      const method = options.apiKey ? "gemini-api-key" : options.enterprise || options.project ? "oauth-business" : options.method;
      await actions.control({ ...context(), operation: "auth.login", agent: value, organization: options.organization,
        ...(options.provider ? { provider: options.provider } : {}), ...(method ? { method } : {}), ...(options.reuse ? { reuse: true } : {}),
        ...(options.project ? { project: options.project, location: options.location ?? "global" } : {}) });
    });
  auth.command("logout").argument("<agent>", "agent family", agent).option("--provider <id>", "OpenCode: sign out of one provider only", providerId)
    .option("--api-key", "Google Antigravity: forget only the Gemini API key", false)
    .option("--enterprise", "Google Antigravity: sign out of Gemini Enterprise only", false)
    .action(async (value: string, options: { provider?: string; apiKey: boolean; enterprise: boolean }) => {
      if (value !== "antigravity" && (options.apiKey || options.enterprise)) throw new InvalidArgumentError("--api-key and --enterprise are for antigravity");
      if (options.apiKey && options.enterprise) throw new InvalidArgumentError("to sign out of both, leave out --api-key and --enterprise");
      const method = options.apiKey ? "gemini-api-key" : options.enterprise ? "oauth-business" : undefined;
      await actions.control({ ...context(), operation: "auth.logout", agent: value, ...(options.provider ? { provider: options.provider } : {}), ...(method ? { method } : {}) });
    });
  program.command("update").description("install the newest connector release and restart; running work finishes first, and a failed start goes back")
    .option("--check", "report the available release without installing anything", false)
    .option("--unattended", "launched by the connector itself; recorded as such in the update ledger", false)
    .action(async (options: { check: boolean; unattended: boolean }) => actions.update({ ...context(), ...options }));
  // ON16: managed-git key registration is a command on the trusted machine,
  // because the private half must never leave it. The App shows this command.
  const git = program.command("git").description("this computer's key for Konteks-managed repositories");
  const key = git.command("key").description("the SSH key this computer uses for Konteks-managed repositories");
  key.command("add").description("create this computer's key and register it with Konteks")
    .option("--title <title>", "how the key is labelled in Konteks")
    .action(async (options: { title?: string }) => actions.control({ ...context(), operation: "git.key.add", ...(options.title ? { title: options.title } : {}) }));
  key.command("list").description("list the keys registered for this computer").action(async () => actions.control({ ...context(), operation: "git.key.list" }));
  key.command("remove").description("revoke one registered key").argument("<keyRef>", "key reference from `git key list`")
    .action(async (keyRef: string) => actions.control({ ...context(), operation: "git.key.remove", keyRef }));
  // W1-L2: a person asks their agent to remove Konteks, in plain words; the
  // description is what the agent finds in `--help`.
  program.command("uninstall").description("remove Konteks from this computer after running work finishes; your repositories and your agents' own sign-ins stay")
    .action(async () => actions.uninstall(context()));
  return program;
}

/** The bundle version of the release this root's runtime record points at, if one is installed. */
export function installedReleaseVersion(root: string): string | null {
  try {
    const record = JSON.parse(readFileSync(join(root, "native-runtime.json"), "utf8")) as { bundleVersion?: unknown };
    return typeof record.bundleVersion === "string" && record.bundleVersion ? record.bundleVersion : null;
  } catch {
    return null;
  }
}
