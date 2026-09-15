import { startControlSocketServer } from "@konteks/remote-common";
import { createDaemon } from "./daemon.js";
import { Supervisor } from "./supervisor.js";

const supervisor = new Supervisor();
let controlSocket: { close(): Promise<void> } | null = null;

const daemon = createDaemon({
  name: "supervisor",
  exitProcess: (code) => process.exit(code),
  onStart: async () => {
    await supervisor.start();
    controlSocket = await startControlSocketServer({
      token: await supervisor.store.controlToken(),
      port: supervisor.config.SUPERVISOR_CONTROL_PORT,
      handler: supervisor.controlHandler(),
    });
  },
  shutdownSteps: () => [
    { name: "closeControlSocket", run: async () => controlSocket?.close() },
    { name: "stopSupervisor", run: () => supervisor.stop() },
  ],
});

daemon.start().catch((error: unknown) => {
  process.stderr.write(`supervisor failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
