import { spawn } from "node:child_process";
import {
  integrationError,
  officialConnectionSetup,
  setupCommandDigest,
  type IntegrationErrorCode,
  type IntegrationSetupResult,
  type IntegrationSetupTaskSpec,
} from "@konteks/backstage-plugin-common";
import { createLogger, type Logger } from "@konteks/remote-common";

/** Runs one confirmed official setup operation (P08, D29). */
export interface IntegrationSetupRunner {
  run(spec: IntegrationSetupTaskSpec, assertCurrent: () => void): Promise<IntegrationSetupResult>;
}

/** The agent's own pinned CLI (the release's Node and package), with the runner's environment. */
export interface SetupCommandLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Runs a command and returns ONLY its exit code; `null` when it could not run or was stopped. */
export type SetupCommandRunner = (command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ exitCode: number | null }>;

/**
 * Input closed, output never read (D29: sanitized output only; a CLI may
 * print URLs or tokens), a hard time bound, no shell.
 */
export const spawnSetupCommand: SetupCommandRunner = (command, args, env, timeoutMs) => new Promise(resolve => {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, { env, stdio: ["ignore", "ignore", "ignore"], shell: false });
  } catch {
    resolve({ exitCode: null });
    return;
  }
  let stopped = false;
  const timer = setTimeout(() => { stopped = true; child.kill("SIGKILL"); }, timeoutMs);
  timer.unref();
  child.once("error", () => { clearTimeout(timer); resolve({ exitCode: null }); });
  child.once("close", code => { clearTimeout(timer); resolve({ exitCode: stopped ? null : code }); });
});

export interface OfficialSetupRunnerDeps {
  /** Codex's pinned CLI on this computer, or null when no Codex runner is installed. */
  codex: () => SetupCommandLaunch | null;
  run?: SetupCommandRunner;
  /** Bound for each command (an official add may open the provider's sign-in). */
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * The confirmed official setup (experience "The connector does the setup
 * work", D29): the argv is NEVER taken from the task. The task names a
 * catalogue entry (`officialConnectionSetup`), and must match it exactly:
 * the official endpoint, the server name and the reviewed command digest.
 * Codex: `codex mcp get` first (an existing connection under that name is
 * never overwritten), then the pinned `codex mcp add`, then `get` again to
 * see whether the registration exists. Claude: account connectors are added
 * in the Claude app, so the result is a handoff to the official page.
 */
export class OfficialSetupRunner implements IntegrationSetupRunner {
  private readonly run_: SetupCommandRunner;
  private readonly logger: Logger;

  constructor(private readonly deps: OfficialSetupRunnerDeps) {
    this.run_ = deps.run ?? spawnSetupCommand;
    this.logger = deps.logger ?? createLogger({ name: "integration-setup" });
  }

  async run(spec: IntegrationSetupTaskSpec, assertCurrent: () => void): Promise<IntegrationSetupResult> {
    const base = { schemaVersion: 1 as const, taskId: spec.taskId, kind: "setup" as const, setupId: spec.setupId };
    const failed = (code: IntegrationErrorCode, reason?: string): IntegrationSetupResult =>
      ({ ...base, outcome: "failed", error: integrationError(code, reason ? { reason } : undefined) });
    const entry = officialConnectionSetup(spec.agentId, spec.provider);
    if (!entry || entry.officialEndpoint !== spec.officialEndpoint || setupCommandDigest(entry) !== spec.commandDigest) {
      this.logger.warn({ setupId: spec.setupId, agentId: spec.agentId, provider: spec.provider }, "refused a setup task that is not the reviewed catalogue entry");
      return failed("operation_unsupported", "not_reviewed");
    }
    if (entry.kind === "handoff") return { ...base, outcome: "handoff", handoffUrl: entry.handoffUrl };
    if (entry.serverName !== spec.serverName) return failed("operation_unsupported", "not_reviewed");
    const launch = this.deps.codex();
    if (!launch) return failed("runtime_offline", "agent_runner");
    const timeoutMs = this.deps.timeoutMs ?? 5 * 60_000;
    const codex = (args: readonly string[]) => this.run_(launch.command, [...launch.args, ...args], launch.env, timeoutMs);
    assertCurrent();
    if ((await codex(["mcp", "get", entry.serverName])).exitCode === 0) return { ...base, outcome: "already_present" };
    assertCurrent();
    const added = await codex(entry.argv);
    const present = (await codex(["mcp", "get", entry.serverName])).exitCode === 0;
    this.logger.info({ setupId: spec.setupId, agentId: spec.agentId, provider: spec.provider, addExit: added.exitCode, present }, "official setup command ran");
    // The registration is what was asked for; a sign-in the add began may
    // still be open on this computer, which the next probe will show.
    return present ? { ...base, outcome: "added" } : failed("capability_unknown", "add_failed");
  }
}
