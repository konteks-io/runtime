import type { KeyObject } from "node:crypto";
import { ed25519Sign, type RemoteSignedBundleManifest } from "@konteks/remote-common";
import {
  ReleaseManifestSchema,
  exchangeManifestDigest,
  exchangeManifestSigningBytes,
  releaseManifestDigest,
  releaseManifestSigningBytes,
  type ReleaseManifest,
} from "./manifest.js";

/**
 * Release-pipeline signing. Lives here so CI and tests share one
 * implementation with the verifier; signing keys are never present in an
 * image or a launcher build.
 */
export function signReleaseManifest(
  unsigned: Omit<ReleaseManifest, "digest" | "signature">,
  key: { keyId: string; privateKey: KeyObject },
): ReleaseManifest {
  const digest = releaseManifestDigest(unsigned);
  const withDigest = { ...unsigned, digest };
  const value = ed25519Sign(key.privateKey, releaseManifestSigningBytes(withDigest));
  return ReleaseManifestSchema.parse({
    ...withDigest,
    signature: { algorithm: "Ed25519", keyId: key.keyId, value },
  });
}

/**
 * Derives the exchange manifest Core will hand back (used by fixtures and by
 * the release pipeline to publish the reference Core stores).
 */
export function deriveExchangeManifest(
  release: ReleaseManifest,
  key: { keyId: string; privateKey: KeyObject },
  expiresAt: string,
): RemoteSignedBundleManifest {
  const unsigned = {
    bundleVersion: release.bundleVersion,
    protocol: release.protocol,
    components: release.components,
    images: release.images.map((image) => ({
      ref: image.ref,
      digest: image.digest,
      signatureRef: image.signatureRef,
    })),
    agentBridges: release.agentBridges.map((bridge) => ({
      agentId: bridge.agentId,
      ref: bridge.ref,
      digest: bridge.digest,
      signatureRef: bridge.signatureRef,
    })),
    expiresAt,
  };
  const digest = exchangeManifestDigest(unsigned as Omit<RemoteSignedBundleManifest, "digest" | "signature">);
  const withDigest = { ...unsigned, digest } as Omit<RemoteSignedBundleManifest, "signature">;
  const value = ed25519Sign(key.privateKey, exchangeManifestSigningBytes(withDigest));
  return { ...withDigest, signature: { algorithm: "Ed25519", keyId: key.keyId, value } } as RemoteSignedBundleManifest;
}
