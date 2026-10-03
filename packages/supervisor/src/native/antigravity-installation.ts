import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import {
  fetchedAgentFolderName, fetchedAgentPin, fetchedAgentPlatformKey, hostAgentFamily, hostAgentVersionSupported,
  type FetchedAgentPlatformKey, type FetchedAgentPlatformPin, type FetchedAgentSigner,
} from "@konteks/remote-release";
import type { NativeRuntimeRecord } from "./installation.js";
import { downloadPinnedFile, extractZipEntry, FetchedArchiveError, freeDiskBytes, readZipEntries, verifyFetchedSignature } from "./fetched-archive.js";

/**
 * Google Antigravity's ACP server, fetched by the connector. Nobody
 * installs it: on the
 * person's yes the connector downloads Google's zip from the URL this runtime
 * release pins (`fetched-agents.json`), checks its size and sha256, unpacks it
 * with path checks, checks every file's size and sha256 and Google's
 * signature, and moves it into `<root>/agents/antigravity/<version>-<platform>/`
 * (folders 0700, files 0755, never on PATH, never under `<root>/credentials`).
 * Before every start the same checks run again, the hash cached per
 * file identity; any mismatch means the copy is never run.
 */

const ANTIGRAVITY_AGENT_ID = "antigravity";

/** Asked before anything is downloaded: onboarding, `agent add antigravity`, and the site's card. */
export const ANTIGRAVITY_CONSENT_TEXT = "Konteks will download Google Antigravity from Google's server (dl.google.com, about 110 MB, 400 MB on disk), check Google's signature, and keep it updated with Konteks updates. Google's terms apply to its use (antigravity.google/terms). Download it now? [y/N]";

/** A fetch needs about 1.2 GB (zip, unpacked copy, the previous version during an update); below 1.5 GB free it is refused. */
export const ANTIGRAVITY_MIN_FREE_BYTES = 1_500_000_000;

type Diagnostic = "antigravity_not_fetched" | "antigravity_unsupported_version" | "antigravity_unsafe_install" | "antigravity_no_disk_space" | "antigravity_unsupported_platform";

const ADD = "konteks-remote agent add antigravity";
const MESSAGES: Record<Diagnostic, string> = {
  antigravity_not_fetched: `Google Antigravity has not been downloaded to this computer. Run \`${ADD}\` to fetch it.`,
  antigravity_unsupported_version: `Google Antigravity on this computer is not the version this connector runs. Run \`${ADD}\` to fetch it again.`,
  antigravity_unsafe_install: `Google Antigravity on this computer does not match Google's release. Run \`${ADD}\` to fetch it again.`,
  antigravity_no_disk_space: "Google Antigravity needs about 1.2 GB free on this computer. Free some space, then try again.",
  antigravity_unsupported_platform: "Google Antigravity is not available for this computer yet.",
};

