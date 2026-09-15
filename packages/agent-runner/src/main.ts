import { createLogger } from "@konteks/remote-common";
import { startRunnerApi } from "./api/server.js";
import { loadRunnerConfig } from "./config.js";
import { AgentRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const config = loadRunnerConfig();
  const logger = createLogger({ name: `agent-runner-${config.RUNNER_AGENT_ID}` });
  const runtime = new AgentRuntime({ config, logger });
  await startRunnerApi({ port: config.RUNNER_PORT, runtime, logger });
  await runtime.start();
  const shutdown = (): void => {
    runtime
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  logger.info({ agentId: config.RUNNER_AGENT_ID, authMode: config.RUNNER_AUTH_MODE }, "agent runner started");
}

main().catch((error: unknown) => {
  process.stderr.write(`agent runner failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
