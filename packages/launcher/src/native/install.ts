import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, parse, resolve } from "node:path";
import { CONTROL_SOCKET_DEFAULT_PORT, findGitForWindows, RemoteInstanceError, SystemClock, writeSecretFile } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, findAgentBridge, installOfflineAgentPackage, isHostAgentId, NATIVE_MANIFEST_URL, selectNativeArtifacts, stageNativeRelease, verifyNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { acquireNativeRootLock, compareSemver, deleteNativeAntigravity, HOST_AGENT_INSTALL_ADAPTERS, hostAgentInstallAdapter, loadNativeInstallation, signOutNativeAntigravity, type HostAgentInstallAdapter, nativeAgentOffered, NativeRuntimeRecordSchema, parseNativeRuntimeRecord, resolveNativeClaudeExecutable, resolveNativeCodexHome, runNativeActivationExchange, SupervisorStore, verifyNativeGitTool, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import { isRetiredAgentId, retiredAgentMessage } from "@konteks/backstage-plugin-common";
import { z } from "zod";
import type { Output } from "../output.js";
import { promptSecret } from "../prompt.js";
import { nativePlatform, type NativePlatform } from "./service.js";
import { releaseStaged, writeStagingProgress } from "./enrollment-staging.js";
import type { FetchConsent } from "./consent.js";

export { NATIVE_MANIFEST_URL };
export interface NativeInstallOptions {
  root: string; activationId: string; coreUrl: string; relayUrl: string;
  agents?: string[]; controlPort?: number; output: Output;
  deps?: {
    roots?: readonly EmbeddedReleaseRoot[]; platform?: NativePlatform;
    manifest?: unknown; fetchFn?: typeof fetch; activate?: typeof runNativeActivationExchange;
    readActivationCode?: () => Promise<string>;
    git?: NativeRuntimeRecord["git"] | null;
    /** A fetched agent's consent line answered (Google Antigravity, A20); without it nothing is downloaded. */
    consent?: FetchConsent;
    /**
     * Without an explicit agent list: Claude Code or Codex, when not found
     * here, offered to the person before the code is asked (D116); true once
     * it is here. Without it the install connects with what it found.
     */
    setupAgent?: (agentId: "claude-code" | "codex") => Promise<boolean>;
  };
}
export interface NativeAgentAddOptions {
  root: string;
  agentId: NativeRuntimeRecord["agents"][number];
  output: Output;
  deps?: {
    roots?: readonly EmbeddedReleaseRoot[];
    platform?: NativePlatform;
    manifest?: unknown;
    fetchFn?: typeof fetch;
  };
}

/** Native activation + immutable release layout. Service registration is a separate phase. */
export async function installNative(options: NativeInstallOptions): Promise<NativeRuntimeRecord> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = resolve(options.root);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  // Validate endpoints/agent selection before any activation or executable download.
  // An operator's explicit list is held to (every agent must be here); without
  // one, the agents are found the way onboarding finds them and none is
  // required (D116, OS14): a computer with nothing installed still connects.
  const explicit = options.agents !== undefined;
  let agents = options.agents ?? [];
  refuseRetiredAgents(agents);
  const draft = NativeRuntimeRecordSchema.parse({ schemaVersion: 1, deploymentKind: "native_connector", instanceId: "pending", workspaceId: "pending", releaseId: "pending", manifestDigest: "pending", bundleVersion: "pending", coreUrl: options.coreUrl, relayUrl: options.relayUrl, agents, controlPort: options.controlPort ?? CONTROL_SOCKET_DEFAULT_PORT });
  await privateDirectory(root);
  const installLockDir = join(root, "installer");
  await privateDirectory(installLockDir);
  const lock = acquireNativeRootLock(installLockDir);
  try {
    const existing = await lstat(join(root, "native-runtime.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      const installation = await loadNativeInstallation(root, { roots, platform });
      const identity = await new SupervisorStore(join(root, "supervisor")).identity();
      if (identity?.activationId !== options.activationId || installation.record.coreUrl !== draft.coreUrl || installation.record.relayUrl !== draft.relayUrl || (explicit && JSON.stringify(installation.record.agents) !== JSON.stringify(agents))) throw invalid();
      if (installation.record.agents.includes("codex") && installation.record.codexHome === undefined) {
        const codexHome = installation.runners.find(runner => runner.RUNNER_AGENT_ID === "codex")?.RUNNER_NATIVE_CODEX_HOME;
        if (!codexHome) throw invalid();
        const bound = NativeRuntimeRecordSchema.parse({ ...installation.record, codexHome });
        lock.assertOwned();
        await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(bound));
        return bound;
      }
      return installation.record;
    }
    if (!explicit) agents = await findOrOfferAgents(root, options.deps?.setupAgent);
    // Resolve before activation: a missing local profile must not consume an
    // activation and leave a partly installed, unstartable connector.
    const codexHome = agents.includes("codex") ? await resolveNativeCodexHome() : undefined;
    const claudeExecutable = agents.includes("claude-code") ? await resolveNativeClaudeExecutable() : undefined;
    // Agents the person installed themselves (DeepSeek Harness, OpenCode 2):
    // located and version-checked now, never downloaded, so an unsupported
    // one (OpenCode 1, say) is refused before an activation is used up. A
    // fetched one (Google Antigravity) is downloaded now on the person's yes
    // to its consent line, for the same reason.
    const hosted = await locateHostAgents(agents, root, options.deps?.consent, options.output);
    const bundled = agents.filter(agent => !isHostAgentId(agent));
    const fetchFn = options.deps?.fetchFn ?? fetch;
    const payload = options.deps?.manifest ?? await fetchNativeManifest(fetchFn);
    const release = verifyNativeRelease(payload, roots);
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: bundled });
    // A bridge without official tooling and a closed dependency tree is not a
    // usable native install. Raw npm archives never trigger registry resolution.
    if (artifacts.some(artifact => artifact.kind === "connector" ? artifact.format !== "executable" : artifact.format !== "offline_agent_tgz")) throw new RemoteInstanceError("bundle_untrusted", "Native agents require a complete signed offline package with official login tooling.");
    // The native enrollment owner exclusively creates supervisor; precreating
    // it would erase the distinction between new enrollment and legacy history.
    for (const dir of ["releases", "credentials", "workspaces", "logs"]) await privateDirectory(join(root, dir));
    options.output.line("Connecting this computer to Konteks. Type the one-time code from the site.");
    const activated = await (options.deps?.activate ?? runNativeActivationExchange)({ dataDir: join(root, "supervisor"), coreUrl: draft.coreUrl, activationId: options.activationId, platform, release, roots, clock: new SystemClock(), readActivationCode: options.deps?.readActivationCode ?? (() => promptSecret({ label: "One-time code", minLength: 8 })), fetchFn });
    lock.assertOwned();
    const identity = await new SupervisorStore(join(root, "supervisor")).identity();
    if (!identity || identity.instanceId !== activated.instanceId || activated.manifestDigest !== release.manifest.digest) throw invalid();
    // Unpacking takes about a minute; the person hears each step instead of
    // a silent terminal after the code (W1-M2: 51 s with nothing said).
    options.output.line(bundled.length > 0 ? "Code accepted. Unpacking the agents on this computer; this takes about a minute." : "Code accepted. Setting up Konteks on this computer…");
    const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: bundled }, releasesDir: join(root, "releases"), fetchFn });
    await privateDirectory(join(staged.directory, "agents"));
    let unpacked = 0;
    for (const agent of agents) {
      if (bundled.includes(agent)) {
        const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
        unpacked += 1;
        options.output.line(`Unpacking ${findAgentBridge(agent)?.displayName ?? agent} (${unpacked} of ${bundled.filter(id => agents.includes(id)).length})…`);
        await installOfflineAgentPackage(staged.bridges[agent]!, join(staged.directory, "agents", agent), artifact);
      }
      await privateDirectory(join(root, "credentials", agent));
      await privateDirectory(join(root, "workspaces", agent));
    }
    await writeSecretFile(join(staged.directory, "manifest.json"), JSON.stringify(release.manifest));
    const releaseId = `release-${basename(staged.directory).replace(/^\.candidate-/, "")}`;
    const releaseDirectory = join(root, "releases", releaseId);
    await rename(staged.directory, releaseDirectory);
    const git = options.deps?.git === undefined ? await discoverGit() : options.deps.git;
    const record = NativeRuntimeRecordSchema.parse({ ...draft, agents, instanceId: identity.instanceId, workspaceId: identity.workspaceId, releaseId, bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest, ...(codexHome ? { codexHome } : {}), ...(claudeExecutable ? { claudeExecutable } : {}), ...hosted, ...(git ? { git: await verifyNativeGitTool(git) } : {}) });
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(record));
    await loadNativeInstallation(root, { roots, platform });
    options.output.line("Installed. Starting Konteks on this computer next.");
    return record;
  } finally { lock.release(); }
}

