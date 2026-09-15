import { startSysmonServer } from "./server.js";

const port = Number(process.env.SYSMON_PORT ?? "41830");
const dataRoot = process.env.SYSMON_DATA_ROOT ?? "/data";

startSysmonServer({ port, dataRoot }).catch((error: unknown) => {
  process.stderr.write(`sysmon failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
