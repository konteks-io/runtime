import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ed25519Sign, ed25519Verify, fileSha256, RemoteInstanceError, runCommand } from "@konteks/remote-common";

/**
 * The publisher identity the operating system sees in a connector
 * executable. macOS keys privacy grants (App Management, Full Disk Access,
 * Local Network) on a binary's designated requirement; Windows keys
 * SmartScreen and Smart App Control reputation on the Authenticode
 * publisher; Linux has no OS signature, so a detached Ed25519 signature made
 * with a key this build pins stands in for one. Unsigned means none of those
 * is present: an ad-hoc macOS signature (its requirement is the build's own
 * hash), no Authenticode signature, or no signature from a pinned key.
 */
export type CodeIdentity = { signed: false } | { signed: true; publisher: string };

type IdentityOs = "macos" | "windows" | "debian";
type IdentityRun = (command: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface CodeIdentityDeps {
  run?: IdentityRun;
  /** The Ed25519 public keys (JWK `x`) a Linux connector signature may be made with. */
  linuxKeys?: readonly string[];
}

const UNSIGNED: CodeIdentity = Object.freeze({ signed: false });
const LinuxKeysSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]{43}$/));

/** The Linux connector signing keys the release build pins into this executable (`build-launcher.mjs`). */
export const EMBEDDED_LINUX_SIGNING_KEYS: readonly string[] = Object.freeze(parseLinuxSigningKeys(process.env.KONTEKS_LINUX_SIGNING_KEYS_JSON));

export function parseLinuxSigningKeys(json: string | undefined): string[] {
  return json ? LinuxKeysSchema.parse(JSON.parse(json)) : [];
}

const READERS: Readonly<Record<IdentityOs, (file: string, deps: CodeIdentityDeps) => Promise<CodeIdentity>>> = {
  macos: macosIdentity,
  windows: windowsIdentity,
  debian: linuxIdentity,
};

/**
 * The publisher of the executable at `file`, or unsigned. A signature that
 * is present but does not verify is refused rather than read as unsigned.
 */
export function readCodeIdentity(file: string, os: IdentityOs, deps: CodeIdentityDeps = {}): Promise<CodeIdentity> {
  return READERS[os](file, deps);
}

const defaultRun: IdentityRun = (command, args) => runCommand({ command, args, timeoutMs: 60_000 });

async function macosIdentity(file: string, deps: CodeIdentityDeps): Promise<CodeIdentity> {
  const run = deps.run ?? defaultRun;
  if (!(await macosPublisherSigned(file, run))) return UNSIGNED;
  if ((await run("codesign", ["--verify", "--strict", file])).code !== 0) throw invalidSignature();
  const requirement = await run("codesign", ["-d", "-r-", file]);
  const designated = `${requirement.stdout}\n${requirement.stderr}`.match(/^designated => (.+)$/m)?.[1]?.trim();
  if (requirement.code !== 0 || !designated) throw invalidSignature();
  return { signed: true, publisher: `macos ${designated}` };
}

/** Signed with a certificate of a team; false when not signed at all or only ad-hoc (no team). */
async function macosPublisherSigned(file: string, run: IdentityRun): Promise<boolean> {
  const details = await run("codesign", ["-dv", "--verbose=2", file]);
  const text = `${details.stdout}\n${details.stderr}`;
  if (details.code !== 0) {
    if (/not signed at all/.test(text)) return false;
    throw invalidSignature();
  }
  return !/^Signature=adhoc$/m.test(text) && !/^TeamIdentifier=not set$/m.test(text);
}

const AuthenticodeSchema = z.object({ status: z.string(), subject: z.string() });

/** The signature's status and signer, read by Windows itself; the path is a quoted literal, never code. */
function authenticodeScript(file: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$signature = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'`,
    "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
    "[Console]::Out.Write((@{ status = [string]$signature.Status; subject = $subject } | ConvertTo-Json -Compress))",
  ].join("\n");
}

async function windowsIdentity(file: string, deps: CodeIdentityDeps): Promise<CodeIdentity> {
  const run = deps.run ?? defaultRun;
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(authenticodeScript(file), "utf16le").toString("base64")]);
  const parsed = result.code === 0 ? AuthenticodeSchema.safeParse(parseJson(result.stdout.trim())) : null;
  if (!parsed?.success) throw new RemoteInstanceError("temporarily_unavailable", "Windows could not read the connector's signature.");
  if (parsed.data.status === "NotSigned") return UNSIGNED;
  if (parsed.data.status !== "Valid" || !parsed.data.subject) throw invalidSignature();
  return { signed: true, publisher: `windows ${parsed.data.subject}` };
}

/** `<executable>.sig`: the connector's digest, signed with a pinned Ed25519 key. */
const LinuxSignatureSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("Ed25519"),
  keyId: z.string().regex(/^[a-f0-9]{16}$/),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signature: z.string().min(1),
}).strict();
type LinuxSignature = z.infer<typeof LinuxSignatureSchema>;

async function linuxIdentity(file: string, deps: CodeIdentityDeps): Promise<CodeIdentity> {
  const raw = await readFile(`${file}.sig`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return UNSIGNED;
  const signature = LinuxSignatureSchema.safeParse(parseJson(raw));
  if (!signature.success) throw invalidSignature();
  // A key this build does not pin proves nothing it can check.
  const key = (deps.linuxKeys ?? EMBEDDED_LINUX_SIGNING_KEYS).find(x => linuxSigningKeyId(x) === signature.data.keyId);
  if (!key) return UNSIGNED;
  if (!(await linuxSignatureHolds(file, signature.data, linuxPublicKey(key)))) throw invalidSignature();
  return { signed: true, publisher: `debian ed25519:${signature.data.keyId}` };
}

async function linuxSignatureHolds(file: string, signature: LinuxSignature, key: KeyObject): Promise<boolean> {
  return (await fileSha256(file)) === signature.digest && ed25519Verify(key, linuxSignedBytes(signature.digest), signature.signature);
}

/** The short id a Linux signature names its key by: the first 16 hex of SHA-256 over the key's JWK `x`. */
export function linuxSigningKeyId(x: string): string {
  return createHash("sha256").update(x).digest("hex").slice(0, 16);
}

/** The release build's side: the `.sig` document for one connector executable. */
export async function signLinuxConnector(file: string, privateKey: KeyObject): Promise<string> {
  const x = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (!x) throw new Error("the Linux connector signing key must be an Ed25519 private key");
  const digest = await fileSha256(file);
  const document: LinuxSignature = { version: 1, algorithm: "Ed25519", keyId: linuxSigningKeyId(x), digest, signature: ed25519Sign(privateKey, linuxSignedBytes(digest)) };
  return `${JSON.stringify(document)}\n`;
}

function linuxSignedBytes(digest: string): Uint8Array {
  return Buffer.from(`konteks-connector-signature-v1\n${digest}\n`, "utf8");
}

function linuxPublicKey(x: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function invalidSignature(): RemoteInstanceError {
  return new RemoteInstanceError("bundle_untrusted", "The connector's signature does not verify.");
}
