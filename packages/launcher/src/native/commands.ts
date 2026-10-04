import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EMBEDDED_RELEASE_ROOTS, findAgentBridge, resolveNativeConnectorExecutable, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { createNativeService, hostAgentInstallAdapter, loadNativeInstallation, readNativeUpdateLedger, verifyInstalledNativeConnector, NATIVE_SHUTDOWN_RECEIPT_FILE, type HostAgentInstallAdapter, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import { ReleaseAcceptedSchema, RemoteInstanceError, SupervisorStatusSchema, runCommand, sanitizeInheritedChildProcessEnv, writeSecretFile } from "@konteks/remote-common";
import { agents, authLogin, authLogout, authStatus, doctor, gitKeyAdd, gitKeyList, gitKeyRemove, previewStatus, status, supportBundle } from "./control-commands.js";
import { SupervisorControl } from "../control.js";
import { addNativeAgent, fetchHostAgent, installNative, readNativeRecord, reassignOccupiedNativeControlPort, recordNativeEnrollment, removeNativeAgent, restoreNativeRecord, stageNativeEnrollment } from "./install.js";
import { terminalFetchConsent, type FetchConsent } from "./consent.js";
import { closeAgentSetup, ensurePersonalAgent, isPersonalAgent, PERSONAL_AGENTS, productionAgentClosingDeps, setUpPersonalAgent } from "./agent-setup.js";
import { confirm } from "../prompt.js";
import { spawnEnrollmentStaging } from "./enrollment-staging.js";
import { onboardCoreUrl, onboardFailureStep, runOnboard, type OnboardStep } from "./onboard.js";
import { describeServiceFailure, encodeServiceDefinition, nativePlatform, nativeServiceDefinition, NativeServiceCommandError, parseLoadedService, parseServiceExits, serviceRun, startNativeServiceDefinition, type NativeServiceCommand, type NativeServiceDefinition, type NativeServiceExecute, type NativeServiceRun } from "./service.js";
import { clearServiceStartFailure, connectorLogFile, connectorLogTail, localServiceReport, readServiceStartFailure, recordServiceStartFailure } from "./service-report.js";
import { verbose, verboseCommand } from "../verbose.js";
import { checkNativeUpdate } from "./update.js";
import { prepareDeliveryGraft } from "./graft.js";
import { earlierFailure, earlierFailureNote, keepLauncherCurrent, productionUpdateDeps, refreshInstalledLauncher, runNativeUpdate, selfUpdateNote } from "./update-transaction.js";
import { productionUninstallDeps, uninstallNative } from "./uninstall.js";
import type { NativeCliActions, NativeCommandContext } from "./cli.js";
import { captureWindowsServiceOwner, type NativeServiceProcessOwner } from "./windows-service-owner.js";

const environment = () => sanitizeInheritedChildProcessEnv({ env: process.env });
/** Runs one service or OS command and keeps how it ended; `--verbose` prints it (D129). */
async function runServiceCommand(command: NativeServiceCommand, timeoutMs = 30_000): Promise<NativeServiceRun> {
  const started = Date.now();
  try {
    const result = await runCommand({ ...command, env: environment(), timeoutMs });
    const run: NativeServiceRun = { code: result.code, stdout: result.stdout, stderr: result.stderr, ...(result.code === null && Date.now() - started >= timeoutMs ? { timedOut: true } : {}) };
    verboseCommand(command, run, Date.now() - started);
    return run;
  } catch (error) {
    verboseCommand(command, { code: null, error: error instanceof Error ? error.message : String(error) }, Date.now() - started);
    throw error;
  }
}
/** As `runServiceCommand`, with a command that cannot be run kept as its outcome instead of thrown. */
const executeDetailed: NativeServiceExecute = command => runServiceCommand(command)
  .catch((error: unknown): NativeServiceRun => ({ code: null, error: error instanceof Error ? error.message : String(error) }));
async function execute(command: NativeServiceCommand): Promise<number | null> {
  return (await runServiceCommand(command)).code;
}
async function serviceExits(definition: NativeServiceDefinition) {
  if (!definition.exits) return null;
  const result = await runServiceCommand(definition.exits, 10_000);
  return result.code === 0 ? parseServiceExits(nativePlatform().os, result.stdout ?? "") : null;
}
async function serviceDefinition(root: string) {
  const platform = nativePlatform();
  const record = await readNativeRecord(root);
  let userId: string | undefined;
  if (platform.os === "windows") {
    const result = await runServiceCommand({ command: "whoami.exe", args: ["/user", "/fo", "csv", "/nh"] }, 10_000);
    userId = result.code === 0 ? result.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0] : undefined;
  }
  // `konteks-connector`, or `connector` in a release from before the rename (a rollback may return to one).
  const executable = await resolveNativeConnectorExecutable(join(root, "releases", record.releaseId), platform.os);
  return nativeServiceDefinition({ os: platform.os, home: homedir(), root, executable, uid: process.getuid?.(), ...(userId ? { userId } : {}) });
}