/**
 * Prepare a machine for `konteks-remote onboard` (onboarding-simplified OS3).
 *
 * The activation install cannot serve the agent-first door: it consumes an
 * activation that does not exist yet and prompts for a code at a terminal the
 * person's coding agent does not have. This does everything that does not
 * need an identity — verify the signed release against the embedded roots,
 * stage it, install the agent bridges for the families this machine actually
 * has — and stops. No runtime record is written, because there is no instance
 * id to write; `onboard` binds and writes it.
 *
 * Agent families are detected rather than assumed (OS14). Someone who runs
 * only Claude Code is not refused for not also having Codex.
 */
export async function prepareNativeEnrollment(options: {
  root: string;
  coreUrl: string;
  relayUrl: string;
  output: Output;
  agents?: string[];
  controlPort?: number;
  deps?: NativeInstallOptions["deps"];
}): Promise<{ agents: string[]; bundleVersion: string; releaseId: string }> {
  await recordNativeEnrollment(options);
  return stageNativeEnrollment({ root: options.root, ...(options.deps ? { deps: options.deps } : {}) });
}

const ENROLLMENT_MANIFEST = "enrollment-manifest.json";

/** The order agents are listed in (the site's order). */
const AGENT_ORDER = ["claude-code", "codex", "dsh", "opencode", "antigravity"];

