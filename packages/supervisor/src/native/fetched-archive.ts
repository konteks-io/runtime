import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, mkdir, open, statfs } from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import * as zlib from "node:zlib";
import type { FetchedAgentSigner } from "@konteks/remote-release";

/**
 * The generic half of a fetched host agent (antigravity-runtime-support A2,
 * A15, A16, A19): download one pinned archive over HTTPS, read and unpack a
 * zip without trusting anything in it, check the OS signature a pin names,
 * and measure free disk space. Nothing here knows an agent; the pins and the
 * person-facing lines live in the agent's installation module.
 */

/** Why a fetch or an unpack was refused (the agent's module words it for the person). */
export type FetchedArchiveFailure = "download_failed" | "size_mismatch" | "digest_mismatch" | "unsafe_archive";

export class FetchedArchiveError extends Error {
  constructor(readonly reason: FetchedArchiveFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FetchedArchiveError";
  }
}

export interface FetchedDownloadOptions {
  /** The pinned https URL; redirects are followed only to https. */
  url: string;
  /** Absolute path of a file that must not exist yet (created 0600). */
  destination: string;
  expected: { size: number; sha256: string };
  /** Extra trust roots (a test's local HTTPS server); otherwise the system bundle plus NODE_EXTRA_CA_CERTS. */
  ca?: string | Buffer;
  /** Where proxy variables are read from (default: this process). */
  env?: NodeJS.ProcessEnv;
  /** Refused after this long without a byte (default 60 s). */
  idleTimeoutMs?: number;
  /** Told the bytes received so far as they arrive (the site's download line). */
  onProgress?: (receivedBytes: number) => void;
}

const MAX_REDIRECTS = 5;

/**
 * Download exactly the pinned bytes: https only, proxy variables honoured
 * (`HTTPS_PROXY`/`ALL_PROXY` and `NO_PROXY`, through an HTTP CONNECT tunnel),
 * no cookies or credentials sent, a declared length that differs from the
 * pin refused before anything is written, never more bytes than pinned, and
 * the sha256 checked at the end. A failure leaves the partial file for the
 * caller to remove with its staging folder.
 */
export async function downloadPinnedFile(options: FetchedDownloadOptions): Promise<void> {
  if (!isAbsolute(options.destination)) throw new FetchedArchiveError("download_failed", "the download destination must be absolute");
  const response = await get(new URL(options.url), options, MAX_REDIRECTS);
  const declared = response.headers["content-length"];
  if (declared !== undefined && Number(declared) !== options.expected.size) {
    response.destroy();
    throw new FetchedArchiveError("size_mismatch", `the server announced ${declared} bytes, the pin ${options.expected.size}`);
  }
  const handle = await open(options.destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.byteLength;
        if (size > options.expected.size) throw new FetchedArchiveError("size_mismatch", "the download is larger than the pin");
        hash.update(chunk);
        await handle.write(chunk);
        options.onProgress?.(size);
      }
    } catch (error) {
      if (error instanceof FetchedArchiveError) throw error;
      throw new FetchedArchiveError("download_failed", "the download was interrupted", { cause: error });
    }
    if (size !== options.expected.size) throw new FetchedArchiveError("size_mismatch", `received ${size} bytes, the pin ${options.expected.size}`);
    if (hash.digest("hex") !== options.expected.sha256) throw new FetchedArchiveError("digest_mismatch", "the download does not match the pinned sha256");
    await handle.sync();
  } finally {
    response.destroy();
    await handle.close();
  }
}

async function get(url: URL, options: FetchedDownloadOptions, redirectsLeft: number): Promise<IncomingMessage> {
  if (url.protocol !== "https:" || url.username || url.password) throw new FetchedArchiveError("download_failed", "only plain https downloads are allowed");
  const idle = options.idleTimeoutMs ?? 60_000;
  const proxy = proxyFor(url, options.env ?? process.env);
  const socket = proxy ? await tunnel(proxy, url, idle) : undefined;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req: ClientRequest = httpsRequest(url, {
      method: "GET",
      headers: { "user-agent": "konteks-connector", accept: "application/octet-stream, application/zip, */*" },
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      // With `createConnection` and no agent, the request runs on our TLS
      // session inside the proxy tunnel.
      ...(socket === undefined ? {} : {
        createConnection: () => tlsConnect({ socket, servername: url.hostname, ...(options.ca === undefined ? {} : { ca: options.ca }) }),
      }),
    }, resolve);
    req.setTimeout(idle, () => req.destroy(new Error("no response from the download server")));
    req.on("error", error => reject(new FetchedArchiveError("download_failed", "the download server could not be reached", { cause: error })));
    req.end();
  });
  response.socket?.setTimeout(idle, () => response.destroy(new Error("the download stalled")));
  const status = response.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location;
    response.resume();
    if (!location || redirectsLeft <= 0) throw new FetchedArchiveError("download_failed", "too many or empty redirects");
    return get(new URL(location, url), options, redirectsLeft - 1);
  }
  if (status !== 200) {
    response.resume();
    throw new FetchedArchiveError("download_failed", `the download server answered ${status}`);
  }
  return response;
}

