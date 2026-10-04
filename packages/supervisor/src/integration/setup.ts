import { spawn } from "node:child_process";
import {
  integrationError,
  officialConnectionSetup,
  setupArgv,
  setupCommandDigest,
  type IntegrationErrorCode,
  type IntegrationSetupResult,
  type IntegrationSetupTaskSpec,
} from "@konteks/backstage-plugin-common";
import { createLogger, type Logger } from "@konteks/remote-common";

/** Runs one confirmed official setup operation. */
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
 * Input closed, output never read (sanitized output only; a CLI may
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

type SetupEntry = NonNullable<ReturnType<typeof officialConnectionSetup>>;

/** One setup task's checked entry and the commands that carry it out. */
interface SetupRun {
  spec: IntegrationSetupTaskSpec;
  entry: Exclude<SetupEntry, { kind: "handoff" }>;
  base: { schemaVersion: 1; taskId: string; kind: "setup"; setupId: string };
  failed: (code: IntegrationErrorCode, reason?: string) => IntegrationSetupResult;
  codex: (args: readonly string[]) => Promise<{ exitCode: number | null }>;
  present: () => Promise<boolean>;
  before: boolean;
  assertCurrent: () => void;
}

interface OfficialSetupRunnerDeps {
  /** Codex's pinned CLI on this computer, or null when no Codex runner is installed. */
  codex: () => SetupCommandLaunch | null;
  run?: SetupCommandRunner;
  /** Bound for each command (an official add may open the provider's sign-in). */
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * The confirmed official setup: the argv is NEVER taken from the task. The task names a
 * catalogue entry (`officialConnectionSetup`), and must match it exactly:
 * the official endpoint, the server name and the reviewed command digest.
 * Codex: `codex mcp get` first, then the change's reviewed argv
 * (`setupArgv`): an add never overwrites an existing connection of that name
 * and checks the registration exists afterwards; a sign-in (`mcp login`)
 * needs the connection to exist; a remove (`mcp remove`) checks it is gone.
 * Nothing there is `absent`. A handoff entry (Claude account connectors, a
 * Codex provider needing a registered client or a personal token) runs
 * nothing and returns the official page.
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
    const entry = this.reviewedEntry(spec);
    if (!entry) return failed("operation_unsupported", "not_reviewed");
    if (entry.kind === "handoff") return { ...base, outcome: "handoff", handoffUrl: entry.handoffUrl };
    if (entry.serverName !== spec.serverName) return failed("operation_unsupported", "not_reviewed");
    const launch = this.deps.codex();
    if (!launch) return failed("runtime_offline", "agent_runner");
    const timeoutMs = this.deps.timeoutMs ?? 5 * 60_000;
    const codex = (args: readonly string[]) => this.run_(launch.command, [...launch.args, ...args], launch.env, timeoutMs);
    const present = async () => (await codex(["mcp", "get", entry.serverName])).exitCode === 0;
    assertCurrent();
    const before = await present();
    const setup: SetupRun = { spec, entry, base, failed, codex, present, before, assertCurrent };
    const change = { add: () => this.add(setup), sign_in: () => this.signIn(setup), remove: () => this.remove(setup) };
    return change[spec.change]();
  }

  /** The catalogue entry the task names, only when it matches it exactly. */
  private reviewedEntry(spec: IntegrationSetupTaskSpec): SetupEntry | null {
    const entry = officialConnectionSetup(spec.agentId, spec.provider);
    if (!entry || entry.officialEndpoint !== spec.officialEndpoint || setupCommandDigest(entry, spec.change) !== spec.commandDigest) {
      this.logger.warn({ setupId: spec.setupId, agentId: spec.agentId, provider: spec.provider }, "refused a setup task that is not the reviewed catalogue entry");
      return null;
    }
    return entry;
  }

  /** Never overwrite a connection the person already has under that name. */
  private async add({ spec, entry, base, failed, codex, present, before, assertCurrent }: SetupRun): Promise<IntegrationSetupResult> {
    if (before) return { ...base, outcome: "already_present" };
    assertCurrent();
    const added = await codex(setupArgv(entry, "add"));
    const after = await present();
    this.logger.info({ setupId: spec.setupId, agentId: spec.agentId, provider: spec.provider, change: spec.change, exit: added.exitCode, present: after }, "official setup command ran");
    // The registration is what was asked for; a sign-in the add began may
    // still be open on this computer, which the next probe will show.
    return after ? { ...base, outcome: "added" } : failed("capability_unknown", "add_failed");
  }

  /** `codex mcp login` finishes when the provider's sign-in does. */
  private async signIn({ spec, entry, base, failed, codex, before, assertCurrent }: SetupRun): Promise<IntegrationSetupResult> {
    if (!before) return { ...base, outcome: "absent" };
    assertCurrent();
    const login = await codex(setupArgv(entry, "sign_in"));
    this.logger.info({ setupId: spec.setupId, agentId: spec.agentId, provider: spec.provider, change: spec.change, exit: login.exitCode }, "official setup command ran");
    return login.exitCode === 0 ? { ...base, outcome: "signed_in" } : failed("needs_auth", "sign_in_failed");
  }

  /**
   * Core refuses a remove of an entry Konteks did not add unless the person
   * confirmed it; the spec says which (`addedByKonteks`).
   */
  private async remove({ spec, entry, base, failed, codex, present, before, assertCurrent }: SetupRun): Promise<IntegrationSetupResult> {
    if (!before) return { ...base, outcome: "absent" };
    assertCurrent();
    const removed = await codex(setupArgv(entry, "remove"));
    const after = await present();
    this.logger.info({ setupId: spec.setupId, agentId: spec.agentId, provider: spec.provider, change: spec.change, addedByKonteks: spec.addedByKonteks, exit: removed.exitCode, present: after }, "official setup command ran");
    return after ? failed("capability_unknown", "remove_failed") : { ...base, outcome: "removed" };
  }}
