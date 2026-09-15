import { z } from "zod";
import {
  RemoteInstanceError,
  canonicalize,
  ed25519PublicKeyFromJwk,
  ed25519Verify,
  jcsDigest,
  parseRfc3339,
  withoutMembers,
  type JsonValue,
  type RemoteSignedBundleManifest,
  type Ed25519PublicJwk,
} from "@konteks/remote-common";

/**
 * The signed release manifest the launcher fetches INDEPENDENTLY of Core.
 * It is a superset of the exchange manifest Core returns
 * (`RemoteSignedBundleManifest`): the same bundle version, images, and agent
 * bridges, plus everything installation-and-auth.md requires the release to
 * pin — Compose template digest, minimum host versions, SBOM/provenance
 * references, migration order and compatibility, health gates, rollback
 * metadata, and the signed egress allowlist the gateway enforces.
 *
 * Trust comes from the Ed25519 release root embedded in the signed launcher,
 * never from TLS or from Core (invariant 32).
 */
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const COMPOSE_CONFIG_SCHEMA_VERSION = 1;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "image digests must be sha256:<hex>");
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const refSchema = z.string().min(1).max(512);

export const BundleComponentSchema = z.enum([
  "supervisor",
  "gateway",
  "agent-runner",
  "browser-tool",
  "preview-forwarder",
  "sysmon",
  "harness",
  "validation-runtime",
  "postgres",
  "valkey",
]);
export type BundleComponent = z.infer<typeof BundleComponentSchema>;

export const ReleaseImageSchema = z
  .object({
    component: BundleComponentSchema,
    ref: refSchema,
    digest: digestSchema,
    architectures: z.array(z.enum(["amd64", "arm64"])).min(1),
    signatureRef: refSchema,
    sbomRef: refSchema,
    provenanceRef: refSchema,
    version: z.string().min(1),
  })
  .strict();
export type ReleaseImage = z.infer<typeof ReleaseImageSchema>;

export const AgentBridgeLoginToolingSchema = z
  .object({
    /** Official login command run inside the credential volume; interactive. */
    login: z.array(z.string().min(1)).min(1),
    logout: z.array(z.string().min(1)).min(1),
    /** Official identity/status signal used for the keyed fingerprint (D111); absent = conservative fallback. */
    identitySignal: z.array(z.string().min(1)).min(1).optional(),
    /** Whether the bridge documents a file-backed host cache that may be copied once with consent. */
    hostCacheImport: z
      .object({ relativePath: z.string().min(1), documentedBy: z.string().url() })
      .strict()
      .optional(),
  })
  .strict();

export const ReleaseAgentBridgeSchema = z
  .object({
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    displayName: z.string().min(1).max(80),
    /** npm package name and exact version vendored into the runner image at build time. */
    package: z.string().min(1),
    version: z.string().min(1),
    /** OCI ref + digest of the runner image family that vendors this bridge. */
    ref: refSchema,
    digest: digestSchema,
    signatureRef: refSchema,
    acpProtocol: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).strict(),
    /** Command the runner spawns over stdio; never a package-registry lookup at runtime. */
    command: z.array(z.string().min(1)).min(1),
    tooling: AgentBridgeLoginToolingSchema,
    /** The CP0 bridge matrix: how this bridge honours the gateway base URL when keyed. */
    egress: z
      .object({
        baseUrlEnv: z.string().min(1).optional(),
        providers: z.array(z.enum(["anthropic", "openai", "google", "deepseek"])).min(1),
      })
      .strict(),
  })
  .strict();
export type ReleaseAgentBridge = z.infer<typeof ReleaseAgentBridgeSchema>;

export const EgressAllowlistEntrySchema = z
  .object({
    provider: z.enum(["anthropic", "openai", "google", "deepseek"]),
    hosts: z.array(z.string().min(1)).min(1),
    pathPrefixes: z.array(z.string().startsWith("/")).min(1),
  })
  .strict();

export const SignedEgressAllowlistSchema = z
  .object({
    revision: z.string().min(1).max(64),
    entries: z.array(EgressAllowlistEntrySchema).min(1),
  })
  .strict();