/** The proxy for an https URL from the standard variables, unless `NO_PROXY` covers its host. */
export function proxyFor(url: URL, env: NodeJS.ProcessEnv): URL | null {
  const value = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!value) return null;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(/[\s,]+/).map(entry => entry.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  for (const entry of noProxy) {
    if (entry === "*") return null;
    const bare = entry.replace(/:\d+$/, "").replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  let proxy: URL;
  try { proxy = new URL(value.includes("://") ? value : `http://${value}`); } catch { throw new FetchedArchiveError("download_failed", "the proxy setting is not a URL"); }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new FetchedArchiveError("download_failed", "only http and https proxies are supported");
  return proxy;
}

/** An HTTP CONNECT tunnel to `target` through `proxy`; the TLS session to the target runs inside it. */
async function tunnel(proxy: URL, target: URL, idle: number): Promise<import("node:net").Socket> {
  const authority = `${target.hostname}:${target.port || 443}`;
  const headers: Record<string, string> = { host: authority };
  if (proxy.username) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
  const requestFn = proxy.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn({ host: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80), method: "CONNECT", path: authority, headers, agent: false });
    req.setTimeout(idle, () => req.destroy(new Error("the proxy did not answer")));
    req.on("connect", (response: IncomingMessage, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new FetchedArchiveError("download_failed", `the proxy refused the connection (${response.statusCode})`));
        return;
      }
      resolve(socket);
    });
    req.on("error", error => reject(new FetchedArchiveError("download_failed", "the proxy could not be reached", { cause: error })));
    req.end();
  });
}

/** One file entry of a zip, as its central directory and local header describe it. */
export interface ZipFileEntry {
  /** The plain relative path (checked). */
  path: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc32: number;
  /** Where its compressed bytes start in the archive. */
  dataOffset: number;
  /** Unix permission bits the archive recorded (0 when none). */
  mode: number;
}

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX_ENTRIES = 256;
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function unsafe(message: string): FetchedArchiveError { return new FetchedArchiveError("unsafe_archive", message); }

/** A plain relative path: no absolute path, drive, backslash, empty, `.` or `..` segment, or control character. */
export function safeArchivePath(name: string): boolean {
  if (name.length === 0 || name.length > 255 || CONTROL.test(name) || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return name.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The file entries of a zip, refusing anything that could escape or deceive:
 * zip64, spanned or encrypted archives, methods other than stored or
 * deflate, absolute or `..` paths, backslashes, symbolic links and other
 * special files, duplicate names (case-insensitively), local headers that
 * disagree with the central directory, and data ranges that overlap.
 * Directory entries are checked and dropped (folders are made as needed).
 */
export async function readZipEntries(archive: string): Promise<ZipFileEntry[]> {
  const handle = await open(archive, constants.O_RDONLY);
  try {
    const { size } = await handle.stat();
    if (size < 22) throw unsafe("not a zip archive");
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let index = tailLength - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD && tail.readUInt16LE(index + 20) === tailLength - index - 22) { eocd = index; break; }
    }
    if (eocd < 0) throw unsafe("no end of central directory");
    const disk = tail.readUInt16LE(eocd + 4), cdDisk = tail.readUInt16LE(eocd + 6);
    const onDisk = tail.readUInt16LE(eocd + 8), total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    const eocdOffset = size - tailLength + eocd;
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw unsafe("spanned archives are not accepted");
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw unsafe("zip64 archives are not accepted");
    if (total > MAX_ENTRIES || cdOffset + cdSize !== eocdOffset) throw unsafe("the central directory is not where the archive says");
    const central = Buffer.alloc(cdSize);
    await handle.read(central, 0, cdSize, cdOffset);
    const entries: ZipFileEntry[] = [];
    const seen = new Set<string>();
    const ranges: Array<[number, number]> = [];
    let at = 0;
    for (let index = 0; index < total; index += 1) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== CENTRAL) throw unsafe("a central directory entry is damaged");
      const host = central.readUInt8(at + 5);
      const flags = central.readUInt16LE(at + 8), method = central.readUInt16LE(at + 10);
      const crc32 = central.readUInt32LE(at + 16), compressedSize = central.readUInt32LE(at + 20), uncompressed = central.readUInt32LE(at + 24);
      const nameLength = central.readUInt16LE(at + 28), extraLength = central.readUInt16LE(at + 30), commentLength = central.readUInt16LE(at + 32);
      const diskStart = central.readUInt16LE(at + 34), external = central.readUInt32LE(at + 38), localOffset = central.readUInt32LE(at + 42);
      const end = at + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw unsafe("a central directory entry is damaged");
      const rawName = central.subarray(at + 46, at + 46 + nameLength);
      at = end;
      if (flags & 0x41) throw unsafe("encrypted entries are not accepted");
      if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw unsafe("zip64 entries are not accepted");
      if (method !== 0 && method !== 8) throw unsafe("an entry uses an unsupported compression method");
      const name = (flags & 0x800) ? new TextDecoder("utf-8", { fatal: true }).decode(rawName) : rawName.toString("latin1");
      const unixMode = host === 3 ? external >>> 16 : 0;
      const type = unixMode & S_IFMT;
      const directory = name.endsWith("/") || type === S_IFDIR || (host !== 3 && (external & 0x10) !== 0);
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw unsafe(`${JSON.stringify(name)} is a link or special file`);
      const path = directory ? name.replace(/\/$/, "") : name;
      if (!safeArchivePath(path)) throw unsafe(`${JSON.stringify(name)} is not a plain relative path`);
      const key = path.toLowerCase();
      if (seen.has(key)) throw unsafe(`${JSON.stringify(name)} appears twice`);
      seen.add(key);
      if (directory) {
        if (uncompressed !== 0 || type === S_IFREG) throw unsafe(`${JSON.stringify(name)} is not a plain folder`);
        continue;
      }
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, localOffset);
      if (localOffset + 30 > cdOffset || local.readUInt32LE(0) !== LOCAL) throw unsafe(`${JSON.stringify(name)} has no local header`);
      const localName = Buffer.alloc(local.readUInt16LE(26));
      await handle.read(localName, 0, localName.length, localOffset + 30);
      if (!localName.equals(rawName) || local.readUInt16LE(8) !== method || (local.readUInt16LE(6) & 0x41)) throw unsafe(`${JSON.stringify(name)} disagrees with its local header`);
      const dataOffset = localOffset + 30 + localName.length + local.readUInt16LE(28);
      if (dataOffset + compressedSize > cdOffset) throw unsafe(`${JSON.stringify(name)} runs past the archive's data`);
      ranges.push([localOffset, dataOffset + compressedSize]);
      entries.push({ path, method: method as 0 | 8, compressedSize, size: uncompressed, crc32, dataOffset, mode: unixMode & 0o7777 });
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < ranges.length; index += 1) if (ranges[index]![0] < ranges[index - 1]![1]) throw unsafe("two entries share bytes");
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Unpack one entry to `destination` (created exclusively, parents 0700),
 * never writing more than `expected.size` bytes, and check its size, CRC and
 * sha256. Files with any execute bit in the archive become 0755, others 0644.
 */
