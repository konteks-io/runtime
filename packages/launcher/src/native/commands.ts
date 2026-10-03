import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EMBEDDED_RELEASE_ROOTS, findAgentBridge, resolveNativeConnectorExecutable, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { createNativeService, hostAgentInstallAdapter, loadNativeInstallation, ownedByAnotherConnector, readNativeUpdateLedger, verifyInstalledNativeConnector, NATIVE_SHUTDOWN_RECEIPT_FILE, type HostAgentInstallAdapter, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import { ReleaseAcceptedSchema, RemoteInstanceError, SupervisorStatusSchema, runCommand, sanitizeInheritedChildProcessEnv, writeSecretFile } from "@konteks/remote-common";
import { agents, authLogin, authLogout, authStatus, doctor, gitKeyAdd, gitKeyList, gitKeyRemove, previewStatus, status, supportBundle, type ControlContext } from "./control-commands.js";
import { SupervisorControl } from "../control.js";
import { addNativeAgent, fetchHostAgent, installNative, readNativeRecord, reassignOccupiedNativeControlPort, recordNativeEnrollment, removeNativeAgent, restoreNativeRecord, stageNativeEnrollment } from "./install.js";
import { terminalFetchConsent, type FetchConsent } from "./consent.js";
import { closeAgentSetup, ensurePersonalAgent, isPersonalAgent, PERSONAL_AGENTS, productionAgentClosingDeps, setUpPersonalAgent } from "./agent-setup.js";
import { confirm } from "../prompt.js";
import { spawnEnrollmentStaging } from "./enrollment-staging.js";
import { onboardCoreUrl, onboardFailureStep, runOnboard } from "./onboard.js";
import type { OnboardStep } from "./onboard-session.js";
import { describeServiceFailure, encodeServiceDefinition, nativePlatform, nativeServiceDefinition, NativeServiceCommandError, parseLoadedService, parseServiceExits, serviceRun, startNativeServiceDefinition, type HostOs, type NativeServiceCommand, type NativeServiceDefinition, type NativeServiceExecute, type NativeServiceRun } from "./service.js";
import { clearServiceStartFailure, connectorLogFile, connectorLogTail, localServiceReport, readServiceStartFailure, recordServiceStartFailure } from "./service-report.js";
import { verbose, verboseCommand } from "../verbose.js";
import { checkNativeUpdate } from "./update.js";
import { prepareDeliveryGraft } from "./graft.js";
import { earlierFailure, earlierFailureNote, keepLauncherCurrent, productionUpdateDeps, refreshInstalledLauncher, runNativeUpdate, selfUpdateNote } from "./update-transaction.js";
import { productionUninstallDeps, uninstallNative } from "./uninstall.js";
import type { NativeCliActions, NativeCommandContext } from "./cli.js";

const environment = () => sanitizeInheritedChildProcessEnv({ env: process.env });
/** Runs one service or OS command and keeps how it ended; `--verbose` prints it. */
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
const SERVICE_RELOAD_GRACE_MS = 60_000;
const SERVICE_RELOAD_FILE = "service-reload.json";

type OwnServiceDefinitionOutcome = "not_installed" | "current" | "next_start" | "restarting";

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
 * log file would arrive one release late or never. Rewriting the
 * file alone left it for "the next start", which never came: launchd's
 * KeepAlive respawns reuse the plist it loaded, so a connector updated by the
 * install launcher (which loads a plist without the log file) ran with its
 * output on /dev/null until someone stopped and started it.
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
 * found. A Windows task that is missing although its file is current
 * (a start whose registration failed) is registered again.
 */
export async function keepServiceOnOwnDefinition(root: string, deps: OwnServiceDefinitionDeps): Promise<OwnServiceDefinitionOutcome> {
  const definition = await deps.definition(root);
  const onDisk = await deps.read(definition.path).then(asBytes, () => null);
  if (onDisk === null) return "not_installed";
  const expected = encodeServiceDefinition(definition);
  const rewritten = !onDisk.equals(expected);
  const helperChanged = await writeChangedSupportFiles(definition, deps);
  let reregistered = false;
  if (rewritten) await rewriteDefinition(definition, deps, expected, onDisk);
  else reregistered = await registerMissingTask(definition, deps);
  const unchanged = rewritten || helperChanged || reregistered ? "next_start" : "current";
  return reloadOntoDefinition(definition, deps, rewritten, unchanged);
}

function asBytes(value: Uint8Array | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

/** Whether any support file (the Windows helper) had to be written. */
async function writeChangedSupportFiles(definition: NativeServiceDefinition, deps: OwnServiceDefinitionDeps): Promise<boolean> {
  let changed = false;
  for (const file of definition.supportFiles ?? []) {
    const current = await deps.read(file.path).then(asBytes, () => null);
    if (current?.equals(Buffer.from(file.contents, "utf8"))) continue;
    await deps.write(file.path, file.contents);
    changed = true;
  }
  return changed;
}

/**
 * Task Scheduler stores its own XML copy. Replace it without starting
 * another connector; its next start will use this release's helper.
 */
async function registerTask(definition: NativeServiceDefinition, deps: OwnServiceDefinitionDeps): Promise<void> {
  for (const command of definition.install) {
    const run = serviceRun(await deps.execute(command));
    if (run.code !== 0) throw new NativeServiceCommandError("register", command, run);
  }
}

/** The definition as the service manager reads it; a refused Windows registration puts back the bytes it found. */
async function rewriteDefinition(definition: NativeServiceDefinition, deps: OwnServiceDefinitionDeps, expected: Buffer, onDisk: Buffer): Promise<void> {
  await deps.write(definition.path, definition.fileEncoding ? expected : definition.contents);
  if (deps.os !== "windows") return;
  try { await registerTask(definition, deps); }
  catch (error) {
    await deps.write(definition.path, onDisk);
    throw error;
  }
}

/** A Windows task whose file is current but that is not registered (a failed start) is registered again. */
async function registerMissingTask(definition: NativeServiceDefinition, deps: OwnServiceDefinitionDeps): Promise<boolean> {
  if (deps.os !== "windows" || !definition.registered || serviceRun(await deps.execute(definition.registered)).code !== 1) return false;
  deps.log("the Konteks task is not registered with Windows; registering it so it starts at the next sign-in");
  await registerTask(definition, deps);
  return true;
}

/**
 * When this process is the one the service manager runs and its loaded
 * definition is not this one, reload it and restart onto it, at most once
 * per definition within `SERVICE_RELOAD_WINDOW_MS`.
 */
async function reloadOntoDefinition(definition: NativeServiceDefinition, deps: OwnServiceDefinitionDeps, rewritten: boolean, unchanged: OwnServiceDefinitionOutcome): Promise<OwnServiceDefinitionOutcome> {
  const reload = definition.reload;
  const loaded = reload ? await loadedByThisProcess(definition, deps) : null;
  if (!reload || !loaded) return unchanged;
  if (!rewritten && loaded.current) return "current";
  const digest = createHash("sha256").update(definition.contents).digest("hex");
  if (await reloadedRecently(deps, digest)) return "next_start";
  await deps.recordReload({ digest, at: deps.now() });
  deps.log("the service manager runs an older definition of this connector; reloading it and restarting onto this release's");
  await runReload(reload, deps);
  return "restarting";
}

/** What the service manager has loaded, when the process it runs is this one. */
async function loadedByThisProcess(definition: NativeServiceDefinition, deps: OwnServiceDefinitionDeps): Promise<{ pid: number | null; current: boolean } | null> {
  if (!definition.inspect || !definition.expected) return null;
  const output = await deps.inspect(definition.inspect);
  const loaded = output === null ? null : parseLoadedService(deps.os, output, definition.expected);
  return loaded && loaded.pid === deps.pid ? loaded : null;
}

async function reloadedRecently(deps: OwnServiceDefinitionDeps, digest: string): Promise<boolean> {
  const last = await deps.lastReload().catch(() => null);
  if (!last || last.digest !== digest || deps.now() - last.at >= SERVICE_RELOAD_WINDOW_MS) return false;
  deps.log(`the service manager was already asked to load this release's definition at ${new Date(last.at).toISOString()} and still runs another; it applies from the next start`);
  return true;
}

async function runReload(reload: NonNullable<NativeServiceDefinition["reload"]>, deps: OwnServiceDefinitionDeps): Promise<void> {
  if (reload.kind === "detached") return deps.detach(reload.command, reload.logFile);
  for (const command of reload.commands) {
    if (serviceRun(await deps.execute(command)).code !== 0) throw new Error(`${command.command} ${command.args.join(" ")} exited unsuccessfully`);
  }
}

/**
 * End the service's own process group when its graceful stop did not finish
 * (a rollback must still restore and start the previous release). The pid is
 * the one the service manager runs; nothing where it names none.
 */
async function forceStopService(definition: NativeServiceDefinition): Promise<void> {
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
}

/** How long a command waits for a connector that is still starting (a fresh start takes about a minute). */
const STARTING_WAIT_MS = 90_000;

/**
 * A command that needs the running connector, run while it is still coming up
 * (right after `start`, or after `agent add` restarted it), waits for it and
 * says so once, instead of failing with "cannot reach the supervisor control
 * socket" (the setup window ran `auth login` straight after `agent add`).
 * A stopped service is not waited for: the command's own error says so.
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
      if (!await stillStarting(error, deps, deadline)) return;
      if (!said) input.output.line("Konteks is still starting on this computer; waiting for it…");
      said = true;
      await deps.sleep(2_000);
    }
  }
}

/** The control socket is not open yet, the service runs, and the wait is not over. */
async function stillStarting(error: unknown, deps: { running: () => Promise<boolean>; now: () => number }, deadline: number): Promise<boolean> {
  if (!(error instanceof RemoteInstanceError) || error.code !== "control_socket_unavailable") return false;
  return deps.now() < deadline && await deps.running();
}

type UpdateCheck = Awaited<ReturnType<typeof checkNativeUpdate>>;
type UpdateInput = Parameters<NativeCliActions["update"]>[0];

/**
 * A release published before Konteks accepts it would install, be refused
 * by Konteks and roll back minutes later. The running service asks Konteks
 * with this machine's lease; only a definite other answer stops the update,
 * so a machine that cannot ask still updates as asked. The version Konteks
 * accepts instead, or null.
 */
async function acceptedInstead(root: string, check: UpdateCheck | null): Promise<string | null> {
  if (!check || check.status === "current") return null;
  const record = await readNativeRecord(root).catch(() => null);
  if (!record) return null;
  const control = new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort);
  const accepted = await control.call({ op: "release.accepted" }, ReleaseAcceptedSchema, { timeoutMs: 10_000 }).catch(() => null);
  const version = check.release.manifest.bundleVersion;
  return accepted?.bundleVersion && accepted.bundleVersion !== version ? accepted.bundleVersion : null;
}

async function updateAttempts(root: string) {
  return (await readNativeUpdateLedger(root).catch(() => ({ attempts: [] }))).attempts;
}

/** `update --check`: what the channel offers, what Konteks accepts, and an earlier failure of the same release here. */
async function reportUpdateCheck(input: UpdateInput): Promise<void> {
  const check = await checkNativeUpdate({ root: input.root });
  if (check.status === "current") {
    const attempts = await updateAttempts(input.root);
    input.output.line([`Installed release ${check.bundleVersion} is current.`, selfUpdateNote(attempts, check.bundleVersion)].filter(Boolean).join(" "));
    input.output.result({ state: "current", bundleVersion: check.bundleVersion });
    return;
  }
  const acceptedOther = await acceptedInstead(input.root, check);
  if (acceptedOther) {
    input.output.line(`Release ${check.release.manifest.bundleVersion} is published, but Konteks accepts ${acceptedOther} for this machine, so it stays on ${check.current.bundleVersion} until Konteks accepts the new one.`);
    input.output.result({ state: "not_accepted", installed: check.current.bundleVersion, available: check.release.manifest.bundleVersion, accepted: acceptedOther });
    return;
  }
  const failed = earlierFailure(await updateAttempts(input.root), check.release.manifest.digest);
  input.output.line(failed
    ? `Release ${check.release.manifest.bundleVersion} is available (installed: ${check.current.bundleVersion}), but ${earlierFailureNote(failed)}`
    : `Release ${check.release.manifest.bundleVersion} is available (installed: ${check.current.bundleVersion}); run \`konteks-remote update\` to install it.`);
  input.output.result({ state: "available", installed: check.current.bundleVersion, available: check.release.manifest.bundleVersion, manifestDigest: check.release.manifest.digest, ...(failed ? { failedHere: { outcome: failed.outcome, at: failed.finishedAt ?? failed.startedAt, detail: failed.detail } } : {}) });
}

/** Before an update the person asked for: true when Konteks accepts another release (nothing is changed); otherwise it says what an earlier attempt here did. */
async function notAcceptedByKonteks(input: UpdateInput): Promise<boolean> {
  const check = await checkNativeUpdate({ root: input.root }).catch(() => null);
  const acceptedOther = await acceptedInstead(input.root, check);
  if (acceptedOther && check && check.status !== "current") {
    input.output.line(`Release ${check.release.manifest.bundleVersion} is published, but Konteks accepts ${acceptedOther} for this machine, so nothing was changed; ${check.current.bundleVersion} keeps running until Konteks accepts the new one.`);
    input.output.result({ state: "not_accepted", installed: check.current.bundleVersion, available: check.release.manifest.bundleVersion, accepted: acceptedOther });
    return true;
  }
  if (check) await sayEarlierAttempts(input, check);
  return false;
}

/** An earlier failed attempt at the same release, or the update the connector already made by itself. */
async function sayEarlierAttempts(input: UpdateInput, check: UpdateCheck): Promise<void> {
  const attempts = await updateAttempts(input.root);
  if (check.status === "current") {
    const selfUpdated = selfUpdateNote(attempts, check.bundleVersion);
    if (selfUpdated) input.output.line(selfUpdated);
    return;
  }
  const failed = earlierFailure(attempts, check.release.manifest.digest);
  if (failed) input.output.line(`Trying again as asked: ${earlierFailureNote(failed)}`);
}

type ControlInput = Parameters<NativeCliActions["control"]>[0];
type ControlOperation = (context: ControlContext, input: ControlInput) => Promise<void>;

async function serviceRunning(root: string): Promise<boolean> {
  return await execute((await serviceDefinition(root)).status) === 0;
}

function controlSocketUnavailable(error: unknown): boolean {
  return error instanceof RemoteInstanceError && error.code === "control_socket_unavailable";
}

/** A stopped connector is an answer, not an error. */
async function statusOrStopped(context: ControlContext, input: ControlInput): Promise<void> {
  try {
    return await status(context);
  } catch (error) {
    if (!controlSocketUnavailable(error) || await serviceRunning(input.root)) throw error;
    input.output.line("Konteks is stopped on this computer. konteks-remote start starts it again.");
  }
}

/**
 * Doctor and support ask the running connector; a connector that is not
 * running still gets the last failed start and its log.
 */
async function doctorOrSupport(context: ControlContext, input: ControlInput): Promise<void> {
  const isDoctor = input.operation === "doctor";
  let healthy: boolean;
  try { healthy = isDoctor ? await doctor(context) : (await supportBundle(context), true); }
  catch (error) {
    if (!controlSocketUnavailable(error)) throw error;
    return reportStoppedService(input, isDoctor);
  }
  if (isDoctor) {
    input.output.line(`Connector log: ${connectorLogFile(input.root)}`);
    if (!healthy) process.exitCode = 2;
    return;
  }
  const failure = await readServiceStartFailure(input.root);
  if (failure) input.output.line(`Last failed start (${failure.at}): ${failure.message}`);
}

/** The last failed start and the connector log, for a connector that is not running. */
async function reportStoppedService(input: ControlInput, isDoctor: boolean): Promise<void> {
  const report = await localServiceReport(input.root, { tailLines: isDoctor ? 10 : 200 });
  input.output.result(report.value);
  for (const line of report.lines) input.output.line(line);
  if (isDoctor) process.exitCode = 2;
}

const CONTROL_OPERATIONS: Readonly<Record<ControlInput["operation"], ControlOperation>> = {
  status: statusOrStopped,
  agents: context => agents(context),
  doctor: doctorOrSupport,
  support: doctorOrSupport,
  "preview.status": context => previewStatus(context),
  "auth.status": (context, input) => authStatus(context, input.agent),
  "auth.login": (context, input) => authLogin(context, input.agent!, input.organization ?? false, {
    ...(input.provider ? { provider: input.provider } : {}), ...(input.method ? { method: input.method } : {}), ...(input.reuse ? { reuse: true } : {}),
    ...(input.project ? { project: input.project, location: input.location ?? "global" } : {}) }),
  "auth.logout": (context, input) => authLogout(context, input.agent!, input.provider, input.method),
  "git.key.add": (context, input) => gitKeyAdd(context, input.title),
  "git.key.list": context => gitKeyList(context),
  "git.key.remove": (context, input) => gitKeyRemove(context, input.keyRef!),
};

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
};

