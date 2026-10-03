import { createHash } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createGunzip } from "node:zlib";
import type { RemoteNativeArtifact } from "@konteks/remote-common";
import { OFFLINE_AGENT_LIMITS, OFFLINE_AGENT_PROFILE_FILE, offlinePackageInvalid, readNativeAgentProfile, type NativeAgentPackageProfile } from "./offline-profile.js";

/** Extract only the authenticated, complete inventory; never invoke a package manager. */
export async function installOfflineAgentPackage(archive: string, destination: string, artifact: RemoteNativeArtifact): Promise<NativeAgentPackageProfile> {
  if (!isAbsolute(destination)) throw offlinePackageInvalid();
  await verifyFile(archive, artifact.digest, artifact.sizeBytes, false);
  await mkdir(destination, { mode: 0o700 }); // Exclusive: never merge into live code.
  const input = createReadStream(archive), unzip = createGunzip();
  input.on("error", error => unzip.destroy(error)); input.pipe(unzip);
  const reader = new TarReader(unzip[Symbol.asyncIterator]());
  try {
    const profile = await extractProfile(reader, destination, artifact);
    for (const file of profile.files) await extractInventoryFile(reader, destination, file);
    if ((await reader.read(1024)).some(byte => byte !== 0)) throw offlinePackageInvalid();
    await reader.end();
    return await verifyOfflineAgentPackage(destination, artifact);
  } catch {
    await rm(destination, { recursive: true, force: true });
    throw offlinePackageInvalid();
  } finally { input.destroy(); unzip.destroy(); }
}

/** The profile entry, which must come first, read against the signed artifact. */
async function extractProfile(reader: TarReader, destination: string, artifact: RemoteNativeArtifact): Promise<NativeAgentPackageProfile> {
  const first = header(await reader.read(512));
  if (first.path !== OFFLINE_AGENT_PROFILE_FILE || first.size > OFFLINE_AGENT_LIMITS.profileBytes) throw offlinePackageInvalid();
  const receipt = await reader.read(first.size);
  await reader.padding(first.size);
  const profile = readNativeAgentProfile(receipt, artifact);
  await writeFileChunks(join(destination, OFFLINE_AGENT_PROFILE_FILE), receipt);
  return profile;
}

/** The next archive entry, which must be exactly this inventoried file. */
async function extractInventoryFile(reader: TarReader, destination: string, file: NativeAgentPackageProfile["files"][number]): Promise<void> {
  const next = header(await reader.read(512));
  if (next.path !== file.path || next.size !== file.sizeBytes) throw offlinePackageInvalid();
  const target = join(destination, ...file.path.split("/"));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, "wx", 0o600);
  const digest = createHash("sha256");
  try {
    let remaining = file.sizeBytes;
    while (remaining > 0) {
      const chunk = await reader.read(Math.min(64 * 1024, remaining));
      digest.update(chunk); await handle.writeFile(chunk); remaining -= chunk.length;
    }
    if (`sha256:${digest.digest("hex")}` !== file.digest) throw offlinePackageInvalid();
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(target, file.executable ? 0o700 : 0o600);
  await reader.padding(file.sizeBytes);
}

/** Rehash every dependency, not just the bridge/auth entrypoint or a local marker. */
export async function verifyOfflineAgentPackage(directory: string, artifact: RemoteNativeArtifact): Promise<NativeAgentPackageProfile> {
  try {
    await privateDirectory(directory);
    const profile = await readInstalledProfile(directory, artifact);
    const expected = new Set([OFFLINE_AGENT_PROFILE_FILE, ...profile.files.map(file => file.path)]);
    const directories = parentDirectories(expected);
    await walk(directory, "", expected, directories);
    if (expected.size !== 0 || directories.size !== 0) throw offlinePackageInvalid();
    for (const file of profile.files) await verifyFile(join(directory, ...file.path.split("/")), file.digest, file.sizeBytes, file.executable);
    return profile;
  } catch { throw offlinePackageInvalid(); }
}