/**
 * Every agent family this machine actually has (OS14): Claude Code's
 * executable and Codex's profile by file checks, and the agents the person
 * installed themselves (DeepSeek Harness, OpenCode 2) when offered. A fetched
 * one (Google Antigravity) is never detected: the connector downloads it, it
 * is not found. Nothing is downloaded or run.
 */
async function detectNativeAgents(root: string): Promise<string[]> {
  const detected: string[] = [];
  if (await resolveNativeClaudeExecutable().then(() => true).catch(() => false)) detected.push("claude-code");
  if (await resolveNativeCodexHome().then(() => true).catch(() => false)) detected.push("codex");
  for (const host of HOST_AGENT_INSTALL_ADAPTERS) {
    if (host.fetch !== undefined) continue;
    if (host.offered && await host.locate(undefined, { root }).then(() => true).catch(() => false)) detected.push(host.agentId);
  }
  return detected;
}

/** The agents found here, plus Claude Code or Codex when the person set one up on being asked (D116). */
async function findOrOfferAgents(root: string, setupAgent?: (agentId: "claude-code" | "codex") => Promise<boolean>): Promise<string[]> {
  const agents = await detectNativeAgents(root);
  for (const agent of ["claude-code", "codex"] as const) {
    if (agents.includes(agent) || !setupAgent) continue;
    if (await setupAgent(agent).catch(() => false)) agents.push(agent);
  }
  return agents.sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b));
}

/**
 * The control port a new enrollment records (WS1-020): the default when it is
 * free, otherwise one the system hands out. A machine that already runs another
 * Konteks connector would otherwise get a runtime that activates and then dies
 * on `EADDRINUSE`.
 */
export async function chooseControlPort(preferred = CONTROL_SOCKET_DEFAULT_PORT): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number | null>((resolveListen) => {
      const server = createServer();
      server.once("error", () => resolveListen(null));
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : null;
        server.close(() => resolveListen(chosen));
      });
    });
  const chosen = (await tryListen(preferred)) ?? (await tryListen(0));
  if (chosen === null)
    throw new RemoteInstanceError(
      "temporarily_unavailable",
      "No local control port is available; the native connector was not changed.",
    );
  return chosen;
}

/**
 * A stopped connector may carry a port that another local process has since
 * taken. Reassign only that installer-owned field, under both native locks,
 * after verifying the signed installation and the service manager's state.
 */
export async function reassignOccupiedNativeControlPort(options: {
  root: string;
  serviceStopped: () => Promise<boolean>;
  roots?: readonly EmbeddedReleaseRoot[];
  platform?: NativePlatform;
}): Promise<{ previousPort: number; controlPort: number } | null> {
  const root = resolve(options.root);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  if (!(await options.serviceStopped()))
    throw new RemoteInstanceError(
      "temporarily_unavailable",
      "This connector's service is still registered or running. Stop this installation's service before retrying start; its identity and local work are unchanged.",
    );
  const installer = acquireNativeRootLock(join(root, "installer"));
  let supervisor: ReturnType<typeof acquireNativeRootLock> | undefined;
  try {
    supervisor = acquireNativeRootLock(join(root, "supervisor"));
    if (!(await options.serviceStopped()))
      throw new RemoteInstanceError(
        "temporarily_unavailable",
        "This connector's service began starting. Stop this installation's service before retrying start; its identity and local work are unchanged.",
      );
    const roots = options.roots ?? EMBEDDED_RELEASE_ROOTS;
    const platform = options.platform ?? nativePlatform();
    const current = (await loadNativeInstallation(root, { roots, platform })).record;
    const chosen = await chooseControlPort(current.controlPort);
    if (chosen === current.controlPort) return null;
    const successor = NativeRuntimeRecordSchema.parse({ ...current, controlPort: chosen });
    installer.assertOwned();
    supervisor.assertOwned();
    if (!(await options.serviceStopped()))
      throw new RemoteInstanceError(
        "temporarily_unavailable",
        "This connector's service began starting. Stop this installation's service before retrying start; its identity and local work are unchanged.",
      );
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(successor));
    try {
      await loadNativeInstallation(root, { roots, platform });
    } catch (error) {
      installer.assertOwned();
      supervisor.assertOwned();
      await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(current));
      throw error;
    }
    return { previousPort: current.controlPort, controlPort: chosen };
  } finally {
    supervisor?.release();
    installer.release();
  }
}

/**
 * The fast half of an enrollment install (WS1-012): detect the families,
 * fetch and verify the signed release, and remember it. Enough for `onboard`
 * to ask the first question; nothing is unpacked. The signed payload is kept
 * so the unpacking verifies exactly what was recorded, without a second fetch.
 */
