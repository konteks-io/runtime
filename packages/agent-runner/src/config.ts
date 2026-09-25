import { z } from "zod";
import { RemoteNativeArtifactSchema } from "@konteks/remote-common";
import { NativeAgentPackageProfileSchema } from "@konteks/remote-release";

/**
 * Runner configuration. One container per agent family; everything here is
 * set by the launcher's Compose rendering. There is no instance key, no Core
 * token, and no Docker socket anywhere in this environment.
 */
export const RunnerConfigSchema = z
  .object({
    RUNNER_AGENT_ID: z.enum(["claude-code", "codex", "opencode", "pi", "dsh"]),
    RUNNER_PORT: z.coerce.number().int().min(1).max(65_535).default(41840),
    /** Private credential volume; becomes HOME/XDG for the bridge and its official tooling. */
    RUNNER_CREDENTIAL_DIR: z.string().min(1).default("/credentials"),
    /** Local operator's Codex profile, resolved by native installation only. Never supplied by an assignment. */
    RUNNER_NATIVE_CODEX_HOME: z.string().min(1).optional(),
    RUNNER_NATIVE_CODEX_SOCKET: z.string().min(1).optional(),
    /** Local operator's installed Claude Code CLI and personal login, resolved by native installation only. */
    RUNNER_NATIVE_CLAUDE_EXECUTABLE: z.string().min(1).optional(),
    /** The person's own installed DeepSeek Harness package root, resolved by native installation only. */
    RUNNER_NATIVE_DSH_ROOT: z.string().min(1).optional(),
    /** Execution roots for session `cwd` (component checkouts are mounted beneath it). */
    RUNNER_WORKSPACE_DIR: z.string().min(1).default("/workspace"),
    RUNNER_AUTH_MODE: z.enum(["agent_local_subscription", "gateway_keyed"]).default("agent_local_subscription"),
    /** Present only for gateway-keyed runners: the per-agent gateway base URL prefix. */
    RUNNER_GATEWAY_BASE_URL: z.string().url().optional(),
    /** Vendored bridge install prefix inside the image. */
    RUNNER_BRIDGE_PREFIX: z.string().min(1).default("/opt/konteks/bridges"),
    RUNNER_BRIDGE_VERSION: z.string().min(1).default("unknown"),
    /** Native installer-only signed package facts; never loaded from an assignment. */
    RUNNER_NATIVE_PACKAGE_PROFILE: NativeAgentPackageProfileSchema.optional(),
    RUNNER_NATIVE_PACKAGE_ARTIFACT: RemoteNativeArtifactSchema.optional(),
    /** Browser tool MCP endpoint offered to qa-role sessions. */
    RUNNER_BROWSER_TOOL_URL: z.string().url().optional(),
    RUNNER_INITIALIZE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    /** Hard deadline for each state-changing ACP session bootstrap request. */
    RUNNER_SESSION_BOOTSTRAP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    RUNNER_LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
  })
  .passthrough();
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return RunnerConfigSchema.parse(env);
}
