/**
 * Publisher signing of the connector executable and its installer, opt-in per
 * OS: each OS signs once its secrets are configured, and until then the
 * release ships unsigned with a visible "unsigned (deferred)" warning in the
 * job summary. Secrets that are only partly configured, or a signature that
 * does not verify, fail the job.
 *
 *   macOS   — Developer ID Application (`codesign --options runtime
 *             --timestamp --identifier dev.konteks.connector`) + notarytool;
 *             Developer ID Installer for the .pkg (`productsign`).
 *             APPLE_DEVELOPER_ID_P12 (base64 .p12 holding both identities),
 *             APPLE_DEVELOPER_ID_P12_PASSWORD, APPLE_TEAM_ID; notarization:
 *             APPLE_NOTARY_KEY_P8 (App Store Connect API key, .p8 text),
 *             APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER_ID.
 *   Windows — Authenticode (`signtool /fd SHA256 /tr … /td SHA256`) with
 *             WINDOWS_CODESIGN_PFX (base64 .pfx) and WINDOWS_CODESIGN_PASSWORD.
 *   Linux   — a detached Ed25519 signature `<executable>.sig` made with
 *             LINUX_SIGNING_KEY (PKCS#8 PEM); its public key is baked into
 *             the connector (`linuxSigningKeysJson`) and every update must
 *             verify under it.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The one code-signing identifier every connector Mach-O carries. */
export const CONNECTOR_CODE_IDENTIFIER = "dev.konteks.connector";
const ENTITLEMENTS = "packaging/macos/connector.entitlements";
const TIMESTAMP_URL = "http://timestamp.digicert.com";
const SECRETS = {
  macos: ["APPLE_DEVELOPER_ID_P12", "APPLE_DEVELOPER_ID_P12_PASSWORD", "APPLE_TEAM_ID"],
  notary: ["APPLE_NOTARY_KEY_P8", "APPLE_NOTARY_KEY_ID", "APPLE_NOTARY_ISSUER_ID"],
  windows: ["WINDOWS_CODESIGN_PFX", "WINDOWS_CODESIGN_PASSWORD"],
  debian: ["LINUX_SIGNING_KEY"],
};

const run = (command, argv, options = {}) => execFileSync(command, argv, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });

/** True when every secret of the group is set; throws when only some are. */
export function configured(group, env = process.env) {
  const present = SECRETS[group].filter(name => env[name]);
  if (present.length > 0 && present.length < SECRETS[group].length) {
    throw new Error(`${group} signing is only partly configured: set ${SECRETS[group].join(", ")} together (missing ${SECRETS[group].filter(name => !env[name]).join(", ")})`);
  }
  return present.length === SECRETS[group].length;
}