/** launchctl bootout acknowledges deregistration before asynchronous owned
 * process cleanup has necessarily finished. A new private receipt is written
 * only after every daemon shutdown step succeeds. */
export async function stopNativeConnector(input: NativeCommandContext, deps: NativeStopDeps = productionNativeStopDeps): Promise<void> {
  const definition = await deps.definition(input.root);
  const stoppedCodes = stoppedExitCodes(deps.platform.os);
  assertRunningBeforeStop(await deps.execute(definition.status), stoppedCodes);
  const previousReceipt = await deps.readReceipt(input.root);
  const stopRun = serviceRun(await (deps.run ?? deps.execute)(definition.stop));
  if (stopRun.code !== 0) throw new RemoteInstanceError("temporarily_unavailable", `Konteks could not be stopped on this computer (${new NativeServiceCommandError("stop", definition.stop, stopRun).message}); konteks-remote --verbose stop shows every step.`);
  input.output.line("Stopping Konteks on this computer…");
  const deadline = deps.now() + (deps.deadlineMs ?? 30_000);
  while (!await stopConfirmed(input.root, definition, deps, { previousReceipt, stoppedCodes })) {
    if (deps.now() >= deadline) throw new RemoteInstanceError("temporarily_unavailable", "Konteks stopped, but its agents may still be closing. Wait a moment, then check with konteks-remote status.");
    await deps.sleep(deps.pollMs ?? 250);
  }
  input.output.line("Konteks is stopped on this computer. Your sign-ins and work are kept; konteks-remote start starts it again.");
}

