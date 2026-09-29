import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RunnerConfigSchema } from "@konteks/remote-agent-runner";
import {
  ANTIGRAVITY_CONSENT_TEXT, ANTIGRAVITY_MIN_FREE_BYTES, antigravityFolders, antigravityPin, clearAntigravityVerificationCache,
  fetchNativeAntigravity, locateNativeAntigravity, pruneNativeAntigravity, removeNativeAntigravity,
  verifyNativeAntigravityFolder, verifyNativeAntigravityRecord, type AntigravityInstallDeps, type AntigravityPin,
} from "../native/antigravity-installation.js";
import { proxyFor, readZipEntries, safeArchivePath, verifyFetchedSignature } from "../native/fetched-archive.js";
import { antigravityDownloadState } from "../native/antigravity-download.js";
import { HostAgentDownloadSchema } from "@konteks/remote-common";
import { antigravityInstallAdapter, hostAgentInstallAdapter, nativeAgentOffered } from "../native/host-agents.js";
import { antigravityDiskBytes, antigravityFetchUnderWay } from "../native/antigravity-installation.js";
import { antigravityUpdateNeeded, recordFetchedAntigravity, updateNativeAntigravity } from "../native/antigravity-update.js";
import { deleteNativeAntigravity, signOutNativeAntigravity } from "../native/antigravity-removal.js";
import { NativeRuntimeRecordSchema, type NativeRuntimeRecord } from "../native/installation.js";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { RemoteInstanceError } from "@konteks/remote-common";

const posix = process.platform !== "win32";
const haveOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** A zip built in memory: stored or deflated entries, Unix modes (a symbolic link is `0o120777`). */
function zip(entries: Array<{ name: string; data?: Buffer; method?: 0 | 8; mode?: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE((3 << 8) | 30, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38); header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
// Stand-ins for Google's two executables: compressible and not.
const SERVER = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(64 * 1024, "agy-acp-server ")]);
const HARNESS = createHash("sha512").update("localharness").digest();
const GOOD = zip([{ name: "agy_acp_server.par", data: SERVER }, { name: "localharness_external", data: HARNESS, method: 0, mode: 0o100555 }]);

/** A pin for a served archive, with the two pinned files. */
function pinFor(archive: Buffer, path = "/good.zip"): AntigravityPin {
  return {
    version: "1.2.1", key: "darwin-arm64",
    platform: {
      url: `https://localhost:${port}${path}`,
      archive: { format: "zip", size: archive.length, sha256: sha(archive) },
      command: "agy_acp_server.par", args: [],
      files: [{ path: "agy_acp_server.par", size: SERVER.length, sha256: sha(SERVER) }, { path: "localharness_external", size: HARNESS.length, sha256: sha(HARNESS) }],
      signer: { kind: "apple_team_id", teamId: "EQHXZ8M8AV" },
    },
  };
}

let server: HttpsServer;
let port = 0;
let cert = "";
let certDir = "";
const hits: string[] = [];
const routes = new Map<string, (res: import("node:http").ServerResponse) => void>();
const serve = (path: string, body: Buffer, headers: Record<string, string | number> = {}) => {
  routes.set(path, res => { res.writeHead(200, { "content-type": "application/zip", "content-length": body.length, ...headers }); res.end(body); });
};