function refuse(diagnostic: Diagnostic, cause?: unknown): RemoteInstanceError {
  return new RemoteInstanceError("prerequisite_missing", MESSAGES[diagnostic], {
    diagnostic,
    // Nothing the person can run fixes a computer Google publishes no copy for.
    recoveryActions: diagnostic === "antigravity_unsupported_platform" ? [] : [{ kind: diagnostic === "antigravity_no_disk_space" ? "free_disk" : "install_backend", agentId: ANTIGRAVITY_AGENT_ID }],
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The one pin this computer runs: version, platform key and the platform's archive facts. */
export interface AntigravityPin {
  version: string;
  key: FetchedAgentPlatformKey;
  platform: FetchedAgentPlatformPin;
}

/** Replaceable pieces, for tests only (never from Core, ACP or the environment). */
export interface AntigravityInstallDeps {
  /** A pin other than this release's (tests' fixture archives). */
  pin?: AntigravityPin;
  /** Free bytes on the volume of a path. */
  freeBytes?: (path: string) => Promise<number>;
  /** The OS signature check (macOS `codesign`, Windows Authenticode). */
  verifySignature?: (file: string, signer: FetchedAgentSigner) => Promise<boolean>;
  /** Download settings: extra trust roots (a local HTTPS fixture) and the proxy environment. */
  download?: { ca?: string | Buffer; env?: NodeJS.ProcessEnv; idleTimeoutMs?: number };
}

/** This release's pin for this computer; refused when there is none. */
export function antigravityPin(deps: AntigravityInstallDeps = {}): AntigravityPin {
  return deps.pin ?? releasePin();
}

function releasePin(): AntigravityPin {
  const pin = fetchedAgentPin(ANTIGRAVITY_AGENT_ID);
  const key = fetchedAgentPlatformKey();
  const platform = key === null ? undefined : pin?.platforms[key];
  if (!pin || key === null || !platform) throw refuse("antigravity_unsupported_platform");
  // The pin and the family's accepted range come from the same release; a pin outside it is a build error.
  if (!hostAgentVersionSupported(hostAgentFamily(ANTIGRAVITY_AGENT_ID), pin.version)) throw refuse("antigravity_unsupported_version");
  return { version: pin.version, key, platform };
}
/** Where the connector keeps Antigravity: `<root>/agents/antigravity/` and the pinned version's folder in it. */
export function antigravityFolders(root: string, pin: Pick<AntigravityPin, "version" | "key">): { agents: string; base: string; version: string } {
  const agents = join(root, "agents");
  const base = join(agents, ANTIGRAVITY_AGENT_ID);
  return { agents, base, version: join(base, fetchedAgentFolderName(pin, pin.key)) };
}

/** The verified fetched server, as the runner launches it. */
interface NativeAntigravityInstallation {
  root: string;
  version: string;
  /** The executable the registry's `cmd` names, inside `root`. */
  command: string;
}

/**
 * Integrity before every start: the connector's folders are private and
 * the person's; the folder holds exactly the pinned files, each a plain file
 * with one link, owned by the person, writable only by them, of the pinned
 * size and sha256 and carrying the pinned signature. Hashes and signature
 * verdicts are cached per file identity (device, inode, size, modification
 * and change time), so an unchanged copy is not re-read, and any change is.
 */
export async function verifyNativeAntigravityFolder(root: string, deps: AntigravityInstallDeps = {}): Promise<NativeAntigravityInstallation> {
  const pin = antigravityPin(deps);
  const folders = antigravityFolders(root, pin);
  const exists = await lstat(folders.version).then(() => true, () => false);
  if (!exists) throw refuse("antigravity_not_fetched");
  try {
    await verifyFolderContents(folders, pin, deps);
  } catch (error) {
    if (error instanceof RemoteInstanceError) throw error;
    throw refuse("antigravity_unsafe_install", error);
  }
  return { root: folders.version, version: pin.version, command: join(folders.version, ...pin.platform.command.split("/")) };
}

async function verifyFolderContents(folders: { agents: string; base: string; version: string }, pin: AntigravityPin, deps: AntigravityInstallDeps): Promise<void> {
  for (const folder of [folders.agents, folders.base, folders.version]) {
    if (!privateDirectoryEntry(await lstat(folder))) throw refuse("antigravity_unsafe_install");
  }
  const expected = new Set(pin.platform.files.map(file => file.path));
  const found = await listFiles(folders.version);
  if (found.length !== expected.size || found.some(path => !expected.has(path))) throw refuse("antigravity_unsafe_install");
  const verifySignature = deps.verifySignature ?? ((file: string, signer: FetchedAgentSigner) => verifyFetchedSignature(file, signer));
  for (const file of pin.platform.files) {
    if (!await pinnedFileIntact(join(folders.version, ...file.path.split("/")), file, pin.platform.signer, verifySignature)) throw refuse("antigravity_unsafe_install");
  }
}

/** A plain, singly linked file the person owns, of the pinned size, sha256 and signature. */
async function pinnedFileIntact(
  path: string,
  file: AntigravityPin["platform"]["files"][number],
  signer: FetchedAgentSigner,
  verifySignature: (file: string, signer: FetchedAgentSigner) => Promise<boolean>,
): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || !personsFile(info) || info.size !== file.size) return false;
  if (await cachedSha256(path, info) !== file.sha256) return false;
  return cachedSignature(path, info, signer, verifySignature);
}
/** Every file under `folder` as a `/`-separated relative path; a link or special file refuses. */
async function listFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const info = await lstat(path);
        if (!privateFolder(info) && !personsFolder(info)) throw refuse("antigravity_unsafe_install");
        await walk(path);
      } else if (entry.isFile()) files.push(relative(folder, path).split(sep).join("/"));
      else throw refuse("antigravity_unsafe_install");
    }
  };
  await walk(folder);
  return files;
}

