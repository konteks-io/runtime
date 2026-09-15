import {
  CoreResponseError,
  RemoteInstanceError,
  createLogger,
  newNonce,
  jcsDigest,
  parseRfc3339,
  type Clock,
  type InstanceKeyPair,
  type Logger,
  type JsonValue,
  type RemoteInstanceReadinessRequest,
  type RemoteSignedBundleManifest,
} from "@konteks/remote-common";
import { assertSameBundle, verifyExchangeManifest, verifyNativeRelease, type VerifiedNativeRelease, type EmbeddedReleaseRoot, type ReleaseManifest } from "@konteks/remote-release";
import type { CoreClient } from "../core/client.js";
import type { SupervisorStore } from "../state/store.js";

/**
 * Two-phase provisioning (invariants 27/31/32). Phase 1 exchanges the
 * one-time activation code before any image pull: generate/load the instance
 * key, prove possession, consume the activation, verify the returned bundle
 * manifest against the embedded release root AND the independently fetched
 * release manifest, and persist identity + the short provisioning credential.
 * The activation code exists only in the prompt closure and is dropped
 * immediately after the request is built.
 */
interface ActivationExchangeBase {
  store: SupervisorStore;
  core: CoreClient;
  clock: Clock;
  key: InstanceKeyPair;
  activationId: string;
  /** Reads the code from the no-echo prompt; never called twice. */
  readActivationCode: () => Promise<string>;
  roots: readonly EmbeddedReleaseRoot[];
  logger?: Logger;
}
export type ActivationExchangeArgs = ActivationExchangeBase & ({
  deploymentKind: "native_connector";
  platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64"; containerBackend: "none"; deploymentKind: "native_connector" };
  release: VerifiedNativeRelease;
} | {
  deploymentKind?: "appliance";
  platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64"; containerBackend: "docker_compose" };
  release: ReleaseManifest;
});

export interface ActivationExchangeOutcome {
  instanceId: string;
  manifest: RemoteSignedBundleManifest;
  manifestDigest: string;
  provisioningWindowExpiresAt: string;
}

export async function runActivationExchange(args: ActivationExchangeArgs): Promise<ActivationExchangeOutcome> {
  const logger = args.logger ?? createLogger({ name: "provisioning" });
  const existing = await args.store.identity();
  if (existing && existing.activationId !== args.activationId) {
    throw new RemoteInstanceError("registration_mismatch", "this data root already holds an instance from a different activation; uninstall first", {
      recoveryActions: [{ kind: "revoke_in_app" }],
    });
  }
  if (existing && existing.administrativeStatus !== "provisioning") {
    throw new RemoteInstanceError("activation_consumed", "this runtime is already activated", { recoveryActions: [{ kind: "run_doctor" }] });
  }
  // A retried exchange reuses this semantic nonce in its idempotency key.
  // The transport proof nonce is regenerated for every HTTP attempt.
  let nonce = existing?.exchangeNonce ?? newNonce();
  if (args.deploymentKind === "native_connector") {
    const independent = verifyNativeRelease(args.release.manifest, args.roots, args.clock.now());
    const attempt = await args.store.activationAttempt();
    if (existing && !attempt) throw new RemoteInstanceError("registration_mismatch", "Existing identity requires an explicit native migration; it cannot be relabelled during activation.");
    const binding = { activationId: args.activationId, keyDigest: jcsDigest(args.key.publicKeyJwk as unknown as JsonValue), platformDigest: jcsDigest(args.platform), manifestDigest: independent.manifest.digest };
    if (attempt) {
      if (attempt.activationId !== binding.activationId || attempt.keyDigest !== binding.keyDigest || attempt.platformDigest !== binding.platformDigest || attempt.manifestDigest !== binding.manifestDigest || (existing && existing.exchangeNonce !== attempt.nonce)) throw new RemoteInstanceError("registration_mismatch", "Activation retry does not match its original identity, platform and release.");
      nonce = attempt.nonce;
    } else {
      await args.store.saveActivationAttempt({ ...binding, nonce, createdAt: args.clock.nowIso() });
    }
    const provisioning = await args.store.provisioning();
    const stored = await args.store.manifest();
    if (existing && provisioning && stored) {
      const verified = verifyNativeRelease(stored.manifest, args.roots, args.clock.now());
      if (verified.manifest.digest !== binding.manifestDigest || stored.manifestDigest !== binding.manifestDigest || provisioning.manifestDigest !== binding.manifestDigest) throw new RemoteInstanceError("install_state_corrupt", "Stored native activation release is inconsistent.");
      if (parseRfc3339(provisioning.provisioningWindowExpiresAt) <= args.clock.coreNow()) throw new RemoteInstanceError("provisioning_window_expired", "Native provisioning window expired; a fresh activation is required.");
      return { instanceId: existing.instanceId, manifest: verified.manifest, manifestDigest: binding.manifestDigest, provisioningWindowExpiresAt: provisioning.provisioningWindowExpiresAt };
    }
  }
  const activationCode = await args.readActivationCode();
  let result;
  try {
    result = await args.core.activationExchange(
      { activationId: args.activationId, activationCode, publicKeyJwk: args.key.publicKeyJwk, platform: args.platform },
      nonce,
    );
  } catch (error) {
    if (error instanceof CoreResponseError) {
      throw new RemoteInstanceError(error.code, activationFailureMessage(error.wireCode), { recoveryActions: [{ kind: "new_activation" }], cause: error });
    }
    throw error;
  }
  let manifestDigest: string;
  if (args.deploymentKind === "native_connector") {
    const exchange = verifyNativeRelease(result.bundleManifest, args.roots, args.clock.now());
    if (exchange.manifest.digest !== args.release.manifest.digest) throw new RemoteInstanceError("bundle_untrusted", "Native exchange differs from the independently verified release.");
    manifestDigest = exchange.manifest.digest;
  } else {
    ({ manifestDigest } = verifyExchangeManifest({ exchange: result.bundleManifest, release: args.release, roots: args.roots, nowMs: args.clock.now() }));
  }
  await args.store.saveIdentity({
    instanceId: result.instanceId,
    // Known from the exchange: the components the launcher renders need it at
    // boot, well before the lease that also carries it.
    workspaceId: result.workspaceId,
    activationId: args.activationId,
    activatedAt: args.clock.nowIso(),
    administrativeStatus: "provisioning",
    exchangeNonce: nonce,
  });
  await args.store.saveProvisioning({
    provisioningCredential: result.provisioningCredential,
    provisioningCredentialExpiresAt: result.provisioningCredentialExpiresAt,
    provisioningWindowExpiresAt: result.provisioningWindowExpiresAt,
    manifestDigest,
    lastRefreshAt: null,
  });
  await args.store.saveManifest(result.bundleManifest, manifestDigest);
  logger.info({ instanceId: result.instanceId }, "activation exchanged; instance is provisioning");
  return { instanceId: result.instanceId, manifest: result.bundleManifest, manifestDigest, provisioningWindowExpiresAt: result.provisioningWindowExpiresAt };
}

