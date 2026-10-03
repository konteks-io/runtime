import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import { isRetiredAgentId } from "@konteks/backstage-plugin-common";
import { RemoteInstanceError } from "@konteks/remote-common";
import { RunnerConfigSchema, type RunnerConfig } from "@konteks/remote-agent-runner";
import { EmbeddedReleaseRootSchema, findAgentBridge, selectNativeArtifacts, verifyNativeRelease, verifyOfflineAgentPackage, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { SupervisorConfigSchema } from "../config.js";
import { IdentitySchema, ManifestRecordSchema } from "../state/store.js";
import { verifyInstalledNativeBridges } from "./installed.js";
import { NativeGitToolSchema, verifyNativeGitTool } from "./git-workspace.js";
import { resolveNativeCodexHome } from "./codex-home.js";
import { resolveNativeClaudeExecutable } from "./claude-executable.js";
import { hostAgentInstallAdapter, nativeAgentOffered } from "./host-agents.js";
import { antigravityUpdateNeeded, updateNativeAntigravity } from "./antigravity-update.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
function endpoint(protocol: "https:" | "wss:") {
  return z.string().max(2048).url().refine(value => {
    const url = new URL(value);
    return url.protocol === protocol && !url.username && !url.password && !url.search && !url.hash;
  });
}

/**
 * The agents a native runtime knows: Claude Code, Codex, the person's own
 * DeepSeek Harness and OpenCode 2, and Google Antigravity, which the
 * connector fetches itself on the person's yes (host-agents.ts, offered since
 * antigravity CP6).
 */
const NATIVE_AGENT_IDS = ["claude-code", "codex", "dsh", "opencode", "antigravity"] as const;

/** Installer-owned metadata, not an environment file or arbitrary process configuration. */
export const NativeRuntimeRecordSchema = z.object({
  schemaVersion: z.literal(1), deploymentKind: z.literal("native_connector"),
  instanceId: identifier, workspaceId: identifier, releaseId: identifier,
  manifestDigest: z.string().min(1).max(128), bundleVersion: z.string().min(1).max(128),
  coreUrl: endpoint("https:"), relayUrl: endpoint("wss:"),
  controlPort: z.number().int().min(1).max(65_535),
  // Zero agents is a machine enrolled from an agent door with nothing
  // detectable yet (OS14); it advertises no roles until one is added.
  agents: z.array(z.enum(NATIVE_AGENT_IDS)).max(NATIVE_AGENT_IDS.length)
    .refine(agents => new Set(agents).size === agents.length),
  git: NativeGitToolSchema.optional(),
  /** Local installer-owned profile binding, never a cloud-provided path. */
  codexHome: z.string().min(1).max(4096).optional(),
  codexSocket: z.string().min(1).max(4096).optional(),
  /** The operator's own installed Claude Code CLI, located at install time. */
  claudeExecutable: z.string().min(1).max(4096).optional(),
  /** The person's own installed DeepSeek Harness package root, located at install time. */
  dshRoot: z.string().min(1).max(4096).optional(),
  /** The person's Node that runs it (the connector cannot run another script). */
  dshNode: z.string().min(1).max(4096).optional(),
  /** The person's own installed OpenCode 2 executable, and the version it had when recorded (re-read on every load). */
  opencodeBinary: z.string().min(1).max(4096).optional(),
  opencodeVersion: z.string().min(1).max(128).optional(),
  /**
   * The Google Antigravity server the connector fetched: the pinned version
   * and its folder under `<root>/agents/antigravity/` (re-verified against
   * the release's pin on every load; never shown on the site or in doctor).
   */
  antigravityVersion: z.string().min(1).max(128).optional(),
  antigravityRoot: z.string().min(1).max(4096).optional(),
}).strict();
export type NativeRuntimeRecord = z.infer<typeof NativeRuntimeRecordSchema>;

/** Short, private per-installation namespace; the official Codex home remains shared. */
export async function resolveNativeCodexSocket(root: string, codexHome: string, requested?: string): Promise<string> {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 20);
  const uid = process.getuid?.() ?? 0;
  const name = `konteks-codex-${uid}-${digest}`;
  let base = await realpath(tmpdir());
  let socket = join(base, name, "s");
  if (Buffer.byteLength(socket) > 96) {
    base = await realpath("/tmp");
    socket = join(base, name, "s");
  }
  if (Buffer.byteLength(socket) > 96) throw invalid();
  // An older record may point at the global Codex socket. Migrate its path
  // without operating on the existing holder. Other short explicit sockets
  // retain their installer-owned path; startup separately proves private
  // directory ownership and rejects a foreign process at that socket.
  if (requested !== undefined) {
    const legacy = join(codexHome, "app-server-control", "app-server-control.sock");
    if (requested !== legacy && requested !== socket) {
      if (!isAbsolute(requested) || resolve(requested) !== requested ||
          /[\p{Cc}\p{Cf}\p{Cs}]/u.test(requested) || Buffer.byteLength(requested) > 96) throw invalid();
      return requested;
    }
  }
  if (socket === join(codexHome, "app-server-control", "app-server-control.sock")) throw invalid();
  return socket;
}