const posix = process.platform !== "win32";
function privateDirectoryEntry(info: Stats): boolean { return info.isDirectory() && privateFolder(info); }
function privateFolder(info: Stats): boolean { return !posix || (info.uid === process.getuid?.() && (info.mode & 0o077) === 0); }
function personsFolder(info: Stats): boolean { return !posix || (info.uid === process.getuid?.() && (info.mode & 0o022) === 0); }
function personsFile(info: Stats): boolean { return !posix || (info.uid === process.getuid?.() && (info.mode & 0o022) === 0); }

const identity = (path: string, info: Stats) => `${path}\u0000${info.dev}\u0000${info.ino}\u0000${info.size}\u0000${info.mtimeMs}\u0000${info.ctimeMs}`;
const hashes = new Map<string, string>();
const signatures = new Map<string, boolean>();
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

async function cachedSha256(path: string, info: Stats): Promise<string> {
  const key = identity(path, info);
  const known = hashes.get(key);
  if (known !== undefined) return known;
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
  } finally { await handle.close(); }
  const after = await lstat(path);
  // Changed while it was read: never cached, and read again next time.
  if (identity(path, after) !== key) return "";
  return remember(hashes, key, hash.digest("hex"));
}

async function cachedSignature(path: string, info: Stats, signer: FetchedAgentSigner, verify: (file: string, signer: FetchedAgentSigner) => Promise<boolean>): Promise<boolean> {
  const key = `${identity(path, info)}\u0000${JSON.stringify(signer)}`;
  const known = signatures.get(key);
  if (known !== undefined) return known;
  const verdict = await verify(path, signer);
  // Only a pass is remembered; a failure is checked afresh next time.
  return verdict ? remember(signatures, key, true) : false;
}

/** Forget cached verdicts (tests). */
export function clearAntigravityVerificationCache(): void {
  hashes.clear();
  signatures.clear();
}

/**
 * The install-record fields for the fetched copy in `root`, verified now
 * Never downloads: an absent copy reads "not fetched".
 */
export async function locateNativeAntigravity(root: string, deps: AntigravityInstallDeps = {}): Promise<Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot">> {
  const installation = await verifyNativeAntigravityFolder(root, deps);
  return { antigravityVersion: installation.version, antigravityRoot: installation.root };
}

/**
 * Every load: the recorded copy must be the one this release pins, in the
 * connector's own folder, and still verify. A record naming another version
 * (a runtime update carried a new pin) reads "unsupported version"
 * until the new copy is fetched.
 */
export async function verifyNativeAntigravityRecord(record: Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot">, root: string, deps: AntigravityInstallDeps = {}): Promise<NativeAntigravityInstallation> {
  const pin = antigravityPin(deps);
  if (record.antigravityVersion === undefined || record.antigravityRoot === undefined) throw refuse("antigravity_not_fetched");
  if (record.antigravityVersion !== pin.version) throw refuse("antigravity_unsupported_version");
  if (record.antigravityRoot !== antigravityFolders(root, pin).version) throw refuse("antigravity_unsafe_install");
  return verifyNativeAntigravityFolder(root, deps);
}

