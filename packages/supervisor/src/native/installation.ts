import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { z } from "zod";
import { isRetiredAgentId } from "@konteks/backstage-plugin-common";
import { RemoteInstanceError } from "@konteks/remote-common";
import { RunnerConfigSchema, type RunnerConfig } from "@konteks/remote-agent-runner";
import { EmbeddedReleaseRootSchema, findAgentBridge, selectNativeArtifacts, verifyNativeRelease, verifyOfflineAgentPackage, type EmbeddedReleaseRoot, type VerifiedNativeRelease } from "@konteks/remote-release";
import { SupervisorConfigSchema } from "../config.js";
import { IdentitySchema, ManifestRecordSchema } from "../state/store.js";
import { verifyInstalledNativeBridges } from "./installed.js";
import { NativeGitToolSchema, verifyNativeGitTool } from "./git-workspace.js";
import { resolveNativeCodexHome } from "./codex-home.js";
import { resolveNativeClaudeExecutable } from "./claude-executable.js";
import { hostAgentInstallAdapter, nativeAgentOffered } from "./host-agents.js";
import { antigravityUpdateNeeded, updateNativeAntigravity } from "./antigravity-update.js";
import { plainAbsolutePath } from "./host-files.js";

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
 * connector fetches itself on the person's yes (host-agents.ts).
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
  // detectable yet; it advertises no roles until one is added.
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
  const socket = await defaultCodexSocket(root);
  const legacy = join(codexHome, "app-server-control", "app-server-control.sock");
  // An older record may point at the global Codex socket. Migrate its path
  // without operating on the existing holder. Other short explicit sockets
  // retain their installer-owned path; startup separately proves private
  // directory ownership and rejects a foreign process at that socket.
  if (requested !== undefined && requested !== legacy && requested !== socket) return explicitSocket(requested);
  if (socket === legacy) throw invalid();
  return socket;
}

/** `<tmp>/konteks-codex-<uid>-<root digest>/s`, under /tmp when the temporary folder's path is too long for a socket. */
async function defaultCodexSocket(root: string): Promise<string> {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 20);
  const name = `konteks-codex-${process.getuid?.() ?? 0}-${digest}`;
  let socket = join(await realpath(tmpdir()), name, "s");
  if (Buffer.byteLength(socket) > 96) socket = join(await realpath("/tmp"), name, "s");
  if (Buffer.byteLength(socket) > 96) throw invalid();
  return socket;
}

function explicitSocket(requested: string): string {
  if (!plainAbsolutePath(requested) || resolve(requested) !== requested || Buffer.byteLength(requested) > 96) throw invalid();
  return requested;
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
  if (!plainAbsolutePath(root)) throw invalid();
  const resolved = resolve(root);
  if (resolved === parse(resolved).root || resolved === resolve(homedir())) throw invalid();
  try {
    return await new InstallationLoader(options).load(resolved);
  } catch (error) {
    if (error instanceof RemoteInstanceError) throw error;
    throw invalid();
  }
}

type NativeRunnerConfig = ReturnType<typeof RunnerConfigSchema.parse>;
type NativeArtifacts = ReturnType<typeof selectNativeArtifacts>;
type HostAdapter = NonNullable<ReturnType<typeof hostAgentInstallAdapter>>;

/** One load: every private directory it checked is checked again, unchanged, before the configuration is returned. */
class InstallationLoader {
  private readonly directories = new Map<string, Stats>();

  constructor(private readonly options: NativeInstallationOptions) {}

  async load(start: string) {
    await this.directory(start);
    // Canonicalize ancestors (e.g. macOS /var -> /private/var), but never accept a linked root.
    const root = await realpath(start);
    const { record, retiredAgents } = parseNativeRuntimeRecord(await readPrivateJson(join(root, "native-runtime.json")));
    if (record.git) await verifyNativeGitTool(record.git);
    const roots = z.array(EmbeddedReleaseRootSchema).parse(this.options.roots);
    const dataDir = join(root, "supervisor");
    const releaseDir = join(root, "releases", record.releaseId);
    for (const path of [dataDir, join(root, "releases"), releaseDir, join(releaseDir, "agents"), join(root, "credentials"), join(root, "workspaces")]) await this.directory(path);
    const release = await verifiedRelease(record, dataDir, releaseDir, roots, this.options.nowMs);
    const { runners, unavailableAgents } = await this.agentRunners(root, record, release, releaseDir);
    await this.assertDirectoriesUnchanged();
    const config = supervisorConfig(record, dataDir, releaseDir, this.options);
    return { record, config, runners, roots, release, retiredAgents, unavailableAgents };
  }

