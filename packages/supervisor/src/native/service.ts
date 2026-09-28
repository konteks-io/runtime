import { startControlSocketServer, type ControlSocketServer } from "@konteks/remote-common";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDaemon, type CreateDaemonOptions, type Daemon, type DaemonStep } from "../daemon.js";
import { SupervisorStore, type ShutdownProgress } from "../state/store.js";
import { Supervisor, type SupervisorOptions } from "../supervisor.js";
import { loadNativeInstallation, type NativeInstallationOptions } from "./installation.js";
import { fetchNativeReleaseManifest, resolveNativeConnectorExecutable } from "@konteks/remote-release";
import { launchNativeUpdater } from "./update-launch.js";
import { readNativeUpdateLedger } from "./update-ledger.js";
import { writeSecretFile } from "@konteks/remote-common";

export const NATIVE_SHUTDOWN_RECEIPT_FILE = "shutdown-complete";

export interface NativeServiceOptions extends NativeInstallationOptions {
  root: string;
  /** Test/embedding override; production defaults to the claim-bound native preparer. */
  prepareInputs?: NonNullable<SupervisorOptions["native"]>["prepareInputs"];
  prepareRepositoryWorktree?: NonNullable<SupervisorOptions["native"]>["prepareRepositoryWorktree"];
  runtimeOptions?: NonNullable<SupervisorOptions["native"]>["runtimeOptions"];
  signalSource?: CreateDaemonOptions["signalSource"];
  exitProcess?: CreateDaemonOptions["exitProcess"];
  /** `false` disables self-update; an object overrides the production channel/launcher (tests). */
  update?: false | Partial<NonNullable<NonNullable<SupervisorOptions["native"]>["update"]>>;
}

/** Fence work and stop owned processes before closing the control listener.
 * `server.close()` waits for existing clients, so putting it first can consume
 * the daemon watchdog while bridge and app-server cleanup has not even begun. */
export function nativeShutdownSteps(
  supervisor: () => Pick<Supervisor, "stop"> | undefined,
  control: () => Pick<ControlSocketServer, "close"> | undefined,
  writeReceipt: () => Promise<void> = async () => undefined,
  recordProgress: (phase: ShutdownProgress["phase"], state: ShutdownProgress["state"]) => Promise<void> = async () => undefined,
): DaemonStep[] {
  let supervisorStopped = false;
  let controlClosed = false;
  const note = async (phase: ShutdownProgress["phase"], state: ShutdownProgress["state"]): Promise<void> => {
    // Progress is advisory; failures cannot suppress cleanup or attest completion.
    await recordProgress(phase, state).catch(() => undefined);
  };
  return [
    { name: "stopNativeSupervisor", run: async () => { await supervisor()?.stop(); supervisorStopped = true; } },
    { name: "closeNativeControl", run: async () => {
      // The daemon still closes control after a failed supervisor stop; preserve
      // the earlier blocked/failed supervisor phase for diagnosis in that case.
      if (supervisorStopped) await note("control_close", "entered");
      await control()?.close();
      controlClosed = true;
      if (supervisorStopped) await note("control_close", "completed");
    } },
    { name: "recordNativeShutdown", run: async () => {
      if (!supervisorStopped || !controlClosed) throw new Error("Native shutdown cleanup did not complete; no shutdown receipt was written.");
      await note("receipt", "entered");
      await writeReceipt();
      await note("receipt", "completed");
    } },
  ];
}

/** Native service composition: local agents plus authenticated control, no domain services. */
export function createNativeService(options: NativeServiceOptions): Daemon {
  let supervisor: Supervisor | undefined;
  let control: ControlSocketServer | undefined;
  const exitStore = new SupervisorStore(join(options.root, "supervisor"));
  // The liveness callback reads `daemon` only after createDaemon has returned.
  const daemon: Daemon = createDaemon({
    name: "native-connector",
    ...(options.signalSource ? { signalSource: options.signalSource } : {}),
    ...(options.exitProcess ? { exitProcess: options.exitProcess } : {}),
    recordNonzeroExit: reason => exitStore.recordLastExit(reason),
    onStart: async () => {
      const installation = await loadNativeInstallation(options.root, options);
      // The connector of the release now serving: `konteks-connector`, or `connector` in a release from before the rename.
      const executable = await resolveNativeConnectorExecutable(join(options.root, "releases", installation.record.releaseId), options.platform.os);
      const update = options.update === false ? undefined : {
        fetchManifest: () => fetchNativeReleaseManifest(),
        launch: async () => launchNativeUpdater({ root: options.root, executable, os: options.platform.os }),
        readLedger: () => readNativeUpdateLedger(options.root),
        ...(options.update ?? {}),
      };
      supervisor = new Supervisor(installation.config, {
        onLivenessLost: () => { void daemon.shutdown("liveness-lost", 1).catch(() => undefined); },
        // Uninstalled (W1-L2): nothing is left for this process to do, and its
        // folder is about to be deleted — end it, whatever runs it.
        onRetired: () => { void daemon.shutdown("retired", 0).catch(() => undefined); },
        native: {
          trustedRoots: installation.roots, runners: installation.runners,
          repositoryCacheRoot: join(options.root, "repositories"),
          ...(update ? { update } : {}),
          ...(installation.record.git ? { git: installation.record.git } : {}),
          ...(options.prepareInputs ? { prepareInputs: options.prepareInputs } : {}),
          ...(options.prepareRepositoryWorktree ? { prepareRepositoryWorktree: options.prepareRepositoryWorktree } : {}),
          ...(options.runtimeOptions ? { runtimeOptions: options.runtimeOptions } : {}),
        },
      });
      if (installation.retiredAgents.length > 0) {
        supervisor.logger.warn({ retiredAgents: installation.retiredAgents }, "this installation still lists agents Konteks no longer runs; they are skipped (Claude Code, Codex and DeepSeek Harness are supported)");
      }
      await supervisor.start();
      control = await startControlSocketServer({
        token: await supervisor.store.controlToken(),
        port: installation.config.SUPERVISOR_CONTROL_PORT,
        handler: supervisor.controlHandler(),
        onUnexpectedError: (error, operation) => supervisor?.logger.error({ err: error, operation }, "control operation failed"),
      });
    },
    shutdownSteps: () => nativeShutdownSteps(
      () => supervisor,
      () => control,
      () => writeSecretFile(join(options.root, "supervisor", NATIVE_SHUTDOWN_RECEIPT_FILE), randomUUID()),
      (phase, state) => exitStore.recordShutdownProgress(phase, state),
    ),
  });
  return daemon;
}
