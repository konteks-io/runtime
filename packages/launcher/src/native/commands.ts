import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EMBEDDED_RELEASE_ROOTS, findAgentBridge, resolveNativeConnectorExecutable, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { createNativeService, loadNativeInstallation, readNativeUpdateLedger, verifyInstalledNativeConnector, NATIVE_SHUTDOWN_RECEIPT_FILE, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import { ReleaseAcceptedSchema, RemoteInstanceError, SupervisorStatusSchema, runCommand, sanitizeInheritedChildProcessEnv, writeSecretFile } from "@konteks/remote-common";
import { agents, authLogin, authLogout, authStatus, doctor, gitKeyAdd, gitKeyList, gitKeyRemove, previewStatus, status, supportBundle } from "./control-commands.js";
import { SupervisorControl } from "../control.js";
import { addNativeAgent, installNative, readNativeRecord, reassignOccupiedNativeControlPort, recordNativeEnrollment, restoreNativeRecord, stageNativeEnrollment } from "./install.js";
import { spawnEnrollmentStaging } from "./enrollment-staging.js";
import { onboardCoreUrl, onboardFailureStep, runOnboard, type OnboardStep } from "./onboard.js";
import { nativePlatform, nativeServiceDefinition, parseServiceExits, startNativeServiceDefinition, type NativeServiceCommand, type NativeServiceDefinition } from "./service.js";
import { checkNativeUpdate } from "./update.js";
import { prepareDeliveryGraft } from "./graft.js";
import { earlierFailure, earlierFailureNote, productionUpdateDeps, runNativeUpdate, selfUpdateNote } from "./update-transaction.js";
import { productionUninstallDeps, uninstallNative } from "./uninstall.js";
import type { NativeCliActions, NativeCommandContext } from "./cli.js";

const environment = () => sanitizeInheritedChildProcessEnv({ env: process.env });
async function execute(command: NativeServiceCommand): Promise<number | null> {
  const result = await runCommand({ ...command, env: environment(), timeoutMs: 30_000 });
  return result.code;
}
async function serviceExits(definition: NativeServiceDefinition) {
  if (!definition.exits) return null;
  const result = await runCommand({ ...definition.exits, env: environment(), timeoutMs: 10_000 });
  return result.code === 0 ? parseServiceExits(nativePlatform().os, result.stdout) : null;
}
async function serviceDefinition(root: string) {
  const platform = nativePlatform();
  const record = await readNativeRecord(root);
  let userId: string | undefined;
  if (platform.os === "windows") {
    const result = await runCommand({ command: "whoami.exe", args: ["/user", "/fo", "csv", "/nh"], env: environment(), timeoutMs: 10_000 });
    userId = result.code === 0 ? result.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0] : undefined;
  }
  // `konteks-connector`, or `connector` in a release from before the rename (a rollback may return to one).
  const executable = await resolveNativeConnectorExecutable(join(root, "releases", record.releaseId), platform.os);
  return nativeServiceDefinition({ os: platform.os, home: homedir(), root, executable, uid: process.getuid?.(), ...(userId ? { userId } : {}) });
}

