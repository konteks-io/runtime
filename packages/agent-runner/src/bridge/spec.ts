import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { findGitForWindows, RemoteInstanceError, sanitizeInheritedChildProcessEnv, type Logger } from "@konteks/remote-common";
import { findAgentBridge, verifyOfflineAgentPackageOnce, type AgentBridgeFamily, type NativeAgentPackageProfile } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import { hostAdapterForRunner } from "../host/registry.js";

/**
 * How this runner spawns its bridge and its official tooling. The bridge is
 * the binary in the installed offline agent package (or, for a host-installed
 * agent, what its host adapter located) — never `npx` or a registry lookup. The environment is
 * rebuilt from scratch: a dedicated HOME and XDG directories inside the
 * private credential folder and PATH to the package prefix.
 */
export interface BridgeSpawnSpec {
  family: AgentBridgeFamily;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** How long Claude Code waits for a Konteks MCP server's tools at session start (its `MCP_TIMEOUT`). */
const CLAUDE_MCP_STARTUP_TIMEOUT_MS = "180000";

export function resolveBridgeFamily(agentId: string): AgentBridgeFamily {
  const family = findAgentBridge(agentId);
  if (!family) {
    throw new RemoteInstanceError("agent_unavailable", `unsupported agent family: ${agentId}`);
  }
  return family;
}

export function bridgeEnvironment(config: RunnerConfig, family: AgentBridgeFamily): NodeJS.ProcessEnv {
  const base = sanitizeInheritedChildProcessEnv({ env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb" } });
  let env = privateHomeEnvironment(config, base);
  const profile = config.RUNNER_NATIVE_PACKAGE_PROFILE;
  // A host-installed agent (the person's own DeepSeek Harness or OpenCode)
  // gets the environment and private home its adapter builds.
  const host = hostAdapterForRunner(config, family);
  if (host) env = host.environment(config, family, env);
  if (config.RUNNER_NATIVE_CODEX_HOME !== undefined) useSharedCodexHome(config, family, profile, config.RUNNER_NATIVE_CODEX_HOME, env);
  if (config.RUNNER_NATIVE_CLAUDE_EXECUTABLE !== undefined) usePersonalClaude(config, family, profile, config.RUNNER_NATIVE_CLAUDE_EXECUTABLE, env);
  if (config.RUNNER_NATIVE_CODEX_SOCKET !== undefined) useSharedCodexSocket(config, profile, config.RUNNER_NATIVE_CODEX_SOCKET, env);
  if (profile) useNativePackage(config, profile, base.PATH ?? "", env);
  return env;
}

/** The sanitized inherited environment with a dedicated HOME and XDG directories inside the private credential folder. */
function privateHomeEnvironment(config: RunnerConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    // The platform's own separator: a `:` on Windows fused the prefix with the
    // first PATH entry, which a host agent's environment then inherited.
    PATH: `${join(config.RUNNER_BRIDGE_PREFIX, "bin")}${delimiter}${base.PATH ?? ""}`,
    HOME: config.RUNNER_CREDENTIAL_DIR,
    XDG_CONFIG_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".config"),
    XDG_DATA_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".local", "share"),
    XDG_CACHE_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".cache"),
    XDG_STATE_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".local", "state"),
    NO_COLOR: "1",
    CI: "1",
  };
}