/**
 * Read a stored record. One written before 7.0.0 may still list Pi or the
 * old bundled OpenCode: those agents are not run, so they are dropped (and
 * reported back for a warning) instead of failing the whole installation. A
 * host agent that is not offered is dropped the same way (none today: since
 * opencode-runtime-support CP6 an old record naming `opencode` reads as the
 * person's own OpenCode 2, O13, and Google Antigravity is offered since its
 * CP6). The strict schema refuses a retired id that
 * is not a native agent (Pi); the installer refuses the rest.
 */
export function parseNativeRuntimeRecord(value: unknown): { record: NativeRuntimeRecord; retiredAgents: string[] } {
  const agents = (value as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return { record: NativeRuntimeRecordSchema.parse(value), retiredAgents: [] };
  const known = (agent: string) => (NATIVE_AGENT_IDS as readonly string[]).includes(agent);
  const dropped = (agent: unknown): agent is string => typeof agent === "string"
    && (known(agent) ? !nativeAgentOffered(agent) : isRetiredAgentId(agent));
  const retiredAgents = agents.filter(dropped);
  const kept = agents.filter(agent => !dropped(agent));
  return { record: NativeRuntimeRecordSchema.parse({ ...(value as object), agents: kept }), retiredAgents };
}

export interface NativeInstallationOptions {
  /** Supplied by the verified executable, never discovered in the writable installation. */
  roots: readonly EmbeddedReleaseRoot[];
  platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64" };
  nowMs?: number;
  /** The service environment, for preview tuning only (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Read-only preflight. The supervisor must still acquire ownership and reverify before spawning. */
export async function loadNativeInstallation(root: string, options: NativeInstallationOptions) {
  if (!isAbsolute(root) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(root)) throw invalid();
  root = resolve(root);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  const directories = new Map<string, Stats>();
  const directory = async (path: string) => {
    const info = await lstat(path);
    if (!info.isDirectory() || !privateOwner(info)) throw invalid();
    directories.set(path, info);
  };
  try {
    await directory(root);
    // Canonicalize ancestors (e.g. macOS /var -> /private/var), but never accept a linked root.
    root = await realpath(root);
    const { record, retiredAgents } = parseNativeRuntimeRecord(await readPrivateJson(join(root, "native-runtime.json")));
    if (record.git) await verifyNativeGitTool(record.git);
    const roots = z.array(EmbeddedReleaseRootSchema).parse(options.roots);
    const dataDir = join(root, "supervisor");
    const releaseDir = join(root, "releases", record.releaseId);
    for (const path of [dataDir, join(root, "releases"), releaseDir, join(releaseDir, "agents"), join(root, "credentials"), join(root, "workspaces")]) await directory(path);
    const identity = IdentitySchema.parse(await readPrivateJson(join(dataDir, "identity.json")));
    if (identity.instanceId !== record.instanceId || identity.workspaceId !== record.workspaceId) throw invalid();
    const release = verifyNativeRelease(await readPrivateJson(join(releaseDir, "manifest.json")), roots, options.nowMs);
    const exchangeRecord = ManifestRecordSchema.parse(await readPrivateJson(join(dataDir, "manifest.json")));
    const exchange = verifyNativeRelease(exchangeRecord.manifest, roots, options.nowMs);
    // Activation provenance remains immutable. A later installed release may
    // differ, but both manifests must independently verify against the roots
    // embedded in the connector executable.
    if (release.manifest.digest !== record.manifestDigest) throw invalid();
    if (exchangeRecord.manifestDigest !== exchange.manifest.digest) throw invalid();
    if (release.manifest.bundleVersion !== record.bundleVersion) throw invalid();
    const runners = [];
    const unavailableAgents: NativeUnavailableAgent[] = [];
    // A host-installed agent (the person's own DeepSeek Harness or OpenCode)
    // has no signed artifact: its adapter re-locates and re-verifies it here
    // on every load instead. One the person removed or moved out of the
    // supported range is left out (and retried by the supervisor), never a
    // reason to stop the other agents.
    const bundled = record.agents.filter(agent => findAgentBridge(agent)?.hostInstall === undefined);
    const artifacts = selectNativeArtifacts(release, { ...options.platform, agentIds: bundled });
    for (const agent of record.agents) {
      if (!bundled.includes(agent)) {
        const host = hostAgentInstallAdapter(agent);
        if (!host) throw invalid();
        const credentials = join(root, "credentials", agent);
        const workspace = join(root, "workspaces", agent);
        for (const path of [credentials, workspace]) await directory(path);
        const canonicalRoot = root;
        try {
          runners.push(await nativeHostRunnerConfig(canonicalRoot, record, agent));
        } catch (error) {
          if (!hostAgentUnavailable(error)) throw error;
          if (agent === "antigravity") {
            // Google Antigravity (A17): a record naming another version (a
            // runtime update carried a new pin) or a copy gone missing is
            // fetched again on the person's first yes, checked, and switched
            // to; the retry does it, at once. Anything else waits for them.
            const entry: NativeUnavailableAgent = {
              agentId: agent, error,
              relocate: () => nativeHostRunnerConfig(canonicalRoot, record, agent),
              fetched: { ...(record.antigravityVersion === undefined ? {} : { antigravityVersion: record.antigravityVersion }), ...(record.antigravityRoot === undefined ? {} : { antigravityRoot: record.antigravityRoot }) },
            };
            if (antigravityUpdateNeeded(record, error)) {
              entry.updating = true;
              entry.relocate = async () => {
                const updated = await updateNativeAntigravity(canonicalRoot, record, { selfCheck: config => host.selfCheck(config) });
                entry.fetched = updated.fetched;
                return updated.config;
              };
            }
            unavailableAgents.push(entry);
            continue;
          }
          unavailableAgents.push({ agentId: agent, error, relocate: () => nativeHostRunnerConfig(canonicalRoot, record, agent) });
        }
        continue;
      }
      const prefix = join(releaseDir, "agents", agent);
      const credentials = join(root, "credentials", agent);
      const workspace = join(root, "workspaces", agent);
      for (const path of [prefix, credentials, workspace]) await directory(path);
      const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
      const profile = await verifyOfflineAgentPackage(prefix, artifact);
      const codexHome = agent === "codex" ? await resolveNativeCodexHome(record.codexHome === undefined ? process.env : { CODEX_HOME: record.codexHome }) : undefined;
      const claudeExecutable = agent === "claude-code" ? await resolveNativeClaudeExecutable(record.claudeExecutable === undefined ? process.env : { CLAUDE_CODE_EXECUTABLE: record.claudeExecutable }) : undefined;
      runners.push(RunnerConfigSchema.parse({
        RUNNER_AGENT_ID: agent, RUNNER_AUTH_MODE: "agent_local_subscription",
        RUNNER_CREDENTIAL_DIR: credentials, RUNNER_WORKSPACE_DIR: workspace,
        ...(codexHome ? { RUNNER_NATIVE_CODEX_HOME: codexHome } : {}),
        ...(claudeExecutable ? { RUNNER_NATIVE_CLAUDE_EXECUTABLE: claudeExecutable } : {}),
        // The supervisor owns this shared service lifecycle. Its default socket
        // is per connector; only the official CODEX_HOME remains shared.
        ...(codexHome && profile.codexLocalProxy ? { RUNNER_NATIVE_CODEX_SOCKET: await resolveNativeCodexSocket(root, codexHome, record.codexSocket) } : {}),
        RUNNER_BRIDGE_PREFIX: prefix, RUNNER_BRIDGE_VERSION: profile.bridge.version,
        RUNNER_NATIVE_PACKAGE_PROFILE: profile, RUNNER_NATIVE_PACKAGE_ARTIFACT: artifact,
      }));
    }
    const bundledRunners = runners.filter(runner => bundled.includes(runner.RUNNER_AGENT_ID));
    if (bundledRunners.length > 0 || bundled.length === record.agents.length) await verifyInstalledNativeBridges(release, bundledRunners, options.platform);
    for (const [path, before] of directories) {
      const after = await lstat(path);
      if (!after.isDirectory() || !privateOwner(after) || !sameFile(before, after)) throw invalid();
    }
    const config = SupervisorConfigSchema.parse({
      SUPERVISOR_DEPLOYMENT_KIND: "native_connector", SUPERVISOR_DATA_DIR: dataDir,
      SUPERVISOR_CORE_URL: record.coreUrl, SUPERVISOR_RELAY_URL: record.relayUrl,
      SUPERVISOR_CONTROL_PORT: record.controlPort, SUPERVISOR_BUNDLE_VERSION: record.bundleVersion,
      SUPERVISOR_PLATFORM_OS: options.platform.os, SUPERVISOR_PLATFORM_ARCH: options.platform.architecture,
      SUPERVISOR_RELEASE_MANIFEST_FILE: join(releaseDir, "manifest.json"),
      // The managed-git key lives in this runtime's private data, not at the
      // container default `/data/git-keys`, which a laptop does not have: key
      // registration failed there and onboarding could never push (WS1-024).
      SUPERVISOR_ONBOARD_GIT_KEY_DIR: join(dataDir, "git-keys"),
      // Same for the evidence collector's scratch: `/data/onboard` does not
      // exist on a laptop, so every grouping read failed with ENOENT.
      SUPERVISOR_ONBOARD_SCRATCH_ROOT: join(dataDir, "onboard"),
      // Preview tuning is the only setting read from the service environment,
      // and only a valid whole number is taken; anything else keeps the default.
      ...previewTuning(options.env ?? process.env),
    });
    return { record, config, runners, roots, release, retiredAgents, unavailableAgents };
  } catch (error) {
    if (error instanceof RemoteInstanceError) throw error;
    throw invalid();
  }
}

/** The stored runtime record of `root` (private, checked like every load), without loading the release. */
export async function readNativeRuntimeRecord(root: string): Promise<NativeRuntimeRecord> {
  try {
    return parseNativeRuntimeRecord(await readPrivateJson(join(root, "native-runtime.json"))).record;
  } catch (error) {
    if (error instanceof RemoteInstanceError) throw error;
    throw invalid();
  }
}

/** A listed host agent the load could not find or verify; `relocate` tries again (supervisor retry). */
export interface NativeUnavailableAgent {
  agentId: string;
  error: RemoteInstanceError;
  relocate: () => Promise<RunnerConfig>;
  /** Google Antigravity: the copy the install record names (its download state reads it); the new copy once an update switched to it. */
  fetched?: Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot">;
  /** Google Antigravity: `relocate` fetches this release's pin (A17), so the retry starts at once. */
  updating?: boolean;
}

/** The locators' refusals (not found, unsupported version, unsafe install): the person can fix these, the connector runs on. */
function hostAgentUnavailable(error: unknown): error is RemoteInstanceError {
  return error instanceof RemoteInstanceError && error.code === "prerequisite_missing";
}

/**
 * A host agent's runner configuration from the record: its private folders
 * (checked again) and the settings its adapter re-locates and re-verifies.
 */
export async function nativeHostRunnerConfig(root: string, record: NativeRuntimeRecord, agent: string): Promise<RunnerConfig> {
  const host = hostAgentInstallAdapter(agent);
  if (!host || !record.agents.includes(agent as NativeRuntimeRecord["agents"][number])) throw invalid();
  const credentials = join(root, "credentials", agent);
  const workspace = join(root, "workspaces", agent);
  for (const path of [credentials, workspace]) {
    const info = await lstat(path);
    if (!info.isDirectory() || !privateOwner(info)) throw invalid();
  }
  return RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: agent, RUNNER_AUTH_MODE: "agent_local_subscription",
    RUNNER_CREDENTIAL_DIR: credentials, RUNNER_WORKSPACE_DIR: workspace,
    ...await host.runnerSettings(record, { root }),
  });
}