export async function recordNativeEnrollment(options: {
  root: string;
  coreUrl: string;
  relayUrl: string;
  agents?: string[];
  controlPort?: number;
  deps?: NativeInstallOptions["deps"];
}): Promise<{ agents: string[]; bundleVersion: string; staged: boolean }> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = resolve(options.root);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  await privateDirectory(root);
  const installLockDir = join(root, "installer");
  await privateDirectory(installLockDir);
  const lock = acquireNativeRootLock(installLockDir);
  try {
    const prepared = await readNativeEnrollment(root).catch(() => null);
    if (prepared) {
      lock.assertOwned();
      return { agents: prepared.agents, bundleVersion: prepared.bundleVersion, staged: await releaseStaged(root, prepared.releaseId) };
    }
    const detected: string[] = [];
    // A fetched agent (Google Antigravity) is downloaded on the person's yes
    // after onboarding, never as part of it: `agent add` asks its question.
    const fetched = options.agents?.find(agent => hostAgentInstallAdapter(agent)?.fetch !== undefined);
    if (fetched !== undefined) throw new RemoteInstanceError("agent_unavailable", `${findAgentBridge(fetched)?.displayName ?? fetched} is added after onboarding, once you agree to its download: konteks-remote agent add ${fetched}`);
    if (options.agents && options.agents.length > 0) detected.push(...options.agents);
    else detected.push(...await detectNativeAgents(root));
    // None is required (OS14): a machine with no detectable family still
    // enrolls, and the closing summary says how to add one.
    const fetchFn = options.deps?.fetchFn ?? fetch;
    const payload = options.deps?.manifest ?? await fetchNativeManifest(fetchFn);
    const release = verifyNativeRelease(payload, roots);
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: detected.filter(agent => !isHostAgentId(agent)) });
    if (artifacts.some(artifact => artifact.kind === "connector" ? artifact.format !== "executable" : artifact.format !== "offline_agent_tgz")) {
      throw new RemoteInstanceError("bundle_untrusted", "Native agents require a complete signed offline package with official login tooling.");
    }
    for (const dir of ["releases", "credentials", "workspaces", "logs", "supervisor"]) await privateDirectory(join(root, dir));
    lock.assertOwned();
    await writeSecretFile(join(installLockDir, ENROLLMENT_MANIFEST), JSON.stringify(payload));
    // The endpoints are remembered so `onboard` speaks to the same Core the
    // person installed against, without asking them for a URL.
    await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify(NativeEnrollmentRecordSchema.parse({
      schemaVersion: 1,
      coreUrl: options.coreUrl,
      relayUrl: options.relayUrl,
      agents: detected,
      bundleVersion: release.manifest.bundleVersion,
      manifestDigest: release.manifest.digest,
      controlPort: options.controlPort ?? await chooseControlPort(),
    })));
    return { agents: detected, bundleVersion: release.manifest.bundleVersion, staged: false };
  } finally { lock.release(); }
}

/**
 * The slow half: unpack the recorded release and its agent packages, report
 * progress for `onboard` to show, and name the staged release in the record.
 * Idempotent: a release already staged is returned as it is.
 */
export async function stageNativeEnrollment(options: {
  root: string;
  deps?: NativeInstallOptions["deps"];
}): Promise<{ agents: string[]; bundleVersion: string; releaseId: string }> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = resolve(options.root);
  const installLockDir = join(root, "installer");
  await privateDirectory(installLockDir);
  const lock = acquireNativeRootLock(installLockDir);
  try {
    const prepared = await readNativeEnrollment(root);
    if (prepared.releaseId && await releaseStaged(root, prepared.releaseId)) {
      await writeStagingProgress(root, { state: "done", done: prepared.agents.length, total: prepared.agents.length });
      return { agents: prepared.agents, bundleVersion: prepared.bundleVersion, releaseId: prepared.releaseId };
    }
    const total = prepared.agents.length;
    const progress = (done: number, agent?: string) =>
      writeStagingProgress(root, { state: "running", pid: process.pid, done, total, ...(agent ? { agent } : {}) });
    try {
      await progress(0);
      const payload = options.deps?.manifest ?? JSON.parse(await readFile(join(installLockDir, ENROLLMENT_MANIFEST), "utf8"));
      const release = verifyNativeRelease(payload, roots);
      if (release.manifest.digest !== prepared.manifestDigest) throw invalid();
      const bundled = prepared.agents.filter(agent => !isHostAgentId(agent));
      const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: bundled });
      const fetchFn = options.deps?.fetchFn ?? fetch;
      const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: bundled }, releasesDir: join(root, "releases"), fetchFn });
      await privateDirectory(join(staged.directory, "agents"));
      let done = 0;
      for (const agent of prepared.agents) {
        await progress(done, agent);
        if (bundled.includes(agent)) {
          const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
          await installOfflineAgentPackage(staged.bridges[agent]!, join(staged.directory, "agents", agent), artifact);
        }
        await privateDirectory(join(root, "credentials", agent));
        await privateDirectory(join(root, "workspaces", agent));
        done += 1;
      }
      await writeSecretFile(join(staged.directory, "manifest.json"), JSON.stringify(release.manifest));
      const releaseId = `release-${basename(staged.directory).replace(/^\.candidate-/, "")}`;
      await rename(staged.directory, join(root, "releases", releaseId));
      lock.assertOwned();
      await writeSecretFile(join(root, "native-enrollment.json"), JSON.stringify(NativeEnrollmentRecordSchema.parse({ ...prepared, releaseId })));
      await writeStagingProgress(root, { state: "done", done: total, total });
      return { agents: prepared.agents, bundleVersion: release.manifest.bundleVersion, releaseId };
    } catch (error) {
      await writeStagingProgress(root, {
        state: "failed",
        done: 0,
        total,
        message: error instanceof Error ? error.message : "Unpacking the agent packages failed.",
      }).catch(() => undefined);
      throw error;
    }
  } finally { lock.release(); }
}