  private async directory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || !privateOwner(info)) throw invalid();
    this.directories.set(path, info);
  }

  /**
   * A host-installed agent (the person's own DeepSeek Harness or OpenCode)
   * has no signed artifact: its adapter re-locates and re-verifies it here
   * on every load instead. One the person removed or moved out of the
   * supported range is left out (and retried by the supervisor), never a
   * reason to stop the other agents.
   */
  private async agentRunners(root: string, record: NativeRuntimeRecord, release: VerifiedNativeRelease, releaseDir: string) {
    const runners: NativeRunnerConfig[] = [];
    const unavailableAgents: NativeUnavailableAgent[] = [];
    const bundled = record.agents.filter(agent => findAgentBridge(agent)?.hostInstall === undefined);
    const artifacts = selectNativeArtifacts(release, { ...this.options.platform, agentIds: bundled });
    for (const agent of record.agents) {
      if (bundled.includes(agent)) runners.push(await this.bundledRunner(root, record, releaseDir, agent, artifacts));
      else await this.hostRunner(root, record, agent, { runners, unavailableAgents });
    }
    const bundledRunners = runners.filter(runner => bundled.includes(runner.RUNNER_AGENT_ID as NativeRuntimeRecord["agents"][number]));
    if (bundledRunners.length > 0 || bundled.length === record.agents.length) await verifyInstalledNativeBridges(release, bundledRunners, this.options.platform);
    return { runners, unavailableAgents };
  }

  private async hostRunner(root: string, record: NativeRuntimeRecord, agent: string, found: { runners: NativeRunnerConfig[]; unavailableAgents: NativeUnavailableAgent[] }): Promise<void> {
    const host = hostAgentInstallAdapter(agent);
    if (!host) throw invalid();
    for (const path of [join(root, "credentials", agent), join(root, "workspaces", agent)]) await this.directory(path);
    try {
      found.runners.push(await nativeHostRunnerConfig(root, record, agent));
    } catch (error) {
      if (!hostAgentUnavailable(error)) throw error;
      found.unavailableAgents.push(agent === "antigravity"
        ? antigravityUnavailable(root, record, error, host)
        : { agentId: agent, error, relocate: () => nativeHostRunnerConfig(root, record, agent) });
    }
  }

  private async bundledRunner(root: string, record: NativeRuntimeRecord, releaseDir: string, agent: string, artifacts: NativeArtifacts): Promise<NativeRunnerConfig> {
    const prefix = join(releaseDir, "agents", agent);
    const credentials = join(root, "credentials", agent);
    const workspace = join(root, "workspaces", agent);
    for (const path of [prefix, credentials, workspace]) await this.directory(path);
    const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
    const profile = await verifyOfflineAgentPackage(prefix, artifact);
    const { codexHome, claudeExecutable } = await agentExecutables(agent, record);
    return RunnerConfigSchema.parse({
      RUNNER_AGENT_ID: agent, RUNNER_AUTH_MODE: "agent_local_subscription",
      RUNNER_CREDENTIAL_DIR: credentials, RUNNER_WORKSPACE_DIR: workspace,
      ...(codexHome ? { RUNNER_NATIVE_CODEX_HOME: codexHome } : {}),
      ...(claudeExecutable ? { RUNNER_NATIVE_CLAUDE_EXECUTABLE: claudeExecutable } : {}),
      // The supervisor owns this shared service lifecycle. Its default socket
      // is per connector; only the official CODEX_HOME remains shared.
      ...await codexSocketSetting(root, codexHome, profile.codexLocalProxy, record.codexSocket),
      RUNNER_BRIDGE_PREFIX: prefix, RUNNER_BRIDGE_VERSION: profile.bridge.version,
      RUNNER_NATIVE_PACKAGE_PROFILE: profile, RUNNER_NATIVE_PACKAGE_ARTIFACT: artifact,
    });
  }

  private async assertDirectoriesUnchanged(): Promise<void> {
    for (const [path, before] of this.directories) {
      const after = await lstat(path);
      if (!after.isDirectory() || !privateOwner(after) || !sameFile(before, after)) throw invalid();
    }
  }
}

/**
 * The installed release, verified against the embedded roots. Activation
 * provenance remains immutable: a later installed release may differ, but
 * both manifests must independently verify against the roots embedded in the
 * connector executable.
 */
async function verifiedRelease(record: NativeRuntimeRecord, dataDir: string, releaseDir: string, roots: EmbeddedReleaseRoot[], nowMs: number | undefined): Promise<VerifiedNativeRelease> {
  const identity = IdentitySchema.parse(await readPrivateJson(join(dataDir, "identity.json")));
  if (identity.instanceId !== record.instanceId || identity.workspaceId !== record.workspaceId) throw invalid();
  const release = verifyNativeRelease(await readPrivateJson(join(releaseDir, "manifest.json")), roots, nowMs);
  const exchangeRecord = ManifestRecordSchema.parse(await readPrivateJson(join(dataDir, "manifest.json")));
  const exchange = verifyNativeRelease(exchangeRecord.manifest, roots, nowMs);
  if (release.manifest.digest !== record.manifestDigest) throw invalid();
  if (exchangeRecord.manifestDigest !== exchange.manifest.digest) throw invalid();
  if (release.manifest.bundleVersion !== record.bundleVersion) throw invalid();
  return release;
}