/** One line in the job summary (and an annotation when unsigned), for every signing outcome. */
export function report(what, outcome) {
  const line = outcome.signed ? `${what}: signed (${outcome.detail})` : `${what}: unsigned (deferred) — ${outcome.detail}`;
  console.log(outcome.signed ? line : `::warning title=Unsigned connector::${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
}

/** The Linux signing public keys to bake into the connector, as `KONTEKS_LINUX_SIGNING_KEYS_JSON`. */
export function linuxSigningKeysJson(env = process.env) {
  if (!configured("debian", env)) return "[]";
  return JSON.stringify([createPublicKey(createPrivateKey(env.LINUX_SIGNING_KEY)).export({ format: "jwk" }).x]);
}

/** A private scratch folder removed when this process exits. */
function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * The Developer ID identities in a temporary keychain of their own, or null
 * when macOS signing is not configured. The keychain is never added to the
 * search list and is deleted on exit.
 */
export function macosSigning(env = process.env) {
  if (!configured("macos", env)) return null;
  const directory = scratch("konteks-macos-signing-");
  const keychain = join(directory, "signing.keychain-db");
  const password = randomBytes(24).toString("base64url");
  writeFileSync(join(directory, "identity.p12"), Buffer.from(env.APPLE_DEVELOPER_ID_P12.replace(/\s+/g, ""), "base64"), { mode: 0o600 });
  run("security", ["create-keychain", "-p", password, keychain]);
  process.on("exit", () => { try { execFileSync("security", ["delete-keychain", keychain], { stdio: "ignore" }); } catch { /* already gone */ } });
  run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  run("security", ["unlock-keychain", "-p", password, keychain]);
  run("security", ["import", join(directory, "identity.p12"), "-k", keychain, "-P", env.APPLE_DEVELOPER_ID_P12_PASSWORD, "-T", "/usr/bin/codesign", "-T", "/usr/bin/productsign"]);
  run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain], { stdio: "ignore" });
  return { keychain, team: env.APPLE_TEAM_ID, application: identityOf(keychain, "codesigning", "Developer ID Application", env.APPLE_TEAM_ID), installer: identityOf(keychain, "basic", "Developer ID Installer", env.APPLE_TEAM_ID), notary: configured("notary", env) ? notaryKey(directory, env) : null };
}

/** The SHA-1 of the one identity of this kind for the team. */
function identityOf(keychain, policy, kind, team) {
  const listed = run("security", ["find-identity", "-v", "-p", policy, keychain]);
  const found = listed.split("\n").map(line => line.match(/\b([0-9A-F]{40})\s+"(.+)"/)).filter(match => match && match[2].startsWith(`${kind}: `) && match[2].endsWith(`(${team})`));
  if (found.length !== 1) throw new Error(`APPLE_DEVELOPER_ID_P12 must hold exactly one "${kind}: … (${team})" identity; found ${found.length}`);
  return found[0][1];
}

function notaryKey(directory, env) {
  const key = join(directory, "notary.p8");
  writeFileSync(key, env.APPLE_NOTARY_KEY_P8, { mode: 0o600 });
  return ["--key", key, "--key-id", env.APPLE_NOTARY_KEY_ID, "--issuer", env.APPLE_NOTARY_ISSUER_ID];
}

/** Submit one file (zipped when it is a bare executable) and wait for Apple's verdict. */
export function notarize(signing, file) {
  const directory = scratch("konteks-notary-");
  const submission = file.endsWith(".pkg") ? file : join(directory, "connector.zip");
  if (submission !== file) run("ditto", ["-c", "-k", "--keepParent", file, submission]);
  const verdict = JSON.parse(run("xcrun", ["notarytool", "submit", submission, ...signing.notary, "--wait", "--output-format", "json"]));
  if (verdict.status !== "Accepted") throw new Error(`notarization of ${file} ended ${verdict.status} (submission ${verdict.id}); read it with xcrun notarytool log ${verdict.id}`);
}

function signMacosConnector(file, signing) {
  if (!signing) return { signed: false, detail: `ad-hoc, identifier ${CONNECTOR_CODE_IDENTIFIER}; macOS identifies each build by its hash until ${SECRETS.macos.join(", ")} are set` };
  run("codesign", ["--force", "--options", "runtime", "--timestamp", "--identifier", CONNECTOR_CODE_IDENTIFIER, "--entitlements", ENTITLEMENTS, "--keychain", signing.keychain, "--sign", signing.application, file]);
  run("codesign", ["--verify", "--strict", "--verbose=2", file]);
  if (!signing.notary) return { signed: true, detail: `Developer ID ${signing.team}, not notarized: set ${SECRETS.notary.join(", ")}` };
  notarize(signing, file);
  return { signed: true, detail: `Developer ID ${signing.team}, notarized` };
}

/** signtool from the newest Windows SDK on the runner (it is not on PATH there). */
function signtool() {
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = existsSync(kits) ? readdirSync(kits).filter(name => /^10\./.test(name) && existsSync(join(kits, name, "x64", "signtool.exe"))).sort() : [];
  if (versions.length === 0) throw new Error("signtool.exe was not found in a Windows 10 SDK; it is required to sign the Windows connector");
  return join(kits, versions.at(-1), "x64", "signtool.exe");
}

/** Authenticode signing of one file with the configured certificate, or null when Windows signing is not configured. */
export function windowsSigning(env = process.env) {
  if (!configured("windows", env)) return null;
  const pfx = join(scratch("konteks-authenticode-"), "codesign.pfx");
  writeFileSync(pfx, Buffer.from(env.WINDOWS_CODESIGN_PFX.replace(/\s+/g, ""), "base64"), { mode: 0o600 });
  const tool = signtool();
  return (file) => {
    run(tool, ["sign", "/fd", "SHA256", "/tr", TIMESTAMP_URL, "/td", "SHA256", "/f", pfx, "/p", env.WINDOWS_CODESIGN_PASSWORD, file]);
    run(tool, ["verify", "/pa", file]);
  };
}

function signWindowsConnector(file, sign) {
  if (!sign) return { signed: false, detail: `no Authenticode signature until ${SECRETS.windows.join(", ")} are set` };
  sign(file);
  return { signed: true, detail: "Authenticode, timestamped" };
}

async function signLinuxExecutable(file, env) {
  if (!configured("debian", env)) return { signed: false, detail: `no detached signature until ${SECRETS.debian[0]} is set` };
  const { signLinuxConnector, readCodeIdentity, linuxSigningKeyId } = await import(pathToFileURL(join(process.cwd(), "packages", "release", "dist", "index.js")).href);
  const key = createPrivateKey(env.LINUX_SIGNING_KEY);
  writeFileSync(`${file}.sig`, await signLinuxConnector(file, key));
  const x = createPublicKey(key).export({ format: "jwk" }).x;
  const identity = await readCodeIdentity(file, "debian", { linuxKeys: [x] });
  if (!identity.signed) throw new Error("the Linux connector signature does not verify under its own key");
  return { signed: true, detail: `Ed25519 key ${linuxSigningKeyId(x)}` };
}

/**
 * Sign the connector executable in place for `os` when that OS's secrets
 * are configured; `context` carries the macOS keychain or Windows signer the
 * installer is signed with too. Reports the outcome either way.
 */
export async function signConnector(os, file, context = {}, env = process.env) {
  const outcome = os === "macos" ? signMacosConnector(file, context.macos)
    : os === "windows" ? signWindowsConnector(file, context.windows)
      : await signLinuxExecutable(file, env);
  report(`connector ${os}`, outcome);
  return outcome;
}