/** What `install --enroll` remembered for `onboard`: endpoints, families, the staged release. */
export const NativeEnrollmentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  coreUrl: z.string().min(1),
  relayUrl: z.string().min(1),
  agents: z.array(z.string().min(1)),
  /** Absent until the agent packages are unpacked (WS1-012). */
  releaseId: z.string().min(1).optional(),
  bundleVersion: z.string().min(1),
  manifestDigest: z.string().min(1),
  controlPort: z.number().int().positive(),
}).strict();
export type NativeEnrollmentRecord = z.infer<typeof NativeEnrollmentRecordSchema>;

export async function readNativeEnrollment(root: string): Promise<NativeEnrollmentRecord> {
  const path = join(resolve(root), "native-enrollment.json");
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw invalid();
  return NativeEnrollmentRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/**
 * Finish an enrollment install once `onboard` has bound the machine (OS3).
 *
 * `bind` persisted the identity, provisioning state and manifest record under
 * `supervisor/`; this writes the runtime record that `start`, `status` and
 * every later command load, from the staged release `install --enroll` left
 * and the identity Core answered with. It ends by loading the installation
 * the way the service will, so a record that would not start is never written.
 */
export async function completeNativeEnrollment(root: string, identity: { instanceId: string; workspaceId: string }, deps: NativeInstallOptions["deps"] = {}): Promise<NativeRuntimeRecord> {
  const platform = deps.platform ?? nativePlatform();
  const roots = deps.roots ?? EMBEDDED_RELEASE_ROOTS;
  root = resolve(root);
  const installLockDir = join(root, "installer");
  await privateDirectory(installLockDir);
  const lock = acquireNativeRootLock(installLockDir);
  try {
    const existing = await lstat(join(root, "native-runtime.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      const installation = await loadNativeInstallation(root, { roots, platform });
      if (installation.record.instanceId !== identity.instanceId) throw invalid();
      return installation.record;
    }
    const prepared = await readNativeEnrollment(root);
    if (!prepared.releaseId) {
      throw new RemoteInstanceError("temporarily_unavailable", "The agent packages are still unpacking on this machine.");
    }
    const stored = await new SupervisorStore(join(root, "supervisor")).identity();
    if (!stored || stored.instanceId !== identity.instanceId || stored.workspaceId !== identity.workspaceId) throw invalid();
    const release = verifyNativeRelease(JSON.parse(await readFile(join(root, "releases", prepared.releaseId, "manifest.json"), "utf8")), roots);
    if (release.manifest.digest !== prepared.manifestDigest) throw invalid();
    const codexHome = prepared.agents.includes("codex") ? await resolveNativeCodexHome().catch(() => undefined) : undefined;
    const claudeExecutable = prepared.agents.includes("claude-code") ? await resolveNativeClaudeExecutable().catch(() => undefined) : undefined;
    // A host-installed agent that has gone missing since detection is dropped, like a missing profile.
    const hosted: Partial<NativeRuntimeRecord> = {};
    const located = new Set<string>();
    for (const agent of prepared.agents) {
      const host = hostAgentInstallAdapter(agent);
      const fields = host?.offered ? await host.locate(undefined, { root }).catch(() => undefined) : undefined;
      if (fields) { Object.assign(hosted, fields); located.add(agent); }
    }
    const agents = prepared.agents.filter(agent => (agent === "codex" ? codexHome !== undefined : agent === "claude-code" ? claudeExecutable !== undefined : hostAgentInstallAdapter(agent) ? located.has(agent) : true));
    const git = deps.git === undefined ? await discoverGit() : deps.git;
    const record = NativeRuntimeRecordSchema.parse({
      schemaVersion: 1, deploymentKind: "native_connector",
      instanceId: identity.instanceId, workspaceId: identity.workspaceId,
      releaseId: prepared.releaseId, bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest,
      coreUrl: prepared.coreUrl, relayUrl: prepared.relayUrl, agents, controlPort: prepared.controlPort,
      ...(codexHome ? { codexHome } : {}), ...(claudeExecutable ? { claudeExecutable } : {}), ...hosted, ...(git ? { git: await verifyNativeGitTool(git) } : {}),
    });
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(record));
    await loadNativeInstallation(root, { roots, platform });
    return record;
  } finally { lock.release(); }
}

/**
 * Add one agent to an existing identity without reactivation. A newer release
 * is fetched independently and verified by the executable's embedded roots;
 * the existing release is never edited. A complete successor is verified
 * before the installer atomically moves the runtime record to it. The caller
 * owns service drain/restart, while the runtime-root lock proves the supervisor
 * is actually stopped before any installed authority changes.
 */
export async function addNativeAgent(options: NativeAgentAddOptions): Promise<NativeRuntimeRecord> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = resolve(options.root);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  refuseRetiredAgents([options.agentId]);
  await privateDirectory(root);
  const installLockDir = join(root, "installer");
  await privateDirectory(installLockDir);
  const lock = acquireNativeRootLock(installLockDir);
  let runtimeLock: ReturnType<typeof acquireNativeRootLock> | undefined;
  let successorDirectory: string | null = null;
  try {
    runtimeLock = acquireNativeRootLock(join(root, "supervisor"));
    const current = await loadNativeInstallation(root, { roots, platform });
    if (current.record.agents.includes(options.agentId)) {
      // A fetched agent whose copy no longer verifies (or an update's new
      // copy just fetched) is recorded again from the verified folder.
      if (await fetchedAgentStale(root, current.record, options.agentId)) return await addHostAgent(root, current.record, options, { roots, platform }, lock);
      options.output.line(`${options.agentId} is already installed; no files or identity were changed.`);
      return current.record;
    }
    if (isHostAgentId(options.agentId)) return await addHostAgent(root, current.record, options, { roots, platform }, lock);
    const fetchFn = options.deps?.fetchFn ?? fetch;
    const payload = options.deps?.manifest ?? await fetchNativeManifest(fetchFn);
    const release = verifyNativeRelease(payload, roots);
    // The installed release itself adds its own package for the agent (a
    // computer connected before Claude Code or Codex was here, D116); any
    // other release must be newer. Stale or same-version substitutes are refused.
    const sameRelease = release.manifest.digest === current.record.manifestDigest;
    if (!sameRelease && compareSemver(release.manifest.bundleVersion, current.record.bundleVersion) <= 0) {
      throw new RemoteInstanceError("update_required", "Adding an agent requires a newer signed native release; stale or same-version manifests are refused.");
    }
    const agents = [...current.record.agents, options.agentId];
    const bundled = agents.filter(agent => !isHostAgentId(agent));
    const codexHome = options.agentId === "codex" ? await resolveNativeCodexHome() : current.record.codexHome;
    const claudeExecutable = options.agentId === "claude-code" ? await resolveNativeClaudeExecutable() : current.record.claudeExecutable;
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: bundled });
    if (artifacts.some(artifact => artifact.kind === "connector" ? artifact.format !== "executable" : artifact.format !== "offline_agent_tgz")) {
      throw new RemoteInstanceError("bundle_untrusted", "Native agents require a complete signed offline package with official login tooling.");
    }
    const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: bundled }, releasesDir: join(root, "releases"), fetchFn });
    await privateDirectory(join(staged.directory, "agents"));
    try {
      for (const agent of bundled) {
        const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
        await installOfflineAgentPackage(staged.bridges[agent]!, join(staged.directory, "agents", agent), artifact);
      }
      await writeSecretFile(join(staged.directory, "manifest.json"), JSON.stringify(release.manifest));
      const releaseId = `release-${basename(staged.directory).replace(/^\.candidate-/, "")}`;
      successorDirectory = join(root, "releases", releaseId);
      lock.assertOwned();
      await rename(staged.directory, successorDirectory);
      await privateDirectory(join(root, "credentials", options.agentId));
      await privateDirectory(join(root, "workspaces", options.agentId));
      const successor = NativeRuntimeRecordSchema.parse({
        ...current.record,
        releaseId,
        bundleVersion: release.manifest.bundleVersion,
        manifestDigest: release.manifest.digest,
        agents,
        ...(codexHome ? { codexHome } : {}),
        ...(claudeExecutable ? { claudeExecutable } : {}),
      });
      const supervisorStore = new SupervisorStore(join(root, "supervisor"));
      const previousManifest = await supervisorStore.manifest();
      if (!previousManifest || previousManifest.manifestDigest !== current.record.manifestDigest) throw invalid();
      try {
        lock.assertOwned();
        await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(successor));
        await supervisorStore.saveManifest(release.manifest, release.manifest.digest);
        await loadNativeInstallation(root, { roots, platform });
      } catch (error) {
        lock.assertOwned();
        await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(current.record));
        await supervisorStore.saveManifest(previousManifest.manifest, previousManifest.manifestDigest);
        await loadNativeInstallation(root, { roots, platform });
        throw error;
      }
      options.output.line(`${findAgentBridge(options.agentId)?.displayName ?? options.agentId} added; your other agents, sign-ins and work are unchanged.`);
      return successor;
    } catch (error) {
      if (successorDirectory === null) await rm(staged.directory, { recursive: true, force: true });
      throw error;
    }
  } finally {
    runtimeLock?.release();
    lock.release();
  }
}

