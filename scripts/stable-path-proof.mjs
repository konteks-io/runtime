#!/usr/bin/env node
/**
 * Proof, on the OS it runs on, that a connector self-update keeps one
 * executed path and one publisher identity:
 *
 *   1. builds two consecutive connector executables N and N+1 with the
 *      release build (`build-launcher.mjs`), signed when this OS's signing
 *      secrets are configured (`sign-connector.mjs`);
 *   2. serves both from a local signed release channel (a throwaway release
 *      root baked into both builds, TLS on 127.0.0.1);
 *   3. lays out an installed N the way `install` does after Konteks's
 *      activation (which needs Konteks, so a local activation stands in),
 *      and starts it with N's own `konteks-remote start`: the OS service
 *      manager runs it from `<root>/bin/konteks-connector`;
 *   4. runs the real self-update to N+1 (`update --unattended`, the command
 *      the connector launches itself): stage → identity check → drain →
 *      stop → commit → start → health gate;
 *   5. asserts the service manager still names the same path, the running
 *      connector's executable is that path and holds N+1's bytes, N+1
 *      answers, and N's folder is only a rollback copy; and that N and N+1
 *      carry the same valid publisher identity. Unsigned (signing deferred),
 *      the identity checks are reported in the job summary and the path
 *      checks still run;
 *   6. uninstalls with N+1's own command.
 *
 *   node scripts/stable-path-proof.mjs [--work <directory>]
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configured, CONNECTOR_CODE_IDENTIFIER, macosSigning, report, signConnector, windowsSigning } from "./sign-connector.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter(pair => pair.length === 2));
const OS = { darwin: "macos", win32: "windows", linux: "debian" }[process.platform];
const ARCHITECTURE = process.arch === "arm64" ? "arm64" : "amd64";
const EXE = OS === "windows" ? ".exe" : "";
const VERSIONS = ["1.0.0", "1.0.1"];
const WORK = realpathSync(args.work ? (mkdirSync(args.work, { recursive: true }), args.work) : mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "konteks-stable-path-")));
const ROOT = join(WORK, "root");
const STABLE = join(ROOT, "bin", `konteks-connector${EXE}`);
const LABEL = `dev.konteks.remote.${createHash("sha256").update(OS === "windows" ? normalize(ROOT).toLowerCase() : normalize(ROOT)).digest("hex").slice(0, 12)}`;
const dist = (pkg) => import(pathToFileURL(resolve("packages", pkg, "dist", "index.js")).href);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sleep = (ms) => new Promise(done => setTimeout(done, ms));
/** The connector's child processes get no keychain-backed CA lookup (it can hang a CI keychain) and no inherited channel override. */
const childEnv = (extra = {}) => { const env = { ...process.env, ...extra }; delete env.NODE_USE_SYSTEM_CA; return env; };
const run = (command, argv, options = {}) => execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: childEnv(options.env), timeout: options.timeout ?? 600_000 });
/** Runs a connector command with this terminal, without blocking this process: it serves the release channel meanwhile. */
const connector = (command, argv, env = {}, ms = 900_000) => new Promise((done, fail) => {
  const child = spawn(command, argv, { stdio: "inherit", env: childEnv(env) });
  const timer = setTimeout(() => child.kill(), ms);
  child.once("error", fail);
  child.once("exit", code => { clearTimeout(timer); if (code === 0) done(); else fail(new Error(`${command} ${argv.join(" ")} exited ${code}`)); });
});
/** Exit code and everything a command printed, stdout and stderr together (codesign writes its details to stderr). */
const capture = (command, argv) => { const result = spawnSync(command, argv, { encoding: "utf8", env: childEnv() }); return { ok: result.status === 0, text: `${result.stdout ?? ""}${result.stderr ?? ""}` }; };

const failures = [];
function check(what, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  if (!ok) failures.push(what);
}