/**
 * The OS service managers use distinct exit codes for a known stopped
 * service; other failures cannot prove anything. systemctl uses 3 for
 * inactive and 4 for a unit not installed yet.
 */
function stoppedExitCodes(os: HostOs): readonly number[] {
  if (os === "macos") return [113];
  return os === "debian" ? [3, 4] : [1];
}

function assertRunningBeforeStop(status: number | null, stoppedCodes: readonly number[]): void {
  if (status === 0) return;
  if (status !== null && stoppedCodes.includes(status)) throw new RemoteInstanceError("temporarily_unavailable", "Konteks is already stopped on this computer.");
  throw new RemoteInstanceError("temporarily_unavailable", "Konteks could not tell whether it is running on this computer, so nothing was stopped; konteks-remote doctor says why.");
}

/** A new shutdown receipt and a stopped service. */
async function stopConfirmed(root: string, definition: NativeServiceDefinition, deps: NativeStopDeps, before: { previousReceipt: string | null; stoppedCodes: readonly number[] }): Promise<boolean> {
  const receipt = await deps.readReceipt(root);
  const status = await deps.execute(definition.status);
  return receipt !== null && receipt !== before.previousReceipt && status !== null && before.stoppedCodes.includes(status);
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
  } = {},
): Promise<void> {
  const { platform, roots, executeService, definitionOf } = startDefaults(deps);
  const installation = await loadNativeInstallation(input.root, { roots, platform });
  await verifyInstalledNativeConnector(
    installation.release,
    join(input.root, "releases", installation.record.releaseId),
    platform,
  );
  const definition = await definitionOf(input.root);
  const stoppedCodes = stoppedExitCodes(platform.os);
  const serviceState = () => readServiceState(executeService, definition, stoppedCodes);
  if ((await serviceState()) === "running") {
    await assertControlAnswers(input.root, installation.record.controlPort);
    input.output.line(ALREADY_RUNNING);
    return;
  }
  await moveOffOccupiedPort(input, { roots, platform }, serviceState);
  verbose(`registering and starting ${definition.label} from ${definition.path}`);
  const started = await startNativeServiceDefinition(definition, {
    execute: command => command === definition.status ? serviceState().then(state => state === "running" ? 0 : stoppedCodes[0]!) : executeService(command),
    write: writeSecretFile,
  }).catch((error: unknown) => startFailed(input.root, startFailureDetail(error, platform.os), error));
  if (started === "already_running") {
    input.output.line(ALREADY_RUNNING);
    return;
  }
  await watchStartedService(input.root, platform.os, serviceState, deps);
  await clearServiceStartFailure(input.root).catch(() => undefined);
  if (definition.requiresLinger) input.output.line("This Linux user service needs user lingering to remain available after logout. Configure it explicitly if required.");
  // Starting the process is not the same as being open for work: the service
  // finishes unpacking and opens its control port about a minute later. Saying
  // only "started" invited a second and third `start` against a service that
  // was already coming up.
  input.output.line("Konteks is starting on this computer and is ready for work within a minute; konteks-remote status shows how it is doing.");
}

