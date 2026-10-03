import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { RemoteInstanceError } from "@konteks/remote-common";
import { fetchedAgentPlatformPin, findAgentBridge, hostAgentVersionSupported } from "@konteks/remote-release";
import {
  RunnerConfigSchema, prepareAntigravityHome, resolveBridgeSpawnSpec, spawnBridge, sweepAntigravityProcesses,
  type RunnerConfig,
} from "@konteks/remote-agent-runner";

/**
 * Before Google Antigravity reads "ready", prove the exact server the
 * connector fetched answers as the one Konteks governs (A3): its own name and
 * the pinned version, the four sign-in methods (and not the hidden gateway),
 * MCP over http (the Konteks servers), load and resume, and embedded context
 * (how its `AGENTS.md` arrives, A9). One `initialize` in the connector's
 * private home, with the Konteks environment, then the process and anything
 * it left are stopped. A session needs a sign-in, so the rest is judged per
 * session: the `model` select and the `default` mode before a session reads
 * ready (`verifyAntigravitySession`), the tool filter by effect (CP4's
 * tripwire: a subagent tool never appears in a `tool_call`).
 */

/** The sign-in methods antigravity-acp 1.2.x offers (`initialize.authMethods`). */
export const ANTIGRAVITY_AUTH_METHODS: readonly string[] = Object.freeze(["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]);

interface AntigravitySelfCheckOptions {
  /** The Antigravity runner's configuration (the verified folder, version and credential directory). */
  config: RunnerConfig;
  spawn?: typeof spawnBridge;
  /** Stops processes left with the private home (replaced only in tests). */
  sweep?: (credentialDir: string) => Promise<number>;
  initializeTimeoutMs?: number;
  /** Passes remembered per (folder, version, each file's identity); replaced only in tests. */
  cache?: Map<string, true>;
}

const PASSED = new Map<string, true>();

export async function checkAntigravityServer(options: AntigravitySelfCheckOptions): Promise<void> {
  const config = RunnerConfigSchema.parse(options.config);
  const folder = config.RUNNER_NATIVE_ANTIGRAVITY_ROOT;
  const pin = fetchedAgentPlatformPin("antigravity");
  const family = findAgentBridge("antigravity");
  if (!folder || !pin || !family) {
    throw new RemoteInstanceError("prerequisite_missing", "Google Antigravity has not been downloaded to this computer.", { diagnostic: "antigravity_not_fetched" });
  }
  const cache = options.cache ?? PASSED;
  const key = await checkKey(folder, pin.files, config.RUNNER_BRIDGE_VERSION);
  if (cache.has(key)) return;
  const initialize = await initializeOnce(options, config);
  const drift = antigravityInitializeDrift(initialize, config.RUNNER_BRIDGE_VERSION);
  if (drift.length > 0) throw unsupported(config.RUNNER_BRIDGE_VERSION, drift);
  if (cache.size >= 16) cache.delete(cache.keys().next().value as string);
  cache.set(key, true);
}

/** The folder, the version and each pinned file's identity: a pass holds until any of them changes. */
async function checkKey(folder: string, files: ReadonlyArray<{ path: string }>, version: string): Promise<string> {
  const identities = await Promise.all(files.map(async file => {
    const found = await stat(join(folder, ...file.path.split("/")));
    return [file.path, found.dev, found.ino, found.size, found.mtimeMs].join(":");
  }));
  return [folder, version, ...identities].join("\u0000");
}

/** Start the server once in the private home, take its initialize answer, and stop it; leftovers are swept before and after. */
async function initializeOnce(options: AntigravitySelfCheckOptions, config: ReturnType<typeof RunnerConfigSchema.parse>): Promise<InitializeResponse> {
  const sweep = options.sweep ?? (credentialDir => sweepAntigravityProcesses(credentialDir));
  await sweep(config.RUNNER_CREDENTIAL_DIR);
  const paths = await prepareAntigravityHome(config.RUNNER_CREDENTIAL_DIR);
  const refuse = async () => { throw new RemoteInstanceError("agent_unavailable", "not answered during the start check"); };
  try {
    const bridge = await (options.spawn ?? spawnBridge)({
      spec: { ...resolveBridgeSpawnSpec(config), cwd: paths.home },
      initializeTimeoutMs: options.initializeTimeoutMs ?? config.RUNNER_INITIALIZE_TIMEOUT_MS,
      clientVersion: config.RUNNER_BRIDGE_VERSION,
      handlers: { onSessionUpdate: () => undefined, onRequestPermission: refuse, onCreateElicitation: refuse, onExit: () => undefined },
    });
    const initialize = bridge.initializeResult;
    await bridge.stop();
    return initialize;
  } catch (error) {
    if (error instanceof RemoteInstanceError && error.code === "protocol_incompatible") throw unsupported(config.RUNNER_BRIDGE_VERSION, ["it speaks another ACP protocol version"]);
    throw new RemoteInstanceError("agent_unavailable", "Google Antigravity could not start on this computer. Try again in a moment.", { diagnostic: "antigravity_self_check_failed", retryable: true, cause: error });
  } finally {
    await sweep(config.RUNNER_CREDENTIAL_DIR).catch(() => 0);
  }
}

function unsupported(version: string, drift: readonly string[]): RemoteInstanceError {
  return new RemoteInstanceError("prerequisite_missing",
    `Unsupported Google Antigravity version: ${version} does not answer as Konteks expects (${drift.slice(0, 4).join("; ")}${drift.length > 4 ? "; …" : ""}). Update the connector.`,
    { diagnostic: "antigravity_unsupported_version", recoveryActions: [{ kind: "update" }] });
}

/** Plain lines naming what differs from the server Konteks governs; empty when it answers as expected. */
export function antigravityInitializeDrift(initialize: InitializeResponse, pinnedVersion: string): string[] {
  return [
    ...identityDrift(initialize.agentInfo, pinnedVersion),
    ...authDrift(initialize.authMethods),
    ...capabilityDrift(initialize.agentCapabilities),
  ];
}

function identityDrift(info: InitializeResponse["agentInfo"], pinnedVersion: string): string[] {
  const name = info?.name === "antigravity-acp" ? [] : ["it is not Google's antigravity-acp server"];
  return [...name, ...versionDrift(typeof info?.version === "string" ? info.version : null, pinnedVersion)];
}

function versionDrift(version: string | null, pinnedVersion: string): string[] {
  if (version !== pinnedVersion) return [`it reports version ${version ?? "none"}, not the pinned ${pinnedVersion}`];
  return hostAgentVersionSupported(findAgentBridge("antigravity")!, pinnedVersion) ? [] : [`version ${pinnedVersion} is outside the supported range`];
}

function authDrift(authMethods: InitializeResponse["authMethods"]): string[] {
  const methods = new Set((authMethods ?? []).map(method => method.id));
  const drift = ANTIGRAVITY_AUTH_METHODS.filter(method => !methods.has(method)).map(method => `the ${method} sign-in is missing`);
  if (methods.has("gateway")) drift.push("it offers the gateway sign-in, which Konteks never enables");
  return drift;
}

type AgentCapabilities = NonNullable<InitializeResponse["agentCapabilities"]>;

/** What the governed server must be able to do, and the line naming it when it cannot. */
const CAPABILITY_CHECKS: ReadonlyArray<readonly [(caps: AgentCapabilities) => boolean, string]> = [
  [caps => caps.mcpCapabilities?.http === true, "it does not take MCP servers over http"],
  [caps => caps.loadSession === true, "it cannot load a session"],
  [caps => caps.sessionCapabilities?.resume != null, "it cannot resume a session"],
  [caps => caps.promptCapabilities?.embeddedContext === true, "it does not take embedded context"],
];

function capabilityDrift(caps: InitializeResponse["agentCapabilities"]): string[] {
  const present: AgentCapabilities = caps ?? {};
  return CAPABILITY_CHECKS.filter(([holds]) => !holds(present)).map(([, line]) => line);
}