/**
 * Fetch the pinned copy on the person's yes. Nothing is downloaded
 * without `consent`; a copy that already verifies is kept as it is. Otherwise:
 * the disk budget, then the download into a private staging folder in
 * the connector's own folder over HTTPS from the pinned URL only, size and
 * sha256, the zip unpacked with path checks and nothing but the pinned files,
 * the zip deleted, every file verified with the signature, and the folder
 * moved into place in one rename. Any failure removes what it staged and
 * leaves a previous copy as it was; a previous copy that no longer verified
 * is replaced.
 */
export async function fetchNativeAntigravity(request: { root: string; consent: boolean }, deps: AntigravityInstallDeps = {}): Promise<Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot">> {
  if (request.consent !== true) throw new RemoteInstanceError("agent_unavailable", "Nothing was downloaded: Google Antigravity was not added.");
  const pin = antigravityPin(deps);
  const folders = antigravityFolders(request.root, pin);
  const current = await locateNativeAntigravity(request.root, deps).catch(() => null);
  if (current) return current;
  await privateDirectory(folders.agents);
  await privateDirectory(folders.base);
  const free = await (deps.freeBytes ?? freeDiskBytes)(folders.base);
  if (free < ANTIGRAVITY_MIN_FREE_BYTES) throw refuse("antigravity_no_disk_space");
  const staging = await mkdtemp(join(folders.base, ".fetch-"));
  const progress = { receivedBytes: 0, sizeBytes: pin.platform.archive.size };
  fetchesUnderWay.set(request.root, progress);
  try {
    await stagePinnedCopy({ pin, folders, staging, deps, onProgress: received => { progress.receivedBytes = received; } });
    await verifyOrRemove(request.root, folders.version, deps);
    return { antigravityVersion: pin.version, antigravityRoot: folders.version };
  } catch (error) {
    throw fetchFailure(error);
  } finally {
    if (fetchesUnderWay.get(request.root) === progress) fetchesUnderWay.delete(request.root);
    await rm(staging, { recursive: true, force: true });
  }
}

/** Download the pinned zip into `staging`, unpack exactly the pinned files, and move them into the version folder. */
async function stagePinnedCopy(stage: {
  pin: AntigravityPin;
  folders: { version: string };
  staging: string;
  deps: AntigravityInstallDeps;
  onProgress: (received: number) => void;
}): Promise<void> {
  const { pin, folders, staging, deps } = stage;
  const archive = join(staging, "archive.zip");
  const unpacked = join(staging, "unpacked");
  await downloadPinnedFile({ url: pin.platform.url, destination: archive, expected: pin.platform.archive, ...deps.download, onProgress: stage.onProgress });
  const entries = await readZipEntries(archive);
  const pinned = new Map(pin.platform.files.map(file => [file.path, file]));
  if (entries.length !== pinned.size || entries.some(entry => !pinned.has(entry.path))) throw new FetchedArchiveError("unsafe_archive", "the archive does not hold exactly the pinned files");
  await mkdir(unpacked, { mode: 0o700 });
  for (const entry of entries) await extractZipEntry(archive, entry, join(unpacked, ...entry.path.split("/")), pinned.get(entry.path)!);
  await rm(archive, { force: true });
  await chmod(unpacked, 0o700);
  // Verify where it will run from: the same checks as every start.
  if (await lstat(folders.version).then(() => true, () => false)) await rename(folders.version, join(staging, "stale"));
  await rename(unpacked, folders.version);
}

/** The moved copy must pass the start checks where it will run; one that does not is removed. */
async function verifyOrRemove(root: string, version: string, deps: AntigravityInstallDeps): Promise<void> {
  try {
    await verifyNativeAntigravityFolder(root, deps);
  } catch (error) {
    await rm(version, { recursive: true, force: true });
    throw error;
  }
}

