import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CoreResponseError, RemoteInstanceError, SystemClock, writeSecretFile, type RemoteSignedBundleManifest } from "@konteks/remote-common";
import { verifyNativeRelease, type EmbeddedReleaseRoot, type VerifiedNativeRelease } from "@konteks/remote-release";
import { acquireNativeRootLock, CoreClient, NATIVE_ROOT_LOCK_FILE, NativeRuntimeRecordSchema, ownedByAnotherConnector, SupervisorStore, type NativeRuntimeRecord, type NativeRootLock } from "@konteks/remote-supervisor";
import type { NativePlatform } from "./service.js";

type Identity = NonNullable<Awaited<ReturnType<SupervisorStore["identity"]>>>;
const entry = z.string().min(1).max(255).refine(value => value !== "." && value !== ".." && !value.startsWith(NATIVE_ROOT_LOCK_FILE) && !/[\\/]/.test(value));
const RecoverySchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), activationId: z.string().min(1),
  previous: NativeRuntimeRecordSchema, manifest: z.unknown(),
  phase: z.enum(["prepared", "activated", "archiving", "promoting", "promoted"]),
  previousEntries: z.array(entry).max(256).refine(items => new Set(items).size === items.length),
  successorEntries: z.array(entry).max(256).refine(items => new Set(items).size === items.length),
}).strict();
type NativeReinstallState = z.infer<typeof RecoverySchema>;

interface ReinstallOptions {
  root: string; activationId: string; coreUrl: string; relayUrl: string;
  agents: readonly string[] | null; installer: NativeRootLock;
  roots: readonly EmbeddedReleaseRoot[]; platform: NativePlatform; fetchFn: typeof fetch;
  release(): Promise<VerifiedNativeRelease>;
  activate(dataDir: string, release: VerifiedNativeRelease): Promise<Identity>;
  finish(release: VerifiedNativeRelease, identity: Identity, previous: NativeRuntimeRecord): Promise<NativeRuntimeRecord>;
  progress(stage: "checking" | "resuming" | "preserving"): void;
  stopRetired?(record: NativeRuntimeRecord): Promise<void>;
}

function recoveryFile(root: string) { return join(root, "installer", "reinstall.json"); }
function stageRoot(options: ReinstallOptions, state: NativeReinstallState) { return join(options.root, "installer", `reinstall-${state.id}`); }
function archiveRoot(options: ReinstallOptions, state: NativeReinstallState) { return join(options.root, "retired", `reinstall-${state.id}`); }
function conflict(message: string) { return new RemoteInstanceError("registration_mismatch", message); }

async function privateEntry(path: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== process.getuid?.() && process.platform !== "win32") throw conflict("Reinstallation requires private state owned by this user.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw conflict("Reinstallation requires private state owned by this user.");
  return info;
}

export async function readNativeReinstall(root: string): Promise<NativeReinstallState | null> {
  const path = recoveryFile(root);
  const info = await privateEntry(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw conflict("Reinstallation checkpoint is invalid; private data was preserved.");
  try { return RecoverySchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch { throw conflict("Reinstallation checkpoint is invalid; private data was preserved."); }
}

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await privateEntry(path)).isDirectory()) throw conflict("Reinstallation directory is invalid.");
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function retainedKey(dataDir: string) {
  const info = await privateEntry(join(dataDir, "instance-key.jwk")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (!info.isFile() || info.nlink !== 1 || info.size > 65_536)) throw conflict("The existing runtime key is unsafe; private data was preserved.");
  const key = await new SupervisorStore(dataDir).loadInstanceKey();
  if (!key) throw conflict("The existing runtime key is unavailable; private data was preserved. Run konteks-remote doctor.");
  return key;
}

/** A fresh key proof is accepted even after the old bearer was revoked. */
async function assertRuntimeRetired(dataDir: string, previous: NativeRuntimeRecord, fetchFn: typeof fetch): Promise<void> {
  const key = await retainedKey(dataDir);
  const core = new CoreClient({ baseUrl: previous.coreUrl, clock: new SystemClock(), key: () => key, credential: () => null,
    fetchFn: (url, init) => fetchFn(url, { ...init, redirect: "error" }),
  });
  try { await core.resolveRuntimeOwner(previous.instanceId); }
  catch (error) {
    if (error instanceof CoreResponseError && error.wireCode === "instance_revoked" && error.status === 422) return;
    throw new RemoteInstanceError("recovery_required", "Konteks could not verify that the previous runtime was revoked. Private data was preserved; retry this installation when verification is available.", { retryable: true, recoveryActions: [{ kind: "retry" }] });
  }
  throw conflict("This runtime is still registered. Revoke it in Konteks before installing a new activation; private data was preserved.");
}