/** Two throwaway Ed25519 keys: the release root both builds trust, and the Core control key it certifies. */
function proofRoots() {
  const release = generateKeyPairSync("ed25519");
  const core = generateKeyPairSync("ed25519");
  const jwk = key => { const { kty, crv, x } = key.export({ format: "jwk" }); return { kty, crv, x }; };
  const root = { keyId: "stable-path-proof", publicKeyJwk: jwk(release.publicKey), coreControlKeys: [{ keyId: "stable-path-proof-core", publicKeyJwk: jwk(core.publicKey) }] };
  return { privateKey: release.privateKey, root, json: JSON.stringify({ roots: [root] }) };
}

/** One release build of the connector, copied out of the shared build folder and signed when configured. */
async function buildConnector(version, roots, signing) {
  const out = join(WORK, "builds", version);
  mkdirSync(out, { recursive: true });
  execFileSync(process.execPath, ["scripts/build-launcher.mjs", "--os", OS, "--architecture", ARCHITECTURE, "--out", join(out, "unused-package")], {
    stdio: "inherit", env: childEnv({ KONTEKS_RELEASE_ROOTS_JSON: roots.json, KONTEKS_LAUNCHER_VERSION: `v${version}` }),
  });
  const file = join(out, `konteks-remote${EXE}`);
  copyFileSync(join("dist", "launcher-build", `konteks-remote${EXE}`), file);
  chmodSync(file, 0o755);
  await signConnector(OS, file, signing);
  return file;
}

/** A self-signed certificate for 127.0.0.1 that the connector trusts through NODE_EXTRA_CA_CERTS. */
function localTls() {
  const directory = join(WORK, "tls");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", join(directory, "openssl.cnf"), "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")]);
  return { key: readFileSync(join(directory, "key.pem")), cert: readFileSync(join(directory, "cert.pem")), caFile: join(directory, "cert.pem") };
}

