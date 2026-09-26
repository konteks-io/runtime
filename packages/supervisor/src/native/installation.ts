import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import { isRetiredAgentId } from "@konteks/backstage-plugin-common";
import { RemoteInstanceError } from "@konteks/remote-common";
import { RunnerConfigSchema } from "@konteks/remote-agent-runner";
import { EmbeddedReleaseRootSchema, findAgentBridge, selectNativeArtifacts, verifyNativeRelease, verifyOfflineAgentPackage, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { SupervisorConfigSchema } from "../config.js";
import { IdentitySchema, ManifestRecordSchema } from "../state/store.js";
import { verifyInstalledNativeBridges } from "./installed.js";
import { NativeGitToolSchema, verifyNativeGitTool } from "./git-workspace.js";
import { resolveNativeCodexHome } from "./codex-home.js";
import { resolveNativeClaudeExecutable } from "./claude-executable.js";
import { resolveNativeDshInstallation, resolveNativeDshNode, verifyNativeDshRoot } from "./dsh-installation.js";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
function endpoint(protocol: "https:" | "wss:") {
  return z.string().max(2048).url().refine(value => {
    const url = new URL(value);
    return url.protocol === protocol && !url.username && !url.password && !url.search && !url.hash;
  });
}

/** The agents a native runtime runs: Claude Code, Codex and the person's own DeepSeek Harness. */
export const NATIVE_AGENT_IDS = ["claude-code", "codex", "dsh"] as const;

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
}).strict();
export type NativeRuntimeRecord = z.infer<typeof NativeRuntimeRecordSchema>;

/**
 * Read a stored record. One written before 7.0.0 may still list Pi or
 * OpenCode: those agents are no longer run, so they are dropped (and reported
 * back for a warning) instead of failing the whole installation. Every write
 * still goes through the strict schema, which refuses them.
 */
export function parseNativeRuntimeRecord(value: unknown): { record: NativeRuntimeRecord; retiredAgents: string[] } {
  const agents = (value as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return { record: NativeRuntimeRecordSchema.parse(value), retiredAgents: [] };
  const retiredAgents = agents.filter((agent): agent is string => typeof agent === "string" && isRetiredAgentId(agent));
  const kept = agents.filter(agent => !(typeof agent === "string" && isRetiredAgentId(agent)));
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
    // A host-installed agent (the person's own DeepSeek Harness) has no signed
    // artifact: it is re-located and re-verified here on every load instead.
    const bundled = record.agents.filter(agent => findAgentBridge(agent)?.hostInstall === undefined);
    const artifacts = selectNativeArtifacts(release, { ...options.platform, agentIds: bundled });
    for (const agent of record.agents) {
      if (!bundled.includes(agent)) {
        const credentials = join(root, "credentials", agent);
        const workspace = join(root, "workspaces", agent);
        for (const path of [credentials, workspace]) await directory(path);
        const dsh = record.dshRoot === undefined ? await resolveNativeDshInstallation() : await verifyNativeDshRoot(record.dshRoot);
        const node = await resolveNativeDshNode(dsh, record.dshNode === undefined ? process.env : { DSH_NODE: record.dshNode });
        runners.push(RunnerConfigSchema.parse({
          RUNNER_AGENT_ID: agent, RUNNER_AUTH_MODE: "agent_local_subscription",
          RUNNER_CREDENTIAL_DIR: credentials, RUNNER_WORKSPACE_DIR: workspace,
          RUNNER_NATIVE_DSH_ROOT: dsh.root, RUNNER_NATIVE_DSH_ENTRY: dsh.entry, RUNNER_NATIVE_DSH_NODE: node,
          RUNNER_BRIDGE_PREFIX: dsh.root, RUNNER_BRIDGE_VERSION: dsh.version,
        }));
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
        // The supervisor owns this shared service lifecycle. The path remains
        // under the operator's local profile and is never cloud supplied.
        ...(codexHome && profile.codexLocalProxy ? { RUNNER_NATIVE_CODEX_SOCKET: record.codexSocket ?? join(codexHome, "app-server-control", "app-server-control.sock") } : {}),
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
    return { record, config, runners, roots, release, retiredAgents };
  } catch (error) {
    if (error instanceof RemoteInstanceError) throw error;
    throw invalid();
  }
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
