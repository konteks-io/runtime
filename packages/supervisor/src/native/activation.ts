import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isFsErrorWithCode, jcsDigest, RemoteInstanceError, RemotePlatformSchema, type Clock, type FetchFn } from "@konteks/remote-common";
import { selectNativeArtifacts, verifyNativeRelease, type EmbeddedReleaseRoot, type VerifiedNativeRelease } from "@konteks/remote-release";
import { CoreClient } from "../core/client.js";
import { runActivationExchange, type ActivationExchangeOutcome } from "../provisioning/activation.js";
import { SupervisorStore } from "../state/store.js";
import { SupervisorJournal } from "../state/journal.js";
import { StateMutationGate } from "../state/mutation-gate.js";
import { acquireNativeRootLock } from "./root-lock.js";

/** Install's native exchange phase: owns state before creating a key or nonce. */
export async function runNativeActivationExchange(args: {
  dataDir: string;
  coreUrl: string;
  activationId: string;
  platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64"; containerBackend: "none"; deploymentKind: "native_connector" };
  release: VerifiedNativeRelease;
  roots: readonly EmbeddedReleaseRoot[];
  clock: Clock;
  readActivationCode: () => Promise<string>;
  fetchFn?: FetchFn;
}): Promise<ActivationExchangeOutcome> {
  const platform = RemotePlatformSchema.parse(args.platform);
  if (platform.deploymentKind !== "native_connector" || platform.containerBackend !== "none") throw new RemoteInstanceError("registration_mismatch", "Native activation cannot use an appliance platform.");
  const release = verifyNativeRelease(args.release.manifest, args.roots, args.clock.now());
  selectNativeArtifacts(release, { ...platform, agentIds: [] });
  if (!isAbsolute(args.dataDir)) throw new RemoteInstanceError("install_state_corrupt", "Native enrollment requires an absolute private root.");
  let fresh = false;
  try { await mkdir(args.dataDir, { mode: 0o700 }); fresh = true; }
  catch (error) { if (!isFsErrorWithCode(error, "EEXIST")) throw error; }
  const owner = acquireNativeRootLock(args.dataDir);
  const mutations = new StateMutationGate(() => owner.assertOwned());
  try {
    const store = new SupervisorStore(args.dataDir, mutations.run);
    await store.init();
    const journal = new SupervisorJournal(store.path("journal"), mutations.run); await journal.load();
    const attempt = await store.activationAttempt();
    const identityBeforeExchange = await store.identity();
    const keyFile = await lstat(store.path("instance-key.jwk")).catch(error => { if (isFsErrorWithCode(error, "ENOENT")) return null; throw error; });
    if (attempt || journal.execution.enrollment()) {
      if (!keyFile?.isFile() || keyFile.nlink !== 1) throw new RemoteInstanceError("install_state_corrupt", "The native activation's original key is missing or unsafe; restore its original private state.");
    }
    const key = await store.loadOrCreateInstanceKey();
    const keyDigest = jcsDigest(key.publicKeyJwk as never);
    // mkdir and lock acquisition are separate operations. A competing caller
    // may have enrolled in between; never promote its existing state as ours.
    if (fresh && !keyFile && !attempt && !identityBeforeExchange) await journal.execution.seedEnrollment({ enrollmentId: randomUUID(), activationId: args.activationId, keyDigest, createdAt: args.clock.nowIso() });
    const enrollment = journal.execution.enrollment();
    if (enrollment && (enrollment.activationId !== args.activationId || enrollment.keyDigest !== keyDigest)) throw new RemoteInstanceError("registration_mismatch", "Native enrollment retry changed its original lineage.");
    const core = new CoreClient({ baseUrl: args.coreUrl, clock: args.clock, key: () => key, credential: () => null, ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}) });
    const outcome = await runActivationExchange({ store, core, key, clock: args.clock, activationId: args.activationId, platform: { ...platform, containerBackend: "none", deploymentKind: "native_connector" }, deploymentKind: "native_connector", release, roots: args.roots, readActivationCode: async () => {
      const code = await args.readActivationCode();
      owner.assertOwned();
      return code;
    } });
    owner.assertOwned();
    if (enrollment) {
      const identity = await store.identity();
      if (!identity || identity.instanceId !== outcome.instanceId || !identity.workspaceId || identity.activationId !== enrollment.activationId) throw new RemoteInstanceError("registration_mismatch", "Activation did not establish the native enrollment identity.");
      await journal.execution.bindEnrollment({ ...enrollment, instanceId: identity.instanceId, workspaceId: identity.workspaceId, exchangeNonce: identity.exchangeNonce });
      owner.assertOwned();
    }
    return outcome;
  } finally {
    await mutations.close();
    owner.release();
  }
}