/**
 * An agent the person installed themselves (DeepSeek Harness, OpenCode 2) adds no files to
 * the release: its host adapter locates it, the record keeps what it found,
 * it gets private folders, and the installation must still load, restoring
 * the previous record if it does not.
 */
async function addHostAgent(root: string, previous: NativeRuntimeRecord, options: NativeAgentAddOptions, deps: { roots: readonly EmbeddedReleaseRoot[]; platform: NativePlatform }, lock: ReturnType<typeof acquireNativeRootLock>): Promise<NativeRuntimeRecord> {
  const host = hostAgentInstallAdapter(options.agentId);
  if (!host?.offered) throw notOffered(options.agentId);
  // A fetched agent was downloaded before the service stopped (runNativeAgentAdd); here it is only verified again.
  const located = await host.locate(undefined, { root });
  await privateDirectory(join(root, "credentials", options.agentId));
  await privateDirectory(join(root, "workspaces", options.agentId));
  const listed = previous.agents.includes(options.agentId);
  const successor = NativeRuntimeRecordSchema.parse({ ...previous, agents: listed ? previous.agents : [...previous.agents, options.agentId], ...located });
  try {
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(successor));
    await loadNativeInstallation(root, deps);
  } catch (error) {
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(previous));
    throw error;
  }
  const name = findAgentBridge(options.agentId)?.displayName ?? options.agentId;
  if (host.fetch !== undefined) {
    const version = located.antigravityVersion;
    options.output.line(listed
      ? `${name}${version ? ` ${version}` : ""} downloaded from Google again and its signature checked; its sign-ins were kept.`
      : `${name}${version ? ` ${version}` : ""} added: downloaded from Google and its signature checked; nothing else changed. To sign it in here with a Gemini API key: konteks-remote auth login ${options.agentId} --api-key. With Gemini Enterprise: konteks-remote auth login ${options.agentId} --enterprise --project <project id>`);
    return successor;
  }
  const version = located.opencodeVersion;
  options.output.line(`${name}${version ? ` ${version}` : ""} added from this machine's own installation; no release was downloaded and nothing else changed. To sign it in here: konteks-remote auth login ${options.agentId}`);
  return successor;
}