function activationFailureMessage(code: string): string {
  switch (code) {
    case "activation_expired":
      return "the activation code has expired; create a new activation in App or MCP";
    case "activation_consumed":
      return "the activation was already used; create a new activation in App or MCP";
    case "activation_invalid":
      return "the activation code was not accepted";
    case "limit_exceeded":
      return "your plan's connected-runtime limit is reached; remove a runtime or upgrade";
    default:
      return `activation exchange failed (${code})`;
  }
}

/**
 * Refreshes the short provisioning credential with the same key inside the
 * overall provisioning window. Never extends the window; after the window a
 * fresh activation is required.
 */
export async function refreshProvisioningCredential(args: { store: SupervisorStore; core: CoreClient; clock: Clock; logger?: Logger }): Promise<void> {
  const logger = args.logger ?? createLogger({ name: "provisioning" });
  const [identity, provisioning, stored] = await Promise.all([args.store.identity(), args.store.provisioning(), args.store.manifest()]);
  if (!identity || !provisioning || !stored) throw new RemoteInstanceError("install_state_corrupt", "provisioning state is incomplete; rerun install");
  if (parseRfc3339(provisioning.provisioningWindowExpiresAt) <= args.clock.coreNow()) {
    throw new RemoteInstanceError("provisioning_window_expired", "the provisioning window has expired; remove this record and create a fresh activation", {
      recoveryActions: [{ kind: "new_activation" }, { kind: "revoke_in_app" }],
    });
  }
  let result;
  try {
    result = await args.core.refreshProvisioningCredential({ instanceId: identity.instanceId, manifestDigest: provisioning.manifestDigest });
  } catch (error) {
    if (error instanceof CoreResponseError && error.code === "provisioning_window_expired") {
      throw new RemoteInstanceError("provisioning_window_expired", "the provisioning window has expired; create a fresh activation", { recoveryActions: [{ kind: "new_activation" }], cause: error });
    }
    throw error;
  }
  if (result.bundleManifest) {
    assertSameBundle(stored.manifest, result.bundleManifest);
    await args.store.saveManifest(result.bundleManifest, stored.manifestDigest);
  }
  await args.store.saveProvisioning({
    ...provisioning,
    provisioningCredential: result.provisioningCredential,
    provisioningCredentialExpiresAt: result.provisioningCredentialExpiresAt,
    provisioningWindowExpiresAt: provisioning.provisioningWindowExpiresAt,
    lastRefreshAt: args.clock.nowIso(),
  });
  logger.info({ instanceId: identity.instanceId }, "provisioning credential refreshed under the same key");
}

export function provisioningCredentialIsExpired(provisioning: { provisioningCredentialExpiresAt: string }, clock: Clock, marginMs = 60_000): boolean {
  return parseRfc3339(provisioning.provisioningCredentialExpiresAt) - marginMs <= clock.coreNow();
}

/**
 * Phase 2: exact four-component signed readiness. Agent login is NOT a
 * readiness condition. On acceptance the provisioning credential is dropped
 * and the first lease is stored.
 */
export async function submitReadiness(args: {
  store: SupervisorStore;
  core: CoreClient;
  clock: Clock;
  protocolVersion: string;
  bundleVersion: string;
  components: RemoteInstanceReadinessRequest["components"];
  logger?: Logger;
}): Promise<{ lease: string; leaseExpiresAt: string }> {
  const logger = args.logger ?? createLogger({ name: "provisioning" });
  const [identity, stored] = await Promise.all([args.store.identity(), args.store.manifest()]);
  if (!identity || !stored) throw new RemoteInstanceError("install_state_corrupt", "cannot submit readiness without identity and manifest");
  const result = await args.core.submitReadiness({
    instanceId: identity.instanceId,
    ...(stored.manifest.deploymentKind === "native_connector" ? { deploymentKind: "native_connector" as const } : {}),
    bundleVersion: args.bundleVersion,
    protocolVersion: args.protocolVersion,
    manifestDigest: stored.manifestDigest,
    components: args.components,
  });
  await args.store.saveIdentity({ ...identity, administrativeStatus: "active" });
  await args.store.clearProvisioning();
  logger.info({ instanceId: identity.instanceId }, "readiness accepted; instance is active");
  return { lease: result.lease, leaseExpiresAt: result.leaseExpiresAt };
}
