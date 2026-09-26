import { z } from "zod";

/**
 * Supervisor configuration. Everything is derived from the installer-owned
 * native runtime record (`loadNativeInstallation`); nothing here is a secret
 * (secrets live in the restricted data directory as 0600 files).
 */
export const SupervisorConfigSchema = z
  .object({
    /** The native connector is the only deployment; the retired appliance is refused. */
    SUPERVISOR_DEPLOYMENT_KIND: z.literal("native_connector").default("native_connector"),
    SUPERVISOR_DATA_DIR: z.string().min(1).default("/data"),
    SUPERVISOR_CORE_URL: z.string().url(),
    SUPERVISOR_CORE_PERMISSION_ANSWER_PRODUCER: z.string().min(1).max(256).optional(),
    /** Empty means HTTPS-only. */
    SUPERVISOR_RELAY_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
    SUPERVISOR_CONTROL_PORT: z.coerce.number().int().min(1).max(65_535).default(41800),
    /** The onboard lane's scratch: `clones/` for deep reads and relocation mirrors, `archives/` for single-file tars (OB6 §2). */
    SUPERVISOR_ONBOARD_SCRATCH_ROOT: z.string().min(1).default("/data/onboard"),
    /** Where this runtime's managed-git key lives. Private half, never backed up, never sent (ON16). */
    SUPERVISOR_ONBOARD_GIT_KEY_DIR: z.string().min(1).default("/data/git-keys"),
    /** Repositories in flight during an evidence pass; the host is somebody's laptop. */
    SUPERVISOR_ONBOARD_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(4),
    /** The platform MCP endpoint handed to agents inside `mcpServers` (Core's redeem answers a bearer token, not a URL). */
    SUPERVISOR_PLATFORM_MCP_URL: z.string().url().optional(),
    SUPERVISOR_BUNDLE_VERSION: z.string().min(1).default("0.1.0"),
    SUPERVISOR_PLATFORM_OS: z.enum(["macos", "windows", "debian"]).default("debian"),
    SUPERVISOR_PLATFORM_ARCH: z.enum(["amd64", "arm64"]).default("amd64"),
    /** Verified release manifest (written by the launcher after verification). */
    SUPERVISOR_RELEASE_MANIFEST_FILE: z.string().min(1).default("/etc/konteks/release-manifest.json"),
    SUPERVISOR_HTTPS_FALLBACK_POLL_MS: z.coerce.number().int().positive().default(5_000),
    SUPERVISOR_ACK_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
    SUPERVISOR_ACK_EVERY_FRAMES: z.coerce.number().int().positive().default(32),
    SUPERVISOR_REPLAY_BUFFER_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
    SUPERVISOR_REPLAY_BUFFER_AGE_MS: z.coerce.number().int().positive().default(10 * 60_000),
    SUPERVISOR_SOFT_MAX_CONCURRENT: z.coerce.number().int().positive().optional(),
    SUPERVISOR_PULL_MAX_ITEMS: z.coerce.number().int().positive().default(4),
  })
  .passthrough();
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

export function loadSupervisorConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  return SupervisorConfigSchema.parse(env);
}
