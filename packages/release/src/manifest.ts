import { z } from "zod";
import { RemoteInstanceError, type Ed25519PublicJwk, type RemoteSignedBundleManifest } from "@konteks/remote-common";

/**
 * Release trust. A native release manifest (`native.ts`) is verified against
 * the Ed25519 release roots embedded in the signed launcher, never against
 * TLS or Core (invariant 32).
 */
export interface EmbeddedReleaseRoot {
  keyId: string;
  publicKeyJwk: Ed25519PublicJwk;
  /** Optional Core control-signing key certified by this root (see supervisor control channel). */
  coreControlKeys?: Array<{ keyId: string; publicKeyJwk: Ed25519PublicJwk }> | undefined;
}

export const EmbeddedReleaseRootSchema = z
  .object({
    keyId: z.string().min(1),
    publicKeyJwk: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(1) }).strict(),
    coreControlKeys: z
      .array(
        z
          .object({
            keyId: z.string().min(1),
            publicKeyJwk: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(1) }).strict(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

function untrusted(reason: string): RemoteInstanceError {
  return new RemoteInstanceError("bundle_untrusted", `bundle_untrusted: ${reason}`, {
    recoveryActions: [{ kind: "update" }, { kind: "contact_support" }],
  });
}

/**
 * A refreshed exchange manifest (provisioning-credential refresh) may carry a
 * new signature envelope but must be the exact same bundle version and digest.
 */
export function assertSameBundle(previous: RemoteSignedBundleManifest, refreshed: RemoteSignedBundleManifest): void {
  if (previous.digest !== refreshed.digest || previous.bundleVersion !== refreshed.bundleVersion) {
    throw untrusted("refreshed manifest changed the bundle version or digest");
  }
}
