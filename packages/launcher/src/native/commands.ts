import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EMBEDDED_RELEASE_ROOTS, resolveNativeConnectorExecutable } from "@konteks/remote-release";
import { createNativeService, loadNativeInstallation, readNativeUpdateLedger, verifyInstalledNativeConnector } from "@konteks/remote-supervisor";
import { ReleaseAcceptedSchema, RemoteInstanceError, runCommand, sanitizeInheritedChildProcessEnv, writeSecretFile } from "@konteks/remote-common";
import { agents, authLogin, authLogout, authStatus, doctor, gitKeyAdd, gitKeyList, gitKeyRemove, status, supportBundle } from "../commands/lifecycle.js";
import { SupervisorControl } from "../control.js";
import { addNativeAgent, installNative, readNativeRecord, recordNativeEnrollment, restoreNativeRecord, stageNativeEnrollment } from "./install.js";
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
async function start(input: NativeCommandContext): Promise<void> {
  const platform = nativePlatform();
  const installation = await loadNativeInstallation(input.root, { roots: EMBEDDED_RELEASE_ROOTS, platform });
  await verifyInstalledNativeConnector(installation.release, join(input.root, "releases", installation.record.releaseId), platform);
  const definition = await serviceDefinition(input.root);
  const started = await startNativeServiceDefinition(definition, { execute, write: writeSecretFile }).catch(error => {
    throw new RemoteInstanceError("temporarily_unavailable", "The native user service could not start; installed identity and credentials were preserved.", { cause: error });
  });
  if (started === "already_running") { input.output.line("Native user service is already running; use status to inspect cloud readiness."); return; }
  if (definition.requiresLinger) input.output.line("This Linux user service needs user lingering to remain available after logout. Configure it explicitly if required.");
  // Starting the process is not the same as being open for work: the service
  // finishes unpacking and opens its control port about a minute later. Saying
  // only "started" invited a second and third `start` against a service that
  // was already coming up.
  input.output.line("Native user service started. It takes about a minute after a fresh install before it is ready for work; agent login and cloud readiness are reported separately by status.");
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
    await start(input);
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
  addAgent: async input => {
    const previous = await readNativeRecord(input.root);
    if (previous.agents.includes(input.agent)) {
      input.output.line(`${input.agent} is already installed; no restart is needed.`);
      return;
    }
    const definition = await serviceDefinition(input.root);
    const wasRunning = await execute(definition.status) === 0;
    if (wasRunning) {
      const control = new SupervisorControl({ supervisorData: join(input.root, "supervisor") }, previous.controlPort);
      const drain = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
      await control.call({ op: "drain", reason: "update" }, z.unknown());
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        const state = await control.call({ op: "drain.status" }, drain);
        // Idle ACP sessions are durable and resume after restart; only an
        // executing assignment must reach its terminal report first.
        if (state.activeAssignments === 0) break;
        if (Date.now() >= deadline) throw new RemoteInstanceError("active_work", "Agent installation waited 15 minutes for active work; the runtime remains running and drained so it can be inspected safely.");
        input.output.line(`waiting for ${state.activeAssignments} active assignment(s) before installing ${input.agent}…`);
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
      if (await execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime drained but could not stop; its installation was not changed.");
    }
    let successor: Awaited<ReturnType<typeof addNativeAgent>> | undefined;
    try {
      successor = await addNativeAgent({ root: input.root, agentId: input.agent, output: input.output });
      if (wasRunning) await start(input);
      input.output.result({ instanceId: successor.instanceId, agents: successor.agents, state: "installed" });
    } catch (error) {
      if (successor) {
        try { await restoreNativeRecord(input.root, successor.releaseId, previous); }
        catch (rollbackError) { throw new RemoteInstanceError("temporarily_unavailable", "The new agent did not start and automatic rollback failed; credentials and workspaces remain preserved.", { cause: rollbackError }); }
      }
      if (wasRunning) await start(input).catch(() => undefined);
      throw error;
    }
  },
  serve: async input => {
    const service = createNativeService({ root: input.root, roots: EMBEDDED_RELEASE_ROOTS, platform: nativePlatform(),
      prepareRepositoryWorktree: (cwd, agentId) => prepareDeliveryGraft(input.root, cwd, agentId),
      exitProcess: code => process.exit(code) });
    await service.start();
    await service.waitUntilStopped();
  },
  start,
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
    await runNativeUpdate({ root: input.root, output: input.output, unattended: input.unattended }, productionUpdateDeps({ serviceDefinition, execute, start, serviceExits }));
  },
  uninstall: async input => {
    const result = await uninstallNative(input, productionUninstallDeps({ root: input.root, serviceDefinition, execute }));
    input.output.result(result);
  },
  stop: async input => {
    const definition = await serviceDefinition(input.root);
    if (await execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The native user service could not be stopped; inspect its OS service status.");
    input.output.line("Native service stopped; identity, credentials and local work are preserved.");
  },
  control: async input => {
    const record = await readNativeRecord(input.root);
    const context = { output: input.output, control: new SupervisorControl({ supervisorData: join(input.root, "supervisor") }, record.controlPort) };
    switch (input.operation) {
      case "status": return status(context);
      case "agents": return agents(context);
      case "doctor": if (!await doctor(context)) process.exitCode = 2; return;
      case "support": return supportBundle(context);
      case "auth.status": return authStatus(context, input.agent);
      case "auth.login": return authLogin(context, input.agent!, input.organization ?? false);
      case "auth.logout": return authLogout(context, input.agent!);
      case "git.key.add": return gitKeyAdd(context, input.title);
      case "git.key.list": return gitKeyList(context);
      case "git.key.remove": return gitKeyRemove(context, input.keyRef!);
    }
  },
};
