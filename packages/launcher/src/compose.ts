import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOrCreateSecretFile, runCommand, sha256Hex, writeSecretFile, RemoteInstanceError, type CommandResult } from "@konteks/remote-common";
import { COMPOSE_CONFIG_SCHEMA_VERSION, type ReleaseManifest } from "@konteks/remote-release";
import { COMPOSE_PROJECT_NAME, type InstallPaths } from "./paths.js";

/**
 * Compose orchestration hidden behind the CLI. The versioned template ships
 * with the launcher (its digest is pinned in the signed release manifest);
 * the launcher renders a `.env` from the verified manifest (image digests,
 * bridge digests, agent set, auth modes, platform) and drives `docker
 * compose` with a fixed project name. A raw Compose file is an implementation
 * detail, never the customer-facing product.
 *
 * Agent runners are selected through Compose profiles: `runner-<agent>` for
 * `agent_local_subscription` (direct egress) and `runner-<agent>-keyed` for
 * `gateway_keyed` (control + keyed networks only, so the gateway is the sole
 * provider route). Both answer as `runner-<agent>` on the control network.
 */
export type AgentAuthMode = "agent_local_subscription" | "gateway_keyed";

export interface AgentSelection {
  agentId: string;
  authMode: AgentAuthMode;
}

export interface ComposeRenderInputs {
  release: ReleaseManifest;
  paths: InstallPaths;
  coreUrl: string;
  relayUrl: string | null;
  agents: AgentSelection[];
  platform: { os: string; architecture: string };
  bundleVersion: string;
  controlPort?: number;
}

export function composeTemplatePath(): string {
  // esbuild maps import.meta.url to __filename in the native CommonJS bundle.
  // Repository ESM builds retain a file URL. Accept both representations so
  // this helper remains valid outside the embedded-template release path.
  const modulePath = import.meta.url.startsWith("file:") ? fileURLToPath(import.meta.url) : import.meta.url;
  return join(dirname(modulePath), "..", "..", "..", "compose", "compose.template.yaml");
}

export function imageRef(release: ReleaseManifest, component: ReleaseManifest["images"][number]["component"]): string {
  const image = release.images.find((candidate) => candidate.component === component);
  if (!image) throw new RemoteInstanceError("bundle_untrusted", `release manifest has no image for ${component}`);
  return `${image.ref}@${image.digest}`;
}

function envKey(agentId: string): string {
  return agentId.toUpperCase().replace(/-/g, "_");
}

/** The Compose service that runs an agent under a given auth mode. */
export function runnerService(agentId: string, authMode: AgentAuthMode): string {
  return authMode === "gateway_keyed" ? `runner-${agentId}-keyed` : `runner-${agentId}`;
}

/** The Compose profile that enables `runnerService(agentId, authMode)`. */
export function runnerProfile(agentId: string, authMode: AgentAuthMode): string {
  return authMode === "gateway_keyed" ? `runner-${agentId}-keyed` : `runner-${agentId}-subscription`;
}

