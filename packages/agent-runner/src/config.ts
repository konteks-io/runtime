import { isAbsolute } from "node:path";
import { z } from "zod";
import { RemoteNativeArtifactSchema } from "@konteks/remote-common";
import { NativeAgentPackageProfileSchema } from "@konteks/remote-release";

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));

/**
 * The QA browser (Playwright MCP) as a connector capability: the
 * pinned package and the connector's launcher inside an installed Claude
 * Code or Codex package (`packageAgent`), run on `node`, which is that
 * package's own Node or, when none is usable, the person's own (`nodeSource`).
 */
export const RunnerBrowserSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  packageAgent: z.enum(["claude-code", "codex"]),
  nodeSource: z.enum(["agent_package", "person"]),
  node: absolutePath,
  launcher: absolutePath,
  entrypoint: absolutePath,
}).strict();
export type RunnerBrowser = z.infer<typeof RunnerBrowserSchema>;

/**
 * Runner configuration. One in-process runner per agent family; everything
 * here is derived by the native installation (`loadNativeInstallation`).
 * There is no instance key and no Core token in this configuration.
 */
export const RunnerConfigSchema = z
  .object({
    RUNNER_AGENT_ID: z.enum(["claude-code", "codex", "dsh", "opencode", "antigravity"]),
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
    /** The person's own installed OpenCode 2 executable (a native binary), resolved by native installation only. */
    RUNNER_NATIVE_OPENCODE_BINARY: z.string().min(1).optional(),
    /**
     * The verified folder of the Google Antigravity ACP server the connector
     * fetched (`<root>/agents/antigravity/<version>-<platform>`), resolved and
     * re-verified against the release's pin by native installation only.
     */
    RUNNER_NATIVE_ANTIGRAVITY_ROOT: z.string().min(1).optional(),
    /** Execution roots for session `cwd` (component checkouts are mounted beneath it). */
    RUNNER_WORKSPACE_DIR: z.string().min(1).default("/workspace"),
    /** Agents run under the person's own local login (or, for DeepSeek Harness, their own key). */
    RUNNER_AUTH_MODE: z.literal("agent_local_subscription").default("agent_local_subscription"),
    /** Installed offline agent package prefix (or the person's own DeepSeek Harness root, OpenCode's folder, or the fetched Antigravity folder). */
    RUNNER_BRIDGE_PREFIX: z.string().min(1).default("/opt/konteks/bridges"),
    RUNNER_BRIDGE_VERSION: z.string().min(1).default("unknown"),
    /** Native installer-only signed package facts; never loaded from an assignment. */
    RUNNER_NATIVE_PACKAGE_PROFILE: NativeAgentPackageProfileSchema.optional(),
    RUNNER_NATIVE_PACKAGE_ARTIFACT: RemoteNativeArtifactSchema.optional(),
    /**
     * The connector's QA browser for an agent whose own package carries none
     * (DeepSeek Harness, OpenCode): resolved by the supervisor from an
     * installed Claude Code or Codex package and a usable Node. Never
     * loaded from an assignment.
     */
    RUNNER_BROWSER: RunnerBrowserSchema.optional(),
    RUNNER_INITIALIZE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    /** Hard deadline for each state-changing ACP session bootstrap request. */
    RUNNER_SESSION_BOOTSTRAP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    RUNNER_LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
  })
  .passthrough();
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
