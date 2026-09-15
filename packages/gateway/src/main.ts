import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createLogger } from "@konteks/remote-common";
import { startGatewayAdmin, type GatewayAdminState } from "./admin.js";
import { EgressAllowlistIndex, EgressAllowlistSchema } from "./allowlist.js";
import { AssignmentRegistry } from "./caps.js";
import { KeyVault } from "./keys.js";
import { SupervisorObservationSink } from "./observation.js";
import { startGatewayProxy, type GatewayProxy } from "./proxy.js";

const EnvSchema = z.object({
  GATEWAY_PROXY_PORT: z.coerce.number().int().default(41810),
  GATEWAY_ADMIN_PORT: z.coerce.number().int().default(41811),
  GATEWAY_ALLOWLIST_FILE: z.string().min(1).default("/etc/konteks/egress-allowlist.json"),
  GATEWAY_INSTANCE_ID_FILE: z.string().min(1).default("/etc/konteks/instance-id"),
  GATEWAY_SUPERVISOR_URL: z.string().url().default("http://supervisor:41820"),
  GATEWAY_VERSION: z.string().min(1).default("0.1.0"),
});

async function main(): Promise<void> {
  const logger = createLogger({ name: "gateway" });
  const env = EnvSchema.parse(process.env);
  // The allowlist file is the verified release manifest's `egressAllowlist`,
  // written by the launcher into the gateway's read-only config volume. The
  // gateway has no key on disk anywhere; this volume holds configuration only.
  const allowlist = new EgressAllowlistIndex(EgressAllowlistSchema.parse(JSON.parse(await readFile(env.GATEWAY_ALLOWLIST_FILE, "utf8"))));
  let instanceId = "";
  const readInstanceId = async (): Promise<void> => {
    try {
      instanceId = (await readFile(env.GATEWAY_INSTANCE_ID_FILE, "utf8")).trim();
    } catch {
      instanceId = "";
    }
  };
  await readInstanceId();

  const keys = new KeyVault();
  const assignments = new AssignmentRegistry();
  const sink = new SupervisorObservationSink({ supervisorUrl: env.GATEWAY_SUPERVISOR_URL });
  const state: GatewayAdminState = { stage: "observe", configRevisionApplied: null };
  let proxy: GatewayProxy | null = null;
  await startGatewayAdmin({
    port: env.GATEWAY_ADMIN_PORT,
    version: env.GATEWAY_VERSION,
    keys,
    assignments,
    allowlist,
    state,
    sink,
    proxy: () => proxy,
  });
  proxy = await startGatewayProxy({
    port: env.GATEWAY_PROXY_PORT,
    instanceId: () => instanceId,
    allowlist,
    keys,
    assignments,
    stage: () => state.stage,
    sink,
  });
  const refresh = setInterval(() => void readInstanceId(), 30_000);
  refresh.unref();
  const shutdown = (): void => {
    keys.clearAll();
    proxy?.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  logger.info({ dialects: allowlist.providers(), allowlistRevision: allowlist.revision }, "gateway started");
}

main().catch((error: unknown) => {
  process.stderr.write(`gateway failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
