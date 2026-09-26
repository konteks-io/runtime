import { z } from "zod";
import { RemoteNativeArtifactSchema } from "@konteks/remote-common";
import { NativeAgentPackageProfileSchema } from "@konteks/remote-release";

/**
 * Runner configuration. One in-process runner per agent family; everything
 * here is derived by the native installation (`loadNativeInstallation`).
 * There is no instance key and no Core token in this configuration.
 */
export const RunnerConfigSchema = z
  .object({
    RUNNER_AGENT_ID: z.enum(["claude-code", "codex", "dsh"]),
    /** Private credential volume; becomes HOME/XDG for the bridge and its official tooling. */
    RUNNER_CREDENTIAL_DIR: z.string().min(1).default("/credentials"),
    /** Local operator's Codex profile, resolved by native installation only. Never supplied by an assignment. */
    RUNNER_NATIVE_CODEX_HOME: z.string().min(1).optional(),
    RUNNER_NATIVE_CODEX_SOCKET: z.string().min(1).optional(),
    /** Local operator's installed Claude Code CLI and personal login, resolved by native installation only. */
    RUNNER_NATIVE_CLAUDE_EXECUTABLE: z.string().min(1).optional(),
    /** The person's own installed DeepSeek Harness package root, resolved by native installation only. */
    RUNNER_NATIVE_DSH_ROOT: z.string().min(1).optional(),
    /** Its `bin.dsh` launcher inside that root, and the person's Node that runs it. */
    RUNNER_NATIVE_DSH_ENTRY: z.string().min(1).optional(),
    RUNNER_NATIVE_DSH_NODE: z.string().min(1).optional(),
    /** Execution roots for session `cwd` (component checkouts are mounted beneath it). */
    RUNNER_WORKSPACE_DIR: z.string().min(1).default("/workspace"),
    /** Agents run under the person's own local login (or, for DeepSeek Harness, their own key). */
    RUNNER_AUTH_MODE: z.literal("agent_local_subscription").default("agent_local_subscription"),
    /** Installed offline agent package prefix (or the person's own DeepSeek Harness root). */
    RUNNER_BRIDGE_PREFIX: z.string().min(1).default("/opt/konteks/bridges"),
    RUNNER_BRIDGE_VERSION: z.string().min(1).default("unknown"),
    /** Native installer-only signed package facts; never loaded from an assignment. */
    RUNNER_NATIVE_PACKAGE_PROFILE: NativeAgentPackageProfileSchema.optional(),
    RUNNER_NATIVE_PACKAGE_ARTIFACT: RemoteNativeArtifactSchema.optional(),
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