/** A listed fetched agent whose recorded copy does not verify now while this release's copy does (fetched again, or an update's). */
async function fetchedAgentStale(root: string, record: NativeRuntimeRecord, agentId: string): Promise<boolean> {
  const host = hostAgentInstallAdapter(agentId);
  if (host?.fetch === undefined) return false;
  const recordedOk = await host.runnerSettings(record, { root }).then(() => true, () => false);
  if (recordedOk) return false;
  return host.locate(undefined, { root }).then(() => true, () => false);
}

export interface NativeAgentRemoveOptions {
  root: string;
  agentId: NativeRuntimeRecord["agents"][number];
  output: Output;
  deps?: {
    roots?: readonly EmbeddedReleaseRoot[];
    platform?: NativePlatform;
    /** Sign out on a process of the connector's own (tests replace it). */
    signOut?: typeof signOutNativeAntigravity;
  };
}

/**
 * Remove a fetched agent (Google Antigravity, A18) without reactivation:
 * with the service stopped (the caller's part, as for `agent add`), sign it
 * out on a process of the connector's own, drop it from the runtime record
 * (the installation must still load), then delete every downloaded version,
 * its private home with its sign-ins, and its workspace folder. Other agents,
 * the identity and the release are untouched.
 */
export async function removeNativeAgent(options: NativeAgentRemoveOptions): Promise<NativeRuntimeRecord> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = resolve(options.root);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  const host = hostAgentInstallAdapter(options.agentId);
  if (host?.fetch === undefined) throw notRemovable(options.agentId);
  const lock = acquireNativeRootLock(join(root, "installer"));
  let runtimeLock: ReturnType<typeof acquireNativeRootLock> | undefined;
  try {
    runtimeLock = acquireNativeRootLock(join(root, "supervisor"));
    const current = await loadNativeInstallation(root, { roots, platform });
    const name = findAgentBridge(options.agentId)?.displayName ?? options.agentId;
    if (current.record.agents.includes(options.agentId)) {
      const signedOut = await (options.deps?.signOut ?? signOutNativeAntigravity)(root, current.record);
      const { antigravityVersion: _version, antigravityRoot: _root, ...rest } = current.record;
      const successor = NativeRuntimeRecordSchema.parse({ ...rest, agents: current.record.agents.filter(agent => agent !== options.agentId) });
      try {
        lock.assertOwned();
        await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(successor));
        await loadNativeInstallation(root, { roots, platform });
      } catch (error) {
        lock.assertOwned();
        await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(current.record));
        throw error;
      }
      await deleteNativeAntigravity(root);
      options.output.line(`${name} removed from this computer: ${signedOut ? "signed out, " : ""}its download and its sign-ins here were deleted. Nothing else changed.`);
      return successor;
    }
    // Not listed: a download left from an unfinished add is deleted all the same.
    await deleteNativeAntigravity(root);
    options.output.line(`${name} is not added on this computer; nothing of it is left here.`);
    return current.record;
  } finally {
    runtimeLock?.release();
    lock.release();
  }
}
function notRemovable(agentId: string) {
  return new RemoteInstanceError("agent_unavailable", `${findAgentBridge(agentId)?.displayName ?? agentId} cannot be removed on its own. Only Google Antigravity, which Konteks downloads, can: konteks-remote agent remove antigravity. To remove Konteks from this computer: konteks-remote uninstall`);
}