beforeAll(async () => {
  if (!haveOpenssl) return;
  certDir = await mkdtemp(join(tmpdir(), "agy-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
    "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  cert = await readFile(join(certDir, "cert.pem"), "utf8");
  server = createHttpsServer({ key: await readFile(join(certDir, "key.pem")), cert }, (req, res) => {
    hits.push(req.url ?? "");
    const route = routes.get(req.url ?? "");
    if (route) route(res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  serve("/good.zip", GOOD);
  routes.set("/moved", res => { res.writeHead(302, { location: "/good.zip" }); res.end(); });
  routes.set("/to-http", res => { res.writeHead(302, { location: `http://localhost:${port}/good.zip` }); res.end(); });
  routes.set("/truncated", res => {
    res.writeHead(200, { "content-length": GOOD.length });
    res.write(GOOD.subarray(0, GOOD.length >> 1), () => setTimeout(() => res.socket?.destroy(), 20));
  });
});
afterAll(async () => {
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  if (certDir) await rm(certDir, { recursive: true, force: true });
});

describe.runIf(haveOpenssl)("fetching Google Antigravity (A2, A14–A20)", () => {
  let root = "";
  const signature = vi.fn(async () => true);
  const deps = (pin: AntigravityPin = pinFor(GOOD), extra: Partial<AntigravityInstallDeps> = {}): AntigravityInstallDeps => ({
    pin, verifySignature: signature, freeBytes: async () => 50 * 1024 ** 3, download: { ca: cert, env: {} }, ...extra,
  });
  const fresh = async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agy-root-")));
    await chmod(root, 0o700);
    return root;
  };
  afterEach(async () => {
    hits.length = 0;
    signature.mockReset();
    signature.mockImplementation(async () => true);
    clearAntigravityVerificationCache();
    if (root) await rm(root, { recursive: true, force: true });
  });
  /** Nothing of a refused fetch is left: no version folder, no staging, no archive. */
  const nothingLeft = async () => expect(await readdir(join(root, "agents", "antigravity")).catch(() => [])).toEqual([]);

  it("downloads nothing without the person's yes", async () => {
    await fresh();
    await expect(fetchNativeAntigravity({ root, consent: false }, deps())).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringMatching(/Nothing was downloaded/) });
    await expect(antigravityInstallAdapter.fetch!({ root, consent: false })).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(hits).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect(antigravityInstallAdapter.consentText).toBe(ANTIGRAVITY_CONSENT_TEXT);
    expect(ANTIGRAVITY_CONSENT_TEXT).toContain("dl.google.com, about 110 MB, 400 MB on disk");
    expect(ANTIGRAVITY_CONSENT_TEXT).toMatch(/\[y\/N\]$/);
  });

  it("fetches, unpacks and verifies the pinned zip into the connector's own folder, then keeps it without fetching again", async () => {
    await fresh();
    const fields = await fetchNativeAntigravity({ root, consent: true }, deps());
    const folder = join(root, "agents", "antigravity", "1.2.1-darwin-arm64");
    expect(fields).toEqual({ antigravityVersion: "1.2.1", antigravityRoot: folder });
    expect(hits).toEqual(["/good.zip"]);
    expect((await readdir(folder)).sort()).toEqual(["agy_acp_server.par", "localharness_external"]);
    // The zip and the staging folder are gone (A19); only the version folder stays.
    expect(await readdir(join(root, "agents", "antigravity"))).toEqual(["1.2.1-darwin-arm64"]);
    expect(await readFile(join(folder, "agy_acp_server.par"))).toEqual(SERVER);
    if (posix) {
      for (const path of [join(root, "agents"), join(root, "agents", "antigravity"), folder]) expect((await stat(path)).mode & 0o777).toBe(0o700);
      expect((await stat(join(folder, "agy_acp_server.par"))).mode & 0o777).toBe(0o755);
    }
    // The signature is checked for every file, with the pinned signer.
    expect(signature).toHaveBeenCalledWith(join(folder, "agy_acp_server.par"), { kind: "apple_team_id", teamId: "EQHXZ8M8AV" });
    expect(signature).toHaveBeenCalledWith(join(folder, "localharness_external"), { kind: "apple_team_id", teamId: "EQHXZ8M8AV" });
    await expect(fetchNativeAntigravity({ root, consent: true }, deps())).resolves.toEqual(fields);
    await expect(locateNativeAntigravity(root, deps())).resolves.toEqual(fields);
    await expect(verifyNativeAntigravityRecord(fields, root, deps())).resolves.toEqual({ root: folder, version: "1.2.1", command: join(folder, "agy_acp_server.par") });
    expect(hits).toEqual(["/good.zip"]);
  });

  it("follows an https redirect but never one to plain http", async () => {
    await fresh();
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD, "/moved")))).resolves.toMatchObject({ antigravityVersion: "1.2.1" });
    await removeNativeAntigravity(root);
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD, "/to-http")))).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_not_fetched" });
    await nothingLeft();
  });

  it("refuses a download with the wrong hash, the wrong size, or cut short, and keeps nothing", async () => {
    await fresh();
    const other = Buffer.from(GOOD);
    other[other.length >> 1] ^= 0xff;
    serve("/wrong-hash.zip", other);
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD, "/wrong-hash.zip")))).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_unsafe_install" });
    await nothingLeft();
    serve("/longer.zip", Buffer.concat([GOOD, Buffer.from("tail")]));
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD, "/longer.zip")))).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
    await nothingLeft();
    // The server lies about the length and sends more: never more than the pin is read.
    routes.set("/undeclared.zip", res => { res.writeHead(200); res.end(Buffer.concat([GOOD, Buffer.alloc(4096)])); });
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD, "/undeclared.zip")))).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
    await nothingLeft();
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD, "/truncated")))).rejects.toMatchObject({ code: "prerequisite_missing" });
    await nothingLeft();
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD, "/missing.zip")))).rejects.toMatchObject({ diagnostic: "antigravity_not_fetched" });
    await nothingLeft();
    expect(await lstat(join(root, "agents", "antigravity", "1.2.1-darwin-arm64")).catch(() => null)).toBeNull();
  });

  it.each([
    ["a `../` path", [{ name: "../agy_acp_server.par", data: SERVER }, { name: "localharness_external", data: HARNESS }]],
    ["an absolute path", [{ name: "/tmp/agy_acp_server.par", data: SERVER }, { name: "localharness_external", data: HARNESS }]],
    ["a symbolic link", [{ name: "agy_acp_server.par", data: Buffer.from("/bin/sh"), mode: 0o120777 }, { name: "localharness_external", data: HARNESS }]],
    ["a file nobody pinned", [{ name: "agy_acp_server.par", data: SERVER }, { name: "localharness_external", data: HARNESS }, { name: "extra.sh", data: Buffer.from("echo hi") }]],
    ["a pinned file missing", [{ name: "agy_acp_server.par", data: SERVER }]],
    ["a file with other bytes", [{ name: "agy_acp_server.par", data: Buffer.concat([SERVER.subarray(0, -1), Buffer.from("!")]) }, { name: "localharness_external", data: HARNESS }]],
    ["a duplicate name", [{ name: "agy_acp_server.par", data: SERVER }, { name: "AGY_ACP_SERVER.PAR", data: SERVER }, { name: "localharness_external", data: HARNESS }]],
  ])("refuses a zip holding %s, whatever its own hash", async (_label, entries) => {
    await fresh();
    const bad = zip(entries);
    const path = `/bad-${hits.length}-${sha(bad).slice(0, 8)}.zip`;
    serve(path, bad);
    // The archive's own hash matches the pin: only the unpack checks can refuse it.
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pinFor(bad, path)))).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_unsafe_install" });
    await nothingLeft();
    expect(await readdir(root)).toEqual(["agents"]);
  });

  it("refuses to start a fetch without 1.5 GB free, before downloading anything (A19)", async () => {
    await fresh();
    const refusal = await fetchNativeAntigravity({ root, consent: true }, deps(pinFor(GOOD), { freeBytes: async () => ANTIGRAVITY_MIN_FREE_BYTES - 1 })).catch(error => error);
    expect(refusal).toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_no_disk_space", recoveryActions: [{ kind: "free_disk", agentId: "antigravity" }] });
    expect(refusal.message).toBe("Google Antigravity needs about 1.2 GB free on this computer. Free some space, then try again.");
    expect(hits).toEqual([]);
  });

  it("refuses a copy without Google's signature, at fetch and at every start", async () => {
    await fresh();
    signature.mockImplementation(async () => false);
    await expect(fetchNativeAntigravity({ root, consent: true }, deps())).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
    await nothingLeft();
    signature.mockImplementation(async () => true);
    const fields = await fetchNativeAntigravity({ root, consent: true }, deps());
    clearAntigravityVerificationCache();
    signature.mockImplementation(async () => false);
    await expect(verifyNativeAntigravityRecord(fields, root, deps())).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install",
      message: "Google Antigravity on this computer does not match Google's release. Run `konteks-remote agent add antigravity` to fetch it again." });
  });

  it.runIf(posix)("re-verifies at every start: a flipped byte, a loosened mode or an extra file stops it; unchanged files are not re-read", async () => {
    await fresh();
    const pin = pinFor(GOOD);
    const fields = await fetchNativeAntigravity({ root, consent: true }, deps(pin));
    const folder = fields.antigravityRoot!;
    const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: join(root, "credentials", "antigravity"), RUNNER_WORKSPACE_DIR: join(root, "workspaces", "antigravity"),
      RUNNER_BRIDGE_PREFIX: folder, RUNNER_BRIDGE_VERSION: "1.2.1", RUNNER_NATIVE_ANTIGRAVITY_ROOT: folder });
    // Verified, then the `initialize` start check (CP2) runs on that exact folder.
    const initialize = vi.fn(async () => undefined);
    await antigravityInstallAdapter.selfCheck(config, { antigravity: deps(pin), antigravitySelfCheck: initialize });
    expect(initialize).toHaveBeenCalledWith({ config });
    const calls = signature.mock.calls.length;
    await verifyNativeAntigravityFolder(root, deps(pin));
    expect(signature.mock.calls.length).toBe(calls);
    // A byte flipped in place, with the modification time put back: the change time still differs.
    const harness = join(folder, "localharness_external");
    const before = await stat(harness);
    await chmod(harness, 0o755);
    const handle = await open(harness, "r+");
    await handle.write(Buffer.from([HARNESS[7]! ^ 0x01]), 0, 1, 7);
    await handle.close();
    await utimes(harness, before.atime, before.mtime);
    await expect(antigravityInstallAdapter.selfCheck(config, { antigravity: deps(pin), antigravitySelfCheck: initialize })).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_unsafe_install" });
    expect(initialize).toHaveBeenCalledOnce();
    await expect(verifyNativeAntigravityRecord(fields, root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
    // A fresh fetch replaces the copy that no longer verifies.
    await expect(fetchNativeAntigravity({ root, consent: true }, deps(pin))).resolves.toEqual(fields);
    await verifyNativeAntigravityFolder(root, deps(pin));
    await chmod(join(folder, "agy_acp_server.par"), 0o775);
    await expect(verifyNativeAntigravityFolder(root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
    await chmod(join(folder, "agy_acp_server.par"), 0o755);
    await chmod(folder, 0o755);
    await expect(verifyNativeAntigravityFolder(root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
    await chmod(folder, 0o700);
    await writeFile(join(folder, "hooks.sh"), "echo planted");
    await expect(verifyNativeAntigravityFolder(root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
  });

  it("reads a record for another version, another folder or no copy as the person can fix it", async () => {
    await fresh();
    const pin = pinFor(GOOD);
    await expect(verifyNativeAntigravityRecord({}, root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_not_fetched" });
    await expect(locateNativeAntigravity(root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_not_fetched",
      message: "Google Antigravity has not been downloaded to this computer. Run `konteks-remote agent add antigravity` to fetch it." });
    const fields = await fetchNativeAntigravity({ root, consent: true }, deps(pin));
    await expect(verifyNativeAntigravityRecord({ ...fields, antigravityVersion: "1.1.1" }, root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_unsupported_version" });
    await expect(verifyNativeAntigravityRecord({ ...fields, antigravityRoot: join(root, "elsewhere") }, root, deps(pin))).rejects.toMatchObject({ diagnostic: "antigravity_unsafe_install" });
  });

  it("says on the connected agent where the download stands, as the site reads it (CP3 prep)", async () => {
    await fresh();
    const pin = pinFor(GOOD, "/slow.zip");
    let releaseSecondHalf!: () => void;
    const secondHalfMayFinish = new Promise<void>(resolve => { releaseSecondHalf = resolve; });
    routes.set("/slow.zip", res => {
      res.writeHead(200, { "content-type": "application/zip", "content-length": GOOD.length });
      res.write(GOOD.subarray(0, GOOD.length >> 1), () => {
        void secondHalfMayFinish.then(() => res.end(GOOD.subarray(GOOD.length >> 1)));
      });
    });
    expect(await antigravityDownloadState(root, undefined, deps(pin))).toEqual({ state: "not_downloaded", sizeBytes: GOOD.length });
    const fetching = fetchNativeAntigravity({ root, consent: true }, deps(pin));
    let during: Awaited<ReturnType<typeof antigravityDownloadState>>;
    try {
      await vi.waitFor(async () => {
        const state = await antigravityDownloadState(root, undefined, deps(pin));
        expect(state).toMatchObject({ state: "downloading", sizeBytes: GOOD.length });
        expect(state!.receivedBytes).toBeGreaterThan(0);
      }, { timeout: 3_000, interval: 10 });
      during = await antigravityDownloadState(root, undefined, deps(pin));
      expect(during!.receivedBytes).toBeGreaterThan(0);
      expect(during!.receivedBytes).toBeLessThan(GOOD.length);
    } finally {
      releaseSecondHalf();
    }
    const fields = await fetching;
    expect(await antigravityDownloadState(root, fields, deps(pin))).toEqual({ state: "ready" });
    // A newer pin already fetched while the record still names the old copy: an update waits (A17).
    expect(await antigravityDownloadState(root, { ...fields, antigravityVersion: "1.2.0" }, deps(pin))).toEqual({ state: "update_available", availableVersion: "1.2.1" });
    // The record names a folder that is not the pinned one, or the copy stopped matching Google's release.
    expect(await antigravityDownloadState(root, { ...fields, antigravityRoot: join(root, "elsewhere") }, deps(pin))).toEqual({ state: "integrity_failed" });
    await chmod(join(fields.antigravityRoot!, "agy_acp_server.par"), 0o777);
    expect(await antigravityDownloadState(root, fields, deps(pin))).toEqual({ state: "integrity_failed" });
    expect(await antigravityDownloadState(root, { ...fields, antigravityVersion: "1.2.0" }, deps(pin))).toEqual({ state: "integrity_failed" });
    await rm(fields.antigravityRoot!, { recursive: true, force: true });
    expect(await antigravityDownloadState(root, fields, deps(pin))).toEqual({ state: "not_downloaded", sizeBytes: GOOD.length });
    // Every state is one packages' view takes, and none names a path.
    for (const state of [during, { state: "ready" }, { state: "update_available", availableVersion: "1.2.1" }]) {
      expect(HostAgentDownloadSchema.safeParse(state).success).toBe(true);
      expect(JSON.stringify(state)).not.toContain(root);
    }
  });

  it("honours the proxy variables through a CONNECT tunnel, and NO_PROXY", async () => {
    await fresh();
    const connects: string[] = [];
    const tunnels: Array<{ destroy(): void }> = [];
    const proxy: HttpServer = createHttpServer();
    proxy.on("connect", (req, client, head) => {
      connects.push(req.url ?? "");
      tunnels.push(client);
      const [host, targetPort] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(targetPort), host === "localhost" ? "127.0.0.1" : host!, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      tunnels.push(upstream);
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      await expect(fetchNativeAntigravity({ root, consent: true }, { ...deps(), download: { ca: cert, env: { HTTPS_PROXY: proxyUrl } } })).resolves.toMatchObject({ antigravityVersion: "1.2.1" });
      expect(connects).toEqual([`localhost:${port}`]);
    } finally {
      for (const socket of tunnels) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
    const target = new URL("https://dl.google.com/agy-extensions/x.zip");
    expect(proxyFor(target, { https_proxy: "proxy.corp:3128" })?.host).toBe("proxy.corp:3128");
    expect(proxyFor(target, { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "localhost,.google.com" })).toBeNull();
    expect(proxyFor(target, { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "*" })).toBeNull();
    expect(proxyFor(target, { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "example.com" })?.hostname).toBe("proxy.corp");
    expect(proxyFor(target, {})).toBeNull();
  });

  it("removes every copy, or every copy but the one in use, and never the sign-ins", async () => {
    await fresh();
    const fields = await fetchNativeAntigravity({ root, consent: true }, deps());
    await mkdir(join(root, "credentials", "antigravity", "antigravity", "home"), { recursive: true });
    await mkdir(join(root, "agents", "antigravity", "1.1.1-darwin-arm64"));
    await mkdir(join(root, "agents", "antigravity", ".fetch-left"));
    await pruneNativeAntigravity(root, fields.antigravityRoot!);
    expect(await readdir(join(root, "agents", "antigravity"))).toEqual(["1.2.1-darwin-arm64"]);
    await removeNativeAntigravity(root);
    expect(await readdir(join(root, "agents"))).toEqual([]);
    expect(await readdir(join(root, "credentials", "antigravity", "antigravity"))).toEqual(["home"]);
  });
});

describe("the zip reader and the signature check", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("reads plain entries and refuses what could escape or deceive", async () => {
    dir = await mkdtemp(join(tmpdir(), "agy-zip-"));
    const write = async (name: string, data: Buffer) => { const path = join(dir, name); await writeFile(path, data); return path; };
    const entries = await readZipEntries(await write("good.zip", GOOD));
    expect(entries.map(entry => [entry.path, entry.method, entry.size, entry.mode])).toEqual([["agy_acp_server.par", 8, SERVER.length, 0o755], ["localharness_external", 0, HARNESS.length, 0o555]]);
    await expect(readZipEntries(await write("dir.zip", zip([{ name: "bin/", mode: 0o040755 }, { name: "bin/agy", data: SERVER }])))).resolves.toHaveLength(1);
    await expect(readZipEntries(await write("junk.zip", Buffer.from("not a zip at all, not even close")))).rejects.toMatchObject({ reason: "unsafe_archive" });
    const encrypted = zip([{ name: "a", data: SERVER }]);
    encrypted.writeUInt16LE(0x801, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    await expect(readZipEntries(await write("enc.zip", encrypted))).rejects.toMatchObject({ reason: "unsafe_archive" });
    for (const name of ["../x", "a/../../x", "/etc/x", "C:/x", "a\\b", "a//b", "./a", "a\u0000b"]) expect(safeArchivePath(name), name).toBe(false);
    for (const name of ["agy_acp_server.par", "bin/agy", "a.b/c-d_e"]) expect(safeArchivePath(name), name).toBe(true);
  });

  it("never passes a signer for another operating system", async () => {
    await expect(verifyFetchedSignature("/nonexistent", { kind: "apple_team_id", teamId: "EQHXZ8M8AV" }, "linux")).resolves.toBe(false);
    await expect(verifyFetchedSignature("/nonexistent", { kind: "authenticode", subject: "CN=Google LLC" }, "darwin")).resolves.toBe(false);
    await expect(verifyFetchedSignature("/nonexistent", { kind: "none" }, "linux")).resolves.toBe(true);
  });

  it.runIf(process.platform === "darwin")("refuses an unsigned copy and a re-signed copy on macOS (codesign, Team ID)", async () => {
    dir = await mkdtemp(join(tmpdir(), "agy-sign-"));
    const google = { kind: "apple_team_id", teamId: "EQHXZ8M8AV" } as const;
    const unsigned = join(dir, "unsigned");
    await writeFile(unsigned, SERVER, { mode: 0o755 });
    await expect(verifyFetchedSignature(unsigned, google)).resolves.toBe(false);
    // A re-signed copy: validly signed, but not by Google's Team ID.
    const resigned = join(dir, "resigned");
    await copyFile("/bin/ls", resigned);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", resigned], { stdio: "ignore" });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", resigned], { stdio: "ignore" });
    await expect(verifyFetchedSignature(resigned, google)).resolves.toBe(false);
    // Apple's own binary is signed, but not by Google.
    await expect(verifyFetchedSignature("/bin/ls", google)).resolves.toBe(false);
  });

  // Live only: set AGY_ACP_DIR to a folder holding Google's unpacked 1.2.1 darwin-arm64 server.
  it.runIf(process.platform === "darwin" && process.env.AGY_ACP_DIR !== undefined)("passes Google's own signed executables", { timeout: 120_000 }, async () => {
    for (const name of ["agy_acp_server.par", "localharness_external"]) {
      await expect(verifyFetchedSignature(join(process.env.AGY_ACP_DIR!, name), { kind: "apple_team_id", teamId: "EQHXZ8M8AV" })).resolves.toBe(true);
    }
  });
});

describe("the Antigravity install adapter", () => {
  it("is registered, fetched, offered since CP6, and refuses without the connector's folder", async () => {
    expect(hostAgentInstallAdapter("antigravity")).toBe(antigravityInstallAdapter);
    expect(antigravityInstallAdapter.offered).toBe(true);
    expect(nativeAgentOffered("antigravity")).toBe(true);
    expect(nativeAgentOffered("opencode")).toBe(true);
    await expect(antigravityInstallAdapter.locate()).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_not_fetched" });
    await expect(antigravityInstallAdapter.runnerSettings({} as never)).rejects.toMatchObject({ code: "prerequisite_missing" });
    await expect(antigravityInstallAdapter.selfCheck(RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "antigravity" }))).rejects.toMatchObject({ diagnostic: "antigravity_not_fetched" });
    // Refused before any consent question where Google publishes no copy (plainly, with nothing to run).
    if (`${process.platform}-${process.arch}` === "darwin-arm64") expect(() => antigravityInstallAdapter.assertFetchable!()).not.toThrow();
    else expect(() => antigravityInstallAdapter.assertFetchable!()).toThrow(expect.objectContaining({ diagnostic: "antigravity_unsupported_platform", message: "Google Antigravity is not available for this computer yet.", recoveryActions: [] }));
  });

  it("carries this release's pin: Google's 1.2.1 zip for macOS arm64 from dl.google.com, and nothing for platforms not yet proven", () => {
    const folders = antigravityFolders("/r", { version: "1.2.1", key: "darwin-arm64" });
    expect(folders).toEqual({ agents: join("/r", "agents"), base: join("/r", "agents", "antigravity"), version: join("/r", "agents", "antigravity", "1.2.1-darwin-arm64") });
    if (`${process.platform}-${process.arch}` === "darwin-arm64") {
      expect(antigravityPin()).toMatchObject({ version: "1.2.1", key: "darwin-arm64", platform: {
        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip",
        archive: { size: 111725488, sha256: "0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c" },
        signer: { kind: "apple_team_id", teamId: "EQHXZ8M8AV" },
      } });
    } else {
      expect(() => antigravityPin()).toThrow(/not available for this computer yet/);
    }
  });
});

describe.runIf(haveOpenssl)("keeping Google Antigravity current and removing it (A17, A18, CP6)", () => {
  let root = "";
  const signature = vi.fn(async () => true);
  const deps = (pin: AntigravityPin = pinFor(GOOD)): AntigravityInstallDeps => ({
    pin, verifySignature: signature, freeBytes: async () => 50 * 1024 ** 3, download: { ca: cert, env: {} },
  });
  afterEach(async () => {
    hits.length = 0;
    clearAntigravityVerificationCache();
    if (root) await rm(root, { recursive: true, force: true });
  });
  /** A connector root whose record lists Antigravity at an older version, with that version's folder still there. */
  const updatedRoot = async (): Promise<{ record: NativeRuntimeRecord; old: string }> => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agy-update-")));
    await chmod(root, 0o700);
    const old = join(root, "agents", "antigravity", "1.1.1-darwin-arm64");
    await mkdir(old, { recursive: true, mode: 0o700 });
    await writeFile(join(old, "agy_acp_server.par"), "the previous release's copy");
    const record = NativeRuntimeRecordSchema.parse({
      schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance", workspaceId: "tenant", releaseId: "release-1", manifestDigest: "digest",
      bundleVersion: "1.1.0", coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", controlPort: 7777,
      agents: ["codex", "antigravity"], antigravityVersion: "1.1.1", antigravityRoot: old,
    });
    await writeFile(join(root, "native-runtime.json"), JSON.stringify(record), { mode: 0o600 });
    return { record, old };
  };
  const runnerConfig = async (_root: string, record: NativeRuntimeRecord) => RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "antigravity", RUNNER_NATIVE_ANTIGRAVITY_ROOT: record.antigravityRoot, RUNNER_BRIDGE_PREFIX: record.antigravityRoot, RUNNER_BRIDGE_VERSION: record.antigravityVersion,
  });
  const stored = async () => JSON.parse(await readFile(join(root, "native-runtime.json"), "utf8")) as NativeRuntimeRecord;

  it("is needed only for a listed Antigravity whose copy is another version or missing, never for one that does not verify", () => {
    const listed = { agents: ["antigravity" as const] };
    const refusal = (diagnostic: string) => new RemoteInstanceError("prerequisite_missing", "x", { diagnostic });
    expect(antigravityUpdateNeeded(listed, refusal("antigravity_unsupported_version"))).toBe(true);
    expect(antigravityUpdateNeeded(listed, refusal("antigravity_not_fetched"))).toBe(true);
    expect(antigravityUpdateNeeded(listed, refusal("antigravity_unsafe_install"))).toBe(false);
    expect(antigravityUpdateNeeded(listed, refusal("antigravity_unsupported_platform"))).toBe(false);
    expect(antigravityUpdateNeeded({ agents: [] }, refusal("antigravity_not_fetched"))).toBe(false);
  });

  it("fetches the new pin on the first yes, checks it before switching, records it, and prunes the old version", async () => {
    const { record, old } = await updatedRoot();
    const checked: string[] = [];
    const updated = await updateNativeAntigravity(root, record, { ...deps(), runnerConfig, selfCheck: async config => { checked.push(config.RUNNER_NATIVE_ANTIGRAVITY_ROOT!); } });
    const folder = join(root, "agents", "antigravity", "1.2.1-darwin-arm64");
    expect(updated.fetched).toEqual({ antigravityVersion: "1.2.1", antigravityRoot: folder });
    expect(updated.config.RUNNER_NATIVE_ANTIGRAVITY_ROOT).toBe(folder);
    expect(checked).toEqual([folder]);
    expect(await stored()).toMatchObject({ agents: ["codex", "antigravity"], antigravityVersion: "1.2.1", antigravityRoot: folder, instanceId: "instance" });
    expect(await readdir(join(root, "agents", "antigravity"))).toEqual(["1.2.1-darwin-arm64"]);
    await expect(lstat(old)).rejects.toMatchObject({ code: "ENOENT" });
    expect(hits).toEqual(["/good.zip"]);
  });

  it("keeps the old version and the record when the new copy's start check fails, and a later try does not download again", async () => {
    const { record, old } = await updatedRoot();
    const before = await stored();
    await expect(updateNativeAntigravity(root, record, { ...deps(), runnerConfig, selfCheck: async () => { throw new RemoteInstanceError("prerequisite_missing", "drift", { diagnostic: "antigravity_unsupported_version" }); } }))
      .rejects.toMatchObject({ diagnostic: "antigravity_unsupported_version" });
    expect(await stored()).toEqual(before);
    expect((await lstat(old)).isDirectory()).toBe(true);
    await updateNativeAntigravity(root, record, { ...deps(), runnerConfig, selfCheck: async () => undefined });
    expect(hits).toEqual(["/good.zip"]);
    expect((await stored()).antigravityVersion).toBe("1.2.1");
  });

  it("keeps the old version and the record when the download fails, and asks nothing of a record that never listed it", async () => {
    const { record, old } = await updatedRoot();
    const before = await stored();
    const missing = { ...pinFor(GOOD, "/gone.zip") };
    await expect(updateNativeAntigravity(root, record, { ...deps(missing), runnerConfig, selfCheck: async () => undefined })).rejects.toMatchObject({ code: "prerequisite_missing" });
    expect(await stored()).toEqual(before);
    expect((await lstat(old)).isDirectory()).toBe(true);
    hits.length = 0;
    await expect(updateNativeAntigravity(root, { ...record, agents: ["codex"] }, { ...deps(), runnerConfig, selfCheck: async () => undefined })).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(hits).toEqual([]);
  });

  it("switches in memory and writes the record on a later start when an installer holds the lock", async () => {
    const { record } = await updatedRoot();
    const before = await stored();
    const lock = acquireNativeRootLock(join(root, "installer"));
    const deferred = vi.fn();
    try {
      const updated = await updateNativeAntigravity(root, record, { ...deps(), runnerConfig, selfCheck: async () => undefined, onRecordDeferred: deferred });
      expect(updated.fetched.antigravityVersion).toBe("1.2.1");
      expect(deferred).toHaveBeenCalledWith(expect.objectContaining({ code: "temporarily_unavailable" }));
      expect(await stored()).toEqual(before);
    } finally { lock.release(); }
    await recordFetchedAntigravity(root, { antigravityVersion: "1.2.1", antigravityRoot: join(root, "agents", "antigravity", "1.2.1-darwin-arm64") });
    expect((await stored()).antigravityVersion).toBe("1.2.1");
  });

  it("shows another process's download as under way while it grows, never a stale one, and says what the copy takes on disk", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "agy-progress-")));
    const pin = pinFor(GOOD);
    const staging = join(root, "agents", "antigravity", ".fetch-launcher");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(staging, "archive.zip"), Buffer.alloc(200));
    expect(await antigravityFetchUnderWay(root, { pin })).toEqual({ receivedBytes: 200, sizeBytes: GOOD.length });
    expect(await antigravityDownloadState(root, undefined, { pin })).toEqual({ state: "downloading", receivedBytes: 200, sizeBytes: GOOD.length });
    expect(await antigravityFetchUnderWay(root, { pin }, Date.now() + 60_000)).toBeUndefined();
    expect(antigravityDiskBytes(pin)).toBe(SERVER.length + HARNESS.length);
  });

  it("removes every copy, the private home and the workspace, and never another agent's; signing out a copy that cannot run is skipped", async () => {
    const { record } = await updatedRoot();
    for (const dir of ["credentials/antigravity/antigravity/home/.gemini/antigravity-acp", "credentials/codex", "workspaces/antigravity", "workspaces/codex"]) await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "credentials/antigravity/antigravity/home/.gemini/antigravity-acp/acp_business_token.json"), "{}");
    await expect(signOutNativeAntigravity(root, record)).resolves.toBe(false);
    await deleteNativeAntigravity(root);
    expect((await readdir(root)).sort()).toEqual(["agents", "credentials", "native-runtime.json", "workspaces"]);
    expect(await readdir(join(root, "agents"))).toEqual([]);
    expect(await readdir(join(root, "credentials"))).toEqual(["codex"]);
    expect(await readdir(join(root, "workspaces"))).toEqual(["codex"]);
  });
});