async function moveOffOccupiedPort(input: NativeCommandContext, release: { roots: readonly EmbeddedReleaseRoot[]; platform: ReturnType<typeof nativePlatform> }, serviceState: () => Promise<"running" | "stopped">): Promise<void> {
  const moved = await reassignOccupiedNativeControlPort({
    root: input.root,
    ...release,
    serviceStopped: async () => (await serviceState()) === "stopped",
  });
  if (moved) input.output.line(`Another program uses port ${moved.previousPort}, so Konteks uses port ${moved.controlPort} on this computer instead.`);
}

function startDefaults(deps: { roots?: readonly EmbeddedReleaseRoot[]; platform?: ReturnType<typeof nativePlatform>; definition?: (root: string) => Promise<NativeServiceDefinition>; execute?: NativeServiceExecute }) {
  return {
    platform: deps.platform ?? nativePlatform(),
    roots: deps.roots ?? EMBEDDED_RELEASE_ROOTS,
    executeService: deps.execute ?? executeDetailed,
    definitionOf: deps.definition ?? serviceDefinition,
  };
}

const ALREADY_RUNNING = "Konteks is already running on this computer; konteks-remote status shows how it is doing.";

/** Running or stopped as the service manager says; anything else cannot prove this root is safe to rewrite. */
async function readServiceState(executeService: NativeServiceExecute, definition: NativeServiceDefinition, stoppedCodes: readonly number[]): Promise<"running" | "stopped"> {
  let code: number | null;
  try { code = serviceRun(await executeService(definition.status)).code; }
  catch { code = null; }
  const stopped = code !== null && stoppedCodes.includes(code);
  verbose(`service state: ${code === 0 ? "running" : stopped ? "stopped" : `unknown (status exited ${code ?? "without a code"})`}`);
  if (code === 0) return "running";
  if (stopped) return "stopped";
  throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation is stopped. Inspect and stop only this installation's service before retrying start; identity and local work are unchanged.");
}

