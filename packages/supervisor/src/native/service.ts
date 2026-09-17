import { startControlSocketServer, type ControlSocketServer } from "@konteks/remote-common";
import { join } from "node:path";
import { createDaemon, type CreateDaemonOptions, type Daemon } from "../daemon.js";
import { Supervisor, type SupervisorOptions } from "../supervisor.js";
import { loadNativeInstallation, type NativeInstallationOptions } from "./installation.js";
import { fetchNativeReleaseManifest } from "@konteks/remote-release";
import { launchNativeUpdater } from "./update-launch.js";
import { readNativeUpdateLedger } from "./update-ledger.js";

export interface NativeServiceOptions extends NativeInstallationOptions {
  root: string;
  /** Test/embedding override; production defaults to the claim-bound native preparer. */
  prepareInputs?: NonNullable<SupervisorOptions["native"]>["prepareInputs"];
  runtimeOptions?: NonNullable<SupervisorOptions["native"]>["runtimeOptions"];
  signalSource?: CreateDaemonOptions["signalSource"];
  exitProcess?: CreateDaemonOptions["exitProcess"];
  /** `false` disables self-update; an object overrides the production channel/launcher (tests). */
  update?: false | Partial<NonNullable<NonNullable<SupervisorOptions["native"]>["update"]>>;
}

/** Native service composition: local agents plus authenticated control, no domain services. */
export function createNativeService(options: NativeServiceOptions): Daemon {
  let supervisor: Supervisor | undefined;
  let control: ControlSocketServer | undefined;
  // The liveness callback reads `daemon` only after createDaemon has returned.
  const daemon: Daemon = createDaemon({
    name: "native-connector",
    ...(options.signalSource ? { signalSource: options.signalSource } : {}),
    ...(options.exitProcess ? { exitProcess: options.exitProcess } : {}),
    onStart: async () => {
      const installation = await loadNativeInstallation(options.root, options);
      const executable = join(options.root, "releases", installation.record.releaseId, options.platform.os === "windows" ? "connector.exe" : "connector");
      const update = options.update === false ? undefined : {
        fetchManifest: () => fetchNativeReleaseManifest(),
        launch: async () => launchNativeUpdater({ root: options.root, executable, os: options.platform.os }),
        readLedger: () => readNativeUpdateLedger(options.root),
        ...(options.update ?? {}),
      };
      supervisor = new Supervisor(installation.config, {
        onLivenessLost: () => { void daemon.shutdown("liveness-lost", 1).catch(() => undefined); },
        native: {
          trustedRoots: installation.roots, runners: installation.runners,
          repositoryCacheRoot: join(options.root, "repositories"),
          ...(update ? { update } : {}),
          ...(installation.record.git ? { git: installation.record.git } : {}),
          ...(options.prepareInputs ? { prepareInputs: options.prepareInputs } : {}),
          ...(options.runtimeOptions ? { runtimeOptions: options.runtimeOptions } : {}),
        },
      });
      await supervisor.start();
      control = await startControlSocketServer({
        token: await supervisor.store.controlToken(),
        port: installation.config.SUPERVISOR_CONTROL_PORT,
        handler: supervisor.controlHandler(),
      });
    },
    shutdownSteps: () => [
      { name: "closeNativeControl", run: async () => { await control?.close(); } },
      { name: "stopNativeSupervisor", run: async () => { await supervisor?.stop(); } },
    ],
  });
  return daemon;
}
