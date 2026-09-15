import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { RemoteInstanceError, sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";
import { findAgentBridge, verifyOfflineAgentPackage, type AgentBridgeFamily, type NativeAgentPackageProfile } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";

/**
 * How this runner spawns its bridge and its official tooling. The bridge is
 * the vendored binary under the image's bridge prefix — never `npx` or a
 * registry lookup. The environment is rebuilt from scratch: a dedicated HOME
 * and XDG directories inside the private credential volume, PATH to the
 * vendored prefix, and — only for a gateway-keyed runner — the provider
 * base-URL variable the bridge documents, pointing at the gateway.
 */
export interface BridgeSpawnSpec {
  family: AgentBridgeFamily;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function resolveBridgeFamily(agentId: string): AgentBridgeFamily {
  const family = findAgentBridge(agentId);
  if (!family) {
    throw new RemoteInstanceError("agent_unavailable", `unsupported agent family: ${agentId}`);
  }
  return family;
}

export function bridgeEnvironment(config: RunnerConfig, family: AgentBridgeFamily): NodeJS.ProcessEnv {
  const base = sanitizeInheritedChildProcessEnv({ env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb" } });
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: `${join(config.RUNNER_BRIDGE_PREFIX, "bin")}:${base.PATH ?? ""}`,
    HOME: config.RUNNER_CREDENTIAL_DIR,
    XDG_CONFIG_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".config"),
    XDG_DATA_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".local", "share"),
    XDG_CACHE_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".cache"),
    XDG_STATE_HOME: join(config.RUNNER_CREDENTIAL_DIR, ".local", "state"),
    NO_COLOR: "1",
    CI: "1",
  };
  const profile = config.RUNNER_NATIVE_PACKAGE_PROFILE;
  if (config.RUNNER_NATIVE_CODEX_HOME !== undefined) {
    if (!profile || family.agentId !== "codex" || config.RUNNER_AUTH_MODE !== "agent_local_subscription" ||
        !isAbsolute(config.RUNNER_NATIVE_CODEX_HOME) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(config.RUNNER_NATIVE_CODEX_HOME)) {
      throw new RemoteInstanceError("agent_unavailable", "A shared Codex profile requires a native personal Codex runner and an absolute local profile path.");
    }
    // Official Codex owns this profile and its thread store. Do not copy or
    // synthesize rollouts; connector scope/identity metadata stays private.
    env.CODEX_HOME = config.RUNNER_NATIVE_CODEX_HOME;
  }
  if (config.RUNNER_NATIVE_CLAUDE_EXECUTABLE !== undefined) {
    if (!profile || family.agentId !== "claude-code" || config.RUNNER_AUTH_MODE !== "agent_local_subscription" ||
        !isAbsolute(config.RUNNER_NATIVE_CLAUDE_EXECUTABLE) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(config.RUNNER_NATIVE_CLAUDE_EXECUTABLE)) {
      throw new RemoteInstanceError("agent_unavailable", "A personal Claude Code profile requires a native personal Claude runner and an absolute local executable.");
    }
    // Like bb, reuse the operator's own installed CLI and its official login
    // (macOS keychain / ~/.claude). Konteks never copies or reads credentials.
    const operator = userInfo();
    env.CLAUDE_CODE_EXECUTABLE = config.RUNNER_NATIVE_CLAUDE_EXECUTABLE;
    env.HOME = operator.homedir;
    env.USER = operator.username;
    env.LOGNAME = operator.username;
    if (process.env.SHELL && isAbsolute(process.env.SHELL)) env.SHELL = process.env.SHELL;
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CI"] as const) delete env[name];
  }
  if (config.RUNNER_NATIVE_CODEX_SOCKET !== undefined) {
    if (!config.RUNNER_NATIVE_CODEX_HOME || !profile?.codexLocalProxy || profile.os === "windows" ||
        !isAbsolute(config.RUNNER_NATIVE_CODEX_SOCKET) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(config.RUNNER_NATIVE_CODEX_SOCKET)) {
      throw new RemoteInstanceError("agent_unavailable", "Shared Codex transport requires its signed native proxy and an absolute local socket.");
    }
    env.CODEX_PATH = join(config.RUNNER_BRIDGE_PREFIX, profile.codexLocalProxy.entrypoint);
    env.KONTEKS_NATIVE_CODEX_SOCKET = config.RUNNER_NATIVE_CODEX_SOCKET;
  }
  if (profile) {
    // Preserve the native machine operator's explicit additional CA trust.
    // Do not inherit NODE_OPTIONS, bearer credentials or TLS-disable flags.
    // Node bridges and Codex's Rust HTTP client use different CA settings.
    // Preserve explicit operator settings; do not infer or replace trust roots.
    for (const name of ["NODE_EXTRA_CA_CERTS", "CODEX_CA_CERTIFICATE"] as const) {
      const extraCa = process.env[name];
      if (!extraCa) continue;
      if (!isAbsolute(extraCa) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(extraCa)) {
        throw new RemoteInstanceError("agent_unavailable", "Native additional CA certificate path must be absolute.");
      }
      env[name] = extraCa;
    }
    const separator = profile.os === "windows" ? ";" : ":";
    const prefixes = [dirname(join(config.RUNNER_BRIDGE_PREFIX, profile.tooling.entrypoint))];
    if (profile.node) prefixes.push(dirname(join(config.RUNNER_BRIDGE_PREFIX, profile.node.entrypoint)));
    env.PATH = [...new Set(prefixes), base.PATH ?? ""].join(separator);
    if (profile.os === "windows") {
      env.USERPROFILE = config.RUNNER_CREDENTIAL_DIR;
      env.APPDATA = join(config.RUNNER_CREDENTIAL_DIR, "AppData", "Roaming");
      env.LOCALAPPDATA = join(config.RUNNER_CREDENTIAL_DIR, "AppData", "Local");
    }
  }
  if (config.RUNNER_AUTH_MODE === "gateway_keyed") {
    if (!config.RUNNER_GATEWAY_BASE_URL) {
      throw new RemoteInstanceError("gateway_unavailable", "gateway-keyed runner has no gateway base URL");
    }
    if (family.egress.baseUrlEnv) {
      env[family.egress.baseUrlEnv] = config.RUNNER_GATEWAY_BASE_URL;
    }
    // OpenCode/Pi route by provider; they honour the standard per-provider base URL variables.
    if (!family.egress.baseUrlEnv) {
      for (const provider of family.egress.providers) {
        env[PROVIDER_BASE_URL_ENV[provider]] = `${config.RUNNER_GATEWAY_BASE_URL.replace(/\/$/, "")}/${provider}`;
      }
    }
  }
  return env;
}