/** A registered or starting service whose control socket does not answer holds the port; stopping it is the person's step. */
async function assertControlAnswers(root: string, controlPort: number): Promise<void> {
  try {
    await new SupervisorControl({ supervisorData: join(root, "supervisor") }, controlPort).call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 2_000 });
  } catch {
    throw new RemoteInstanceError(
      "temporarily_unavailable",
      `This installation's service is registered or starting, but its control socket on port ${controlPort} is unavailable. Stop only this installation's service, then run start again to repair an occupied port; identity and local work are preserved.`,
    );
  }
}

/** Which step failed, in the service manager's own words, with the one next step. */
function startFailureDetail(error: unknown, os: HostOs): string {
  if (error instanceof RemoteInstanceError) return `${error.message}`;
  if (error instanceof NativeServiceCommandError) return describeServiceFailure(os, error);
  return `${error instanceof Error ? error.message : String(error)}. To see every step, run konteks-remote --verbose start.`;
}

/** A failed start is kept for doctor and support, never just "could not start". */
async function startFailed(root: string, detail: string, cause: unknown): Promise<never> {
  const message = `The native user service could not start: ${detail} Installed identity and credentials were preserved.`;
  await recordServiceStartFailure(root, { at: new Date().toISOString(), message }).catch(() => undefined);
  throw new RemoteInstanceError("temporarily_unavailable", message, { cause });
}

/**
 * Where the service manager can say whether the service still runs, a
 * connector that stopped as it started is said now, with its log, not left
 * for the person to find with `status`. launchd's `print` says only that a
 * job is loaded, and KeepAlive restarts it anyway.
 */