function assertTarget(options: ReinstallOptions, previous: NativeRuntimeRecord) {
  if (options.coreUrl !== previous.coreUrl || options.relayUrl !== previous.relayUrl) throw conflict("Reinstallation cannot change this runtime's Core or relay address.");
  if (options.agents !== null && JSON.stringify(options.agents) !== JSON.stringify(previous.agents)) throw conflict("Reconnect this runtime with its existing agents first; change agents after installation.");
}

async function save(options: ReinstallOptions, state: NativeReinstallState, phase: NativeReinstallState["phase"]) {
  options.installer.assertOwned();
  state.phase = phase;
  await writeSecretFile(recoveryFile(options.root), JSON.stringify(state));
}

async function entries(path: string): Promise<string[]> {
  return (await readdir(path)).filter(name => !name.startsWith(NATIVE_ROOT_LOCK_FILE)).map(name => entry.parse(name));
}

async function begin(options: ReinstallOptions, previous: NativeRuntimeRecord): Promise<NativeReinstallState> {
  assertTarget(options, previous);
  const dataDir = join(options.root, "supervisor");
  const identity = await new SupervisorStore(dataDir).identity();
  if (identity?.activationId === options.activationId) throw conflict("The existing activation cannot change installation parameters.");
  options.progress("checking");
  await assertRuntimeRetired(dataDir, previous, options.fetchFn);
  const release = await options.release();
  const state = RecoverySchema.parse({ schemaVersion: 1, id: randomUUID(), activationId: options.activationId,
    previous, manifest: release.manifest, phase: "prepared", previousEntries: await entries(dataDir), successorEntries: [],
  });
  await save(options, state, "prepared");
  return state;
}

async function moved(source: string, destination: string) {
  const exists = async (path: string) => lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const [from, to] = await Promise.all([exists(source), exists(destination)]);
  if (from && !to) {
    await rename(source, destination);
    await syncDirectory(dirname(source));
    await syncDirectory(dirname(destination));
    return;
  }
  if (!from && to) return;
  throw conflict("Reinstallation state changed unexpectedly; private data was preserved.");
}

async function archive(options: ReinstallOptions, state: NativeReinstallState, owner: NativeRootLock) {
  const target = archiveRoot(options, state);
  await directory(join(options.root, "retired"));
  await directory(target);
  await directory(join(target, "supervisor"));
  await save(options, state, "archiving");
  owner.assertOwned();
  await moved(join(options.root, "native-runtime.json"), join(target, "native-runtime.json"));
  for (const name of state.previousEntries) {
    owner.assertOwned();
    await moved(join(options.root, "supervisor", name), join(target, "supervisor", name));
  }
  await save(options, state, "promoting");
}

async function promote(options: ReinstallOptions, state: NativeReinstallState, owner: NativeRootLock) {
  for (const name of state.successorEntries) {
    owner.assertOwned();
    await moved(join(stageRoot(options, state), name), join(options.root, "supervisor", name));
  }
  await save(options, state, "promoted");
}

function assertSuccessor(identity: Identity | null, state: NativeReinstallState): asserts identity is Identity {
  if (!identity || identity.activationId !== state.activationId || identity.instanceId === state.previous.instanceId || identity.workspaceId !== state.previous.workspaceId) {
    throw conflict("The replacement activation does not match this installation's workspace and new identity. Private data was preserved.");
  }
  assertSuccessorStatus(identity, state);
}

function assertSuccessorStatus(identity: Identity, state: NativeReinstallState) {
  if (identity.administrativeStatus === "provisioning") return;
  if (state.phase === "promoted" && identity.administrativeStatus === "active") return;
  throw conflict("The replacement runtime is not eligible to complete installation; its previous private data was preserved.");
}

async function activation(options: ReinstallOptions, state: NativeReinstallState, release: VerifiedNativeRelease) {
  let identity: Identity;
  try { identity = await options.activate(stageRoot(options, state), release); }
  catch (error) {
    await forgetRefusedActivation(options, state, error);
    throw error;
  }
  assertSuccessor(identity, state);
  state.successorEntries = await entries(stageRoot(options, state));
  await save(options, state, "activated");
}

const REFUSED_ACTIVATIONS = new Set(["activation_invalid", "activation_expired", "activation_consumed", "limit_exceeded"]);