/** `SUPERVISOR_PREVIEW_IDLE_MINUTES` (1–1440) and `SUPERVISOR_PREVIEW_MAX_RUNNING` (1–16), when valid. */
export function previewTuning(env: NodeJS.ProcessEnv): { SUPERVISOR_PREVIEW_IDLE_MINUTES?: number; SUPERVISOR_PREVIEW_MAX_RUNNING?: number } {
  const whole = (value: string | undefined, max: number): number | undefined => {
    if (value === undefined || !/^\d{1,5}$/.test(value.trim())) return undefined;
    const parsed = Number(value.trim());
    return parsed >= 1 && parsed <= max ? parsed : undefined;
  };
  const idle = whole(env.SUPERVISOR_PREVIEW_IDLE_MINUTES, 24 * 60);
  const running = whole(env.SUPERVISOR_PREVIEW_MAX_RUNNING, 16);
  return { ...(idle === undefined ? {} : { SUPERVISOR_PREVIEW_IDLE_MINUTES: idle }), ...(running === undefined ? {} : { SUPERVISOR_PREVIEW_MAX_RUNNING: running }) };
}

function privateOwner(info: Stats): boolean {
  return process.platform === "win32" || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.());
}
function sameFile(a: Stats, b: Stats): boolean { return a.ino === b.ino && a.dev === b.dev; }
function invalid() { return new RemoteInstanceError("install_state_corrupt", "Native installation metadata or private paths are invalid; repair the installation before starting."); }

async function readPrivateJson(path: string): Promise<unknown> {
  const before = await lstat(path);
  const limit = 1024 * 1024;
  if (!before.isFile() || before.nlink !== 1 || !privateOwner(before) || before.size > limit) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened) || opened.size !== before.size) throw invalid();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit || size > before.size) throw invalid();
      chunks.push(chunk);
    }
    const after = await handle.stat();
    const named = await lstat(path);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !sameFile(before, named) || named.nlink !== 1 || !privateOwner(named)) throw invalid();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await handle.close(); }
}
