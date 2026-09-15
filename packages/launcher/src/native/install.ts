import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, parse, resolve } from "node:path";
import { CONTROL_SOCKET_DEFAULT_PORT, RemoteInstanceError, SystemClock, writeSecretFile } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, installOfflineAgentPackage, NATIVE_MANIFEST_URL, selectNativeArtifacts, stageNativeRelease, verifyNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { acquireNativeRootLock, compareSemver, loadNativeInstallation, NativeRuntimeRecordSchema, resolveNativeClaudeExecutable, resolveNativeCodexHome, runNativeActivationExchange, SupervisorStore, verifyNativeGitTool, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { promptSecret } from "../prompt.js";
import { nativePlatform, type NativePlatform } from "./service.js";

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
  agentId: "claude-code" | "codex" | "opencode" | "pi";
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
    const fetchFn = options.deps?.fetchFn ?? fetch;
    const payload = options.deps?.manifest ?? await fetchNativeManifest(fetchFn);
    const release = verifyNativeRelease(payload, roots);
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: agents });
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
    const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: agents }, releasesDir: join(root, "releases"), fetchFn });
    await privateDirectory(join(staged.directory, "agents"));
    for (const agent of agents) {
      const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
      await installOfflineAgentPackage(staged.bridges[agent]!, join(staged.directory, "agents", agent), artifact);
      await privateDirectory(join(root, "credentials", agent));
      await privateDirectory(join(root, "workspaces", agent));
    }
    await writeSecretFile(join(staged.directory, "manifest.json"), JSON.stringify(release.manifest));
    const releaseId = `release-${basename(staged.directory).replace(/^\.candidate-/, "")}`;
    const releaseDirectory = join(root, "releases", releaseId);
    await rename(staged.directory, releaseDirectory);
    const git = options.deps?.git === undefined ? await discoverGit() : options.deps.git;
    const record = NativeRuntimeRecordSchema.parse({ ...draft, instanceId: identity.instanceId, workspaceId: identity.workspaceId, releaseId, bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest, ...(codexHome ? { codexHome } : {}), ...(claudeExecutable ? { claudeExecutable } : {}), ...(git ? { git: await verifyNativeGitTool(git) } : {}) });
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(record));
    await loadNativeInstallation(root, { roots, platform });
    options.output.line(`Native files installed for ${record.instanceId}; activation, agent login and cloud readiness are separate states.`);
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
