import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { canonicalize, withoutMembers, type JsonValue } from "./jcs.js";
import { sha256Base64Url } from "./digest.js";

/**
 * The appliance's ES256 (P-256) instance key. The private half never leaves
 * the supervisor's restricted volume, is never mounted into a component or
 * runner, and is never sent after public-key registration.
 */
/** The only public key shape an instance key ever has (ES256 over P-256). */
export interface EcP256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

function asEcP256PublicJwk(jwk: JsonWebKey): EcP256PublicJwk {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("instance key is not an EC P-256 key");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

export interface InstanceKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyJwk: EcP256PublicJwk;
}

export function generateInstanceKey(): InstanceKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKey, publicKeyJwk: asEcP256PublicJwk(publicKey.export({ format: "jwk" })) };
}

export function instanceKeyFromPrivateJwk(jwk: JsonWebKey): InstanceKeyPair {
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyJwk: asEcP256PublicJwk(publicKey.export({ format: "jwk" })) };
}

export function exportPrivateJwk(key: InstanceKeyPair): JsonWebKey {
  return key.privateKey.export({ format: "jwk" });
}

export function publicKeyFromJwk(jwk: JsonWebKey): KeyObject {
  return createPublicKey({ key: jwk, format: "jwk" });
}

/** 16 CSPRNG bytes, base64url — the single canonical client nonce per request. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * The instance-key request proof: `{ algorithm: 'ES256', nonce, signature }`.
 *
 * wire-contracts.md fixes WHAT the signature covers ("the normalized request
 * body, nonce, method, audience, and instance/activation ID") but the D125
 * `CanonicalProofInput` formula is specified only for the replica/relay/attach
 * profiles. This profile mirrors it exactly so CP3's verifier can reuse the
 * same reconstruction: JCS of a closed object whose `bodyDigest` is the JCS
 * digest of the body with every `PROOF_MEMBERS` entry removed.
 */
// CONTRACT-GAP: the byte layout of the ES256 instance-key proof is not fixed
// by wire-contracts.md; this profile ('konteks-instance-proof-v1') is the
// closest faithful reading of D125. CP3 adopted it verbatim
// (core/plugins/remote-instance-backend crypto/instanceProof.ts) with
// audience 'konteks:remote-instance'; the gap now only asks CP1 to publish
// the profile as the shared reference so neither side re-derives it.
export interface InstanceProofInput {
  v: "konteks-instance-proof-v1";
  method: string; // closed per endpoint: 'activation_exchange' | 'provisioning_refresh' | 'readiness' | 'reconnect' | 'relay_handshake' | 'lease_renew' | 'token_redeem'
  audience: string; // Core audience the endpoint names (e.g. 'konteks:remote-instance')
  subject: string; // instanceId, or activationId before an instance exists
  bodyDigest: string;
  nonce: string;
}

export interface InstanceProof {
  algorithm: "ES256";
  nonce: string;
  signature: string;
}

export function instanceProofBytes(input: InstanceProofInput): Uint8Array {
  return Buffer.from(canonicalize(input as unknown as JsonValue), "utf8");
}

export function signInstanceProof(
  key: Pick<InstanceKeyPair, "privateKey">,
  args: { method: string; audience: string; subject: string; body: { [key: string]: JsonValue } },
  nonce: string = newNonce(),
): InstanceProof {
  const bodyDigest = sha256Base64Url(canonicalize(withoutMembers(args.body, PROOF_MEMBERS_LOCAL)));
  const bytes = instanceProofBytes({
    v: "konteks-instance-proof-v1",
    method: args.method,
    audience: args.audience,
    subject: args.subject,
    bodyDigest,
    nonce,
  });
  const signature = cryptoSign("sha256", bytes, {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return { algorithm: "ES256", nonce, signature };
}

export function verifyInstanceProof(
  publicKey: KeyObject,
  args: { method: string; audience: string; subject: string; body: { [key: string]: JsonValue } },
  proof: InstanceProof,
): boolean {
  if (proof.algorithm !== "ES256") return false;
  const bodyDigest = sha256Base64Url(canonicalize(withoutMembers(args.body, PROOF_MEMBERS_LOCAL)));
  const bytes = instanceProofBytes({
    v: "konteks-instance-proof-v1",
    method: args.method,
    audience: args.audience,
    subject: args.subject,
    bodyDigest,
    nonce: proof.nonce,
  });
  try {
    return cryptoVerify(
      "sha256",
      bytes,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(proof.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

const PROOF_MEMBERS_LOCAL = ["replicaAuth", "proof", "keyProof", "relayAuth", "signature"] as const;

/**
 * Detached signature over a JSON body (control acks, heartbeats, observations,
 * the supervisor `RelayAck`): `base64url(ES256(JCS(body minus signature)))`.
 */
export function signBody(
  key: Pick<InstanceKeyPair, "privateKey">,
  body: { [key: string]: JsonValue },
): string {
  const bytes = Buffer.from(canonicalize(withoutMembers(body, ["signature"])), "utf8");
  return cryptoSign("sha256", bytes, { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString(
    "base64url",
  );
}

export function verifyBody(
  publicKey: KeyObject,
  body: { [key: string]: JsonValue },
  signature: string,
): boolean {
  const bytes = Buffer.from(canonicalize(withoutMembers(body, ["signature"])), "utf8");
  try {
    return cryptoVerify(
      "sha256",
      bytes,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * The supervisor `RelayAck` signature covers `channelId`, `dataDirection`,
 * `cumulativeSeq`, and `issuedAt` — never the epoch, which the relay re-stamps
 * per hop (D115).
 */
export function signRelayAck(
  key: Pick<InstanceKeyPair, "privateKey">,
  ack: { channelId: string; dataDirection: "to_runtime"; cumulativeSeq: number; issuedAt: string },
): string {
  return signBody(key, {
    channelId: ack.channelId,
    dataDirection: ack.dataDirection,
    cumulativeSeq: ack.cumulativeSeq,
    issuedAt: ack.issuedAt,
  });
}