/** A reload for the same definition within this window means it did not take; say so instead of restarting again. */
export const SERVICE_RELOAD_WINDOW_MS = 10 * 60_000;
/** How long a `serve` whose service is being reloaded waits to be stopped before it starts anyway. */
export const SERVICE_RELOAD_GRACE_MS = 60_000;
export const SERVICE_RELOAD_FILE = "service-reload.json";

export type OwnServiceDefinitionOutcome = "not_installed" | "current" | "next_start" | "restarting";

export interface OwnServiceDefinitionDeps {
  definition: (root: string) => Promise<NativeServiceDefinition>;
  /** A file's bytes; text is read as UTF-8. */
  read: (path: string) => Promise<Uint8Array | string>;
  write: (path: string, contents: string | Uint8Array) => Promise<void>;
  os: ReturnType<typeof nativePlatform>["os"];
  /** This process. */
  pid: number;
  /** A service command's stdout, or null when it failed. */
  inspect: (command: NativeServiceCommand) => Promise<string | null>;
  execute: NativeServiceExecute;
  /** Starts the command in a session of its own, its output appended to the log file; resolves once it runs. */
  detach: (command: NativeServiceCommand, logFile: string) => Promise<void>;
  lastReload: () => Promise<{ digest: string; at: number } | null>;
  recordReload: (reload: { digest: string; at: number }) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

/**
 * Keeps the running service on the definition this release renders, through
 * the service manager. Whoever registered the service (the install launcher,
 * which an update never replaces, or the previous release's updater) wrote
 * the definition with its own renderer, so service-level changes such as the
 * log file arrived one release late or never (RCA 2026-09-30). Rewriting the
 * file alone left it for "the next start", which never came: launchd's
 * KeepAlive respawns reuse the plist it loaded, so a connector updated by the
 * install launcher (which loads a plist without the log file) ran with its
 * output on /dev/null until someone stopped and started it (RCA 2026-10-01).
 * When this process is the
 * one the service manager runs and the loaded definition is not this one (it
 * was just rewritten, or launchd shows no log file), the service manager
 * reloads it and restarts the service onto it, so it keeps owning the single
 * supervisor. A foreground `serve`, or one the service manager does not name,
 * is never restarted. A second reload for the same definition within
 * `SERVICE_RELOAD_WINDOW_MS` is refused, so a reload that does not take can
 * never become a restart loop.
 *
 * Files are compared as bytes in the encoding the service manager reads
 * (`encodeServiceDefinition`), so a Windows task file in any other encoding is
 * rewritten too, and a refused registration puts back exactly the bytes it
 * found (D129). A Windows task that is missing although its file is current
 * (a start whose registration failed) is registered again.
 */
export async function keepServiceOnOwnDefinition(root: string, deps: OwnServiceDefinitionDeps): Promise<OwnServiceDefinitionOutcome> {
  const definition = await deps.definition(root);
  const asBytes = (value: Uint8Array | string) => typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const onDisk = await deps.read(definition.path).then(asBytes, () => null);
  if (onDisk === null) return "not_installed";
  const expected = encodeServiceDefinition(definition);
  const rewritten = !onDisk.equals(expected);
  let helperChanged = false;
  for (const file of definition.supportFiles ?? []) {
    const current = await deps.read(file.path).then(asBytes, () => null);
    if (current?.equals(Buffer.from(file.contents, "utf8"))) continue;
    await deps.write(file.path, file.contents);
    helperChanged = true;
  }
  const register = async () => {
    // Task Scheduler stores its own XML copy. Replace it without starting
    // another connector; its next start will use this release's helper.
    for (const command of definition.install) {
      const run = serviceRun(await deps.execute(command));
      if (run.code !== 0) throw new NativeServiceCommandError("register", command, run);
    }
  };
  let reregistered = false;
  if (rewritten) {
    await deps.write(definition.path, definition.fileEncoding ? expected : definition.contents);
    if (deps.os === "windows") {
      try { await register(); }
      catch (error) {
        await deps.write(definition.path, onDisk);
        throw error;
      }
    }
  } else if (deps.os === "windows" && definition.registered && serviceRun(await deps.execute(definition.registered)).code === 1) {
    deps.log("the Konteks task is not registered with Windows; registering it so it starts at the next sign-in");
    await register();
    reregistered = true;
  }
  const unchanged = rewritten || helperChanged || reregistered ? "next_start" : "current";
  const reload = definition.reload;
  if (!reload || !definition.inspect || !definition.expected) return unchanged;
  const output = await deps.inspect(definition.inspect);
  const loaded = output === null ? null : parseLoadedService(deps.os, output, definition.expected);
  if (!loaded || loaded.pid !== deps.pid) return unchanged;
  if (!rewritten && loaded.current) return "current";
  const digest = createHash("sha256").update(definition.contents).digest("hex");
  const last = await deps.lastReload().catch(() => null);
  if (last && last.digest === digest && deps.now() - last.at < SERVICE_RELOAD_WINDOW_MS) {
    deps.log(`the service manager was already asked to load this release's definition at ${new Date(last.at).toISOString()} and still runs another; it applies from the next start`);
    return "next_start";
  }
  await deps.recordReload({ digest, at: deps.now() });
  deps.log("the service manager runs an older definition of this connector; reloading it and restarting onto this release's");
  if (reload.kind === "detached") await deps.detach(reload.command, reload.logFile);
  else for (const command of reload.commands) {
    if (serviceRun(await deps.execute(command)).code !== 0) throw new Error(`${command.command} ${command.args.join(" ")} exited unsuccessfully`);
  }
  return "restarting";
}

/**
 * End the service's own process group when its graceful stop did not finish
 * (a rollback must still restore and start the previous release). The pid is
 * the one the service manager runs; nothing where it names none.
 */
async function forceStopService(definition: NativeServiceDefinition): Promise<void> {
  if (nativePlatform().os === "windows") {
    const owner = await captureWindowsServiceOwner(dirname(definition.path));
    if (await execute(definition.status) !== 1 && await execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "Windows could not end this connector's task; its processes were preserved.");
    await owner?.terminate();
    return;
  }
  const pid = await servicePid(definition);
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** The pid the service manager runs for this service; null where it names none. */
async function servicePid(definition: NativeServiceDefinition): Promise<number | null> {
  if (!definition.inspect || !definition.expected) return null;
  const result = await runCommand({ ...definition.inspect, env: environment(), timeoutMs: 10_000 }).catch(() => null);
  const loaded = result?.code === 0 ? parseLoadedService(nativePlatform().os, result.stdout, definition.expected) : null;
  return loaded?.pid ?? null;
}

async function detachServiceCommand(command: NativeServiceCommand, logFile: string): Promise<void> {
  await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = await open(logFile, "a", 0o600);
  try {
    const child = spawn(command.command, command.args, { env: environment(), stdio: ["ignore", log.fd, log.fd], detached: true });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  } finally {
    await log.close();
  }
}

function productionOwnServiceDefinitionDeps(root: string): OwnServiceDefinitionDeps {
  const reloadFile = join(root, "supervisor", SERVICE_RELOAD_FILE);
  return {
    definition: serviceDefinition,
    // Bytes in, bytes out: the definition's own encoding is applied by keepServiceOnOwnDefinition.
    read: path => readFile(path),
    write: writeSecretFile,
    os: nativePlatform().os,
    pid: process.pid,
    inspect: async command => {
      const result = await runServiceCommand(command, 10_000).catch(() => null);
      return result?.code === 0 ? result.stdout ?? "" : null;
    },
    execute: executeDetailed,
    detach: detachServiceCommand,
    lastReload: async () => {
      const value = JSON.parse(await readFile(reloadFile, "utf8")) as { digest?: unknown; at?: unknown };
      return typeof value.digest === "string" && typeof value.at === "number" ? { digest: value.digest, at: value.at } : null;
    },
    recordReload: reload => writeSecretFile(reloadFile, `${JSON.stringify(reload)}\n`),
    now: Date.now,
    log: line => process.stderr.write(`${line}\n`),
  };
}

interface NativeStopDeps {
  definition: (root: string) => Promise<NativeServiceDefinition>;
  execute: typeof execute;
  /** Runs the stop command keeping what it printed, so a refusal says why. */
  run?: NativeServiceExecute;
  readReceipt: (root: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  platform: ReturnType<typeof nativePlatform>;
  deadlineMs?: number;
  pollMs?: number;
  serviceOwner?: (root: string) => Promise<NativeServiceProcessOwner | null>;
  shutdown?: (root: string) => Promise<void>;
  stopGraceMs?: number;
}

/** How long a command waits for a connector that is still starting (a fresh start takes about a minute). */
const STARTING_WAIT_MS = 90_000;

/**
 * A command that needs the running connector, run while it is still coming up
 * (right after `start`, or after `agent add` restarted it), waits for it and
 * says so once, instead of failing with "cannot reach the supervisor control
 * socket" (the setup window ran `auth login` straight after `agent add`,
 * WS1-167). A stopped service is not waited for: the command's own error says so.
 */
export async function waitWhileStarting(
  input: { control: Pick<SupervisorControl, "call">; output: { line(text: string): void } },
  deps: { running: () => Promise<boolean>; sleep: (ms: number) => Promise<void>; now: () => number; waitMs?: number },
): Promise<void> {
  const deadline = deps.now() + (deps.waitMs ?? STARTING_WAIT_MS);
  let said = false;
  for (;;) {
    try {
      await input.control.call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 5_000 });
      return;
    } catch (error) {
      if (!(error instanceof RemoteInstanceError) || error.code !== "control_socket_unavailable") return;
      if (deps.now() >= deadline || !await deps.running()) return;
      if (!said) input.output.line("Konteks is still starting on this computer; waiting for it…");
      said = true;
      await deps.sleep(2_000);
    }
  }
}

/** Operations that act through the running connector, and so wait for one that is starting. */
const WAITS_FOR_CONNECTOR: ReadonlySet<string> = new Set(["status", "preview.status", "agents", "auth.status", "auth.login", "auth.logout", "git.key.add", "git.key.list", "git.key.remove"]);

const productionNativeStopDeps: NativeStopDeps = {
  definition: serviceDefinition,
  execute,
  run: executeDetailed,
  readReceipt: async root => readFile(join(root, "supervisor", NATIVE_SHUTDOWN_RECEIPT_FILE), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
  platform: nativePlatform(),
  ...(process.platform === "win32" ? {
    serviceOwner: captureWindowsServiceOwner,
    shutdown: async (root: string) => {
      const record = await readNativeRecord(root);
      await new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort).call({ op: "shutdown" }, z.unknown());
    },
  } : {}),
};

/** launchctl bootout acknowledges deregistration before asynchronous owned
 * process cleanup has necessarily finished. A new private receipt is written
 * only after every daemon shutdown step succeeds. */
export async function stopNativeConnector(input: NativeCommandContext, deps: NativeStopDeps = productionNativeStopDeps): Promise<void> {
  const definition = await deps.definition(input.root);
  const stoppedCodes = deps.platform.os === "macos" ? [113] : deps.platform.os === "debian" ? [3, 4] : [1];
  const initialStatus = await deps.execute(definition.status);
  const owner = await deps.serviceOwner?.(input.root) ?? null;
  if (initialStatus !== 0 && !owner) {
    if (initialStatus !== null && stoppedCodes.includes(initialStatus)) throw new RemoteInstanceError("temporarily_unavailable", "Konteks is already stopped on this computer.");
    throw new RemoteInstanceError("temporarily_unavailable", "Konteks could not tell whether it is running on this computer, so nothing was stopped; konteks-remote doctor says why.");
  }
  const previousReceipt = await deps.readReceipt(input.root);
  const stopTask = async () => {
    const stopRun = serviceRun(await (deps.run ?? deps.execute)(definition.stop));
    if (stopRun.code !== 0) throw new RemoteInstanceError("temporarily_unavailable", `Konteks could not be stopped on this computer (${new NativeServiceCommandError("stop", definition.stop, stopRun).message}); konteks-remote --verbose stop shows every step.`);
  };
  if (owner && deps.shutdown) await deps.shutdown(input.root).catch(() => {
    input.output.line("The connector did not acknowledge shutdown; waiting for its owned processes to close…");
  });
  else await stopTask();
  input.output.line("Stopping Konteks on this computer…");
  const started = deps.now();
  const deadline = started + (deps.deadlineMs ?? 30_000);
  let forced = false;
  for (;;) {
    const receipt = await deps.readReceipt(input.root);
    const status = await deps.execute(definition.status);
    if (owner) {
      if (!await owner.alive()) {
        if (status !== 1) await stopTask();
        break;
      }
      if (!forced && deps.now() - started >= Math.min(deps.stopGraceMs ?? 15_000, deps.deadlineMs ?? 30_000)) {
        if (status !== 1) await stopTask();
        input.output.line("The connector is still closing; ending this installation's remaining processes…");
        await owner.terminate();
        forced = true;
        continue;
      }
    }
    if (!owner && receipt !== null && receipt !== previousReceipt && status !== null && stoppedCodes.includes(status)) break;
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", "Konteks stopped, but its agents may still be closing. Wait a moment, then check with konteks-remote status.");
    await deps.sleep(deps.pollMs ?? 250);
  }
  input.output.line("Konteks is stopped on this computer. Your sign-ins and work are kept; konteks-remote start starts it again.");
}
/** The real start path with narrow hooks for collision and stopped-service tests. */
export async function startNativeConnector(
  input: NativeCommandContext,
  deps: {
    roots?: readonly EmbeddedReleaseRoot[];
    platform?: ReturnType<typeof nativePlatform>;
    definition?: (root: string) => Promise<NativeServiceDefinition>;
    execute?: NativeServiceExecute;
    /** How long the service is watched after it starts (default 3 s where its status says it runs: Windows, systemd; none on macOS). */
    settleMs?: number;
    sleep?: (ms: number) => Promise<void>;
    serviceOwner?: (root: string) => Promise<NativeServiceProcessOwner | null>;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? nativePlatform();
  const roots = deps.roots ?? EMBEDDED_RELEASE_ROOTS;
  const executeService = deps.execute ?? executeDetailed;
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
    try { code = serviceRun(await executeService(definition.status)).code; }
    catch { code = null; }
    verbose(`service state: ${code === 0 ? "running" : code !== null && stoppedCodes.includes(code) ? "stopped" : `unknown (status exited ${code ?? "without a code"})`}`);
    if (code === 0) return "running";
    if (platform.os === "windows" && await (deps.serviceOwner ?? captureWindowsServiceOwner)(input.root)) return "running";
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
      "Konteks is already running on this computer; konteks-remote status shows how it is doing.",
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
      `Another program uses port ${moved.previousPort}, so Konteks uses port ${moved.controlPort} on this computer instead.`,
    );
  verbose(`registering and starting ${definition.label} from ${definition.path}`);
  // A failure says which step, the service manager's own words and the one
  // next step, and is kept for doctor and support (D129: "could not start"
  // and nothing else, on a Windows PC where the task XML was refused).
  const failed = async (detail: string, cause: unknown): Promise<never> => {
    const message = `The native user service could not start: ${detail} Installed identity and credentials were preserved.`;
    await recordServiceStartFailure(input.root, { at: new Date().toISOString(), message }).catch(() => undefined);
    throw new RemoteInstanceError("temporarily_unavailable", message, { cause });
  };
  const started = await startNativeServiceDefinition(definition, {
    execute: command => command === definition.status ? serviceState().then(state => state === "running" ? 0 : stoppedCodes[0]!) : executeService(command),
    write: writeSecretFile,
  }).catch(async (error: unknown) => {
    if (error instanceof RemoteInstanceError) return failed(`${error.message}`, error);
    if (error instanceof NativeServiceCommandError) return failed(describeServiceFailure(platform.os, error), error);
    return failed(`${error instanceof Error ? error.message : String(error)}. To see every step, run konteks-remote --verbose start.`, error);
  });
  if (started === "already_running") {
    input.output.line(
      "Konteks is already running on this computer; konteks-remote status shows how it is doing.",
    );
    return;
  }
  // Where the service manager can say whether the service still runs, a
  // connector that stopped as it started is said now, with its log, not left
  // for the person to find with `status` (D129). launchd's `print` says only
  // that a job is loaded, and KeepAlive restarts it anyway.
  const settleMs = deps.settleMs ?? (platform.os === "macos" ? null : 3_000);
  if (settleMs !== null) {
    await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(settleMs);
    const state = await serviceState().catch(() => "running" as const);
    if (state === "stopped") {
      const tail = await connectorLogTail(input.root, 3).catch(() => null);
      await failed(`it started and stopped again at once.${tail?.length ? ` The connector log ends: ${tail.join(" | ")}` : ""} The whole log: ${connectorLogFile(input.root)}.`, null);
    }
  }
  await clearServiceStartFailure(input.root).catch(() => undefined);
  if (definition.requiresLinger)
    input.output.line(
      "This Linux user service needs user lingering to remain available after logout. Configure it explicitly if required.",
    );
  // Starting the process is not the same as being open for work: the service
  // finishes unpacking and opens its control port about a minute later. Saying
  // only "started" invited a second and third `start` against a service that
  // was already coming up.
  input.output.line(
    "Konteks is starting on this computer and is ready for work within a minute; konteks-remote status shows how it is doing.",
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
  /** A fetched agent's consent line answered (Google Antigravity, A20). */
  consent?: FetchConsent;
  /** A fetched agent's download, while the service keeps running (tests replace it). */
  fetchAgent?: typeof fetchHostAgent;
  /** The person's own install found and its version checked, before anything is stopped. */
  locate?: (host: HostAgentInstallAdapter, root: string) => Promise<unknown>;
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
  /** Claude Code or Codex found here, or set up now on the person's yes (D116), before anything is stopped. */
  ensurePersonal?: typeof ensurePersonalAgent;
  /** After the restart: sign the agent in and say whether it is ready (D116). */
  closeAgents?: (input: Parameters<typeof closeAgentSetup>[0]) => Promise<void>;
  /** Windows stops the connector's exact tree, rather than only the task host. */
  stop?: (input: NativeCommandContext) => Promise<void>;
  serviceOwner?: (root: string) => Promise<NativeServiceProcessOwner | null>;
}

const productionAgentAddDeps: NativeAgentAddDeps = {
  readRecord: readNativeRecord,
  serviceDefinition,
  execute,
  control: (root, record) => new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort),
  add: addNativeAgent,
  restore: restoreNativeRecord,
  start: startNativeConnector,
  locate: (host, root) => host.locate(undefined, { root }),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: Date.now,
  platform: nativePlatform(),
  ...(process.platform === "win32" ? { stop: stopNativeConnector, serviceOwner: captureWindowsServiceOwner } : {}),
};

/**
 * Drain, stop and wait for ownership before changing an installed agent list.
 * A fetched agent (Google Antigravity) is asked about and downloaded first,
 * while the service keeps running: a no, or a failed download, changes
 * nothing and stops nothing.
 */
export async function runNativeAgentAdd(input: NativeCommandContext & { agent: string; yes?: boolean }, deps: NativeAgentAddDeps = productionAgentAddDeps): Promise<void> {
  const previous = await deps.readRecord(input.root);
  const host = hostAgentInstallAdapter(input.agent);
  const fetched = host?.fetch !== undefined;
  const listed = previous.agents.includes(input.agent as NativeRuntimeRecord["agents"][number]);
  // A listed fetched agent is fetched again only when its recorded copy no longer verifies (A16's remedy).
  const intact = listed && (!fetched || await host!.runnerSettings(previous, { root: input.root }).then(() => true, () => false));
  if (intact) {
    input.output.line(`${findAgentBridge(input.agent)?.displayName ?? input.agent} is already installed; no restart is needed.`);
    return;
  }
  if (fetched) {
    const consent = deps.consent ?? terminalFetchConsent({ ...(input.yes === undefined ? {} : { yes: input.yes }), line: text => input.output.line(text) });
    await (deps.fetchAgent ?? fetchHostAgent)(host!, input.root, consent, input.output);
  }
  // An install Konteks cannot run (DeepSeek Harness 0.2.0 on 09-30) is said
  // before anything stops: the retry stopped the connector, then refused the
  // version and left it stopped (W1-D3).
  else if (host && deps.locate) await deps.locate(host, input.root);
  // Claude Code or Codex not here yet: offered and set up first (D116); a no stops nothing.
  const setUp = !listed && isPersonalAgent(input.agent) && await (deps.ensurePersonal ?? ensurePersonalAgent)(input.agent, input.output) === "set_up";
  const definition = await deps.serviceDefinition(input.root);
  const stoppedCodes = deps.platform.os === "macos" ? [113] : deps.platform.os === "debian" ? [3, 4] : [1];
  const initialStatus = await deps.execute(definition.status);
  if (initialStatus !== 0 && (initialStatus === null || !stoppedCodes.includes(initialStatus))) throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation's service state. Inspect only this installation's service before adding an agent; identity and local work are unchanged.");
  const serviceOwner = await deps.serviceOwner?.(input.root) ?? null;
  const wasRunning = initialStatus === 0 || serviceOwner !== null;
  const drain = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
  // A connector the service manager does not run (`konteks-remote serve` in a
  // terminal) still owns this folder. Waiting for it to let go only timed out
  // after 90 s with "Another connector owns this native data directory"
  // (W1-D3): ask it to stop, the way a signal would, once its work is done.
  const foreground = !wasRunning
    ? await deps.control(input.root, previous).call({ op: "drain.status" }, drain, { timeoutMs: 2_000 }).then(() => true, () => false)
    : false;
  let stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
  const wait = async () => deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
  const stopped = async () => {
    const code = await deps.execute(definition.status);
    if (code === 0) return false;
    if (code !== null && stoppedCodes.includes(code)) return true;
    throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation stopped; its identity and local work are unchanged.");
  };
  if (wasRunning || foreground) {
    const control = deps.control(input.root, previous);
    await control.call({ op: "drain", reason: "update" }, z.unknown());
    const drainDeadline = deps.now() + 15 * 60_000;
    for (;;) {
      const state = await control.call({ op: "drain.status" }, drain);
      if (state.activeAssignments === 0) break;
      if (deps.now() >= drainDeadline) throw new RemoteInstanceError("active_work", "Agent installation waited 15 minutes for active work; the runtime remains running and drained so it can be inspected safely.");
      input.output.line(`waiting for ${state.activeAssignments} active assignment(s) before installing ${input.agent}…`);
      await deps.sleep(deps.pollMs ?? 5_000);
    }
    if (deps.platform.os === "windows" && deps.stop) {
      await deps.stop(input).catch(async error => {
        await control.call({ op: "drain.cancel" }, z.unknown()).catch(() => undefined);
        throw error;
      });
      stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
    } else if (foreground) {
      await control.call({ op: "shutdown" }, z.unknown());
      input.output.line("Konteks is running in a terminal here, not as its background service; stopping it there to add the agent…");
      stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
    } else {
      if (await deps.execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime drained but could not stop; its installation was not changed.");
      stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
      while (!await stopped()) {
        if (deps.now() >= stopDeadline) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime did not finish stopping; its installed agents were not changed.");
        await wait();
      }
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
    if (wasRunning && isPersonalAgent(input.agent)) {
      const close = deps.closeAgents ?? (closing => closeAgentSetup(closing, productionAgentClosingDeps(input.root, input.output, agent => nativeCliActions.control({ ...input, operation: "auth.login", agent }))));
      await close({ agents: [input.agent], signInNow: setUp ? [input.agent] : [], missing: [], output: input.output });
    }
    // Its terminal is not this one, so it is not started again here.
    if (foreground) input.output.line(`${findAgentBridge(input.agent)?.displayName ?? input.agent} is added. Konteks stopped to add it; konteks-remote start starts it again, in the background.`);
    input.output.result({ instanceId: successor.instanceId, agents: successor.agents, state: "installed" });
  } catch (error) {
    if (successor) {
      try {
        if (wasRunning) {
          const code = await deps.execute(definition.status);
          if (deps.platform.os === "windows" && deps.stop) {
            if (code !== 1 || await deps.serviceOwner?.(input.root)) await deps.stop(input);
            stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
          } else {
            if (code === 0 && await deps.execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The new service could not be stopped before agent rollback.");
            if (code !== 0 && (code === null || !stoppedCodes.includes(code))) throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm the new service stopped before agent rollback.");
            stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
            while (!await stopped()) {
              if (deps.now() >= stopDeadline) throw new RemoteInstanceError("temporarily_unavailable", "The new service did not finish stopping before agent rollback.");
              await wait();
            }
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
    if (foreground) input.output.line("Konteks stopped to add the agent and stays stopped; konteks-remote start starts it again, in the background.");
    throw error;
  }
}

interface NativeAgentRemoveDeps {
  readRecord: (root: string) => Promise<NativeRuntimeRecord>;
  serviceDefinition: (root: string) => Promise<NativeServiceDefinition>;
  execute: (command: NativeServiceCommand) => Promise<number | null>;
  control: (root: string, record: NativeRuntimeRecord) => Pick<SupervisorControl, "call">;
  remove: typeof removeNativeAgent;
  start: (input: NativeCommandContext) => Promise<void>;
  /** The one question (A18); `--yes` answers it up front. */
  confirm: (question: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  platform: ReturnType<typeof nativePlatform>;
  stopDeadlineMs?: number;
  pollMs?: number;
}

/**
 * `konteks-remote agent remove antigravity` (A18): asks once, drains and
 * stops the service (its processes stop with it), signs out, drops it from
 * the record, deletes its downloads and its private home, and starts the
 * service again if it was running. Only a fetched agent is removed this way.
 */
export async function runNativeAgentRemove(input: NativeCommandContext & { agent: string; yes?: boolean }, deps: NativeAgentRemoveDeps): Promise<void> {
  const host = hostAgentInstallAdapter(input.agent);
  const name = findAgentBridge(input.agent)?.displayName ?? input.agent;
  if (host?.fetch === undefined) {
    throw new RemoteInstanceError("agent_unavailable", `${name} cannot be removed on its own. Only Google Antigravity, which Konteks downloads, can: konteks-remote agent remove antigravity. To remove Konteks from this computer: konteks-remote uninstall`);
  }
  const previous = await deps.readRecord(input.root);
  const listed = previous.agents.includes(input.agent as NativeRuntimeRecord["agents"][number]);
  const question = `Remove ${name} from this computer? Konteks signs it out, deletes its download and its sign-ins here, and restarts the connector if it is running.`;
  if (input.yes === true) input.output.line(`${question} Answered yes with --yes.`);
  else if (!await deps.confirm(question)) {
    input.output.line(`Nothing was removed; ${name} is ${listed ? "still added" : "not added"} here.`);
    return;
  }
  const definition = await deps.serviceDefinition(input.root);
  const stoppedCodes = deps.platform.os === "macos" ? [113] : deps.platform.os === "debian" ? [3, 4] : [1];
  const initialStatus = await deps.execute(definition.status);
  if (initialStatus !== 0 && (initialStatus === null || !stoppedCodes.includes(initialStatus))) throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation's service state. Inspect only this installation's service before removing an agent; identity and local work are unchanged.");
  const wasRunning = initialStatus === 0;
  const wait = async () => deps.sleep(Math.min(deps.pollMs ?? 1_000, 1_000));
  const stopped = async () => {
    const code = await deps.execute(definition.status);
    if (code === 0) return false;
    if (code !== null && stoppedCodes.includes(code)) return true;
    throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation stopped; its identity and local work are unchanged.");
  };
  let stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
  if (wasRunning) {
    const control = deps.control(input.root, previous);
    const drain = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
    await control.call({ op: "drain", reason: "update" }, z.unknown());
    const drainDeadline = deps.now() + 15 * 60_000;
    for (;;) {
      const state = await control.call({ op: "drain.status" }, drain);
      if (state.activeAssignments === 0) break;
      if (deps.now() >= drainDeadline) throw new RemoteInstanceError("active_work", "Removing the agent waited 15 minutes for active work; the runtime remains running and drained so it can be inspected safely.");
      input.output.line(`waiting for ${state.activeAssignments} active assignment(s) before removing ${name}…`);
      await deps.sleep(deps.pollMs ?? 5_000);
    }
    if (await deps.execute(definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime drained but could not stop; nothing was removed.");
    stopDeadline = deps.now() + (deps.stopDeadlineMs ?? 90_000);
    while (!await stopped()) {
      if (deps.now() >= stopDeadline) throw new RemoteInstanceError("temporarily_unavailable", "The native runtime did not finish stopping; nothing was removed.");
      await wait();
    }
  }
  let successor: NativeRuntimeRecord;
  try {
    for (;;) {
      try {
        successor = await deps.remove({ root: input.root, agentId: input.agent as NativeRuntimeRecord["agents"][number], output: input.output });
        break;
      } catch (error) {
        const owned = error instanceof RemoteInstanceError && error.code === "temporarily_unavailable" && /owns this native data directory/.test(error.message);
        if (!owned || deps.now() >= stopDeadline) throw error;
        await wait();
      }
    }
  } catch (error) {
    if (wasRunning) await deps.start(input).catch(() => undefined);
    throw error;
  }
  if (wasRunning) await deps.start(input);
  input.output.result({ instanceId: successor.instanceId, agents: successor.agents, state: "removed" });
}

/** The removal's one question, in a terminal only (`--yes` answers it elsewhere). */
async function confirmOnTerminal(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) throw new RemoteInstanceError("agent_unavailable", `${question} Nothing was removed: answer in a terminal, or run the command again with --yes.`);
  return confirm(question);
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
    // A fetched agent in --agents (Google Antigravity) asks its consent line in this terminal before anything is activated.
    const consent = terminalFetchConsent({ line: text => input.output.line(text) });
    // Without --agents, a missing Claude Code or Codex is offered before the code is asked (D116).
    const setUp: string[] = [];
    const setupAgent = async (agent: "claude-code" | "codex") => { const done = await setUpPersonalAgent(agent, input.output); if (done) setUp.push(agent); return done; };
    const record = await installNative({ ...input, activationId: input.activationId!, deps: { consent, ...(input.agents === undefined ? { setupAgent } : {}) } });
    await startNativeConnector(input);
    // Sign in what was just set up, then say plainly what is ready and the one command for the rest.
    await closeAgentSetup(
      { agents: record.agents, signInNow: setUp, missing: input.agents === undefined ? PERSONAL_AGENTS.filter(agent => !record.agents.includes(agent)) : [], output: input.output },
      productionAgentClosingDeps(input.root, input.output, agent => nativeCliActions.control({ ...input, operation: "auth.login", agent })),
    );
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
  addAgent: input => runNativeAgentAdd(input),
  removeAgent: input => runNativeAgentRemove(input, {
    readRecord: readNativeRecord, serviceDefinition, execute,
    control: (root, record) => new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort),
    remove: removeNativeAgent, start: startNativeConnector,
    confirm: question => confirmOnTerminal(question),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now, platform: nativePlatform(),
  }),
  serve: async input => {
    const own = await keepServiceOnOwnDefinition(input.root, productionOwnServiceDefinitionDeps(input.root))
      .catch(async error => {
        const detail = error instanceof NativeServiceCommandError ? describeServiceFailure(nativePlatform().os, error) : error instanceof Error ? error.message : String(error);
        process.stderr.write(`service definition not refreshed: ${detail}\n`);
        await recordServiceStartFailure(input.root, { at: new Date().toISOString(), message: `The background service could not be registered again: ${detail}` }).catch(() => undefined);
        return "current" as const;
      });
    if (own === "next_start") process.stderr.write("service definition rewritten by this release; it applies from the next start\n");
    if (own === "restarting") {
      // Nothing is claimed yet: the service manager stops this process within
      // seconds and starts the release on its own definition. Should it not,
      // the connector starts here anyway rather than stay disconnected.
      await new Promise(resolve => setTimeout(resolve, SERVICE_RELOAD_GRACE_MS));
      process.stderr.write("the service manager did not restart this connector onto its definition; starting on the one it has\n");
    }
    const service = createNativeService({ root: input.root, roots: EMBEDDED_RELEASE_ROOTS, platform: nativePlatform(),
      prepareRepositoryWorktree: (cwd, agentId) => prepareDeliveryGraft(input.root, cwd, agentId),
      exitProcess: code => process.exit(code) });
    await service.start();
    // Whichever launcher drove the update, the person's konteks-remote runs this release's code from now on (D113b).
    void keepLauncherCurrent(input.root, { execPath: process.execPath, readRecord: readNativeRecord, readLedger: readNativeUpdateLedger,
      refresh: refreshInstalledLauncher, sleep: ms => new Promise(resolve => setTimeout(resolve, ms).unref()), now: Date.now })
      .then(result => { if (result === "refreshed") process.stderr.write("konteks-remote now runs this release\n"); })
      .catch(error => process.stderr.write(`konteks-remote could not be refreshed to this release: ${error instanceof Error ? error.message : String(error)}\n`));
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
    await runNativeUpdate({ root: input.root, output: input.output, unattended: input.unattended }, productionUpdateDeps({ serviceDefinition, execute, start: startNativeConnector, serviceExits, forceStop: forceStopService, servicePid }));
  },
  uninstall: async input => {
    const result = await uninstallNative(input, productionUninstallDeps({ root: input.root, serviceDefinition, execute }));
    input.output.result(result);
  },
  stop: stopNativeConnector,
  control: async input => {
    const record = await readNativeRecord(input.root);
    const context = { output: input.output, control: new SupervisorControl({ supervisorData: join(input.root, "supervisor") }, record.controlPort) };
    if (WAITS_FOR_CONNECTOR.has(input.operation)) {
      await waitWhileStarting(context, {
        running: async () => await execute((await serviceDefinition(input.root)).status) === 0,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        now: Date.now,
      });
    }
    switch (input.operation) {
      case "status": {
        try {
          return await status(context);
        } catch (error) {
          // A stopped connector is an answer, not an error (09-30).
          if (!(error instanceof RemoteInstanceError) || error.code !== "control_socket_unavailable") throw error;
          if (await execute((await serviceDefinition(input.root)).status) === 0) throw error;
          input.output.line("Konteks is stopped on this computer. konteks-remote start starts it again.");
          return;
        }
      }
      case "agents": return agents(context);
      case "doctor":
      case "support": {
        // Doctor and support ask the running connector; a connector that is
        // not running still gets the last failed start and its log (D129).
        let healthy: boolean;
        try { healthy = input.operation === "doctor" ? await doctor(context) : (await supportBundle(context), true); }
        catch (error) {
          if (!(error instanceof RemoteInstanceError) || error.code !== "control_socket_unavailable") throw error;
          const report = await localServiceReport(input.root, { tailLines: input.operation === "doctor" ? 10 : 200 });
          input.output.result(report.value);
          for (const line of report.lines) input.output.line(line);
          if (input.operation === "doctor") process.exitCode = 2;
          return;
        }
        if (input.operation === "doctor") {
          input.output.line(`Connector log: ${connectorLogFile(input.root)}`);
          if (!healthy) process.exitCode = 2;
        } else {
          const failure = await readServiceStartFailure(input.root);
          if (failure) input.output.line(`Last failed start (${failure.at}): ${failure.message}`);
        }
        return;
      }
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