function fetchFailure(error: unknown): unknown {
  if (error instanceof RemoteInstanceError) return error;
  const diagnostic: Diagnostic = error instanceof FetchedArchiveError && error.reason === "download_failed" ? "antigravity_not_fetched" : "antigravity_unsafe_install";
  return refuse(diagnostic, error);
}
/** Fetches running in this process, by connector root: what the site's "Downloading" line shows. */
const fetchesUnderWay = new Map<string, { receivedBytes: number; sizeBytes: number }>();

/** The running fetch into `root`, if any: bytes received of the pinned zip's size. */
function antigravityFetchProgress(root: string): { receivedBytes: number; sizeBytes: number } | undefined {
  const running = fetchesUnderWay.get(root);
  return running ? { ...running } : undefined;
}

/** A staging download written to this recently is a fetch still under way (another process's). */
const FETCH_ACTIVE_MS = 30_000;

/**
 * A fetch into `root` by this process or another one (`konteks-remote agent
 * add antigravity` downloads in the launcher while the service keeps
 * running): this process's own counter first, otherwise the size of a
 * staging download written to in the last 30 seconds. A staging folder a
 * crashed fetch left behind is older than that and never reads as running.
 */
export async function antigravityFetchUnderWay(root: string, deps: AntigravityInstallDeps = {}, now: number = Date.now()): Promise<{ receivedBytes: number; sizeBytes: number } | undefined> {
  const running = antigravityFetchProgress(root);
  if (running) return running;
  let pin: AntigravityPin;
  try { pin = antigravityPin(deps); } catch { return undefined; }
  const newest = await newestStagingDownload(antigravityFolders(root, pin).base, now);
  return newest ? { receivedBytes: Math.min(newest.size, pin.platform.archive.size), sizeBytes: pin.platform.archive.size } : undefined;
}

async function newestStagingDownload(base: string, now: number): Promise<Stats | undefined> {
  const entries = await readdir(base).catch(() => [] as string[]);
  let newest: Stats | undefined;
  for (const name of entries.filter(entry => entry.startsWith(".fetch-"))) {
    const info = await lstat(join(base, name, "archive.zip")).catch(() => undefined);
    if (recentDownload(info, now) && (!newest || info.mtimeMs > newest.mtimeMs)) newest = info;
  }
  return newest;
}

function recentDownload(info: Stats | undefined, now: number): info is Stats {
  return info?.isFile() === true && now - info.mtimeMs <= FETCH_ACTIVE_MS;
}
/** What the pinned copy takes on disk once unpacked (doctor's "disk used"). */
export function antigravityDiskBytes(pin: Pick<AntigravityPin, "platform">): number {
  return pin.platform.files.reduce((total, file) => total + file.size, 0);
}

/**
 * Remove every downloaded copy (the file part; signing out and the private
 * home are `agent remove antigravity`, antigravity-removal.ts). Sign-ins live
 * under `<root>/credentials`, which this never touches.
 */
export async function removeNativeAntigravity(root: string): Promise<void> {
  await rm(join(root, "agents", ANTIGRAVITY_AGENT_ID), { recursive: true, force: true });
}

/**
 * After an update switched to a new pin and the old copy's last process
 * exited: remove every version folder and leftover staging folder but `keep`.
 */
export async function pruneNativeAntigravity(root: string, keep: string): Promise<void> {
  const base = join(root, "agents", ANTIGRAVITY_AGENT_ID);
  const entries = await readdir(base).catch(() => [] as string[]);
  for (const name of entries) {
    const path = join(base, name);
    if (path !== keep) await rm(path, { recursive: true, force: true });
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (posix && info.uid !== process.getuid?.())) throw refuse("antigravity_unsafe_install");
  if (posix) await chmod(path, 0o700);
}
