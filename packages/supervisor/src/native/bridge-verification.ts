import { createHash, type Hash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RemoteInstanceError, type RemoteNativeArtifact } from "@konteks/remote-common";
import type { RunnerConfig } from "@konteks/remote-agent-runner";
import { isHostAgentId, OFFLINE_AGENT_LIMITS, selectNativeArtifacts, verifyOfflineAgentPackage, type NativeAgentPackageProfile, type VerifiedNativeRelease } from "@konteks/remote-release";

type Platform = { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64" };
type PackageProof = { artifact: string; fingerprint: string; profile: NativeAgentPackageProfile };

/** One installation load's full verifications, usable only while every physical entry is unchanged. */
export class NativeBridgeVerification {
  private readonly packages = new Map<string, PackageProof>();
  private closed = false;

  async verifyPackage(directory: string, artifact: RemoteNativeArtifact): Promise<NativeAgentPackageProfile> {
    this.assertOpen();
    const binding = JSON.stringify(artifact), known = this.packages.get(directory);
    const before = await packageFingerprint(directory);
    if (known) {
      if (known.artifact !== binding || known.fingerprint !== before) throw untrusted();
      return structuredClone(known.profile);
    }
    const profile = await verifyOfflineAgentPackage(directory, structuredClone(artifact));
    const after = await packageFingerprint(directory);
    if (before !== after || JSON.stringify(artifact) !== binding) throw untrusted();
    this.packages.set(directory, { artifact: binding, fingerprint: after, profile: structuredClone(profile) });
    return structuredClone(profile);
  }

  async verifyRunners(release: VerifiedNativeRelease, runners: readonly RunnerConfig[], platform: Platform): Promise<void> {
    this.assertOpen();
    const bundled = runners.filter(runner => !isHostAgentId(runner.RUNNER_AGENT_ID));
    if (bundled.length === 0) return;
    const artifacts = selectNativeArtifacts(release, { ...platform, agentIds: bundled.map(runner => runner.RUNNER_AGENT_ID) });
    for (const runner of bundled) {
      const artifact = artifacts.find(candidate => candidate.agentId === runner.RUNNER_AGENT_ID);
      // A historical bridge-only executable cannot establish official auth tooling.
      if (artifact?.format !== "offline_agent_tgz") throw untrusted();
      const profile = await this.verifyPackage(runner.RUNNER_BRIDGE_PREFIX, artifact);
      if (JSON.stringify(profile) !== JSON.stringify(runner.RUNNER_NATIVE_PACKAGE_PROFILE) || JSON.stringify(artifact) !== JSON.stringify(runner.RUNNER_NATIVE_PACKAGE_ARTIFACT)) throw untrusted();
    }
  }

  /** Final fence after the loader's other awaits; no proof survives this load. */
  async complete(): Promise<void> {
    this.assertOpen();
    try {
      for (const [directory, proof] of this.packages) {
        if (await packageFingerprint(directory) !== proof.fingerprint) throw untrusted();
      }
    } finally {
      this.closed = true;
      this.packages.clear();
    }
  }

  private assertOpen(): void { if (this.closed) throw untrusted(); }
}

type FingerprintBudget = { files: number; directories: number; bytes: bigint };

/** Stream every name and physical identity; maxima cannot hide a changed older entry. */
async function packageFingerprint(directory: string): Promise<string> {
  try {
    const hash = createHash("sha256"), budget: FingerprintBudget = { files: 0, directories: 0, bytes: 0n };
    await fingerprintEntry(directory, "", hash, budget);
    return hash.digest("hex");
  } catch { throw untrusted(); }
}

async function fingerprintEntry(root: string, relative: string, hash: Hash, budget: FingerprintBudget): Promise<void> {
  // The signed inventory admits at most 240 UTF-8 bytes per relative path.
  if (Buffer.byteLength(relative, "utf8") > 240) throw untrusted();
  const path = join(root, ...relative.split("/")), before = await lstat(path, { bigint: true });
  countEntry(before, budget);
  const identity = entryIdentity(relative, before);
  hash.update(identity);
  if (before.isDirectory()) {
    for (const name of (await readdir(path)).sort()) {
      await fingerprintEntry(root, relative ? `${relative}/${name}` : name, hash, budget);
    }
    if (entryIdentity(relative, await lstat(path, { bigint: true })) !== identity) throw untrusted();
  }
}

/** The profile adds one file; canonical 240-byte paths can have at most 119 parent segments. */
function countEntry(info: BigIntStats, budget: FingerprintBudget): void {
  if (info.isFile()) {
    budget.files++; budget.bytes += info.size;
    if (info.nlink !== 1n || budget.files > OFFLINE_AGENT_LIMITS.files + 1 || budget.bytes > BigInt(OFFLINE_AGENT_LIMITS.bytes + OFFLINE_AGENT_LIMITS.profileBytes)) throw untrusted();
    return;
  }
  if (!info.isDirectory() || ++budget.directories > OFFLINE_AGENT_LIMITS.files * 120 + 1) throw untrusted();
}

function entryIdentity(relative: string, info: BigIntStats): string {
  return JSON.stringify([relative, ...[info.dev, info.ino, info.nlink, info.mode, info.uid, info.gid, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].map(value => value.toString())]);
}

function untrusted() { return new RemoteInstanceError("bundle_untrusted", "Installed native bridges do not match the signed executable release."); }