async function readInstalledProfile(directory: string, artifact: RemoteNativeArtifact): Promise<NativeAgentPackageProfile> {
  const receiptPath = join(directory, OFFLINE_AGENT_PROFILE_FILE);
  const info = await lstat(receiptPath);
  if (!info.isFile() || info.nlink !== 1 || info.size > OFFLINE_AGENT_LIMITS.profileBytes) throw offlinePackageInvalid();
  const receipt = await readFile(receiptPath);
  const profile = readNativeAgentProfile(receipt, artifact);
  await verifyFile(receiptPath, artifact.profileDigest!, receipt.length, false);
  return profile;
}

/** Every directory the inventoried paths need. */
function parentDirectories(paths: Iterable<string>): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join("/"));
  }
  return directories;
}

/**
 * A cheap stat fingerprint of an unpacked package: entry count, total file
 * bytes, the newest mtime or ctime of any entry (root included) and the
 * root's identity. Any write, rename, chmod, added or removed file moves at
 * least one of these; ctime cannot be set back by the owning user.
 */
async function offlineAgentPackageFingerprint(directory: string): Promise<string> {
  const root = await lstat(directory, { bigint: true });
  if (!root.isDirectory()) throw offlinePackageInvalid();
  let entries = 0n, bytes = 0n, newest = latest(root.mtimeNs, root.ctimeNs);
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of await readdir(current)) {
      const path = join(current, name);
      const info = await lstat(path, { bigint: true });
      entries += 1n;
      if (info.isFile()) bytes += info.size;
      newest = latest(newest, info.mtimeNs, info.ctimeNs);
      if (info.isDirectory()) pending.push(path);
    }
  }
  return `${root.dev}:${root.ino}:${entries}:${bytes}:${newest}`;
}

function latest(...values: bigint[]): bigint {
  return values.reduce((max, value) => (value > max ? value : max));
}

/** Successful full verifications this process has made, per package and digest. */
const verifiedPackages = new Map<string, { fingerprint: string; profile: NativeAgentPackageProfile }>();

/**
 * Full integrity check on first use, then only while the package is unchanged
 * a stat fingerprint: rehashing a 400 MB agent every turn cost ~12 s.
 * A changed fingerprint, another artifact (digest) or another path verifies in
 * full again; a failure is never remembered.
 */
export async function verifyOfflineAgentPackageOnce(directory: string, artifact: RemoteNativeArtifact): Promise<{ profile: NativeAgentPackageProfile; cached: boolean }> {
  const key = JSON.stringify([directory, artifact]);
  const known = verifiedPackages.get(key);
  let before: string;
  try { before = await offlineAgentPackageFingerprint(directory); }
  catch { verifiedPackages.delete(key); throw offlinePackageInvalid(); }
  if (known && known.fingerprint === before) return { profile: structuredClone(known.profile), cached: true };
  verifiedPackages.delete(key);
  const profile = await verifyOfflineAgentPackage(directory, artifact);
  // Remember only a package that did not move while it was being hashed.
  const after = await offlineAgentPackageFingerprint(directory).catch(() => null);
  if (after === before) verifiedPackages.set(key, { fingerprint: after, profile: structuredClone(profile) });
  return { profile, cached: false };
}

/** Test seam: forget every remembered verification. */
export function forgetVerifiedOfflineAgentPackages(): void { verifiedPackages.clear(); }

async function walk(root: string, relative: string, expected: Set<string>, directories: Set<string>): Promise<void> {
  const directory = relative ? join(root, ...relative.split("/")) : root;
  await privateDirectory(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!directories.delete(path)) throw offlinePackageInvalid();
      await walk(root, path, expected, directories);
    } else if (!entry.isFile() || !expected.delete(path)) throw offlinePackageInvalid();
  }
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw offlinePackageInvalid();
}

