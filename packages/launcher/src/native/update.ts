import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, installOfflineAgentPackage, isHostAgentId, selectNativeArtifacts, stageNativeRelease, verifyNativeRelease, type EmbeddedReleaseRoot, type VerifiedNativeRelease } from "@konteks/remote-release";
import { acquireNativeRootLock, compareSemver, loadNativeInstallation, NativeRuntimeRecordSchema, ownedByAnotherConnector, verifyInstalledNativeConnector, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { nativePlatform, type NativePlatform } from "./service.js";
import { moveRecordAndManifest, withRuntimeLocks } from "./install.js";

export interface NativeUpdateDeps {
  roots?: readonly EmbeddedReleaseRoot[];
  platform?: NativePlatform;
  manifest?: unknown;
  fetchFn?: typeof fetch;
}

type NativeUpdateCheck =
  | { status: "current"; current: NativeRuntimeRecord; bundleVersion: string }
  | { status: "available"; current: NativeRuntimeRecord; release: VerifiedNativeRelease };

/** Read-only: which signed release the channel offers relative to the installed record. */
export async function checkNativeUpdate(options: { root: string; deps?: NativeUpdateDeps }): Promise<NativeUpdateCheck> {
  const platform = options.deps?.platform ?? nativePlatform();
  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const root = validRoot(options.root);
  const current = await loadNativeInstallation(root, { roots, platform });
  const release = verifyNativeRelease(await channelManifest(options.deps), roots);
  if (compareSemver(release.manifest.bundleVersion, current.record.bundleVersion) <= 0) return { status: "current", current: current.record, bundleVersion: current.record.bundleVersion };
  return { status: "available", current: current.record, release };
}

/** The manifest the deps hold, else the one the release channel serves. */
async function channelManifest(deps: NativeUpdateDeps | undefined): Promise<unknown> {
  if (deps?.manifest !== undefined && deps.manifest !== null) return deps.manifest;
  return fetchNativeReleaseManifest(deps?.fetchFn ?? fetch).catch(() => { throw new RemoteInstanceError("temporarily_unavailable", "The native release channel could not be read; the installed release is unchanged."); });
}

export type NativeUpdateStage =
  | { status: "current"; current: NativeRuntimeRecord; bundleVersion: string }
  | { status: "staged"; current: NativeRuntimeRecord; release: VerifiedNativeRelease; releaseId: string; directory: string };

/**
 * The installer folder is held by whatever is changing this installation: most
 * often the connector's own update, still downloading. Say that, rather than
 * the bare ownership refusal.
 */
function installerLockForUpdate(root: string): ReturnType<typeof acquireNativeRootLock> {
  try { return acquireNativeRootLock(join(root, "installer")); }
  catch (error) {
    if (ownedByAnotherConnector(error)) {
      throw new RemoteInstanceError("temporarily_unavailable", "Another update or install of this connector is still running (it may be downloading a release). Wait for it to finish, then run `konteks-remote status`.", { cause: error });
    }
    throw error;
  }
}

/**
 * Stage a strictly newer signed release next to the running one. Every byte is
 * pinned by the manifest, the candidate is verified as an installable connector
 * before it gets a release id, and nothing running is touched: the runtime
 * record still names the previous release until `commitNativeUpdate`.
 */
export async function stageNativeUpdate(options: { root: string; output: Output; deps?: NativeUpdateDeps }): Promise<NativeUpdateStage> {
  const platform = options.deps?.platform ?? nativePlatform();
  const root = validRoot(options.root);
  const lock = installerLockForUpdate(root);
  try {
    const check = await checkNativeUpdate({ root, ...(options.deps ? { deps: options.deps } : {}) });
    if (check.status === "current") return check;
    const { current, release } = check;
    // The person's own DeepSeek Harness and OpenCode are not in any release; only bundled agents are restaged.
    const agents = current.agents.filter(agent => !isHostAgentId(agent));
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: agents });
    assertOfflineArtifacts(artifacts);
    options.output.line(`Staging native release ${release.manifest.bundleVersion} (installed: ${current.bundleVersion})… Downloading, verifying and unpacking its signed packages can take a few minutes; leave this command running and return for the result.`);
    const staged = await stageNativeRelease({ release, target: { ...platform, agentIds: agents }, releasesDir: join(root, "releases"), fetchFn: options.deps?.fetchFn ?? fetch });
    const { releaseId, directory } = await completeStagedRelease({ root, release, platform, agents, artifacts, staged, lock });
    options.output.line(`Release ${release.manifest.bundleVersion} staged as ${releaseId}; the running release is unchanged until it is committed.`);
    return { status: "staged", current, release, releaseId, directory };
  } finally {
    lock.release();
  }
}

