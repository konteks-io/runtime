import {
  allEqual,
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
import { assertSameBundle, verifyNativeRelease, type VerifiedNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import type { CoreClient } from "../core/client.js";
import type { SupervisorStore } from "../state/store.js";

/**
 * Two-phase provisioning (invariants 27/31/32). Phase 1 exchanges the
 * one-time activation code: generate/load the instance key, prove possession,
 * consume the activation, verify the returned bundle manifest against the
 * embedded release root AND the independently verified native release, and
 * persist identity + the short provisioning credential.
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
type ActivationExchangeArgs = ActivationExchangeBase & {
  deploymentKind: "native_connector";
  platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64"; containerBackend: "none"; deploymentKind: "native_connector" };
  release: VerifiedNativeRelease;
};

export interface ActivationExchangeOutcome {
  instanceId: string;
  manifest: RemoteSignedBundleManifest;
  manifestDigest: string;
  provisioningWindowExpiresAt: string;
}

export async function runActivationExchange(args: ActivationExchangeArgs): Promise<ActivationExchangeOutcome> {
  const logger = args.logger ?? createLogger({ name: "provisioning" });
  const existing = await args.store.identity();
  assertActivatable(existing, args.activationId);
  const independent = verifyNativeRelease(args.release.manifest, args.roots, args.clock.now());
  const attempt = await args.store.activationAttempt();
  if (existing && !attempt) throw new RemoteInstanceError("registration_mismatch", "Existing identity requires an explicit native migration; it cannot be relabelled during activation.");
  const binding: ActivationBinding = { activationId: args.activationId, keyDigest: jcsDigest(args.key.publicKeyJwk as unknown as JsonValue), platformDigest: jcsDigest(args.platform), manifestDigest: independent.manifest.digest };
  const nonce = await activationNonce(args, existing, attempt, binding);
  const resumed = await resumedProvisioning(args, existing, binding);
  if (resumed) return resumed;
  const result = await exchanged(args, nonce);
  return recordExchange(args, result, nonce, logger);
}

type Identity = Awaited<ReturnType<SupervisorStore["identity"]>>;
type ActivationAttempt = Awaited<ReturnType<SupervisorStore["activationAttempt"]>>;
type ActivationBinding = { activationId: string; keyDigest: string; platformDigest: string; manifestDigest: string };

function assertActivatable(existing: Identity, activationId: string): void {
  if (existing && existing.activationId !== activationId) {
    throw new RemoteInstanceError("registration_mismatch", "this data root already holds an instance from a different activation; uninstall first", {
      recoveryActions: [{ kind: "revoke_in_app" }],
    });
  }
  if (existing && existing.administrativeStatus !== "provisioning") {
    throw new RemoteInstanceError("activation_consumed", "this runtime is already activated", { recoveryActions: [{ kind: "run_doctor" }] });
  }
}

/**
 * A retried exchange reuses its semantic nonce in its idempotency key, and
 * must match its original identity, platform and release; a first attempt
 * is recorded before anything is sent. The transport proof nonce is
 * regenerated for every HTTP attempt.
 */
async function activationNonce(args: ActivationExchangeArgs, existing: Identity, attempt: ActivationAttempt, binding: ActivationBinding): Promise<string> {
  if (attempt) {
    const same = allEqual([
      [attempt.activationId, binding.activationId],
      [attempt.keyDigest, binding.keyDigest],
      [attempt.platformDigest, binding.platformDigest],
      [attempt.manifestDigest, binding.manifestDigest],
    ]);
    if (!same || (existing && existing.exchangeNonce !== attempt.nonce)) throw new RemoteInstanceError("registration_mismatch", "Activation retry does not match its original identity, platform and release.");
    return attempt.nonce;
  }
  const nonce = existing?.exchangeNonce ?? newNonce();
  await args.store.saveActivationAttempt({ ...binding, nonce, createdAt: args.clock.nowIso() });
  return nonce;
}

/** An exchange that already completed: its stored release must still verify, inside the provisioning window. */
async function resumedProvisioning(args: ActivationExchangeArgs, existing: Identity, binding: ActivationBinding): Promise<ActivationExchangeOutcome | null> {
  const provisioning = await args.store.provisioning();
  const stored = await args.store.manifest();
  if (!existing || !provisioning || !stored) return null;
  const verified = verifyNativeRelease(stored.manifest, args.roots, args.clock.now());
  const consistent = allEqual([
    [verified.manifest.digest, binding.manifestDigest],
    [stored.manifestDigest, binding.manifestDigest],
    [provisioning.manifestDigest, binding.manifestDigest],
  ]);
  if (!consistent) throw new RemoteInstanceError("install_state_corrupt", "Stored native activation release is inconsistent.");
  if (parseRfc3339(provisioning.provisioningWindowExpiresAt) <= args.clock.coreNow()) throw new RemoteInstanceError("provisioning_window_expired", "Native provisioning window expired; a fresh activation is required.");
  return { instanceId: existing.instanceId, manifest: verified.manifest, manifestDigest: binding.manifestDigest, provisioningWindowExpiresAt: provisioning.provisioningWindowExpiresAt };
}

async function exchanged(args: ActivationExchangeArgs, nonce: string) {
  const activationCode = await args.readActivationCode();
  try {
    return await args.core.activationExchange(
      { activationId: args.activationId, activationCode, publicKeyJwk: args.key.publicKeyJwk, platform: args.platform },
      nonce,
    );
  } catch (error) {
    // The message says what to do next, so no second "create a new
    // activation in the App or MCP" line follows it.
    if (error instanceof CoreResponseError) throw new RemoteInstanceError(error.code, activationFailureMessage(error.wireCode), { cause: error });
    throw error;
  }
}

async function recordExchange(args: ActivationExchangeArgs, result: Awaited<ReturnType<typeof exchanged>>, nonce: string, logger: Logger): Promise<ActivationExchangeOutcome> {
  const exchange = verifyNativeRelease(result.bundleManifest, args.roots, args.clock.now());
  if (exchange.manifest.digest !== args.release.manifest.digest) throw new RemoteInstanceError("bundle_untrusted", "Native exchange differs from the independently verified release.");
  const manifestDigest = exchange.manifest.digest;
  await args.store.saveIdentity({
    instanceId: result.instanceId,
    // Known from the exchange, well before the lease that also carries it.
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
const NEW_CODE = "Get a new one on the site (Customize → Runtimes → Connect a runtime) and paste the new command here.";

export function activationFailureMessage(code: string): string {
  switch (code) {
    case "activation_expired":
      return `This code has expired. ${NEW_CODE}`;
    case "activation_consumed":
      return `This code was already used. ${NEW_CODE}`;
    case "activation_invalid":
      return "That code was not accepted. Check it against the site and paste the command again; if it keeps failing, get a new code there (Customize → Runtimes → Connect a runtime).";
    case "limit_exceeded":
      return "This workspace's plan has no room for another computer. Remove one in Customize → Runtimes, or change plans in Settings → Plan.";
    default:
      return `Konteks could not connect this computer (${code}). ${NEW_CODE}`;
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
  const result = await refreshedCredential(args.core, identity.instanceId, provisioning.manifestDigest);
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

async function refreshedCredential(core: CoreClient, instanceId: string, manifestDigest: string) {
  try {
    return await core.refreshProvisioningCredential({ instanceId, manifestDigest });
  } catch (error) {
    if (error instanceof CoreResponseError && error.code === "provisioning_window_expired") {
      throw new RemoteInstanceError("provisioning_window_expired", "the provisioning window has expired; create a fresh activation", { recoveryActions: [{ kind: "new_activation" }], cause: error });
    }
    throw error;
  }
}
export function provisioningCredentialIsExpired(provisioning: { provisioningCredentialExpiresAt: string }, clock: Clock, marginMs = 60_000): boolean {
  return parseRfc3339(provisioning.provisioningCredentialExpiresAt) - marginMs <= clock.coreNow();
}

/**
 * Phase 2: signed readiness of the native agent runner. Agent login is NOT a
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
  if (stored.manifest.deploymentKind !== "native_connector") throw new RemoteInstanceError("bundle_untrusted", "a native connector requires a native release");
  const result = await args.core.submitReadiness({
    instanceId: identity.instanceId,
    deploymentKind: "native_connector",
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