async function forgetRefusedActivation(options: ReinstallOptions, state: NativeReinstallState, error: unknown) {
  if (!(error instanceof RemoteInstanceError) || !REFUSED_ACTIVATIONS.has(error.code)) return;
  const store = new SupervisorStore(stageRoot(options, state));
  if (await store.identity() || await store.activationAttempt()) return;
  options.installer.assertOwned();
  await rm(stageRoot(options, state), { recursive: true, force: true });
  await rm(recoveryFile(options.root));
  await syncDirectory(join(options.root, "installer"));
}

async function complete(options: ReinstallOptions, state: NativeReinstallState, owner: NativeRootLock): Promise<NativeRuntimeRecord> {
  const release = verifyNativeRelease(state.manifest as RemoteSignedBundleManifest, options.roots);
  if (state.phase === "prepared") await activation(options, state, release);
  options.progress("preserving");
  if (state.phase === "activated" || state.phase === "archiving") await archive(options, state, owner);
  if (state.phase === "promoting") await promote(options, state, owner);
  const identity = await new SupervisorStore(join(options.root, "supervisor")).identity();
  assertSuccessor(identity, state);
  owner.assertOwned();
  const record = await options.finish(release, identity, state.previous);
  await finalized(options);
  return record;
}

async function finalized(options: ReinstallOptions) {
  options.installer.assertOwned();
  await rm(recoveryFile(options.root));
  await syncDirectory(join(options.root, "installer"));
}

async function completed(options: ReinstallOptions, state: NativeReinstallState): Promise<NativeRuntimeRecord | null> {
  if (state.phase !== "promoted") return null;
  const record = await lstat(join(options.root, "native-runtime.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!record) return null;
  const identity = await new SupervisorStore(join(options.root, "supervisor")).identity();
  assertSuccessor(identity, state);
  const release = verifyNativeRelease(state.manifest as RemoteSignedBundleManifest, options.roots);
  const installed = await options.finish(release, identity, state.previous);
  await finalized(options);
  return installed;
}

function assertResumeTarget(options: ReinstallOptions, state: NativeReinstallState) {
  assertTarget(options, state.previous);
  if (state.activationId !== options.activationId) throw conflict("Resume the same activation first; a different activation cannot overwrite its pending installation.");
}

async function beginRequired(options: ReinstallOptions, previous?: NativeRuntimeRecord) {
  if (!previous) throw conflict("The previous installation is unavailable; private data was preserved.");
  return begin(options, previous);
}

function stoppablePredecessor(options: ReinstallOptions, pending: NativeReinstallState | null, previous: NativeRuntimeRecord | undefined, error: unknown) {
  if (!ownedByAnotherConnector(error) || !options.stopRetired) throw error;
  if (pending && !["prepared", "activated"].includes(pending.phase)) throw error;
  const record = previous ?? pending?.previous;
  if (!record) throw error;
  return record;
}

async function supervisorOwner(options: ReinstallOptions, pending: NativeReinstallState | null, previous?: NativeRuntimeRecord) {
  try { return acquireNativeRootLock(join(options.root, "supervisor")); }
  catch (error) {
    const record = stoppablePredecessor(options, pending, previous, error);
    assertTarget(options, record);
    options.progress("checking");
    await assertRuntimeRetired(join(options.root, "supervisor"), record, options.fetchFn);
    options.installer.assertOwned();
    await options.stopRetired!(record);
    options.installer.assertOwned();
    return acquireNativeRootLock(join(options.root, "supervisor"));
  }
}

async function recheckRetirement(options: ReinstallOptions, state: NativeReinstallState) {
  const archived = join(archiveRoot(options, state), "supervisor");
  const key = await lstat(join(archived, "instance-key.jwk")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  await assertRuntimeRetired(key ? archived : join(options.root, "supervisor"), state.previous, options.fetchFn);
}

/** Keeps the supervisor's lock inode in place while privately moving old state. */
export async function reinstallNative(options: ReinstallOptions, previous?: NativeRuntimeRecord): Promise<NativeRuntimeRecord> {
  const pending = await readNativeReinstall(options.root);
  if (pending) assertResumeTarget(options, pending);
  const installed = pending ? await completed(options, pending) : null;
  if (installed) return installed;
  const owner = await supervisorOwner(options, pending, previous);
  try {
    const state = pending ?? await beginRequired(options, previous);
    if (pending) {
      options.progress("resuming");
      await recheckRetirement(options, state);
    }
    return await complete(options, state, owner);
  } finally { owner.release(); }
}