async function verifyFile(path: string, digest: string, size: number, executable: boolean): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size !== size || !privateFileMode(before, executable)) throw offlinePackageInvalid();
  const handle = await open(path, OPEN_NO_FOLLOW);
  try {
    if (!sameFile(await handle.stat(), before)) throw offlinePackageInvalid();
    const actual = await hashOpenFile(handle, size);
    if (actual !== digest || !unchangedSince(before, await handle.stat(), await lstat(path))) throw offlinePackageInvalid();
  } finally { await handle.close(); }
}

const OPEN_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Neither the open file nor the name changed while it was hashed. */
function unchangedSince(before: Stats, after: Stats, named: Stats): boolean {
  return after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && sameFile(named, before);
}

/** Owner-only and owned by this user (an executable also owner-executable); Windows has no such modes. */
function privateFileMode(info: Stats, executable: boolean): boolean {
  if (process.platform === "win32") return true;
  return (info.mode & 0o077) === 0 && info.uid === process.getuid?.() && (!executable || (info.mode & 0o100) !== 0);
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

/** The file's digest, refusing more or fewer than `size` bytes. */
async function hashOpenFile(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256"); let actual = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    actual += chunk.length; if (actual > size) throw offlinePackageInvalid(); hash.update(chunk);
  }
  if (actual !== size) throw offlinePackageInvalid();
  return `sha256:${hash.digest("hex")}`;
}

async function writeFileChunks(path: string, bytes: Buffer) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Minimal restricted USTAR reader: rejects links/extensions instead of interpreting them. */
function header(block: Buffer): { path: string; size: number } {
  const string = (offset: number, length: number) => {
    const bytes = block.subarray(offset, offset + length), end = bytes.indexOf(0);
    if (end !== -1 && bytes.subarray(end).some(byte => byte !== 0)) throw offlinePackageInvalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(end === -1 ? bytes : bytes.subarray(0, end));
  };
  const octal = (offset: number, length: number) => {
    const value = block.subarray(offset, offset + length).toString("ascii").replace(/[\0 ]+$/g, "");
    if (!/^[0-7]+$/.test(value)) throw offlinePackageInvalid();
    return Number.parseInt(value, 8);
  };
  if (block[156] !== 48 || string(257, 6) !== "ustar" || block.subarray(157, 257).some(byte => byte !== 0)) throw offlinePackageInvalid();
  const checksum = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (octal(148, 8) !== checksum) throw offlinePackageInvalid();
  const prefix = string(345, 155), name = string(0, 100);
  const size = octal(124, 12);
  if (size > OFFLINE_AGENT_LIMITS.bytes) throw offlinePackageInvalid();
  return { path: prefix ? `${prefix}/${name}` : name, size };
}

class TarReader {
  private buffer: Buffer = Buffer.alloc(0);
  private consumed = 0;
  constructor(private readonly iterator: AsyncIterator<Buffer>) {}
  async read(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      const next = await this.iterator.next();
      if (next.done) throw offlinePackageInvalid();
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
    const output = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length);
    this.consumed += length;
    if (this.consumed > OFFLINE_AGENT_LIMITS.bytes + OFFLINE_AGENT_LIMITS.profileBytes + OFFLINE_AGENT_LIMITS.files * 1024 + 2048) throw offlinePackageInvalid();
    return output;
  }
  async padding(size: number): Promise<void> { if ((await this.read((512 - size % 512) % 512)).some(byte => byte !== 0)) throw offlinePackageInvalid(); }
  async end(): Promise<void> {
    // A bounded final tar record pad is allowed; no trailing archive or hidden bytes.
    let padding = this.buffer.length;
    if (this.buffer.some(byte => byte !== 0)) throw offlinePackageInvalid();
    for (;;) {
      const next = await this.iterator.next(); if (next.done) break;
      padding += next.value.length;
      if (padding > 10_240 || next.value.some(byte => byte !== 0)) throw offlinePackageInvalid();
    }
    if (padding > 10_240) throw offlinePackageInvalid();
  }
}
