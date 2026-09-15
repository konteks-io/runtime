import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, installOfflineAgentPackage, selectNativeArtifacts, stageNativeRelease, verifyNativeRelease, type EmbeddedReleaseRoot, type VerifiedNativeRelease } from "@konteks/remote-release";
import { acquireNativeRootLock, compareSemver, loadNativeInstallation, NativeRuntimeRecordSchema, SupervisorStore, verifyInstalledNativeConnector, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { nativePlatform, type NativePlatform } from "./service.js";

export interface NativeUpdateDeps {
  roots?: readonly EmbeddedReleaseRoot[];
  platform?: NativePlatform;
  manifest?: unknown;
  fetchFn?: typeof fetch;
}

export type NativeUpdateCheck =
  | { status: "current"; current: NativeRuntimeRecord; bundleVersion: string }
  | { status: "available"; current: NativeRuntimeRecord; release: VerifiedNativeRelease };

/** Read-only: which signed release the channel offers relative to the installed record. */
export async function checkNativeUpdate(options: { root: string; deps?: NativeUpdateDeps }): Promise<NativeUpdateCheck> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = validRoot(options.root);
  const current = await loadNativeInstallation(root, { roots, platform });
  const payload = options.deps?.manifest ?? await fetchNativeReleaseManifest(options.deps?.fetchFn ?? fetch).catch(() => { throw new RemoteInstanceError("temporarily_unavailable", "The native release channel could not be read; the installed release is unchanged."); });
  const release = verifyNativeRelease(payload, roots);
  if (compareSemver(release.manifest.bundleVersion, current.record.bundleVersion) <= 0) return { status: "current", current: current.record, bundleVersion: current.record.bundleVersion };
  return { status: "available", current: current.record, release };
}

export type NativeUpdateStage =
  | { status: "current"; current: NativeRuntimeRecord; bundleVersion: string }
  | { status: "staged"; current: NativeRuntimeRecord; release: VerifiedNativeRelease; releaseId: string; directory: string };

/**
 * Stage a strictly newer signed release next to the running one. Every byte is
 * pinned by the manifest, the candidate is verified as an installable connector
 * before it gets a release id, and nothing running is touched: the runtime
 * record still names the previous release until `commitNativeUpdate`.
 */
export async function stageNativeUpdate(options: { root: string; output: Output; deps?: NativeUpdateDeps }): Promise<NativeUpdateStage> {
  const platform = options.deps?.platform ?? nativePlatform();
  const root = validRoot(options.root);
  const lock = acquireNativeRootLock(join(root, "installer"));
  try {
    const check = await checkNativeUpdate({ root, ...(options.deps ? { deps: options.deps } : {}) });
    if (check.status === "current") return check;
    const { current, release } = check;
    const agents = current.agents;
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: agents });
    if (artifacts.some(artifact => artifact.kind === "connector" ? artifact.format !== "executable" : artifact.format !== "offline_agent_tgz")) {
      throw new RemoteInstanceError("bundle_untrusted", "Native updates require a complete signed offline package with official login tooling.");
    }
    const fetchFn = options.deps?.fetchFn ?? fetch;
    options.output.line(`Staging native release ${release.manifest.bundleVersion} (installed: ${current.bundleVersion})…`);
    const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: agents }, releasesDir: join(root, "releases"), fetchFn });
    let directory: string | null = null;
    try {
      await mkdir(join(staged.directory, "agents"), { recursive: true, mode: 0o700 });
      for (const agent of agents) {
        const artifact = artifacts.find(candidate => candidate.agentId === agent)!;
        await installOfflineAgentPackage(staged.bridges[agent]!, join(staged.directory, "agents", agent), artifact);
      }
      await writeSecretFile(join(staged.directory, "manifest.json"), JSON.stringify(release.manifest));
      await verifyInstalledNativeConnector(release, staged.directory, platform);
      const releaseId = `release-${basename(staged.directory).replace(/^\.candidate-/, "")}`;
      directory = join(root, "releases", releaseId);
      lock.assertOwned();
      await rename(staged.directory, directory);
      options.output.line(`Release ${release.manifest.bundleVersion} staged as ${releaseId}; the running release is unchanged until it is committed.`);
      return { status: "staged", current, release, releaseId, directory };
    } catch (error) {
      await rm(directory ?? staged.directory, { recursive: true, force: true });
      throw error;
    }
  } finally {
    lock.release();
  }
}

/**
 * Move the runtime record to a staged release. Requires the runtime lock, which
 * proves the supervisor is stopped; the previous release directory is kept so
 * `restoreNativeRecord` can roll back without a download.
 */
export async function commitNativeUpdate(options: { root: string; releaseId: string; output: Output; deps?: Pick<NativeUpdateDeps, "roots" | "platform"> }): Promise<NativeRuntimeRecord> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = validRoot(options.root);
  if (!/^release-[A-Za-z0-9_-]+$/.test(options.releaseId)) throw invalid();
  const lock = acquireNativeRootLock(join(root, "installer"));
  let runtimeLock: ReturnType<typeof acquireNativeRootLock> | undefined;
  try {
    runtimeLock = acquireNativeRootLock(join(root, "supervisor"));
    const current = await loadNativeInstallation(root, { roots, platform });
    if (current.record.releaseId === options.releaseId) return current.record;
    const directory = join(root, "releases", options.releaseId);
    const release = verifyNativeRelease(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")), roots);
    if (compareSemver(release.manifest.bundleVersion, current.record.bundleVersion) <= 0) throw new RemoteInstanceError("update_required", "Only a strictly newer signed release can be committed; stale or same-version releases are refused.");
    await verifyInstalledNativeConnector(release, directory, platform);
    const successor = NativeRuntimeRecordSchema.parse({ ...current.record, releaseId: options.releaseId, bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest });
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
    options.output.line(`Runtime record moved to ${options.releaseId} (${successor.bundleVersion}); ${current.record.releaseId} is kept for rollback.`);
    return successor;
  } finally {
    runtimeLock?.release();
    lock.release();
  }
}

function validRoot(value: string): string {
  const root = resolve(value);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  return root;
}
function invalid() { return new RemoteInstanceError("install_state_corrupt", "Native update cannot be completed; the installed release, identity and credentials were preserved."); }