const PROVIDER_BASE_URL_ENV: Record<AgentBridgeFamily["egress"]["providers"][number], string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  google: "GOOGLE_GEMINI_BASE_URL",
  deepseek: "DEEPSEEK_BASE_URL",
};

export function resolveBridgeSpawnSpec(config: RunnerConfig): BridgeSpawnSpec {
  const family = resolveBridgeFamily(config.RUNNER_AGENT_ID);
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

/** Recheck the complete closure before process restart or official authentication. */
export async function verifyNativeRunnerPackage(config: RunnerConfig): Promise<void> {
  if (!config.RUNNER_NATIVE_PACKAGE_PROFILE && !config.RUNNER_NATIVE_PACKAGE_ARTIFACT) return;
  const artifact = config.RUNNER_NATIVE_PACKAGE_ARTIFACT;
  if (!artifact) throw new RemoteInstanceError("bundle_untrusted", "native package authority is missing");
  const profile = await verifyOfflineAgentPackage(config.RUNNER_BRIDGE_PREFIX, artifact);
  if (profile.agentId !== config.RUNNER_AGENT_ID || JSON.stringify(profile) !== JSON.stringify(config.RUNNER_NATIVE_PACKAGE_PROFILE)) throw new RemoteInstanceError("bundle_untrusted", "native package profile changed");
}