/** Renders the `.env` Compose reads. Every image is `ref@sha256:…`; no tag is ever used. */
export function renderComposeEnv(inputs: ComposeRenderInputs): string {
  const { release } = inputs;
  const lines: string[] = [
    `KONTEKS_COMPOSE_CONFIG_SCHEMA=${COMPOSE_CONFIG_SCHEMA_VERSION}`,
    `KONTEKS_BUNDLE_VERSION=${inputs.bundleVersion}`,
    `KONTEKS_PLATFORM_OS=${inputs.platform.os}`,
    `KONTEKS_PLATFORM_ARCH=${inputs.platform.architecture}`,
    `KONTEKS_CORE_URL=${inputs.coreUrl}`,
    `KONTEKS_RELAY_URL=${inputs.relayUrl ?? ""}`,
    `KONTEKS_ROOT=${inputs.paths.root}`,
    `KONTEKS_STORES_DIR=${inputs.paths.stores}`,
    `KONTEKS_CONTROL_PORT=${inputs.controlPort ?? 41800}`,
    `KONTEKS_SUPERVISOR_IMAGE=${imageRef(release, "supervisor")}`,
    `KONTEKS_GATEWAY_IMAGE=${imageRef(release, "gateway")}`,
    `KONTEKS_BROWSER_TOOL_IMAGE=${imageRef(release, "browser-tool")}`,
    `KONTEKS_PREVIEW_FORWARDER_IMAGE=${imageRef(release, "preview-forwarder")}`,
    `KONTEKS_SYSMON_IMAGE=${imageRef(release, "sysmon")}`,
    `KONTEKS_HARNESS_IMAGE=${imageRef(release, "harness")}`,
    `KONTEKS_VALIDATION_IMAGE=${imageRef(release, "validation-runtime")}`,
    `KONTEKS_POSTGRES_IMAGE=${imageRef(release, "postgres")}`,
    `KONTEKS_VALKEY_IMAGE=${imageRef(release, "valkey")}`,
    `KONTEKS_EGRESS_ALLOWLIST_REVISION=${release.egressAllowlist.revision}`,
  ];
  // Every bridge the release pins gets its image line so the template
  // interpolates cleanly; profiles decide which runners actually start.
  for (const bridge of release.agentBridges) {
    lines.push(`KONTEKS_RUNNER_${envKey(bridge.agentId)}_IMAGE=${bridge.ref}@${bridge.digest}`);
    lines.push(`KONTEKS_RUNNER_${envKey(bridge.agentId)}_BRIDGE_VERSION=${bridge.version}`);
  }
  const runnerUrls: string[] = [];
  const profiles: string[] = [];
  for (const agent of inputs.agents) {
    if (!release.agentBridges.some((bridge) => bridge.agentId === agent.agentId)) {
      throw new RemoteInstanceError("bundle_untrusted", `release manifest has no bridge for ${agent.agentId}`);
    }
    lines.push(`KONTEKS_RUNNER_${envKey(agent.agentId)}_AUTH_MODE=${agent.authMode}`);
    runnerUrls.push(`${agent.agentId}=http://runner-${agent.agentId}:41840`);
    profiles.push(runnerProfile(agent.agentId, agent.authMode));
  }
  lines.push(`KONTEKS_RUNNER_URLS=${runnerUrls.join(",")}`);
  lines.push(`COMPOSE_PROFILES=${profiles.join(",")}`);
  return `${lines.join("\n")}\n`;
}

/** Unique generated store credentials, written 0600 once and reused across restarts. */
export async function ensureStoreCredentials(paths: InstallPaths): Promise<void> {
  await mkdir(paths.stores, { recursive: true, mode: 0o700 });
  await readOrCreateSecretFile({ bytes: 24, dataDir: paths.stores, encoding: "base64url", fileName: "harness-postgres.password" });
  await readOrCreateSecretFile({ bytes: 24, dataDir: paths.stores, encoding: "base64url", fileName: "validation-postgres.password" });
  await readOrCreateSecretFile({ bytes: 24, dataDir: paths.stores, encoding: "base64url", fileName: "valkey.password" });
}

export async function loadComposeTemplate(path?: string): Promise<{ template: string; digest: string }> {
  // Native releases carry the exact template inside the signed launcher.
  // Repository builds still read it from disk, which keeps local development
  // and digest tests pointed at the canonical source file.
  const embedded = path === undefined ? process.env.KONTEKS_EMBEDDED_COMPOSE_TEMPLATE : undefined;
  const template = embedded ?? (await readFile(path ?? composeTemplatePath(), "utf8"));
  return { template, digest: `sha256:${sha256Hex(template)}` };
}

/**
 * Render the Compose project: the template is copied only after its digest
 * matches the signed release manifest; the `.env` and store credentials are
 * written 0600. Fails closed with `bundle_untrusted` on any mismatch.
 */