async function freePort() {
  const server = createNetServer();
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

/** The local release channel: `/native-manifest.json` is the current release, every file by its versioned URL. */
async function releaseChannel(tls) {
  const files = new Map();
  const channel = { current: null, port: 0, files };
  const server = createHttpsServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    const body = request.url === "/native-manifest.json" ? channel.current : files.get(request.url);
    response.writeHead(body ? 200 : 404).end(body ?? undefined);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  channel.port = server.address().port;
  channel.close = () => new Promise(done => server.close(done));
  return channel;
}

/** One signed native manifest holding just this connector, its bytes (and Linux signature) served by the channel. */
async function publish(channel, version, file, roots) {
  const { signNativeReleaseManifest, verifyNativeRelease } = await dist("release");
  const bytes = readFileSync(file);
  const name = `konteks-remote-${OS}-${ARCHITECTURE}${EXE}`;
  const url = `https://127.0.0.1:${channel.port}/v${version}/${name}`;
  channel.files.set(new URL(url).pathname, bytes);
  if (existsSync(`${file}.sig`)) channel.files.set(`${new URL(url).pathname}.sig`, readFileSync(`${file}.sig`));
  const policy = JSON.parse(readFileSync("release/release-policy.json", "utf8"));
  const manifest = signNativeReleaseManifest({
    bundleVersion: version, protocol: policy.protocol, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [],
    nativeArtifacts: [{ id: `konteks-remote-${OS}-${ARCHITECTURE}`, kind: "connector", format: "executable", os: OS, architecture: ARCHITECTURE, url, digest: sha(bytes), sizeBytes: bytes.length }],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }, { keyId: roots.root.keyId, privateKey: roots.privateKey });
  verifyNativeRelease(manifest, [roots.root]);
  return manifest;
}

/**
 * The installed N as `install` leaves it after Konteks's activation: the
 * release staged by the real stager, the runtime record, the stored
 * activation and machine key. Core is a closed local port: the connector
 * runs offline and keeps retrying, as it does when Konteks is unreachable.
 */
async function installedRelease(channel, manifest, roots, controlPort) {
  const { stageNativeRelease, verifyNativeRelease } = await dist("release");
  const { NativeRuntimeRecordSchema, SupervisorStore } = await dist("supervisor");
  const { writeSecretFile } = await dist("common");
  for (const directory of ["", "releases", "credentials", "workspaces", "logs", "installer"]) mkdirSync(join(ROOT, directory), { recursive: true, mode: 0o700 });
  const release = verifyNativeRelease(manifest, [roots.root]);
  const fetchFn = async (url) => new Response(channel.files.get(new URL(url).pathname));
  const staged = await stageNativeRelease({ release, target: { os: OS, architecture: ARCHITECTURE, agentIds: [] }, releasesDir: join(ROOT, "releases"), fetchFn });
  mkdirSync(join(staged.directory, "agents"), { mode: 0o700 });
  await writeSecretFile(join(staged.directory, "manifest.json"), JSON.stringify(manifest));
  const releaseId = "release-proof-n";
  renameSync(staged.directory, join(ROOT, "releases", releaseId));
  const offline = await freePort();
  const record = NativeRuntimeRecordSchema.parse({ schemaVersion: 1, deploymentKind: "native_connector", instanceId: "stable-path-proof", workspaceId: "stable-path-proof", releaseId, manifestDigest: manifest.digest, bundleVersion: manifest.bundleVersion, coreUrl: `https://127.0.0.1:${offline}`, relayUrl: `wss://127.0.0.1:${offline}/relay/runtime`, controlPort, agents: [] });
  await writeSecretFile(join(ROOT, "native-runtime.json"), JSON.stringify(record));
  const store = new SupervisorStore(join(ROOT, "supervisor"));
  await store.init();
  await store.loadOrCreateInstanceKey();
  await store.saveIdentity({ instanceId: record.instanceId, workspaceId: record.workspaceId, activationId: "stable-path-proof", activatedAt: new Date().toISOString(), administrativeStatus: "active", exchangeNonce: "stable-path-proof" });
  await store.saveManifest(manifest, manifest.digest);
  return record;
}

/** What the OS service manager will run, and the executable of the connector process it runs now. */
const SERVICE = {
  macos: {
    program() { return launchd().match(/^\s*program = (.+)$/m)?.[1] ?? null; },
    running() { const pid = launchd().match(/^\s*pid = (\d+)$/m)?.[1]; return pid ? [run("ps", ["-o", "comm=", "-p", pid]).trim()] : []; },
  },
  debian: {
    program() { return run("systemctl", ["--user", "show", `${LABEL}.service`, "-p", "ExecStart", "--value"]).match(/path=(\S+)/)?.[1] ?? null; },
    running() { const pid = run("systemctl", ["--user", "show", `${LABEL}.service`, "-p", "MainPID", "--value"]).trim(); return pid && pid !== "0" ? [realpathSync(`/proc/${pid}/exe`)] : []; },
  },
  windows: {
    program() { return JSON.parse(readFileSync(join(ROOT, "service.json"), "utf8")).executable; },
    running() {
      const script = `Get-CimInstance Win32_Process -Filter "Name='konteks-connector.exe'" | Where-Object { $_.CommandLine -like '*${ROOT.replace(/'/g, "''")}*' } | ForEach-Object { $_.ExecutablePath }`;
      return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    },
  },
};
function launchd() { try { return run("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`]); } catch { return ""; } }

/** The Windows login host's own copy of the program it starts. */
function windowsHelperProgram() {
  const helper = readFileSync(JSON.parse(readFileSync(join(ROOT, "service.json"), "utf8")).helper, "utf8");
  const encoded = helper.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1] ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le").match(/\$env:KONTEKS_SERVICE_PROGRAM = '(.+)'/)?.[1]?.replace(/''/g, "'") ?? null;
}

async function bundleAnswering(controlPort) {
  const { SupervisorControl } = await import(pathToFileURL(resolve("packages", "launcher", "dist", "control.js")).href);
  const control = new SupervisorControl({ supervisorData: join(ROOT, "supervisor") }, controlPort);
  try { return (await control.call({ op: "status" }, { safeParse: data => ({ success: true, data }) }, { timeoutMs: 5_000 }))?.version?.bundle ?? null; } catch { return null; }
}

async function waitForBundle(controlPort, version, ms = 240_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await bundleAnswering(controlPort)) === version) return true;
    await sleep(2_000);
  }
  return false;
}

