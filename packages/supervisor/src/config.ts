import { z } from "zod";

/**
 * Supervisor configuration. Everything is set by the launcher's Compose
 * rendering or the launcher's in-process provisioning run; nothing here is a
 * secret (secrets live in the restricted data directory as 0600 files).
 */
export const SupervisorConfigSchema = z
  .object({
    /** Appliance is migration-only; native entrypoints select native_connector. */
    SUPERVISOR_DEPLOYMENT_KIND: z.enum(["appliance", "native_connector"]).default("appliance"),
    SUPERVISOR_DATA_DIR: z.string().min(1).default("/data"),
    SUPERVISOR_CORE_URL: z.string().url(),
    SUPERVISOR_CORE_PERMISSION_ANSWER_PRODUCER: z.string().min(1).max(256).optional(),
    /** Empty (the Compose template renders `""` when no relay is configured) means HTTPS-only. */
    SUPERVISOR_RELAY_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
    SUPERVISOR_CONTROL_PORT: z.coerce.number().int().min(1).max(65_535).default(41800),
    SUPERVISOR_INTERNAL_PORT: z.coerce.number().int().min(1).max(65_535).default(41820),
    SUPERVISOR_GATEWAY_ADMIN_URL: z.string().url().default("http://gateway:41811"),
    SUPERVISOR_SYSMON_URL: z.string().url().default("http://sysmon:41830"),
    SUPERVISOR_HARNESS_URL: z.string().url().default("http://harness:3000"),
    SUPERVISOR_VALIDATION_URL: z.string().url().default("http://validation-runtime:3100"),
    /**
     * The local component protocol (supervisor ⇄ Harness / Validation Runtime).
     * Both components dial the supervisor over a unix socket on a shared
     * volume (the Harness accepts only unix/loopback endpoints); the supervisor
     * presents each component's own identity secret on that component's
     * routes: the Harness's bearer token, the Validation Runtime's dispatch
     * HMAC secret. The launcher generates all three secrets at install
     * (`stores/*.token|*.secret`) and Compose mounts each into exactly the
     * supervisor and its owner.
     */
    SUPERVISOR_COMPONENT_SOCKET: z.string().min(1).default("/run/konteks/supervisor.sock"),
    SUPERVISOR_HARNESS_COMPONENT_TOKEN_FILE: z.string().min(1).default("/run/secrets/harness_component_token"),
    SUPERVISOR_VALIDATION_COMPONENT_TOKEN_FILE: z.string().min(1).default("/run/secrets/validation_component_token"),
    SUPERVISOR_VALIDATION_DISPATCH_SECRET_FILE: z.string().min(1).default("/run/secrets/validation_dispatch_secret"),
    /** The Harness container's task-checkout root; the Validation Runtime mounts the same tree read-only as its projection root. */
    SUPERVISOR_HARNESS_TASK_CHECKOUT_ROOT: z.string().min(1).default("/data/checkouts"),
    /** The onboard lane's scratch: `clones/` for deep reads and relocation mirrors, `archives/` for single-file tars (OB6 §2). */
    SUPERVISOR_ONBOARD_SCRATCH_ROOT: z.string().min(1).default("/data/onboard"),
    /** Where this runtime's managed-git key lives. Private half, never backed up, never sent (ON16). */
    SUPERVISOR_ONBOARD_GIT_KEY_DIR: z.string().min(1).default("/data/git-keys"),
    /** Repositories in flight during an evidence pass; the host is somebody's laptop. */
    SUPERVISOR_ONBOARD_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(4),
    /** The platform MCP endpoint handed to agents inside `mcpServers` (Core's redeem answers a bearer token, not a URL). */
    SUPERVISOR_PLATFORM_MCP_URL: z.string().url().optional(),
    SUPERVISOR_BROWSER_TOOL_URL: z.string().url().default("http://browser-tool:41850/mcp"),
    /** `agentId=url` pairs for the agent runners this bundle runs. */
    SUPERVISOR_RUNNER_URLS: z.string().default(""),
    SUPERVISOR_BUNDLE_VERSION: z.string().min(1).default("0.1.0"),
    SUPERVISOR_PLATFORM_OS: z.enum(["macos", "windows", "debian"]).default("debian"),
    SUPERVISOR_PLATFORM_ARCH: z.enum(["amd64", "arm64"]).default("amd64"),
    /** Verified release manifest (written by the launcher after verification). */
    SUPERVISOR_RELEASE_MANIFEST_FILE: z.string().min(1).default("/etc/konteks/release-manifest.json"),
    SUPERVISOR_RELEASE_ROOTS_FILE: z.string().min(1).default("/etc/konteks/release-roots.json"),
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

export function parseRunnerUrls(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of value.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    map.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return map;
}
