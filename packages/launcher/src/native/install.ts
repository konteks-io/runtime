import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, parse, resolve } from "node:path";
import { CONTROL_SOCKET_DEFAULT_PORT, RemoteInstanceError, SystemClock, writeSecretFile } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, installOfflineAgentPackage, isHostAgentId, NATIVE_MANIFEST_URL, selectNativeArtifacts, stageNativeRelease, verifyNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { acquireNativeRootLock, compareSemver, loadNativeInstallation, locateNativeDsh, NativeRuntimeRecordSchema, resolveNativeClaudeExecutable, resolveNativeCodexHome, runNativeActivationExchange, SupervisorStore, verifyNativeGitTool, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import { z } from "zod";
import type { Output } from "../output.js";
import { promptSecret } from "../prompt.js";
import { nativePlatform, type NativePlatform } from "./service.js";
import { releaseStaged, writeStagingProgress } from "./enrollment-staging.js";

export { NATIVE_MANIFEST_URL };
export interface NativeInstallOptions {
  root: string; activationId: string; coreUrl: string; relayUrl: string;
  agents?: string[]; controlPort?: number; output: Output;
  deps?: {
    roots?: readonly EmbeddedReleaseRoot[]; platform?: NativePlatform;
    manifest?: unknown; fetchFn?: typeof fetch; activate?: typeof runNativeActivationExchange;
    readActivationCode?: () => Promise<string>;
    git?: NativeRuntimeRecord["git"] | null;
  };
}
export interface NativeAgentAddOptions {
  root: string;
  agentId: "claude-code" | "codex" | "opencode" | "pi" | "dsh";
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
  const agents = options.agents ?? ["claude-code", "codex"];
  if (agents.includes("pi")) throw new RemoteInstanceError("agent_unavailable", "Pi native authentication and MCP compatibility are not yet supported.");
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
      if (identity?.activationId !== options.activationId || installation.record.coreUrl !== draft.coreUrl || installation.record.relayUrl !== draft.relayUrl || JSON.stringify(installation.record.agents) !== JSON.stringify(agents)) throw invalid();
      if (agents.includes("codex") && installation.record.codexHome === undefined) {
        const codexHome = installation.runners.find(runner => runner.RUNNER_AGENT_ID === "codex")?.RUNNER_NATIVE_CODEX_HOME;
        if (!codexHome) throw invalid();
        const bound = NativeRuntimeRecordSchema.parse({ ...installation.record, codexHome });
        lock.assertOwned();
        await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(bound));
        return bound;
      }
      return installation.record;
    }
    // Resolve before activation: a missing local profile must not consume an
    // activation and leave a partly installed, unstartable connector.
    const codexHome = agents.includes("codex") ? await resolveNativeCodexHome() : undefined;
    const claudeExecutable = agents.includes("claude-code") ? await resolveNativeClaudeExecutable() : undefined;
    // The person's own DeepSeek Harness: located and version-checked now, never downloaded.
    const dsh = agents.includes("dsh") ? await locateNativeDsh() : undefined;
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
    options.output.line("Activating this native agent connector; no local domain services are installed.");
    const activated = await (options.deps?.activate ?? runNativeActivationExchange)({ dataDir: join(root, "supervisor"), coreUrl: draft.coreUrl, activationId: options.activationId, platform, release, roots, clock: new SystemClock(), readActivationCode: options.deps?.readActivationCode ?? (() => promptSecret({ label: "Activation code", minLength: 8 })), fetchFn });
    lock.assertOwned();
    const identity = await new SupervisorStore(join(root, "supervisor")).identity();
    if (!identity || identity.instanceId !== activated.instanceId || activated.manifestDigest !== release.manifest.digest) throw invalid();
    const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: bundled }, releasesDir: join(root, "releases"), fetchFn });
    await privateDirectory(join(staged.directory, "agents"));
    for (const agent of agents) {
      if (bundled.includes(agent)) {
        const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
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
    const record = NativeRuntimeRecordSchema.parse({ ...draft, instanceId: identity.instanceId, workspaceId: identity.workspaceId, releaseId, bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest, ...(codexHome ? { codexHome } : {}), ...(claudeExecutable ? { claudeExecutable } : {}), ...(dsh ?? {}), ...(git ? { git: await verifyNativeGitTool(git) } : {}) });
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(record));
    await loadNativeInstallation(root, { roots, platform });
    options.output.line(`Native files installed for ${record.instanceId}; activation, agent login and cloud readiness are separate states.`);
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

/**
 * The control port a new enrollment records (WS1-020): the default when it is
 * free, otherwise one the system hands out. A machine that already runs another
 * Konteks connector would otherwise get a runtime that activates and then dies
 * on `EADDRINUSE`.
 */
export async function chooseControlPort(preferred = CONTROL_SOCKET_DEFAULT_PORT): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number | null>(resolveListen => {
      const server = createServer();
      server.once("error", () => resolveListen(null));
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : null;
        server.close(() => resolveListen(chosen));
      });
    });
  return (await tryListen(preferred)) ?? (await tryListen(0)) ?? preferred;
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
    if (options.agents && options.agents.length > 0) detected.push(...options.agents);
    else {
      if (await resolveNativeClaudeExecutable().then(() => true).catch(() => false)) detected.push("claude-code");
      if (await resolveNativeCodexHome().then(() => true).catch(() => false)) detected.push("codex");
      if (await locateNativeDsh().then(() => true).catch(() => false)) detected.push("dsh");
    }
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
    const dsh = prepared.agents.includes("dsh") ? await locateNativeDsh().catch(() => undefined) : undefined;
    const agents = prepared.agents.filter(agent => (agent === "codex" ? codexHome !== undefined : agent === "claude-code" ? claudeExecutable !== undefined : agent === "dsh" ? dsh !== undefined : true));
    const git = deps.git === undefined ? await discoverGit() : deps.git;
    const record = NativeRuntimeRecordSchema.parse({
      schemaVersion: 1, deploymentKind: "native_connector",
      instanceId: identity.instanceId, workspaceId: identity.workspaceId,
      releaseId: prepared.releaseId, bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest,
      coreUrl: prepared.coreUrl, relayUrl: prepared.relayUrl, agents, controlPort: prepared.controlPort,
      ...(codexHome ? { codexHome } : {}), ...(claudeExecutable ? { claudeExecutable } : {}), ...(dsh ?? {}), ...(git ? { git: await verifyNativeGitTool(git) } : {}),
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
  if (options.agentId === "pi") throw new RemoteInstanceError("agent_unavailable", "Pi native authentication and MCP compatibility are not yet supported.");
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
      options.output.line(`${options.agentId} is already installed; no files or identity were changed.`);
      return current.record;
    }
    if (isHostAgentId(options.agentId)) return await addHostAgent(root, current.record, options, { roots, platform }, lock);
    const fetchFn = options.deps?.fetchFn ?? fetch;
    const payload = options.deps?.manifest ?? await fetchNativeManifest(fetchFn);
    const release = verifyNativeRelease(payload, roots);
    if (compareSemver(release.manifest.bundleVersion, current.record.bundleVersion) <= 0) {
      throw new RemoteInstanceError("update_required", "Adding an agent requires a newer signed native release; stale or same-version manifests are refused.");
    }
    const agents = [...current.record.agents, options.agentId];
    const codexHome = options.agentId === "codex" ? await resolveNativeCodexHome() : current.record.codexHome;
    const claudeExecutable = options.agentId === "claude-code" ? await resolveNativeClaudeExecutable() : current.record.claudeExecutable;
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: agents });
    if (artifacts.some(artifact => artifact.kind === "connector" ? artifact.format !== "executable" : artifact.format !== "offline_agent_tgz")) {
      throw new RemoteInstanceError("bundle_untrusted", "Native agents require a complete signed offline package with official login tooling.");
    }
    const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: agents }, releasesDir: join(root, "releases"), fetchFn });
    await privateDirectory(join(staged.directory, "agents"));
    try {
      for (const agent of agents) {
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
      options.output.line(`${options.agentId} installed without reactivation; existing credentials and workspaces were preserved.`);
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
 * An agent the person installed themselves (DeepSeek Harness) adds no files to
 * the release: locate it, record it, give it private folders, and prove the
 * installation still loads, restoring the previous record if it does not.
 */
async function addHostAgent(root: string, previous: NativeRuntimeRecord, options: NativeAgentAddOptions, deps: { roots: readonly EmbeddedReleaseRoot[]; platform: NativePlatform }, lock: ReturnType<typeof acquireNativeRootLock>): Promise<NativeRuntimeRecord> {
  const dsh = await locateNativeDsh();
  await privateDirectory(join(root, "credentials", options.agentId));
  await privateDirectory(join(root, "workspaces", options.agentId));
  const successor = NativeRuntimeRecordSchema.parse({ ...previous, agents: [...previous.agents, options.agentId], ...dsh });
  try {
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(successor));
    await loadNativeInstallation(root, deps);
  } catch (error) {
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(previous));
    throw error;
  }
  options.output.line(`${options.agentId} added from this machine's own installation; no release was downloaded and nothing else changed.`);
  return successor;
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
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || !parse(directory).root) continue;
    try {
      const executable = await realpath(join(directory, process.platform === "win32" ? "git.exe" : "git"));
      const info = await lstat(executable);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) continue;
      return await verifyNativeGitTool({ executable, digest: `sha256:${createHash("sha256").update(await readFile(executable)).digest("hex")}` });
    } catch { /* Try the next explicitly installed Git, never download a tool implicitly. */ }
  }
  return null;
}
function invalid() { return new RemoteInstanceError("install_state_corrupt", "Native installation cannot be completed; existing identity and credentials were preserved."); }

/** Read only the private installer record for status/stop, even when a release has expired. */
export async function readNativeRecord(root: string): Promise<NativeRuntimeRecord> {
  const path = join(resolve(root), "native-runtime.json");
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw invalid();
  return NativeRuntimeRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