const samePath = (a, b) => Boolean(a && b) && (OS === "windows" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : realpathOr(a) === realpathOr(b));
function realpathOr(path) { try { return realpathSync(path); } catch { return resolve(path); } }

/** Where the service runs, as the OS and the running process say it. */
function servicePlacement() {
  return { program: SERVICE[OS].program(), running: SERVICE[OS].running(), helper: OS === "windows" ? windowsHelperProgram() : null, digest: existsSync(STABLE) ? sha(readFileSync(STABLE)) : null };
}

function checkPlacement(phase, placement, expectedDigest) {
  check(`${phase}: the service manager runs ${STABLE}`, samePath(placement.program, STABLE), `program ${placement.program}`);
  if (OS === "windows") check(`${phase}: the Windows login host starts the same path`, samePath(placement.helper, STABLE), `helper ${placement.helper}`);
  check(`${phase}: the running connector's executable is that path`, placement.running.length > 0 && placement.running.every(path => samePath(path, STABLE)), placement.running.join(", ") || "no connector process");
  check(`${phase}: that path holds the release's signed bytes`, placement.digest === expectedDigest, placement.digest ?? "missing");
}

/** The OS's own reading of each build's publisher identity; independent of the connector's code. */
const IDENTITY = {
  macos(file) {
    const details = capture("codesign", ["-dv", "--verbose=2", file]).text;
    const requirement = capture("codesign", ["-d", "-r-", file]).text.match(/designated => (.+)/)?.[1]?.trim();
    const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1];
    const signer = team && team !== "not set" ? `${team} ${requirement}` : null;
    return { valid: capture("codesign", ["--verify", "--strict", file]).ok, signer, identifier: details.match(/^Identifier=(.+)$/m)?.[1] ?? null };
  },
  windows(file) {
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; [Console]::Out.Write((@{ status = [string]$s.Status; thumbprint = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { '' } } | ConvertTo-Json -Compress))`;
    const { status, thumbprint } = JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
    return { valid: status === "Valid", signer: thumbprint || null, status };
  },
  /** The detached signature checked with the signing key's own public half, not the connector's verifier. */
  debian(file) {
    if (!existsSync(`${file}.sig`) || !configured("debian")) return { valid: false, signer: null };
    const signature = JSON.parse(readFileSync(`${file}.sig`, "utf8"));
    const publicKey = createPublicKey(createPrivateKey(process.env.LINUX_SIGNING_KEY));
    const bytes = Buffer.from(`konteks-connector-signature-v1\n${signature.digest}\n`, "utf8");
    const holds = signature.digest === sha(readFileSync(file)) && verify(null, bytes, publicKey, Buffer.from(signature.signature, "base64url"));
    return { valid: holds, signer: holds ? `ed25519 ${signature.keyId}` : null };
  },
};

/** Unsigned (signing deferred): said in the summary; on macOS both builds still carry the one identifier. */
function reportUnsigned([n, next]) {
  report(`identity ${OS} N and N+1`, { signed: false, detail: `${OS} publisher signing is deferred; the path checks still ran` });
  if (OS !== "macos") return;
  check("both builds carry the connector's one code-signing identifier", n.identifier === CONNECTOR_CODE_IDENTIFIER && next.identifier === CONNECTOR_CODE_IDENTIFIER, `${n.identifier} / ${next.identifier}`);
}

function checkSigned([n, next]) {
  check("N's publisher signature is valid", n.valid, n.signer ?? n.status ?? "unsigned");
  check("N+1's publisher signature is valid", next.valid, next.signer ?? next.status ?? "unsigned");
  check("N and N+1 have the identical publisher identity", Boolean(n.signer) && n.signer === next.signer, `${n.signer} / ${next.signer}`);
}

/** Gatekeeper's verdict on a notarized command-line executable. */
function checkNotarized(builds) {
  if (OS !== "macos" || !configured("notary")) return;
  for (const [name, file] of [["N", builds[0]], ["N+1", builds[1]]]) {
    const verdict = capture("spctl", ["-a", "-vvv", "-t", "install", file]).text;
    check(`${name} is accepted by Gatekeeper as notarized`, /accepted/.test(verdict) && /Notarized Developer ID/.test(verdict), verdict.trim().split("\n").at(-1));
  }
}

function checkIdentity(builds, signed) {
  const identities = builds.map(file => IDENTITY[OS](file));
  if (!signed) return reportUnsigned(identities);
  checkSigned(identities);
  checkNotarized(builds);
}

/** This OS's signer for the builds, and whether there is one. */
function signingContext() {
  const context = { macos: OS === "macos" ? macosSigning() : null, windows: OS === "windows" ? windowsSigning() : null };
  const signed = { macos: context.macos !== null, windows: context.windows !== null, debian: configured("debian") }[OS];
  return { context, signed };
}

/** N installed and running from the stable path, updated by itself to N+1, checked before and after. */
async function selfUpdate(channel, manifests, tls, controlPort, builds) {
  const network = { NODE_EXTRA_CA_CERTS: tls.caFile, KONTEKS_RELEASE_MANIFEST_URL: `https://127.0.0.1:${channel.port}/native-manifest.json` };
  // N, as the installer leaves it: its own `start` registers the service on the stable path.
  await connector(builds[0], ["--root", ROOT, "start"]);
  check("N starts and answers on its control socket", await waitForBundle(controlPort, VERSIONS[0]));
  const before = servicePlacement();
  checkPlacement("N", before, manifests[0].nativeArtifacts[0].digest);
  // The connector's own self-update command, as the running connector launches it.
  channel.current = JSON.stringify(manifests[1]);
  await connector(STABLE, ["--root", ROOT, "--json", "update", "--unattended"], network);
  check("N+1 answers after the self-update", await waitForBundle(controlPort, VERSIONS[1]));
  const after = servicePlacement();
  checkPlacement("N+1", after, manifests[1].nativeArtifacts[0].digest);
  check("the executed path is unchanged across the update", samePath(before.program, after.program), `${before.program} → ${after.program}`);
  const record = JSON.parse(readFileSync(join(ROOT, "native-runtime.json"), "utf8"));
  check("the record names N+1 and N's folder is kept for rollback", record.bundleVersion === VERSIONS[1] && existsSync(join(ROOT, "releases", "release-proof-n", `konteks-connector${EXE}`)), `${record.releaseId} ${record.bundleVersion}`);
  check("nothing runs from a release folder", after.running.every(path => !/[\\/]releases[\\/]/.test(path)), after.running.join(", "));
}

