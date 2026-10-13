import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { canonicalize, withoutMembers, type JsonValue } from "./jcs.js";

export function sha256Base64Url(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A file's `sha256:<hex>` digest, read as a stream so a connector executable is never held in memory. */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", chunk => hash.update(chunk)).once("error", reject).once("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

/** `base64url(SHA-256(JCS(value)))` — the contract's digest for any JSON body. */
export function jcsDigest(value: JsonValue): string {
  return sha256Base64Url(canonicalize(value));
}

/**
 * `payloadDigest` for an `AssignmentReport`: the report with
 * `reportedAt` and `payloadDigest` removed, canonicalized, hashed.
 */
export function reportPayloadDigest(report: { [key: string]: JsonValue }): string {
  return jcsDigest(withoutMembers(report, ["reportedAt", "payloadDigest"]));
}

/** Keyed hash used for the opaque `authIdentityFingerprint`. */
export function keyedFingerprint(key: Uint8Array, identitySignal: string): string {
  const digest = createHmac("sha256", key).update(identitySignal).digest("base64url");
  // Wire snapshot identities must start with an alphanumeric character.
  // Preserve already-valid fingerprints so an update does not change their
  // existing agent identity; disambiguate the rare base64url '_'/'-' prefix.
  return /^[A-Za-z0-9]/.test(digest) ? digest : `f${digest}`;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