/** An absolute path with no control or format characters. */
function localAbsolutePath(value: string): boolean {
  return isAbsolute(value) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function personalRunner(config: RunnerConfig, family: AgentBridgeFamily, profile: NativeAgentPackageProfile | undefined, agentId: string,
): profile is NativeAgentPackageProfile {
  return (
    profile !== undefined && family.agentId === agentId && config.RUNNER_AUTH_MODE === "agent_local_subscription"
  );
}

/**
 * Official Codex owns this profile and its thread store. Do not copy or
 * synthesize rollouts; connector scope/identity metadata stays private.
 */
function useSharedCodexHome(config: RunnerConfig, family: AgentBridgeFamily, profile: NativeAgentPackageProfile | undefined, codexHome: string, env: NodeJS.ProcessEnv): void {
  if (!personalRunner(config, family, profile, "codex") || !localAbsolutePath(codexHome)) {
    throw new RemoteInstanceError("agent_unavailable", "A shared Codex profile requires a native personal Codex runner and an absolute local profile path.");
  }
  env.CODEX_HOME = codexHome;
}

/**
 * Like bb, reuse the operator's own installed CLI and its official login
 * (macOS keychain / ~/.claude). Konteks never copies or reads credentials.
 */
function usePersonalClaude(config: RunnerConfig, family: AgentBridgeFamily, profile: NativeAgentPackageProfile | undefined, executable: string, env: NodeJS.ProcessEnv): void {
  if (!personalRunner(config, family, profile, "claude-code") || !localAbsolutePath(executable)) {
    throw new RemoteInstanceError("agent_unavailable", "A personal Claude Code profile requires a native personal Claude runner and an absolute local executable.");
  }
  const operator = userInfo();
  env.CLAUDE_CODE_EXECUTABLE = executable;
  env.HOME = operator.homedir;
  env.USER = operator.username;
  env.LOGNAME = operator.username;
  if (process.env.SHELL && isAbsolute(process.env.SHELL)) env.SHELL = process.env.SHELL;
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CI"] as const) delete env[name];
  // Claude Code drops an MCP server whose tool list takes longer than its
  // 30 s default, for the whole session: one slow start on a loaded machine
  // left a planning turn with none of Konteks's tools. A slow list should
  // delay the tools, never take them away.
  env.MCP_TIMEOUT = CLAUDE_MCP_STARTUP_TIMEOUT_MS;
  if (profile.os === "windows") useGitBash(env);
}

/**
 * Claude Code on Windows runs its commands in Git Bash. The connector's PATH
 * may predate a Git for Windows installed with it, so it is named with
 * Anthropic's documented setting, found from the connector's own
 * environment; none found leaves Claude Code to say what it needs.
 */
function useGitBash(env: NodeJS.ProcessEnv): void {
  const bash = findGitForWindows(process.env)?.bash;
  if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
}

function useSharedCodexSocket(config: RunnerConfig, profile: NativeAgentPackageProfile | undefined, socket: string, env: NodeJS.ProcessEnv): void {
  const proxy = profile?.os === "windows" ? undefined : profile?.codexLocalProxy;
  if (!config.RUNNER_NATIVE_CODEX_HOME || !proxy || !localAbsolutePath(socket)) {
    throw new RemoteInstanceError("agent_unavailable", "Shared Codex transport requires its signed native proxy and an absolute local socket.");
  }
  env.CODEX_PATH = join(config.RUNNER_BRIDGE_PREFIX, proxy.entrypoint);
  env.KONTEKS_NATIVE_CODEX_SOCKET = socket;
}

function useNativePackage(config: RunnerConfig, profile: NativeAgentPackageProfile, basePath: string, env: NodeJS.ProcessEnv,
): void {
  keepOperatorCaTrust(env);
  const separator = profile.os === "windows" ? ";" : ":";
  const prefixes = [dirname(join(config.RUNNER_BRIDGE_PREFIX, profile.tooling.entrypoint))];
  if (profile.node) prefixes.push(dirname(join(config.RUNNER_BRIDGE_PREFIX, profile.node.entrypoint)));
  env.PATH = [...new Set(prefixes), basePath].join(separator);
  if (profile.os === "windows") {
    env.USERPROFILE = config.RUNNER_CREDENTIAL_DIR;
    env.APPDATA = join(config.RUNNER_CREDENTIAL_DIR, "AppData", "Roaming");
    env.LOCALAPPDATA = join(config.RUNNER_CREDENTIAL_DIR, "AppData", "Local");
  }
  useWindowsCodexTooling(config, profile, env);
}

const WINDOWS_CODEX_EXECUTABLES = {
  amd64: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  arm64: "node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe",
} as const;

/** ACP must run the signed tooling pin, rather than its own older nested Codex dependency. */
function useWindowsCodexTooling(
  config: RunnerConfig,
  profile: NativeAgentPackageProfile,
  env: NodeJS.ProcessEnv,
): void {
  if (profile.agentId !== "codex" || profile.os !== "windows") return;
  const entrypoint =
    profile.tooling.runtime === "native"
      ? profile.tooling.entrypoint
      : WINDOWS_CODEX_EXECUTABLES[profile.architecture];
  if (!profile.files.some((file) => file.path === entrypoint && file.executable)) {
    throw new RemoteInstanceError(
      "bundle_untrusted",
      "The signed Windows Codex tooling executable is missing from the verified package.",
    );
  }
  env.CODEX_PATH = join(config.RUNNER_BRIDGE_PREFIX, ...entrypoint.split("/"));
}

/**
 * Preserve the native machine operator's explicit additional CA trust. Do
 * not inherit NODE_OPTIONS, bearer credentials or TLS-disable flags. Node
 * bridges and Codex's Rust HTTP client use different CA settings. Preserve
 * explicit operator settings; do not infer or replace trust roots.
 */
function keepOperatorCaTrust(env: NodeJS.ProcessEnv): void {
  for (const name of ["NODE_EXTRA_CA_CERTS", "CODEX_CA_CERTIFICATE"] as const) {
    const extraCa = process.env[name];
    if (!extraCa) continue;
    if (!localAbsolutePath(extraCa)) {
      throw new RemoteInstanceError("agent_unavailable", "Native additional CA certificate path must be absolute.");
    }
    env[name] = extraCa;
  }
}

export function resolveBridgeSpawnSpec(config: RunnerConfig): BridgeSpawnSpec {
  const family = resolveBridgeFamily(config.RUNNER_AGENT_ID);
  const host = hostAdapterForRunner(config, family);
  if (host) return { family, ...host.launch(config, family), env: bridgeEnvironment(config, family), cwd: config.RUNNER_WORKSPACE_DIR };
  const [command, ...args] = family.command;
  if (!command) throw new RemoteInstanceError("agent_unavailable", "bridge family has no command");
  if (config.RUNNER_NATIVE_PACKAGE_PROFILE) {
    return { family, ...nativeCommand(config, config.RUNNER_NATIVE_PACKAGE_PROFILE.bridge, args), env: bridgeEnvironment(config, family), cwd: config.RUNNER_WORKSPACE_DIR };
  }
  return {
    family,
    command: join(config.RUNNER_BRIDGE_PREFIX, "bin", command),
    args,
    env: bridgeEnvironment(config, family),
    cwd: config.RUNNER_WORKSPACE_DIR,
  };
}

export function resolveToolingCommand(config: RunnerConfig, family: AgentBridgeFamily, tooling: readonly string[]): { command: string; args: string[] } {
  const [command, ...args] = tooling;
  if (!command) throw new RemoteInstanceError("agent_unavailable", "bridge family has no tooling command");
  if (config.RUNNER_NATIVE_PACKAGE_PROFILE) {
    if (command !== family.tooling.login[0]) throw new RemoteInstanceError("agent_unavailable", "unsupported official tooling command");
    if (config.RUNNER_NATIVE_CLAUDE_EXECUTABLE !== undefined && family.agentId === "claude-code") return { command: config.RUNNER_NATIVE_CLAUDE_EXECUTABLE, args };
    return nativeCommand(config, config.RUNNER_NATIVE_PACKAGE_PROFILE.tooling, args);
  }
  return { command: join(config.RUNNER_BRIDGE_PREFIX, "bin", command), args };
}

function nativeCommand(config: RunnerConfig, entry: NativeAgentPackageProfile["bridge"], args: string[]) {
  const path = join(config.RUNNER_BRIDGE_PREFIX, ...entry.entrypoint.split("/"));
  if (entry.runtime === "native") return { command: path, args };
  const runtime = config.RUNNER_NATIVE_PACKAGE_PROFILE?.node;
  if (!runtime) throw new RemoteInstanceError("bundle_untrusted", "offline agent package has no verified Node runtime");
  return { command: join(config.RUNNER_BRIDGE_PREFIX, ...runtime.entrypoint.split("/")), args: [path, ...args] };
}

/**
 * Recheck the complete closure before process restart or official
 * authentication. The first use in this process hashes every file; later
 * uses rehash only when the package's stat fingerprint moved.
 */
export async function verifyNativeRunnerPackage(config: RunnerConfig, logger?: Pick<Logger, "info">): Promise<void> {
  if (!config.RUNNER_NATIVE_PACKAGE_PROFILE && !config.RUNNER_NATIVE_PACKAGE_ARTIFACT) return;
  const artifact = config.RUNNER_NATIVE_PACKAGE_ARTIFACT;
  if (!artifact) throw new RemoteInstanceError("bundle_untrusted", "native package authority is missing");
  const startedAt = Date.now();
  const { profile, cached } = await verifyOfflineAgentPackageOnce(config.RUNNER_BRIDGE_PREFIX, artifact);
  if (profile.agentId !== config.RUNNER_AGENT_ID || JSON.stringify(profile) !== JSON.stringify(config.RUNNER_NATIVE_PACKAGE_PROFILE)) throw new RemoteInstanceError("bundle_untrusted", "native package profile changed");
  logger?.info({ event: "native.bootstrap.stage", stage: "package_verify", agentId: config.RUNNER_AGENT_ID,
    mode: cached ? "cached" : "full", durationMs: Date.now() - startedAt }, "agent package verified");
}
