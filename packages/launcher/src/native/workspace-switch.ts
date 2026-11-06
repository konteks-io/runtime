import { join } from "node:path";
import { z } from "zod";
import { RemoteInstanceError } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS } from "@konteks/remote-release";
import { acquireNativeRootLock, loadNativeInstallation, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import { SupervisorControl } from "../control.js";
import type { NativeCommandContext } from "./cli.js";
import { nativePlatform } from "./service.js";
import { readOnboardState, writeOnboardState } from "./onboard-state.js";

interface SwitchDeps {
  confirm(question: string): Promise<boolean>;
  prepareStop(input: NativeCommandContext): Promise<() => Promise<void>>;
  load?(root: string): Promise<NativeRuntimeRecord>;
  control?(root: string, record: NativeRuntimeRecord): Pick<SupervisorControl, "call">;
}

const DrainSchema = z.object({ activeAssignments: z.number().int().nonnegative(), openSessions: z.number().int().nonnegative() }).passthrough();
const RetireSchema = z.object({ outcome: z.enum(["removed", "already_removed", "draining"]), activeAssignments: z.number().int().nonnegative() }).strict();

/** Disconnect the old authority; the existing onboarding flow proves the owner again. */
export async function switchNativeWorkspace(input: NativeCommandContext & { yes?: boolean }, deps: SwitchDeps): Promise<void> {
  const load = deps.load ?? installedRecord;
  const before = await load(input.root);
  const question = `Disconnect this computer from workspace ${before.workspaceId}? Its running work must finish and its sessions must close first. Your agent logins and local files stay. Run onboard afterwards to choose a workspace.`;
  if (!input.yes && !(await deps.confirm(question))) {
    input.output.line("This computer stays connected to its current workspace.");
    return;
  }
  const lock = acquireNativeRootLock(join(input.root, "installer"));
  try {
    const record = await load(input.root);
    if (record.instanceId !== before.instanceId || record.workspaceId !== before.workspaceId) throw changed();
    const control = deps.control?.(input.root, record) ?? new SupervisorControl({ supervisorData: join(input.root, "supervisor") }, record.controlPort);
    const stop = await disconnect(control, record, () => lock.assertOwned(), input.root, () => deps.prepareStop(input));
    await stop();
    lock.assertOwned();
    input.output.line(`This computer is disconnected from workspace ${record.workspaceId}. Your agent logins and local files are kept. Run konteks-remote onboard to authenticate and choose a workspace.`);
    input.output.result({ state: "disconnected", instanceId: record.instanceId, workspaceId: record.workspaceId, next: "konteks-remote onboard" });
  } finally { lock.release(); }
}

async function installedRecord(root: string): Promise<NativeRuntimeRecord> {
  return (await loadNativeInstallation(root, { roots: EMBEDDED_RELEASE_ROOTS, platform: nativePlatform() })).record;
}

async function disconnect(control: Pick<SupervisorControl, "call">, record: NativeRuntimeRecord, assertOwned: () => void, root: string, prepareStop: () => Promise<() => Promise<void>>): Promise<() => Promise<void>> {
  await control.call({ op: "status" }, z.object({ instanceId: z.literal(record.instanceId), workspaceId: z.literal(record.workspaceId) }).passthrough());
  await control.call({ op: "drain", reason: "remove" }, z.unknown());
  const drained = await control.call({ op: "drain.status" }, DrainSchema);
  if (drained.activeAssignments !== 0 || drained.openSessions !== 0) throw busy();
  const stop = await prepareStop();
  assertOwned();
  // Retain this intent before retirement. Even if its reply is lost, onboard
  // asks Core whether the old runtime still exists before replacing any state.
  const previous = await readOnboardState(root);
  await writeOnboardState(root, { ...previous, step: "reconnect" });
  assertOwned();
  const retired = await control.call({ op: "instance.retire" }, RetireSchema);
  if (retired.outcome === "draining" || retired.activeAssignments !== 0) throw busy();
  assertOwned();
  return stop;
}

function busy(): RemoteInstanceError {
  return new RemoteInstanceError("active_work", "This computer is drained but still has work or sessions. Finish the work, close its sessions, then run switch-workspace again. Its identity, files and agent logins were kept.");
}

function changed(): RemoteInstanceError {
  return new RemoteInstanceError("registration_mismatch", "The connected runtime changed while the workspace switch was being confirmed; nothing was disconnected.");
}