export type SignedEgressAllowlist = z.infer<typeof SignedEgressAllowlistSchema>;

export const ReleaseMigrationSchema = z
  .object({
    component: z.enum(["harness", "validation-runtime"]),
    order: z.number().int().nonnegative(),
    backwardCompatible: z.boolean(),
    /** Required when not backward compatible: a tested forward-recovery reference. */
    forwardRecoveryRef: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.backwardCompatible || value.forwardRecoveryRef !== undefined, {
    message: "a non-backward-compatible migration must declare forwardRecoveryRef",
  });

export const ReleaseMinimumsSchema = z
  .object({
    launcher: semverSchema,
    dockerEngine: semverSchema,
    dockerDesktop: semverSchema,
    compose: semverSchema,
    wsl: semverSchema,
    memoryBytes: z.number().int().positive(),
    diskBytes: z.number().int().positive(),
    os: z
      .object({ macos: z.string().min(1), windows: z.string().min(1), debian: z.array(z.string().min(1)).min(1) })
      .strict(),
  })
  .strict();

export const ReleaseSignatureSchema = z
  .object({ algorithm: z.literal("Ed25519"), keyId: z.string().min(1), value: z.string().min(1) })
  .strict();

export const ReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_MANIFEST_SCHEMA_VERSION),
    bundleVersion: semverSchema,
    channel: z.literal("stable"),
    protocol: z.object({ min: z.string().min(1), max: z.string().min(1) }).strict(),
    components: z.tuple([
      z.literal("harness"),
      z.literal("validation_runtime"),
      z.literal("agent_runner"),
      z.literal("gateway"),
    ]),
    images: z.array(ReleaseImageSchema).min(1),
    agentBridges: z.array(ReleaseAgentBridgeSchema).min(1),
    compose: z
      .object({ templateDigest: digestSchema, configSchemaVersion: z.literal(COMPOSE_CONFIG_SCHEMA_VERSION) })
      .strict(),
    egressAllowlist: SignedEgressAllowlistSchema,
    minimums: ReleaseMinimumsSchema,
    migrations: z.array(ReleaseMigrationSchema),
    healthGates: z
      .object({ startupTimeoutSeconds: z.number().int().positive(), agentProbeTimeoutSeconds: z.number().int().positive() })
      .strict(),
    rollback: z
      .object({ previousBundleVersion: semverSchema.optional(), compatibleDataFrom: semverSchema })
      .strict(),
    minimumSupportedBundle: semverSchema,
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    digest: z.string().min(1),
    signature: ReleaseSignatureSchema,
  })
  .strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

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

/** `digest` covers the manifest with `digest` and `signature` removed. */
export function releaseManifestDigest(manifest: Omit<ReleaseManifest, "digest" | "signature">): string {
  return jcsDigest(withoutMembers(manifest as unknown as { [key: string]: JsonValue }, ["digest", "signature"]));
}

export function releaseManifestSigningBytes(manifest: Omit<ReleaseManifest, "signature">): Uint8Array {
  return Buffer.from(canonicalize(withoutMembers(manifest as unknown as { [key: string]: JsonValue }, ["signature"])), "utf8");
}

/**
 * Verifies an independently fetched release manifest against the embedded
 * release root: signer, signature, digest, expiry. Any failure is
 * `bundle_untrusted` — the caller must not pull or spawn anything.
 */
export function verifyReleaseManifest(
  candidate: unknown,
  roots: readonly EmbeddedReleaseRoot[],
  nowMs: number,
): ReleaseManifest {
  const parsed = ReleaseManifestSchema.safeParse(candidate);
  if (!parsed.success) throw untrusted("release manifest does not match the schema");
  const manifest = parsed.data;
  const root = roots.find((entry) => entry.keyId === manifest.signature.keyId);
  if (!root) throw untrusted("release manifest signer is not an embedded release root");
  const expectedDigest = releaseManifestDigest(manifest);
  if (expectedDigest !== manifest.digest) throw untrusted("release manifest digest mismatch");
  const key = ed25519PublicKeyFromJwk(root.publicKeyJwk);
  if (!ed25519Verify(key, releaseManifestSigningBytes(manifest), manifest.signature.value)) {
    throw untrusted("release manifest signature does not verify");
  }
  if (parseRfc3339(manifest.expiresAt) <= nowMs) throw untrusted("release manifest has expired");
  if (parseRfc3339(manifest.issuedAt) > nowMs + 5 * 60_000) throw untrusted("release manifest is issued in the future");
  return manifest;
}