/** Uninstall with N+1's own command; the root's logs are kept in the work folder first. */
async function uninstall(builds) {
  if (existsSync(join(ROOT, "logs"))) cpSync(join(ROOT, "logs"), join(WORK, "logs"), { recursive: true });
  try { await connector(builds.at(-1), ["--root", ROOT, "--json", "uninstall"], {}, 300_000); }
  catch (error) { check("uninstall after the proof", false, error.message); }
}

async function main() {
  if (!OS) throw new Error(`unsupported platform ${process.platform}`);
  console.log(`stable-path proof on ${OS}/${ARCHITECTURE} in ${WORK}`);
  const roots = proofRoots();
  const { context, signed } = signingContext();
  const builds = [];
  for (const version of VERSIONS) builds.push(await buildConnector(version, roots, context));
  checkIdentity(builds, signed);
  const tls = localTls();
  const channel = await releaseChannel(tls);
  const controlPort = await freePort();
  try {
    const manifests = [];
    for (const [index, version] of VERSIONS.entries()) manifests.push(await publish(channel, version, builds[index], roots));
    channel.current = JSON.stringify(manifests[0]);
    await installedRelease(channel, manifests[0], roots, controlPort);
    await selfUpdate(channel, manifests, tls, controlPort, builds);
  } finally {
    await uninstall(builds);
    await channel.close();
  }
  check("uninstall removed the service's executable", !existsSync(STABLE));
  if (failures.length > 0) throw new Error(`stable-path proof failed: ${failures.join("; ")}`);
  console.log(`stable-path proof passed on ${OS}/${ARCHITECTURE} (${signed ? "signed" : "unsigned (deferred)"})`);
}

await main();
