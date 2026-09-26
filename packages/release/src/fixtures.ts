import { generateEd25519 } from "@konteks/remote-common";
import type { KeyObject } from "node:crypto";
import type { EmbeddedReleaseRoot } from "./manifest.js";

/** Test fixture shared across packages: a throwaway release root and its signing key. */
export interface ReleaseFixture {
  root: EmbeddedReleaseRoot;
  privateKey: KeyObject;
  keyId: string;
}

export function buildReleaseFixture(): ReleaseFixture {
  const { privateKey, publicJwk } = generateEd25519();
  const keyId = "release-root-test";
  return { root: { keyId, publicKeyJwk: publicJwk }, privateKey, keyId };
}