/**
 * Google Antigravity: a record naming another version (a runtime update
 * carried a new pin) or a copy gone missing is fetched again on the person's
 * first yes, checked, and switched to; the retry does it, at once. Anything
 * else waits for them.
 */
function antigravityUnavailable(root: string, record: NativeRuntimeRecord, error: RemoteInstanceError, host: HostAdapter): NativeUnavailableAgent {
  const entry: NativeUnavailableAgent = {
    agentId: "antigravity", error,
    relocate: () => nativeHostRunnerConfig(root, record, "antigravity"),
    fetched: { ...(record.antigravityVersion === undefined ? {} : { antigravityVersion: record.antigravityVersion }), ...(record.antigravityRoot === undefined ? {} : { antigravityRoot: record.antigravityRoot }) },
  };
  if (antigravityUpdateNeeded(record, error)) {
    entry.updating = true;
    entry.relocate = async () => {
      const updated = await updateNativeAntigravity(root, record, { selfCheck: config => host.selfCheck(config) });
      entry.fetched = updated.fetched;
      return updated.config;
    };
  }
  return entry;
}

/** Codex's home and Claude Code's executable, located again from the record for the agent that needs one. */
async function agentExecutables(agent: string, record: NativeRuntimeRecord): Promise<{ codexHome: string | undefined; claudeExecutable: string | undefined }> {
  const codexHome = agent === "codex" ? await resolveNativeCodexHome(record.codexHome === undefined ? process.env : { CODEX_HOME: record.codexHome }) : undefined;
  const claudeExecutable = agent === "claude-code" ? await resolveNativeClaudeExecutable(record.claudeExecutable === undefined ? process.env : { CLAUDE_CODE_EXECUTABLE: record.claudeExecutable }) : undefined;
  return { codexHome, claudeExecutable };
}

async function codexSocketSetting(root: string, codexHome: string | undefined, localProxy: unknown, requested: string | undefined): Promise<{ RUNNER_NATIVE_CODEX_SOCKET?: string }> {
  if (!codexHome || !localProxy) return {};
  return { RUNNER_NATIVE_CODEX_SOCKET: await resolveNativeCodexSocket(root, codexHome, requested) };
}

function supervisorConfig(record: NativeRuntimeRecord, dataDir: string, releaseDir: string, options: NativeInstallationOptions) {
  return SupervisorConfigSchema.parse({
    SUPERVISOR_DEPLOYMENT_KIND: "native_connector", SUPERVISOR_DATA_DIR: dataDir,
    SUPERVISOR_CORE_URL: record.coreUrl, SUPERVISOR_RELAY_URL: record.relayUrl,
    SUPERVISOR_CONTROL_PORT: record.controlPort, SUPERVISOR_BUNDLE_VERSION: record.bundleVersion,
    SUPERVISOR_PLATFORM_OS: options.platform.os, SUPERVISOR_PLATFORM_ARCH: options.platform.architecture,
    SUPERVISOR_RELEASE_MANIFEST_FILE: join(releaseDir, "manifest.json"),
    // The managed-git key lives in this runtime's private data, not at the
    // container default `/data/git-keys`, which a laptop does not have.
    SUPERVISOR_ONBOARD_GIT_KEY_DIR: join(dataDir, "git-keys"),
    // Same for the evidence collector's scratch: `/data/onboard` does not
    // exist on a laptop.
    SUPERVISOR_ONBOARD_SCRATCH_ROOT: join(dataDir, "onboard"),
    // Preview tuning is the only setting read from the service environment,
    // and only a valid whole number is taken; anything else keeps the default.
    ...previewTuning(options.env ?? process.env),
  });
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
  /** Google Antigravity: `relocate` fetches this release's pin, so the retry starts at once. */
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
  if (!privateRecordFile(before)) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened) || opened.size !== before.size) throw invalid();
    const bytes = await readBounded(handle, before.size);
    const after = await handle.stat();
    const named = await lstat(path);
    if (!readUnchanged(before, after, named, bytes.length)) throw invalid();
    return JSON.parse(bytes.toString("utf8"));
  } finally { await handle.close(); }
}

const PRIVATE_JSON_LIMIT = 1024 * 1024;

function privateRecordFile(info: Stats): boolean {
  return info.isFile() && info.nlink === 1 && privateOwner(info) && info.size <= PRIVATE_JSON_LIMIT;
}

async function readBounded(handle: FileHandle, size: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let read = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    read += chunk.length;
    if (read > PRIVATE_JSON_LIMIT || read > size) throw invalid();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Every byte read, the file unchanged while it was, and the same private single link still at its path. */
function readUnchanged(before: Stats, after: Stats, named: Stats, read: number): boolean {
  return read === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs &&
    sameFile(before, named) && named.nlink === 1 && privateOwner(named);
}