/** Roll back only the exact successor written by this launcher invocation. */
export async function restoreNativeRecord(root: string, expectedReleaseId: string, previous: NativeRuntimeRecord, deps: { roots?: readonly EmbeddedReleaseRoot[]; platform?: NativePlatform } = {}): Promise<void> {
  root = resolve(root);
  const platform = deps.platform ?? nativePlatform();
  const roots = deps.roots ?? EMBEDDED_RELEASE_ROOTS;
  const lock = acquireNativeRootLock(join(root, "installer"));
  let runtimeLock: ReturnType<typeof acquireNativeRootLock> | undefined;
  try {
    runtimeLock = acquireNativeRootLock(join(root, "supervisor"));
    const current = await loadNativeInstallation(root, { roots, platform });
    if (current.record.releaseId !== expectedReleaseId || current.record.instanceId !== previous.instanceId || current.record.workspaceId !== previous.workspaceId) throw invalid();
    const previousManifest = verifyNativeRelease(JSON.parse(await readFile(join(root, "releases", previous.releaseId, "manifest.json"), "utf8")), roots);
    if (previousManifest.manifest.digest !== previous.manifestDigest || previousManifest.manifest.bundleVersion !== previous.bundleVersion) throw invalid();
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(NativeRuntimeRecordSchema.parse(previous)));
    await new SupervisorStore(join(root, "supervisor")).saveManifest(previousManifest.manifest, previousManifest.manifest.digest);
    await loadNativeInstallation(root, { roots, platform });
  } finally {
    runtimeLock?.release();
    lock.release();
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw invalid();
  // mkdir recursive applies the requested mode to newly created ancestors too.
  if (process.platform !== "win32") await chmod(path, 0o700);
}
async function fetchNativeManifest(fetchFn: typeof fetch): Promise<unknown> {
  try { return await fetchNativeReleaseManifest(fetchFn); } catch { throw invalid(); }
}
async function discoverGit(): Promise<NativeRuntimeRecord["git"] | null> {
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(directory => directory && parse(directory).root)
    .map(directory => join(directory, process.platform === "win32" ? "git.exe" : "git"));
  // Git for Windows installed during this install (winget, D116) is not on this process's PATH yet.
  const windowsGit = process.platform === "win32" ? findGitForWindows(process.env)?.git : undefined;
  if (windowsGit) candidates.push(windowsGit);
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      const info = await lstat(executable);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) continue;
      return await verifyNativeGitTool({ executable, digest: `sha256:${createHash("sha256").update(await readFile(executable)).digest("hex")}` });
    } catch { /* Try the next explicitly installed Git, never download a tool implicitly. */ }
  }
  return null;
}
function invalid() { return new RemoteInstanceError("install_state_corrupt", "Native installation cannot be completed; existing identity and credentials were preserved."); }
/**
 * Retired agents (Pi, Cline) are refused on install with the one shared
 * sentence. A host agent that is not offered is refused too, whatever the
 * shared list says (none today: OpenCode 2 is offered since
 * opencode-runtime-support CP6).
 */
function refuseRetiredAgents(agents: readonly string[]): void {
  const retired = agents.find(agent => isRetiredAgentId(agent));
  if (retired !== undefined) throw new RemoteInstanceError("agent_unavailable", retiredAgentMessage(retired));
  const gated = agents.find(agent => !nativeAgentOffered(agent));
  if (gated !== undefined) throw notOffered(gated);
}
function notOffered(agentId: string) { return new RemoteInstanceError("agent_unavailable", `${agentId} cannot be added on this computer yet.`); }

/**
 * Locate every host-installed agent in `agents`; the install-record fields
 * they need. A fetched agent is downloaded here on the person's yes to its
 * consent line (a copy that already verifies is kept); no answer, or no, is
 * a refusal and nothing is downloaded.
 */
async function locateHostAgents(agents: readonly string[], root: string, consent?: FetchConsent, output?: Output): Promise<Partial<NativeRuntimeRecord>> {
  const fields: Partial<NativeRuntimeRecord> = {};
  for (const agent of agents) {
    const host = hostAgentInstallAdapter(agent);
    if (!host) continue;
    if (host.fetch !== undefined) {
      Object.assign(fields, await fetchHostAgent(host, root, consent, output));
      continue;
    }
    Object.assign(fields, await host.locate(undefined, { root }));
  }
  return fields;
}

/**
 * A fetched agent's download (A20): refused first where the release pins no
 * copy for this computer, then the consent line, then Google's zip into the
 * connector's own folder, checked. A copy that already verifies is kept
 * without asking.
 */
export async function fetchHostAgent(host: HostAgentInstallAdapter, root: string, consent: FetchConsent | undefined, output?: Output): Promise<Partial<NativeRuntimeRecord>> {
  if (host.fetch === undefined) throw notOffered(host.agentId);
  host.assertFetchable?.();
  const kept = await host.locate(undefined, { root }).catch(() => null);
  if (kept) return kept;
  const name = findAgentBridge(host.agentId)?.displayName ?? host.agentId;
  const yes = consent ? await consent(host.agentId, host.consentText ?? `Download ${name}? [y/N]`) : false;
  if (!yes) throw new RemoteInstanceError("agent_unavailable", `Nothing was downloaded: ${name} was not added.`);
  output?.line(`Downloading ${name} from Google and checking Google's signature; this takes a minute or two.`);
  return host.fetch({ root, consent: true });
}

/** Read only the private installer record for status/stop, even when a release has expired. */
export async function readNativeRecord(root: string): Promise<NativeRuntimeRecord> {
  const path = join(resolve(root), "native-runtime.json");
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw invalid();
  return parseNativeRuntimeRecord(JSON.parse(await readFile(path, "utf8"))).record;
}