type SelectedArtifact = ReturnType<typeof selectNativeArtifacts>[number];

function assertOfflineArtifacts(artifacts: readonly SelectedArtifact[]): void {
  if (artifacts.some(artifact => artifact.kind === "connector" ? artifact.format !== "executable" : artifact.format !== "offline_agent_tgz")) {
    throw new RemoteInstanceError("bundle_untrusted", "Native updates require a complete signed offline package with official login tooling.");
  }
}

/**
 * Unpack the agents, record the manifest and verify the candidate as an
 * installable connector before it gets a release id; anything that fails
 * removes the candidate.
 */
async function completeStagedRelease(candidate: {
  root: string; release: VerifiedNativeRelease; platform: NativePlatform; agents: readonly string[]; artifacts: readonly SelectedArtifact[];
  staged: Awaited<ReturnType<typeof stageNativeRelease>>; lock: ReturnType<typeof acquireNativeRootLock>;
}): Promise<{ releaseId: string; directory: string }> {
  const { staged } = candidate;
  let directory: string | null = null;
  try {
    await mkdir(join(staged.directory, "agents"), { recursive: true, mode: 0o700 });
    for (const agent of candidate.agents) {
      const artifact = candidate.artifacts.find(entry => entry.agentId === agent)!;
      await installOfflineAgentPackage(staged.bridges[agent]!, join(staged.directory, "agents", agent), artifact);
    }
    await writeSecretFile(join(staged.directory, "manifest.json"), JSON.stringify(candidate.release.manifest));
    await verifyInstalledNativeConnector(candidate.release, staged.directory, candidate.platform);
    const releaseId = `release-${basename(staged.directory).replace(/^\.candidate-/, "")}`;
    directory = join(candidate.root, "releases", releaseId);
    candidate.lock.assertOwned();
    await rename(staged.directory, directory);
    return { releaseId, directory };
  } catch (error) {
    await rm(directory ?? staged.directory, { recursive: true, force: true });
    throw error;
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
  return withRuntimeLocks(root, async ({ installer }) => {
    const current = await loadNativeInstallation(root, { roots, platform });
    if (current.record.releaseId === options.releaseId) return current.record;
    const release = await stagedRelease(join(root, "releases", options.releaseId), roots, platform, current.record);
    const successor = NativeRuntimeRecordSchema.parse({ ...current.record, releaseId: options.releaseId, bundleVersion: release.manifest.bundleVersion, manifestDigest: release.manifest.digest });
    await moveRecordAndManifest({ root, lock: installer, load: () => loadNativeInstallation(root, { roots, platform }), current: current.record, successor, manifest: release.manifest, corrupt: invalid });
    options.output.line(`Runtime record moved to ${options.releaseId} (${successor.bundleVersion}); ${current.record.releaseId} is kept for rollback.`);
    return successor;
  });
}

/** The staged release, strictly newer than the installed one and verified as an installable connector. */
async function stagedRelease(directory: string, roots: readonly EmbeddedReleaseRoot[], platform: NativePlatform, current: NativeRuntimeRecord): Promise<VerifiedNativeRelease> {
  const release = verifyNativeRelease(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")), roots);
  if (compareSemver(release.manifest.bundleVersion, current.bundleVersion) <= 0) throw new RemoteInstanceError("update_required", "Only a strictly newer signed release can be committed; stale or same-version releases are refused.");
  await verifyInstalledNativeConnector(release, directory, platform);
  return release;
}


function validRoot(value: string): string {
  const root = resolve(value);
  if (root === parse(root).root || root === resolve(homedir())) throw invalid();
  return root;
}
function invalid() { return new RemoteInstanceError("install_state_corrupt", "Native update cannot be completed; the installed release, identity and credentials were preserved."); }