/** The exchange manifest's `digest` covers everything but `digest` and `signature`. */
export function exchangeManifestDigest(manifest: Omit<RemoteSignedBundleManifest, "digest" | "signature">): string {
  return jcsDigest(withoutMembers(manifest as unknown as { [key: string]: JsonValue }, ["digest", "signature"]));
}

export function exchangeManifestSigningBytes(manifest: Omit<RemoteSignedBundleManifest, "signature">): Uint8Array {
  return Buffer.from(canonicalize(withoutMembers(manifest as unknown as { [key: string]: JsonValue }, ["signature"])), "utf8");
}

/**
 * The exchange manifest Core returned is only a reference (invariant 32). It
 * must be signed by the embedded root, unexpired, digest-consistent, and agree
 * with the independently fetched release manifest on version and on every
 * image and bridge digest before any pull or bridge use.
 */
export function verifyExchangeManifest(args: {
  exchange: RemoteSignedBundleManifest;
  release: ReleaseManifest;
  roots: readonly EmbeddedReleaseRoot[];
  nowMs: number;
}): { manifestDigest: string } {
  const { exchange, release, roots, nowMs } = args;
  const root = roots.find((entry) => entry.keyId === exchange.signature.keyId);
  if (!root) throw untrusted("exchange manifest signer is not an embedded release root");
  if (exchange.signature.algorithm !== "Ed25519") throw untrusted("exchange manifest uses an unsupported algorithm");
  if (exchangeManifestDigest(exchange) !== exchange.digest) throw untrusted("exchange manifest digest mismatch");
  const key = ed25519PublicKeyFromJwk(root.publicKeyJwk);
  if (!ed25519Verify(key, exchangeManifestSigningBytes(exchange), exchange.signature.value)) {
    throw untrusted("exchange manifest signature does not verify");
  }
  if (parseRfc3339(exchange.expiresAt) <= nowMs) throw untrusted("exchange manifest has expired");
  if (exchange.bundleVersion !== release.bundleVersion) throw untrusted("exchange and release manifests name different bundle versions");
  if (exchange.protocol.min !== release.protocol.min || exchange.protocol.max !== release.protocol.max) {
    throw untrusted("exchange and release manifests disagree on the protocol range");
  }
  const releaseImages = new Map(release.images.map((image) => [image.ref, image]));
  for (const image of exchange.images) {
    const expected = releaseImages.get(image.ref);
    if (!expected) throw untrusted(`exchange manifest names an image the release does not: ${image.ref}`);
    if (expected.digest !== image.digest) throw untrusted(`image digest mismatch for ${image.ref}`);
    if (expected.signatureRef !== image.signatureRef) throw untrusted(`image signature reference mismatch for ${image.ref}`);
  }
  for (const required of release.images) {
    if (!exchange.images.some((image) => image.ref === required.ref)) {
      throw untrusted(`exchange manifest omits release image ${required.ref}`);
    }
  }
  const releaseBridges = new Map(release.agentBridges.map((bridge) => [bridge.agentId, bridge]));
  for (const bridge of exchange.agentBridges) {
    const expected = releaseBridges.get(bridge.agentId);
    if (!expected) throw untrusted(`exchange manifest names an agent bridge the release does not: ${bridge.agentId}`);
    if (expected.digest !== bridge.digest || expected.ref !== bridge.ref) throw untrusted(`agent bridge digest mismatch for ${bridge.agentId}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(bridge.digest)) throw untrusted(`agent bridge ${bridge.agentId} is not digest-pinned`);
  }
  return { manifestDigest: exchange.digest };
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