export async function extractZipEntry(archive: string, entry: ZipFileEntry, destination: string, expected: { size: number; sha256: string }): Promise<void> {
  if (entry.size !== expected.size) throw new FetchedArchiveError("size_mismatch", `${entry.path} is not the pinned size`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash("sha256");
  const crc = (zlib as { crc32?: (data: Buffer, value?: number) => number }).crc32;
  let crcValue = 0;
  let size = 0;
  const input = createReadStream(archive, { start: entry.dataOffset, end: entry.dataOffset + Math.max(entry.compressedSize, 1) - 1 });
  const source = entry.compressedSize === 0 ? null : entry.method === 8 ? input.pipe(zlib.createInflateRaw()) : input;
  if (source !== null && source !== input) input.on("error", error => source.destroy(error));
  try {
    if (source !== null) {
      try {
        for await (const chunk of source as AsyncIterable<Buffer>) {
          size += chunk.byteLength;
          if (size > expected.size) throw new FetchedArchiveError("size_mismatch", `${entry.path} unpacks larger than pinned`);
          hash.update(chunk);
          if (crc) crcValue = crc(chunk, crcValue);
          await handle.write(chunk);
        }
      } catch (error) {
        if (error instanceof FetchedArchiveError) throw error;
        throw unsafe(`${entry.path} could not be unpacked`);
      }
    }
    if (size !== expected.size) throw new FetchedArchiveError("size_mismatch", `${entry.path} is not the pinned size`);
    if (crc && (crcValue >>> 0) !== entry.crc32) throw unsafe(`${entry.path} fails its CRC`);
    if (hash.digest("hex") !== expected.sha256) throw new FetchedArchiveError("digest_mismatch", `${entry.path} does not match the pinned sha256`);
    await handle.sync();
  } finally {
    input.destroy();
    await handle.close();
  }
  await chmod(destination, entry.mode & 0o111 ? 0o755 : 0o644);
}

/** Free bytes for this user on the volume holding `path`. */
export async function freeDiskBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Whether `file` carries the signature a pin names: macOS `codesign --verify
 * --strict` under Apple's anchor with the pinned Team ID; Windows Authenticode
 * status `Valid` with the pinned subject; Linux nothing (the hashes are the
 * whole check). A signer for another OS than this one never passes.
 */
export async function verifyFetchedSignature(file: string, signer: FetchedAgentSigner, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (signer.kind === "none") return true;
  if (signer.kind === "apple_team_id") {
    if (platform !== "darwin") return false;
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${signer.teamId}"`;
    return run("/usr/bin/codesign", ["--verify", "--strict", `-R${requirement}`, file]).then(result => result.ok);
  }
  if (platform !== "win32") return false;
  const quoted = file.replace(/'/g, "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${quoted}'; [Console]::Out.Write($s.Status.ToString() + "|" + $s.SignerCertificate.Subject)`;
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  return result.ok && result.stdout === `Valid|${signer.subject}`;
}

function run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    execFile(command, args, { env: { PATH: process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin", ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      timeout: 180_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout).trim() }));
  });
}