export async function renderCompose(inputs: ComposeRenderInputs, templatePath?: string): Promise<{ templateDigest: string }> {
  const { template, digest } = await loadComposeTemplate(templatePath);
  if (digest !== inputs.release.compose.templateDigest) {
    throw new RemoteInstanceError("bundle_untrusted", "the Compose template digest does not match the signed release manifest", { recoveryActions: [{ kind: "update" }] });
  }
  if (inputs.release.compose.configSchemaVersion !== COMPOSE_CONFIG_SCHEMA_VERSION) {
    throw new RemoteInstanceError("bundle_untrusted", "the release manifest names a Compose configuration schema this launcher does not implement", { recoveryActions: [{ kind: "update" }] });
  }
  await mkdir(inputs.paths.composeDir, { recursive: true, mode: 0o700 });
  await writeFile(inputs.paths.composeFile, template, { mode: 0o600 });
  await writeSecretFile(inputs.paths.envFile, renderComposeEnv(inputs));
  await ensureStoreCredentials(inputs.paths);
  return { templateDigest: digest };
}

/** Reads `COMPOSE_PROFILES` back from the rendered `.env` so every Compose invocation selects the same runners. */
export async function readComposeProfiles(paths: InstallPaths): Promise<string[]> {
  try {
    const env = await readFile(paths.envFile, "utf8");
    const line = env.split("\n").find((entry) => entry.startsWith("COMPOSE_PROFILES="));
    return (line?.slice("COMPOSE_PROFILES=".length) ?? "").split(",").filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

export interface ComposeRunner {
  run(args: string[], options?: { timeoutMs?: number }): Promise<CommandResult>;
}

/** Drives `docker compose` with a fixed project name and a minimal, secret-free environment. */
export function createComposeRunner(paths: InstallPaths, run: typeof runCommand = runCommand): ComposeRunner {
  return {
    run: async (args, options) => {
      const profiles = await readComposeProfiles(paths);
      return run({
        command: "docker",
        args: ["compose", "--project-name", COMPOSE_PROJECT_NAME, "--file", paths.composeFile, "--env-file", paths.envFile, ...profiles.flatMap((profile) => ["--profile", profile]), ...args],
        cwd: paths.composeDir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DOCKER_HOST: process.env.DOCKER_HOST ?? "",
          DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? "",
          COMPOSE_DOCKER_CLI_BUILD: "0",
          DOCKER_DEFAULT_PLATFORM: "",
        },
        timeoutMs: options?.timeoutMs ?? 30 * 60_000,
        outputCapBytes: 4 * 1024 * 1024,
      });
    },
  };
}

/** Pull by digest, one service at a time, so an interrupted pull resumes at the next service. */
export async function pullServices(compose: ComposeRunner, services: string[], onPulled: (service: string) => Promise<void>): Promise<void> {
  for (const service of services) {
    const result = await compose.run(["pull", "--quiet", service], { timeoutMs: 60 * 60_000 });
    if (result.code !== 0) throw new RemoteInstanceError("temporarily_unavailable", `image pull failed for ${service}`, { retryable: true, recoveryActions: [{ kind: "retry" }] });
    await onPulled(service);
  }
}

/** Services every bundle runs, in dependency order (stores first). */
export const BUNDLE_SERVICES = Object.freeze(["harness-postgres", "validation-postgres", "valkey", "sysmon", "gateway", "browser-tool", "supervisor", "harness", "validation-runtime", "preview-forwarder"] as const);

/** The declared stop order for an update: components before the supervisor, stores last (they are not restarted). */
export const UPDATE_STOP_ORDER = Object.freeze(["preview-forwarder", "validation-runtime", "harness", "browser-tool", "supervisor", "gateway", "sysmon"] as const);

export function bundleServices(agents: AgentSelection[]): string[] {
  return [...BUNDLE_SERVICES, ...agents.map((agent) => runnerService(agent.agentId, agent.authMode))];
}
