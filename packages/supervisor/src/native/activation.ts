import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createLogger, isFsErrorWithCode, jcsDigest, RemoteInstanceError, RemotePlatformSchema, type Clock, type FetchFn } from "@konteks/remote-common";
import { selectNativeArtifacts, verifyNativeRelease, type EmbeddedReleaseRoot, type VerifiedNativeRelease } from "@konteks/remote-release";
import { CoreClient } from "../core/client.js";
import { runActivationExchange, type ActivationExchangeOutcome } from "../provisioning/activation.js";
import { SupervisorStore } from "../state/store.js";
import { SupervisorJournal } from "../state/journal.js";
import { StateMutationGate } from "../state/mutation-gate.js";
import { acquireNativeRootLock, NATIVE_ROOT_LOCK_FILE } from "./root-lock.js";

interface NativeActivationArgs {
  dataDir: string;
  coreUrl: string;
  activationId: string;
  platform: { os: "macos" | "windows" | "debian"; architecture: "amd64" | "arm64"; containerBackend: "none"; deploymentKind: "native_connector" };
  release: VerifiedNativeRelease;
  roots: readonly EmbeddedReleaseRoot[];
  clock: Clock;
  readActivationCode: () => Promise<string>;
  fetchFn?: FetchFn;
}

type RootOwner = ReturnType<typeof acquireNativeRootLock>;
type Enrollment = NonNullable<ReturnType<SupervisorJournal["execution"]["enrollment"]>>;

/** What a root already held before this exchange: an attempt, an identity, the instance key file. */
interface PriorActivation {
  attempt: Awaited<ReturnType<SupervisorStore["activationAttempt"]>>;
  identity: Awaited<ReturnType<SupervisorStore["identity"]>>;
  keyFile: Awaited<ReturnType<typeof lstat>> | null;
}

/** Install's native exchange phase: owns state before creating a key or nonce. */
export async function runNativeActivationExchange(args: NativeActivationArgs): Promise<ActivationExchangeOutcome> {
  const { platform, release } = verifiedActivationTarget(args);
  const fresh = await createPrivateRoot(args.dataDir);
  const owner = acquireNativeRootLock(args.dataDir);
  const mutations = new StateMutationGate(() => owner.assertOwned());
  try {
    const store = new SupervisorStore(args.dataDir, mutations.run);
    await store.init();
    const journal = new SupervisorJournal(store.path("journal"), mutations.run); await journal.load();
    const prior = await priorActivation(store, journal);
    const key = await store.loadOrCreateInstanceKey();
    const enrollment = await enrollmentLineage(journal, args, { fresh, prior, keyDigest: jcsDigest(key.publicKeyJwk as never) });
    const core = new CoreClient({ baseUrl: args.coreUrl, clock: args.clock, key: () => key, credential: () => null, ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}) });
    const outcome = await exchangeOrForget(() => runActivationExchange({ store, core, key, clock: args.clock, activationId: args.activationId, platform: { ...platform, containerBackend: "none", deploymentKind: "native_connector" }, deploymentKind: "native_connector", release, roots: args.roots,
      // The person reads this terminal: its progress lines say what happens,
      // and a JSON log line in between read as noise. Warnings stay.
      logger: createLogger({ name: "provisioning", level: "warn" }),
      readActivationCode: async () => {
      const code = await args.readActivationCode();
      owner.assertOwned();
      return code;
    } }), () => forgetRefusedAttempt(args.dataDir, owner, prior.identity));
    owner.assertOwned();
    if (enrollment) await bindEnrollment(store, journal, enrollment, outcome, owner);
    return outcome;
  } finally {
    await mutations.close();
    owner.release();
  }
}

function verifiedActivationTarget(args: NativeActivationArgs): { platform: ReturnType<typeof RemotePlatformSchema.parse>; release: VerifiedNativeRelease } {
  const platform = RemotePlatformSchema.parse(args.platform);
  if (platform.deploymentKind !== "native_connector" || platform.containerBackend !== "none") throw new RemoteInstanceError("registration_mismatch", "Native activation cannot use an appliance platform.");
  const release = verifyNativeRelease(args.release.manifest, args.roots, args.clock.now());
  selectNativeArtifacts(release, { ...platform, agentIds: [] });
  if (!isAbsolute(args.dataDir)) throw new RemoteInstanceError("install_state_corrupt", "Native enrollment requires an absolute private root.");
  return { platform, release };
}

