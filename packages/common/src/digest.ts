import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize, withoutMembers, type JsonValue } from "./jcs.js";

export function sha256Base64Url(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `base64url(SHA-256(JCS(value)))` — the contract's digest for any JSON body. */
export function jcsDigest(value: JsonValue): string {
  return sha256Base64Url(canonicalize(value));
}

/**
 * `payloadDigest` for an `AssignmentReport` (D125): the report with
 * `reportedAt` and `payloadDigest` removed, canonicalized, hashed.
 */
export function reportPayloadDigest(report: { [key: string]: JsonValue }): string {
  return jcsDigest(withoutMembers(report, ["reportedAt", "payloadDigest"]));
}

/** Keyed hash used for the opaque `authIdentityFingerprint` (D111). */
export function keyedFingerprint(key: Uint8Array, identitySignal: string): string {
  return createHmac("sha256", key).update(identitySignal).digest("base64url");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
