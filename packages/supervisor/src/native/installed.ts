import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { RemoteInstanceError, type RemoteNativeArtifact } from "@konteks/remote-common";
import { presentNativeConnectorExecutables, selectNativeArtifacts, type VerifiedNativeRelease } from "@konteks/remote-release";
import type { RunnerConfig } from "@konteks/remote-agent-runner";
import { NativeBridgeVerification } from "./bridge-verification.js";

/** Verify the complete installed package before any native bridge is spawned. */
export async function verifyInstalledNativeBridges(release: VerifiedNativeRelease, runners: readonly RunnerConfig[], platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64" }): Promise<void> {
  const verification = new NativeBridgeVerification();
  await verification.verifyRunners(release, runners, platform);
  await verification.complete();
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