/** Creates the private root; false when it already existed. */
async function createPrivateRoot(dataDir: string): Promise<boolean> {
  try {
    await mkdir(dataDir, { mode: 0o700 });
    return true;
  } catch (error) {
    if (!isFsErrorWithCode(error, "EEXIST")) throw error;
    return false;
  }
}

async function priorActivation(store: SupervisorStore, journal: SupervisorJournal): Promise<PriorActivation> {
  const attempt = await store.activationAttempt();
  const identity = await store.identity();
  const keyFile = await lstat(store.path("instance-key.jwk")).catch(error => { if (isFsErrorWithCode(error, "ENOENT")) return null; throw error; });
  if ((attempt || journal.execution.enrollment()) && (!keyFile?.isFile() || keyFile.nlink !== 1)) {
    throw new RemoteInstanceError("install_state_corrupt", "The native activation's original key is missing or unsafe; restore its original private state.");
  }
  return { attempt, identity, keyFile };
}

/**
 * The enrollment this activation continues. mkdir and lock acquisition are
 * separate operations: a competing caller may have enrolled in between, so
 * an existing state is never promoted as ours, and a retry must keep its
 * original activation and key.
 */
async function enrollmentLineage(
  journal: SupervisorJournal,
  args: Pick<NativeActivationArgs, "activationId" | "clock">,
  state: { fresh: boolean; prior: PriorActivation; keyDigest: string },
): Promise<Enrollment | undefined> {
  const { prior, keyDigest } = state;
  if (untouchedRoot(state.fresh, prior)) {
    await journal.execution.seedEnrollment({ enrollmentId: randomUUID(), activationId: args.activationId, keyDigest, createdAt: args.clock.nowIso() });
  }
  const enrollment = journal.execution.enrollment();
  if (enrollment && (enrollment.activationId !== args.activationId || enrollment.keyDigest !== keyDigest)) throw new RemoteInstanceError("registration_mismatch", "Native enrollment retry changed its original lineage.");
  return enrollment ?? undefined;
}

/** A root this call created, holding no key, attempt or identity of an earlier enrollment. */
function untouchedRoot(fresh: boolean, prior: PriorActivation): boolean {
  return fresh && !prior.keyFile && !prior.attempt && !prior.identity;
}

/**
 * Konteks answered: this code will never connect here (used, expired, wrong,
 * or no room), and nothing was made. The next command, with a new code from
 * the site, must not meet "Native enrollment retry changed its original
 * lineage", so this attempt is forgotten. An uncertain exchange (no answer)
 * is kept.
 */
async function forgetRefusedAttempt(dataDir: string, owner: RootOwner, identityBeforeExchange: PriorActivation["identity"]): Promise<void> {
  if (identityBeforeExchange) return;
  owner.assertOwned();
  for (const entry of await readdir(dataDir)) {
    if (!entry.startsWith(NATIVE_ROOT_LOCK_FILE)) await rm(join(dataDir, entry), { recursive: true, force: true });
  }
}

async function bindEnrollment(store: SupervisorStore, journal: SupervisorJournal, enrollment: Enrollment, outcome: ActivationExchangeOutcome, owner: RootOwner): Promise<void> {
  const identity = await store.identity();
  if (!identity || identity.instanceId !== outcome.instanceId || !identity.workspaceId || identity.activationId !== enrollment.activationId) throw new RemoteInstanceError("registration_mismatch", "Activation did not establish the native enrollment identity.");
  await journal.execution.bindEnrollment({ ...enrollment, instanceId: identity.instanceId, workspaceId: identity.workspaceId, exchangeNonce: identity.exchangeNonce });
  owner.assertOwned();
}

/** Codes by which Konteks says an activation will never exchange on this machine. */
const REFUSED = new Set(["activation_expired", "activation_consumed", "activation_invalid", "limit_exceeded"]);

async function exchangeOrForget<T>(exchange: () => Promise<T>, forget: () => Promise<void>): Promise<T> {
  try {
    return await exchange();
  } catch (error) {
    if (error instanceof RemoteInstanceError && REFUSED.has(error.code)) await forget().catch(() => undefined);
    throw error;
  }
}
