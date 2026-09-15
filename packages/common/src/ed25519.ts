import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

/**
 * Ed25519 helpers for release-manifest and Core-control-key signatures. The
 * launcher embeds only PUBLIC release roots; signing keys live in the release
 * pipeline and never in an image.
 */
export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export function ed25519PublicKeyFromJwk(jwk: Ed25519PublicJwk): KeyObject {
  return createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
}

export function ed25519Sign(privateKey: KeyObject, bytes: Uint8Array): string {
  return cryptoSign(null, bytes, privateKey).toString("base64url");
}

export function ed25519Verify(publicKey: KeyObject, bytes: Uint8Array, signature: string): boolean {
  try {
    return cryptoVerify(null, bytes, publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function generateEd25519(): { privateKey: KeyObject; publicJwk: Ed25519PublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x: String(jwk.x) } };
}

export function ed25519PrivateKeyFromJwk(jwk: JsonWebKey): KeyObject {
  return createPrivateKey({ key: jwk, format: "jwk" });
}
