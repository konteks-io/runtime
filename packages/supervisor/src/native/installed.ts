import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { RemoteInstanceError, type RemoteNativeArtifact } from "@konteks/remote-common";
import { isHostAgentId, presentNativeConnectorExecutables, selectNativeArtifacts, verifyOfflineAgentPackage, type VerifiedNativeRelease } from "@konteks/remote-release";
import type { RunnerConfig } from "@konteks/remote-agent-runner";

/** Verify the complete installed package before any native bridge is spawned. */
export async function verifyInstalledNativeBridges(release: VerifiedNativeRelease, runners: readonly RunnerConfig[], platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64" }): Promise<void> {
  // No agent yet is a machine connected before any was set up (OS14, D116): nothing to verify.
  if (runners.length === 0) return;
  // Host-installed agents are verified against their local package at load,
  // and intentionally have no signed offline bridge artifact in the release.
  const bundled = runners.filter(runner => !isHostAgentId(runner.RUNNER_AGENT_ID));
  if (bundled.length === 0) return;
  const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: bundled.map(runner => runner.RUNNER_AGENT_ID) });
  for (const runner of bundled) {
    const artifact = artifacts.find(candidate => candidate.agentId === runner.RUNNER_AGENT_ID);
    if (artifact?.format === "offline_agent_tgz") {
      const profile = await verifyOfflineAgentPackage(runner.RUNNER_BRIDGE_PREFIX, artifact);
      if (JSON.stringify(profile) !== JSON.stringify(runner.RUNNER_NATIVE_PACKAGE_PROFILE) || JSON.stringify(artifact) !== JSON.stringify(runner.RUNNER_NATIVE_PACKAGE_ARTIFACT)) throw untrusted();
      continue;
    }
    // A historical bridge-only executable cannot establish official auth tooling.
    throw untrusted();
  }
}

/**
 * The OS service target is verified as well as the bridges it will launch.
 * A release folder holds `konteks-connector`, the pre-rename `connector`, or
 * both (the transition copy older launchers run); every one present must be
 * the signed executable, and at least one must be.
 */
export async function verifyInstalledNativeConnector(release: VerifiedNativeRelease, directory: string, platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64" }): Promise<void> {
  const artifact = selectNativeArtifacts(release, { ...platform, agentIds: [] })[0]!;
  if (artifact.format !== "executable") throw untrusted();
  const present = await presentNativeConnectorExecutables(directory, platform.os);
  if (present.length === 0) throw untrusted();
  for (const path of present) await verifyExecutable(path, artifact);
}

async function verifyExecutable(path: string, artifact: RemoteNativeArtifact): Promise<void> {
  try {
    const info = await lstat(path);
    if (!plainArtifactFile(info, artifact)) throw untrusted();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await verifyOpenedContent(handle, info, artifact);
    } finally { await handle.close(); }
  } catch { throw untrusted(); }
}

/** One plain link of the artifact's size; outside Windows not group or world writable, and executable by its owner. */
function plainArtifactFile(info: Stats, artifact: RemoteNativeArtifact): boolean {
  if (!info.isFile() || info.nlink !== 1 || info.size !== artifact.sizeBytes) return false;
  return process.platform === "win32" || ((info.mode & 0o022) === 0 && (info.mode & 0o100) !== 0);
}

/** The opened file is the one inspected, and its bytes are exactly the artifact's. */
async function verifyOpenedContent(handle: FileHandle, info: Stats, artifact: RemoteNativeArtifact): Promise<void> {
  const opened = await handle.stat();
  if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw untrusted();
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    size += chunk.length;
    if (size > artifact.sizeBytes) throw untrusted();
    hash.update(chunk);
  }
  if (size !== artifact.sizeBytes || `sha256:${hash.digest("hex")}` !== artifact.digest) throw untrusted();
}

function untrusted() { return new RemoteInstanceError("bundle_untrusted", "Installed native bridges do not match the signed executable release."); }