interface NativeStopDeps {
  definition: (root: string) => Promise<NativeServiceDefinition>;
  execute: typeof execute;
  readReceipt: (root: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  platform: ReturnType<typeof nativePlatform>;
  deadlineMs?: number;
  pollMs?: number;
}

const productionNativeStopDeps: NativeStopDeps = {
  definition: serviceDefinition,
  execute,
  readReceipt: async root => readFile(join(root, "supervisor", NATIVE_SHUTDOWN_RECEIPT_FILE), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
  platform: nativePlatform(),
};

/** launchctl bootout acknowledges deregistration before asynchronous owned
 * process cleanup has necessarily finished. A new private receipt is written
 * only after every daemon shutdown step succeeds. */
export async function stopNativeConnector(input: NativeCommandContext, deps: NativeStopDeps = productionNativeStopDeps): Promise<void> {
  const definition = await deps.definition(input.root);
  const stoppedCodes = deps.platform.os === "macos" ? [113] : deps.platform.os === "debian" ? [3, 4] : [1];
  const initialStatus = await deps.execute(definition.status);
  if (initialStatus !== 0) {
    if (initialStatus !== null && stoppedCodes.includes(initialStatus)) throw new RemoteInstanceError("temporarily_unavailable", "The native service is already stopped; this invocation cannot attest an earlier owned-process cleanup. Inspect only this installation before changing its release.");
    throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation is running; no stop was attempted.");
  }
  const previousReceipt = await deps.readReceipt(input.root);
  if (await deps.execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The native user service could not be stopped; inspect its OS service status.");
  input.output.line("Service manager accepted stop; waiting for this connector's owned-process cleanup…");
  const deadline = deps.now() + (deps.deadlineMs ?? 30_000);
  for (;;) {
    const receipt = await deps.readReceipt(input.root);
    const status = await deps.execute(definition.status);
    if (receipt !== null && receipt !== previousReceipt && status !== null && stoppedCodes.includes(status)) break;
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", "The service manager stopped this connector, but its owned process cleanup is unconfirmed. Inspect only this installation before changing its release.");
    await deps.sleep(deps.pollMs ?? 250);
  }
  input.output.line("Native service stopped; identity, credentials and local work are preserved.");
}
/** The real start path with narrow hooks for collision and stopped-service tests. */
export async function startNativeConnector(
  input: NativeCommandContext,
  deps: {
    roots?: readonly EmbeddedReleaseRoot[];
    platform?: ReturnType<typeof nativePlatform>;
    definition?: (root: string) => Promise<NativeServiceDefinition>;
    execute?: typeof execute;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? nativePlatform();
  const roots = deps.roots ?? EMBEDDED_RELEASE_ROOTS;
  const executeService = deps.execute ?? execute;
  const installation = await loadNativeInstallation(input.root, { roots, platform });
  await verifyInstalledNativeConnector(
    installation.release,
    join(input.root, "releases", installation.record.releaseId),
    platform,
  );
  const definition = await (deps.definition ?? serviceDefinition)(input.root);
  // The OS service managers use distinct exit codes for a known stopped
  // service. Other failures cannot prove this root is safe to rewrite.
  // systemctl uses 3 for inactive and 4 for a unit not installed yet.
  const stoppedCodes = platform.os === "macos" ? [113] : platform.os === "debian" ? [3, 4] : [1];
  const serviceState = async (): Promise<"running" | "stopped"> => {
    let code: number | null;
    try { code = await executeService(definition.status); }
    catch { code = null; }
    if (code === 0) return "running";
    if (code !== null && stoppedCodes.includes(code)) return "stopped";
    throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation is stopped. Inspect and stop only this installation's service before retrying start; identity and local work are unchanged.");
  };
  if ((await serviceState()) === "running") {
    try {
      await new SupervisorControl(
        { supervisorData: join(input.root, "supervisor") },
        installation.record.controlPort,
      ).call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 2_000 });
    } catch {
      throw new RemoteInstanceError(
        "temporarily_unavailable",
        `This installation's service is registered or starting, but its control socket on port ${installation.record.controlPort} is unavailable. Stop only this installation's service, then run start again to repair an occupied port; identity and local work are preserved.`,
      );
    }
    input.output.line(
      "Native user service is already running; use status to inspect cloud readiness.",
    );
    return;
  }
  const moved = await reassignOccupiedNativeControlPort({
    root: input.root,
    roots,
    platform,
    serviceStopped: async () => (await serviceState()) === "stopped",
  });
  if (moved)
    input.output.line(
      `Control port ${moved.previousPort} is occupied by another local process; this stopped connector now uses port ${moved.controlPort}. Its identity and local work are unchanged.`,
    );
  const started = await startNativeServiceDefinition(definition, {
    execute: command => command === definition.status ? serviceState().then(state => state === "running" ? 0 : stoppedCodes[0]!) : executeService(command),
    write: writeSecretFile,
  }).catch((error) => {
    throw new RemoteInstanceError(
      "temporarily_unavailable",
      "The native user service could not start; installed identity and credentials were preserved.",
      { cause: error },
    );
  });
  if (started === "already_running") {
    input.output.line(
      "Native user service is already running; use status to inspect cloud readiness.",
    );
    return;
  }
  if (definition.requiresLinger)
    input.output.line(
      "This Linux user service needs user lingering to remain available after logout. Configure it explicitly if required.",
    );
  // Starting the process is not the same as being open for work: the service
  // finishes unpacking and opens its control port about a minute later. Saying
  // only "started" invited a second and third `start` against a service that
  // was already coming up.
  input.output.line(
    "Native user service started. It takes about a minute after a fresh install before it is ready for work; agent login and cloud readiness are reported separately by status.",
  );
}

/** One onboarding step, with a failure said as a step too, never a crash. */
async function onboardStep(input: { root: string; output: NativeCommandContext["output"]; answer?: string; cwd?: string }): Promise<OnboardStep> {
  const coreUrl = await onboardCoreUrl(input.root);
  const context = {
    root: input.root,
    output: input.output,
    ...(input.answer !== undefined ? { answer: input.answer } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(coreUrl ? { coreUrl } : {}),
  };
  try {
    return await runOnboard(context);
  } catch (error) {
    // Never leave the protocol the agent was taught: a failure is a step too.
    return await onboardFailureStep(context, error);
  }
}

interface NativeAgentAddDeps {
  readRecord: (root: string) => Promise<NativeRuntimeRecord>;
  serviceDefinition: (root: string) => Promise<NativeServiceDefinition>;
  execute: (command: NativeServiceCommand) => Promise<number | null>;
  control: (root: string, record: NativeRuntimeRecord) => Pick<SupervisorControl, "call">;
  add: typeof addNativeAgent;
  restore: typeof restoreNativeRecord;
  start: (input: NativeCommandContext) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  platform: ReturnType<typeof nativePlatform>;
  stopDeadlineMs?: number;
  pollMs?: number;
}

const productionAgentAddDeps: NativeAgentAddDeps = {
  readRecord: readNativeRecord,
  serviceDefinition,
  execute,
  control: (root, record) => new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort),
  add: addNativeAgent,
  restore: restoreNativeRecord,
  start: startNativeConnector,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
  platform: nativePlatform(),
};

/** Drain, stop and wait for ownership before changing an installed agent list. */
export async function runNativeAgentAdd(input: NativeCommandContext & { agent: string }, deps: NativeAgentAddDeps = productionAgentAddDeps): Promise<void> {
  const previous = await deps.readRecord(input.root);
  if (previous.agents.includes(input.agent as NativeRuntimeRecord["agents"][number])) {
    input.output.line(`${findAgentBridge(input.agent)?.displayName ?? input.agent} is already installed; no restart is needed.`);
    return;
  }
  const definition = await deps.serviceDefinition(input.root);
  const stoppedCodes = deps.platform.os === "macos" ? [113] : deps.platform.os === "debian" ? [3, 4] : [1];
  const initialStatus = await deps.execute(definition.status);
  if (initialStatus !== 0 && (initialStatus === null || !stoppedCodes.includes(initialStatus))) throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation's service state. Inspect only this installation's service before adding an agent; identity and local work are unchanged.");
  const wasRunning = initialStatus === 0;
  let stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
  const wait = async () => deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
  const stopped = async () => {
    const code = await deps.execute(definition.status);
    if (code === 0) return false;
    if (code !== null && stoppedCodes.includes(code)) return true;
    throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation stopped; its identity and local work are unchanged.");
  };
  if (wasRunning) {
    const control = deps.control(input.root, previous);
    const drain = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
    await control.call({ op: "drain", reason: "update" }, z.unknown());
    const drainDeadline = deps.now() + 15 * 60_000;
    for (;;) {
      const state = await control.call({ op: "drain.status" }, drain);
      if (state.activeAssignments === 0) break;
      if (deps.now() >= drainDeadline) throw new RemoteInstanceError("active_work", "Agent installation waited 15 minutes for active work; the runtime remains running and drained so it can be inspected safely.");
      input.output.line(`waiting for ${state.activeAssignments} active assignment(s) before installing ${input.agent}…`);
      await deps.sleep(deps.pollMs ?? 5_000);
    }
    if (await deps.execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime drained but could not stop; its installation was not changed.");
    stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
    while (!await stopped()) {
      if (deps.now() >= stopDeadline) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime did not finish stopping; its installed agents were not changed.");
      await wait();
    }
  }
  let successor: NativeRuntimeRecord | undefined;
  let ownershipUnsettled = false;
  let saidWaiting = false;
  try {
    for (;;) {
      try {
        successor = await deps.add({ root: input.root, agentId: input.agent as NativeRuntimeRecord["agents"][number], output: input.output });
        ownershipUnsettled = false;
        break;
      } catch (error) {
        const owned = error instanceof RemoteInstanceError && error.code === "temporarily_unavailable" && /owns this native data directory/.test(error.message);
        if (!owned) throw error;
        ownershipUnsettled = true;
        if (deps.now() >= stopDeadline) throw error;
        if (!saidWaiting) { input.output.line("Waiting for the stopped connector to release its private data before adding the agent…"); saidWaiting = true; }
        await wait();
        if (wasRunning && !await stopped()) throw new RemoteInstanceError("temporarily_unavailable", "This connector started again before agent installation; stop only this installation's service and retry.");
      }
    }
    if (wasRunning) await deps.start(input);
    input.output.result({ instanceId: successor.instanceId, agents: successor.agents, state: "installed" });
  } catch (error) {
    if (successor) {
      try {
        if (wasRunning) {
          const code = await deps.execute(definition.status);
          if (code === 0 && await deps.execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The new service could not be stopped before agent rollback.");
          if (code !== 0 && (code === null || !stoppedCodes.includes(code))) throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm the new service stopped before agent rollback.");
          stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
          while (!await stopped()) {
            if (deps.now() >= stopDeadline) throw new RemoteInstanceError("temporarily_unavailable", "The new service did not finish stopping before agent rollback.");
            await wait();
          }
        }
        for (;;) {
          try { await deps.restore(input.root, successor.releaseId, previous); break; }
          catch (restoreError) {
            const owned = restoreError instanceof RemoteInstanceError && restoreError.code === "temporarily_unavailable" && /owns this native data directory/.test(restoreError.message);
            if (!owned || deps.now() >= stopDeadline) throw restoreError;
            await wait();
          }
        }
      } catch (rollbackError) {
        throw new RemoteInstanceError("temporarily_unavailable", "Agent installation failed and automatic rollback could not restore the previous record; identity and local work were preserved.", { cause: rollbackError });
      }
    }
    if (wasRunning && !ownershipUnsettled) await deps.start(input).catch(() => undefined);
    throw error;
  }
}

export const nativeCliActions: NativeCliActions = {
  install: async input => {
    if (input.enroll) {
      // The enrollment install stops short of an identity, because there is no
      // Workspace to have one in yet (onboarding-simplified OS3). It verifies
      // and records the release, and unpacks the agent packages in the
      // background so the person's first question does not wait on them
      // (WS1-012); `onboard` waits for the unpacking where it is needed.
      const prepared = await recordNativeEnrollment(input);
      let unpacking = "done";
      if (!prepared.staged) {
        const pid = await spawnEnrollmentStaging(input.root).catch(() => undefined);
        if (pid === undefined) {
          await stageNativeEnrollment({ root: input.root });
        } else {
          unpacking = "background";
        }
      }
      // The install starts onboarding itself (W1-C2, WS1-078): the agent that
      // ran the one install command reads the first question here, instead of
      // being told to run a second command to get it.
      const first = await onboardStep({ root: input.root, output: input.output });
      input.output.line(
        `${unpacking === "background" ? "This machine is ready. Its agent packages keep unpacking in the background." : "This machine is ready."} ` +
          "Onboarding has started. Its first step is the JSON object below; for each step after it, run `konteks-remote onboard --json` (with `--answer \"<the person's answer>\"` when the step asked something).",
      );
      input.output.line(JSON.stringify(first, null, 2));
      input.output.result({ state: "ready-to-onboard", agents: prepared.agents, bundleVersion: prepared.bundleVersion, unpacking, firstStep: first });
      return;
    }
    const record = await installNative({ ...input, activationId: input.activationId! });
    await startNativeConnector(input);
    input.output.result({ instanceId: record.instanceId, deploymentKind: record.deploymentKind, state: "installed" });
  },
  stageEnrollment: async input => {
    const staged = await stageNativeEnrollment({ root: input.root });
    input.output.result({ state: "staged", releaseId: staged.releaseId, agents: staged.agents });
  },
  onboard: async input => {
    const step = await onboardStep(input);
    // One step per invocation, printed whole. In human mode the same step
    // reads as a sentence so a person running this by hand is not left
    // reading JSON.
    input.output.result(step);
    if (step.ask) input.output.line(`${step.note ? `${step.note}\n` : ""}${step.ask.question}`);
    else if (step.done) input.output.line(`${step.done.summary}\n${step.done.links.site}`);
    else if (step.note) input.output.line(step.note);
  },
  addAgent: runNativeAgentAdd,
  serve: async input => {
    const service = createNativeService({ root: input.root, roots: EMBEDDED_RELEASE_ROOTS, platform: nativePlatform(),
      prepareRepositoryWorktree: (cwd, agentId) => prepareDeliveryGraft(input.root, cwd, agentId),
      exitProcess: code => process.exit(code) });
    await service.start();
    await service.waitUntilStopped();
  },
  start: startNativeConnector,
  update: async input => {
    // A release published before Konteks accepts it would install, be refused
    // by Konteks and roll back minutes later (WS1-093). The running service
    // asks Konteks with this machine's lease; only a definite other answer
    // stops the update, so a machine that cannot ask still updates as asked.
    const notAccepted = async (check: Awaited<ReturnType<typeof checkNativeUpdate>> | null): Promise<string | null> => {
      if (!check || check.status === "current") return null;
      const record = await readNativeRecord(input.root).catch(() => null);
      if (!record) return null;
      const control = new SupervisorControl({ supervisorData: join(input.root, "supervisor") }, record.controlPort);
      const accepted = await control.call({ op: "release.accepted" }, ReleaseAcceptedSchema, { timeoutMs: 10_000 }).catch(() => null);
      const version = check.release.manifest.bundleVersion;
      return accepted?.bundleVersion && accepted.bundleVersion !== version ? accepted.bundleVersion : null;
    };
    if (input.check) {
      const check = await checkNativeUpdate({ root: input.root });
      const acceptedOther = await notAccepted(check);
      if (acceptedOther && check.status !== "current") {
        input.output.line(`Release ${check.release.manifest.bundleVersion} is published, but Konteks accepts ${acceptedOther} for this machine, so it stays on ${check.current.bundleVersion} until Konteks accepts the new one.`);
        input.output.result({ state: "not_accepted", installed: check.current.bundleVersion, available: check.release.manifest.bundleVersion, accepted: acceptedOther });
        return;
      }
      const attempts = (await readNativeUpdateLedger(input.root).catch(() => ({ attempts: [] }))).attempts;
      if (check.status === "current") input.output.line([`Installed release ${check.bundleVersion} is current.`, selfUpdateNote(attempts, check.bundleVersion)].filter(Boolean).join(" "));
      const failed = check.status === "current" ? null : earlierFailure(attempts, check.release.manifest.digest);
      if (check.status !== "current") input.output.line(failed
        ? `Release ${check.release.manifest.bundleVersion} is available (installed: ${check.current.bundleVersion}), but ${earlierFailureNote(failed)}`
        : `Release ${check.release.manifest.bundleVersion} is available (installed: ${check.current.bundleVersion}); run \`konteks-remote update\` to install it.`);
      input.output.result(check.status === "current" ? { state: "current", bundleVersion: check.bundleVersion } : { state: "available", installed: check.current.bundleVersion, available: check.release.manifest.bundleVersion, manifestDigest: check.release.manifest.digest, ...(failed ? { failedHere: { outcome: failed.outcome, at: failed.finishedAt ?? failed.startedAt, detail: failed.detail } } : {}) });
      return;
    }
    if (!input.unattended) {
      const check = await checkNativeUpdate({ root: input.root }).catch(() => null);
      const acceptedOther = await notAccepted(check);
      if (acceptedOther && check && check.status !== "current") {
        input.output.line(`Release ${check.release.manifest.bundleVersion} is published, but Konteks accepts ${acceptedOther} for this machine, so nothing was changed; ${check.current.bundleVersion} keeps running until Konteks accepts the new one.`);
        input.output.result({ state: "not_accepted", installed: check.current.bundleVersion, available: check.release.manifest.bundleVersion, accepted: acceptedOther });
        return;
      }
      const attempts = (await readNativeUpdateLedger(input.root).catch(() => ({ attempts: [] }))).attempts;
      const failed = check && check.status !== "current" ? earlierFailure(attempts, check.release.manifest.digest) : null;
      if (failed) input.output.line(`Trying again as asked: ${earlierFailureNote(failed)}`);
      const selfUpdated = check?.status === "current" ? selfUpdateNote(attempts, check.bundleVersion) : null;
      if (selfUpdated) input.output.line(selfUpdated);
    }
    await runNativeUpdate({ root: input.root, output: input.output, unattended: input.unattended }, productionUpdateDeps({ serviceDefinition, execute, start: startNativeConnector, serviceExits }));
  },
  uninstall: async input => {
    const result = await uninstallNative(input, productionUninstallDeps({ root: input.root, serviceDefinition, execute }));
    input.output.result(result);
  },
  stop: stopNativeConnector,
  control: async input => {
    const record = await readNativeRecord(input.root);
    const context = { output: input.output, control: new SupervisorControl({ supervisorData: join(input.root, "supervisor") }, record.controlPort) };
    switch (input.operation) {
      case "status": return status(context);
      case "agents": return agents(context);
      case "doctor": if (!await doctor(context)) process.exitCode = 2; return;
      case "support": return supportBundle(context);
      case "preview.status": return previewStatus(context);
      case "auth.status": return authStatus(context, input.agent);
      case "auth.login": return authLogin(context, input.agent!, input.organization ?? false, {
        ...(input.provider ? { provider: input.provider } : {}), ...(input.method ? { method: input.method } : {}), ...(input.reuse ? { reuse: true } : {}),
        ...(input.project ? { project: input.project, location: input.location ?? "global" } : {}) });
      case "auth.logout": return authLogout(context, input.agent!, input.provider, input.method);
      case "git.key.add": return gitKeyAdd(context, input.title);
      case "git.key.list": return gitKeyList(context);
      case "git.key.remove": return gitKeyRemove(context, input.keyRef!);
    }
  },
};