async function watchStartedService(root: string, os: HostOs, serviceState: () => Promise<"running" | "stopped">, deps: { settleMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  const settleMs = deps.settleMs ?? (os === "macos" ? null : 3_000);
  if (settleMs === null) return;
  await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(settleMs);
  const state = await serviceState().catch(() => "running" as const);
  if (state !== "stopped") return;
  const tail = await connectorLogTail(root, 3).catch(() => null);
  await startFailed(root, `it started and stopped again at once.${tail?.length ? ` The connector log ends: ${tail.join(" | ")}` : ""} The whole log: ${connectorLogFile(root)}.`, null);
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
  /** A fetched agent's consent line answered. */
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
  /** Claude Code or Codex found here, or set up now on the person's yes, before anything is stopped. */
  ensurePersonal?: typeof ensurePersonalAgent;
  /** After the restart: sign the agent in and say whether it is ready. */
  closeAgents?: (input: Parameters<typeof closeAgentSetup>[0]) => Promise<void>;
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
  const listed = previous.agents.includes(input.agent as NativeRuntimeRecord["agents"][number]);
  if (await alreadyInstalled(input.root, previous, host, listed)) {
    input.output.line(`${findAgentBridge(input.agent)?.displayName ?? input.agent} is already installed; no restart is needed.`);
    return;
  }
  const setUp = await prepareAgent(input, deps, host, listed);
  const cycle = new ServiceCycle(deps, await deps.serviceDefinition(input.root));
  const wasRunning = await cycle.running("The service manager cannot confirm this installation's service state. Inspect only this installation's service before adding an agent; identity and local work are unchanged.");
  const foreground = !wasRunning && await runsInTerminal(deps, input.root, previous);
  cycle.resetStopDeadline();
  if (wasRunning || foreground) await stopForAgentAdd(input, deps, cycle, previous, foreground);
  await new AgentAddition(input, deps, cycle, previous, { wasRunning, foreground, setUp }).run();
}

/**
 * A connector the service manager does not run (`konteks-remote serve` in a
 * terminal) still owns this folder. Waiting for it to let go only timed out
 * after 90 s with "Another connector owns this native data directory": ask
 * it to stop, the way a signal would, once its work is done.
 */
function runsInTerminal(deps: NativeAgentAddDeps, root: string, previous: NativeRuntimeRecord): Promise<boolean> {
  return deps.control(root, previous).call({ op: "drain.status" }, DrainStatusSchema, { timeoutMs: 2_000 }).then(() => true, () => false);
}

/** A listed fetched agent is fetched again only when its recorded copy no longer verifies. */
async function alreadyInstalled(root: string, previous: NativeRuntimeRecord, host: HostAgentInstallAdapter | undefined, listed: boolean): Promise<boolean> {
  if (!listed) return false;
  if (host?.fetch === undefined) return true;
  return host.runnerSettings(previous, { root }).then(() => true, () => false);
}

/**
 * Everything that can be refused before anything stops: a fetched agent
 * asked about and downloaded, a host agent's own install found and its
 * version checked, Claude Code or Codex offered and set up. Whether the
 * agent was set up now.
 */
async function prepareAgent(input: NativeCommandContext & { agent: string; yes?: boolean }, deps: NativeAgentAddDeps, host: HostAgentInstallAdapter | undefined, listed: boolean): Promise<boolean> {
  if (host) await fetchOrLocate(input, deps, host);
  if (listed || !isPersonalAgent(input.agent)) return false;
  return await (deps.ensurePersonal ?? ensurePersonalAgent)(input.agent, input.output) === "set_up";
}

/** A fetched agent asked about and downloaded; a host agent's own install found and its version checked. */
async function fetchOrLocate(input: NativeCommandContext & { yes?: boolean }, deps: NativeAgentAddDeps, host: HostAgentInstallAdapter): Promise<void> {
  if (host.fetch === undefined) {
    if (deps.locate) await deps.locate(host, input.root);
    return;
  }
  const consent = deps.consent ?? terminalFetchConsent({ ...(input.yes === undefined ? {} : { yes: input.yes }), line: text => input.output.line(text) });
  await (deps.fetchAgent ?? fetchHostAgent)(host, input.root, consent, input.output);
}

async function stopForAgentAdd(input: NativeCommandContext & { agent: string }, deps: NativeAgentAddDeps, cycle: ServiceCycle, previous: NativeRuntimeRecord, foreground: boolean): Promise<void> {
  const control = deps.control(input.root, previous);
  await cycle.drain(control, input.output, {
    waiting: count => `waiting for ${count} active assignment(s) before installing ${input.agent}…`,
    timedOut: "Agent installation waited 15 minutes for active work; the runtime remains running and drained so it can be inspected safely.",
  });
  if (!foreground) {
    await cycle.stop("The native runtime drained but could not stop; its installation was not changed.", "The native runtime did not finish stopping; its installed agents were not changed.");
    return;
  }
  await control.call({ op: "shutdown" }, z.unknown());
  input.output.line("Konteks is running in a terminal here, not as its background service; stopping it there to add the agent…");
  cycle.resetStopDeadline();
}

/** The record change of `agent add`, and its rollback to the previous record when anything after it fails. */
class AgentAddition {
  private successor: NativeRuntimeRecord | undefined;
  private ownershipUnsettled = false;
  private saidWaiting = false;

  constructor(
    private readonly input: NativeCommandContext & { agent: string },
    private readonly deps: NativeAgentAddDeps,
    private readonly cycle: ServiceCycle,
    private readonly previous: NativeRuntimeRecord,
    private readonly state: { wasRunning: boolean; foreground: boolean; setUp: boolean },
  ) {}

  /** Applies the change; anything that fails after it rolls the record back and is rethrown. */
  async run(): Promise<void> {
    try {
      await this.apply();
    } catch (error) {
      await this.rollBack();
      throw error;
    }
  }

  private async apply(): Promise<void> {
    const { input, deps, state } = this;
    const successor = await this.addRecord();
    this.successor = successor;
    if (state.wasRunning) await deps.start(input);
    if (state.wasRunning && isPersonalAgent(input.agent)) await this.closeSetup();
    // Its terminal is not this one, so it is not started again here.
    if (state.foreground) input.output.line(`${findAgentBridge(input.agent)?.displayName ?? input.agent} is added. Konteks stopped to add it; konteks-remote start starts it again, in the background.`);
    input.output.result({ instanceId: successor.instanceId, agents: successor.agents, state: "installed" });
  }

  /** The stopped connector may still hold its private data for a moment: retried until the stop deadline. */
  private async addRecord(): Promise<NativeRuntimeRecord> {
    const { input, deps } = this;
    const successor = await this.cycle.whileOwned(() => deps.add({ root: input.root, agentId: input.agent as NativeRuntimeRecord["agents"][number], output: input.output }), {
      owned: () => { this.ownershipUnsettled = true; },
      beforeWait: () => this.sayWaiting(),
      afterWait: () => this.assertStillStopped(),
    });
    this.ownershipUnsettled = false;
    return successor;
  }

  private sayWaiting(): void {
    if (this.saidWaiting) return;
    this.input.output.line("Waiting for the stopped connector to release its private data before adding the agent…");
    this.saidWaiting = true;
  }

  private async assertStillStopped(): Promise<void> {
    if (this.state.wasRunning && !await this.cycle.stopped()) throw new RemoteInstanceError("temporarily_unavailable", "This connector started again before agent installation; stop only this installation's service and retry.");
  }

  private async closeSetup(): Promise<void> {
    const { input, deps } = this;
    const close = deps.closeAgents ?? (closing => closeAgentSetup(closing, productionAgentClosingDeps(input.root, input.output, agent => nativeCliActions.control({ ...input, operation: "auth.login", agent }))));
    await close({ agents: [input.agent], signInNow: this.state.setUp ? [input.agent] : [], missing: [], output: input.output });
  }

  private async rollBack(): Promise<void> {
    if (this.successor) await this.restorePrevious(this.successor);
    if (this.state.wasRunning && !this.ownershipUnsettled) await this.deps.start(this.input).catch(() => undefined);
    if (this.state.foreground) this.input.output.line("Konteks stopped to add the agent and stays stopped; konteks-remote start starts it again, in the background.");
  }

  private async restorePrevious(successor: NativeRuntimeRecord): Promise<void> {
    try {
      if (this.state.wasRunning) await this.stopNewService();
      await this.cycle.whileOwned(() => this.deps.restore(this.input.root, successor.releaseId, this.previous));
    } catch (rollbackError) {
      throw new RemoteInstanceError("temporarily_unavailable", "Agent installation failed and automatic rollback could not restore the previous record; identity and local work were preserved.", { cause: rollbackError });
    }
  }

  private async stopNewService(): Promise<void> {
    const { cycle, deps } = this;
    const code = await deps.execute(cycle.definition.status);
    if (code === 0 && await deps.execute(cycle.definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", "The new service could not be stopped before agent rollback.");
    if (code !== 0 && !cycle.stoppedCode(code)) throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm the new service stopped before agent rollback.");
    await cycle.awaitStopped("The new service did not finish stopping before agent rollback.");
  }
}

const DrainStatusSchema = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();

type ServiceCycleDeps = Pick<NativeAgentRemoveDeps, "execute" | "sleep" | "now" | "platform" | "stopDeadlineMs" | "pollMs">;

/** True for the refusal a connector still holding the native data directory answers with. */
/** The installation's service around a change to its record: drained and stopped first, the change retried while it lets go. */
class ServiceCycle {
  private readonly stoppedCodes: readonly number[];
  private stopDeadline: number;

  constructor(private readonly deps: ServiceCycleDeps, readonly definition: NativeServiceDefinition) {
    this.stoppedCodes = stoppedExitCodes(deps.platform.os);
    this.stopDeadline = this.freshStopDeadline();
  }

  private freshStopDeadline(): number {
    return this.deps.now() + (this.deps.stopDeadlineMs ?? 90_000);
  }

  resetStopDeadline(): void {
    this.stopDeadline = this.freshStopDeadline();
  }

  stoppedCode(code: number | null): boolean {
    return code !== null && this.stoppedCodes.includes(code);
  }

  /** Whether the service runs; a state the service manager cannot confirm refuses with `refusal`. */
  async running(refusal: string): Promise<boolean> {
    const status = await this.deps.execute(this.definition.status);
    if (status !== 0 && !this.stoppedCode(status)) throw new RemoteInstanceError("temporarily_unavailable", refusal);
    return status === 0;
  }

  async stopped(): Promise<boolean> {
    const code = await this.deps.execute(this.definition.status);
    if (code === 0) return false;
    if (this.stoppedCode(code)) return true;
    throw new RemoteInstanceError("temporarily_unavailable", "The service manager cannot confirm this installation stopped; its identity and local work are unchanged.");
  }

  wait(): Promise<void> {
    return this.deps.sleep(Math.min(this.deps.pollMs ?? 1_000, 1_000));
  }

  /** Drains the connector and waits up to 15 minutes for its active work to finish. */
  async drain(control: Pick<SupervisorControl, "call">, output: { line(text: string): void }, words: { waiting: (count: number) => string; timedOut: string }): Promise<void> {
    await control.call({ op: "drain", reason: "update" }, z.unknown());
    const drainDeadline = this.deps.now() + 15 * 60_000;
    for (;;) {
      const state = await control.call({ op: "drain.status" }, DrainStatusSchema);
      if (state.activeAssignments === 0) return;
      if (this.deps.now() >= drainDeadline) throw new RemoteInstanceError("active_work", words.timedOut);
      output.line(words.waiting(state.activeAssignments));
      await this.deps.sleep(this.deps.pollMs ?? 5_000);
    }
  }

  async stop(couldNotStop: string, didNotFinish: string): Promise<void> {
    if (await this.deps.execute(this.definition.stop) !== 0) throw new RemoteInstanceError("temporarily_unavailable", couldNotStop);
    await this.awaitStopped(didNotFinish);
  }

  async awaitStopped(didNotFinish: string): Promise<void> {
    this.resetStopDeadline();
    while (!await this.stopped()) {
      if (this.deps.now() >= this.stopDeadline) throw new RemoteInstanceError("temporarily_unavailable", didNotFinish);
      await this.wait();
    }
  }

  /** Runs `operation` again while a stopping connector still owns the data directory, until the stop deadline. */
  async whileOwned<T>(operation: () => Promise<T>, hooks: { owned?: () => void; beforeWait?: () => void; afterWait?: () => Promise<void> } = {}): Promise<T> {
    const on = { owned: () => undefined, beforeWait: () => undefined, afterWait: async () => undefined, ...hooks };
    for (;;) {
      try { return await operation(); }
      catch (error) {
        if (!ownedByAnotherConnector(error)) throw error;
        on.owned();
        if (this.deps.now() >= this.stopDeadline) throw error;
        on.beforeWait();
        await this.wait();
        await on.afterWait();
      }
    }
  }
}

interface NativeAgentRemoveDeps {
  readRecord: (root: string) => Promise<NativeRuntimeRecord>;
  serviceDefinition: (root: string) => Promise<NativeServiceDefinition>;
  execute: (command: NativeServiceCommand) => Promise<number | null>;
  control: (root: string, record: NativeRuntimeRecord) => Pick<SupervisorControl, "call">;
  remove: typeof removeNativeAgent;
  start: (input: NativeCommandContext) => Promise<void>;
  /** The one question; `--yes` answers it up front. */
  confirm: (question: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  platform: ReturnType<typeof nativePlatform>;
  stopDeadlineMs?: number;
  pollMs?: number;
}

/**
 * `konteks-remote agent remove antigravity`: asks once, drains and
 * stops the service (its processes stop with it), signs out, drops it from
 * the record, deletes its downloads and its private home, and starts the
 * service again if it was running. Only a fetched agent is removed this way.
 */
export async function runNativeAgentRemove(input: NativeCommandContext & { agent: string; yes?: boolean }, deps: NativeAgentRemoveDeps): Promise<void> {
  const name = removableAgentName(input.agent);
  const previous = await deps.readRecord(input.root);
  if (!await removalConfirmed(input, deps, name, previous)) return;
  const cycle = new ServiceCycle(deps, await deps.serviceDefinition(input.root));
  const wasRunning = await cycle.running("The service manager cannot confirm this installation's service state. Inspect only this installation's service before removing an agent; identity and local work are unchanged.");
  cycle.resetStopDeadline();
  if (wasRunning) await stopForAgentRemove(input, deps.control(input.root, previous), cycle, name);
  let successor: NativeRuntimeRecord;
  try {
    successor = await cycle.whileOwned(() => deps.remove({ root: input.root, agentId: input.agent as NativeRuntimeRecord["agents"][number], output: input.output }));
  } catch (error) {
    if (wasRunning) await deps.start(input).catch(() => undefined);
    throw error;
  }
  if (wasRunning) await deps.start(input);
  input.output.result({ instanceId: successor.instanceId, agents: successor.agents, state: "removed" });
}

async function stopForAgentRemove(input: NativeCommandContext, control: Pick<SupervisorControl, "call">, cycle: ServiceCycle, name: string): Promise<void> {
  await cycle.drain(control, input.output, {
    waiting: count => `waiting for ${count} active assignment(s) before removing ${name}…`,
    timedOut: "Removing the agent waited 15 minutes for active work; the runtime remains running and drained so it can be inspected safely.",
  });
  await cycle.stop("The native runtime drained but could not stop; nothing was removed.", "The native runtime did not finish stopping; nothing was removed.");
}

/** Only a fetched agent can be removed on its own; its display name. */
function removableAgentName(agent: string): string {
  const name = findAgentBridge(agent)?.displayName ?? agent;
  if (hostAgentInstallAdapter(agent)?.fetch === undefined) {
    throw new RemoteInstanceError("agent_unavailable", `${name} cannot be removed on its own. Only Google Antigravity, which Konteks downloads, can: konteks-remote agent remove antigravity. To remove Konteks from this computer: konteks-remote uninstall`);
  }
  return name;
}

/** The one question, answered up front by `--yes`; a no removes nothing. */
async function removalConfirmed(input: NativeCommandContext & { agent: string; yes?: boolean }, deps: NativeAgentRemoveDeps, name: string, previous: NativeRuntimeRecord): Promise<boolean> {
  const question = `Remove ${name} from this computer? Konteks signs it out, deletes its download and its sign-ins here, and restarts the connector if it is running.`;
  if (input.yes === true) {
    input.output.line(`${question} Answered yes with --yes.`);
    return true;
  }
  if (await deps.confirm(question)) return true;
  const listed = previous.agents.includes(input.agent as NativeRuntimeRecord["agents"][number]);
  input.output.line(`Nothing was removed; ${name} is ${listed ? "still added" : "not added"} here.`);
  return false;
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
      // Workspace to have one in yet. It verifies
      // and records the release, and unpacks the agent packages in the
      // background so the person's first question does not wait on them;
      // `onboard` waits for the unpacking where it is needed.
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
      // The install starts onboarding itself: the agent that
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
    // Without --agents, a missing Claude Code or Codex is offered before the code is asked.
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
    // Whichever launcher drove the update, the person's konteks-remote runs this release's code from now on.
    void keepLauncherCurrent(input.root, { execPath: process.execPath, readRecord: readNativeRecord, readLedger: readNativeUpdateLedger,
      refresh: refreshInstalledLauncher, sleep: ms => new Promise(resolve => setTimeout(resolve, ms).unref()), now: Date.now })
      .then(result => { if (result === "refreshed") process.stderr.write("konteks-remote now runs this release\n"); })
      .catch(error => process.stderr.write(`konteks-remote could not be refreshed to this release: ${error instanceof Error ? error.message : String(error)}\n`));
    await service.waitUntilStopped();
  },
  start: startNativeConnector,
  update: async input => {
    if (input.check) return reportUpdateCheck(input);
    if (!input.unattended && await notAcceptedByKonteks(input)) return;
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
        running: () => serviceRunning(input.root),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        now: Date.now,
      });
    }
    await CONTROL_OPERATIONS[input.operation](context, input);
  },
};
