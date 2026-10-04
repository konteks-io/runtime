import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { RemoteInstanceError } from "@konteks/remote-common";
import { NATIVE_SHUTDOWN_RECEIPT_FILE } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { SupervisorControl } from "../control.js";
import { readNativeRecord } from "./install.js";
import { readOnboardState } from "./onboard-state.js";
import type { NativeServiceCommand, NativeServiceDefinition } from "./service.js";

const DrainStatusSchema = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
const RetireSchema = z.object({ outcome: z.enum(["removed", "draining", "already_removed"]), activeAssignments: z.number().int().min(0) }).passthrough();

export interface UninstallDeps {
  /** The running connector's control socket; null when nothing answers. */
  control(): Promise<Pick<SupervisorControl, "call"> | null>;
  serviceDefinition(): Promise<NativeServiceDefinition | null>;
  execute(command: NativeServiceCommand): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Whether this machine was ever connected; the install record by default. */
  connected?(root: string): Promise<boolean>;
  /** The connector's last shutdown receipt, if any. */
  receipt?(): Promise<string | null>;
  /** Whether the connector has finished shutting down since `before`: it no longer answers and wrote a new receipt. */
  shutDown?(before: string | null): Promise<boolean>;
}

interface UninstallResult {
  state: "uninstalled";
  /** Whether Konteks removed this runtime, or the person still has to in Settings. */
  runtime: "removed" | "already_removed" | "not_told" | "never_connected";
  root: string;
  repositoryPath?: string;
}

const DRAIN_LIMIT_MS = 15 * 60_000;
const POLL_MS = 5_000;
/** A connector closes its agents and writes its receipt within seconds of being stopped. */
const SHUTDOWN_WAIT_MS = 30_000;
const REMOVE_ATTEMPTS = 5;

/**
 * Remove Konteks from this machine: let running work finish, have
 * Konteks drain, revoke and tombstone this runtime, stop and unregister the
 * background service, then delete the connector's own folder — its program,
 * its identity and key, its logs. The person's repositories and their coding
 * agents' own logins live outside that folder and are never touched.
 *
 * Konteks is told first. If it cannot be told, the machine is still cleaned
 * up and the person is told the one thing left to do on the site, rather than
 * leaving a runtime that looks connected to a machine that is gone.
 */
export async function uninstallNative(input: { root: string; output: Output }, deps: UninstallDeps): Promise<UninstallResult> {
  const root = removableRoot(input.root);
  if (!(await exists(root))) {
    input.output.line("Konteks is not installed on this machine; there is nothing to remove.");
    return { state: "uninstalled", runtime: "never_connected", root };
  }
  const connected = await wasConnected(root, deps);
  const repositoryPath = (await readOnboardState(root).catch(() => null))?.repositoryPath;
  const control = connected ? await deps.control() : null;
  let runtime: UninstallResult["runtime"] = connected ? "not_told" : "never_connected";
  if (control) runtime = await retireThenRemoveService(control, deps, input.output) ?? runtime;
  else await removeService(deps);
  await removeFolder(root, deps);
  input.output.line(removedLine(runtime, repositoryPath));
  return { state: "uninstalled", runtime, root, ...(repositoryPath ? { repositoryPath } : {}) };
}

/**
 * Finish what is running before anything is revoked (a removal must never cut
 * an agent off mid-turn), have Konteks retire the runtime, remove the
 * service, and wait for the connector to let go of its folder. How Konteks
 * answered, or null when it could not be told.
 */
async function retireThenRemoveService(control: Pick<SupervisorControl, "call">, deps: UninstallDeps, output: Output): Promise<"removed" | "already_removed" | null> {
  const receiptBefore = deps.receipt ? await deps.receipt().catch(() => null) : null;
  await drainForRemoval(control, deps, output);
  const retired = await retireRuntime(control, deps);
  await removeService(deps);
  await waitForShutdown(deps, receiptBefore);
  return retired;
}

function removableRoot(raw: string): string {
  const root = resolve(raw);
  if (root === parse(root).root || root === resolve(homedir())) throw new RemoteInstanceError("schema_invalid", "Refusing to remove a home or filesystem root as the Konteks folder.");
  return root;
}

async function wasConnected(root: string, deps: UninstallDeps): Promise<boolean> {
  return deps.connected ? deps.connected(root) : Boolean(await readNativeRecord(root).catch(() => null));
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

/** Drains and waits up to 15 minutes for running work, saying what the wait is for. */
async function drainForRemoval(control: Pick<SupervisorControl, "call">, deps: UninstallDeps, output: Output): Promise<void> {
  await control.call({ op: "drain", reason: "remove" }, z.unknown());
  const progress = new DrainProgress(deps, output);
  for (;;) {
    const state = await control.call({ op: "drain.status" }, DrainStatusSchema);
    if (state.activeAssignments === 0) return;
    if (progress.overdue()) {
      throw new RemoteInstanceError("active_work", "Konteks waited 15 minutes for work still running on this machine, so nothing was removed. The runtime is drained and takes no new work; try again once it finishes.");
    }
    progress.say(state.activeAssignments);
    await deps.sleep(POLL_MS);
  }
}

/**
 * Says what the wait is for once, then a short line a minute: the same line
 * every five seconds read as if nothing were happening.
 */
class DrainProgress {
  private readonly started: number;
  private lastSaid = -Infinity;

  constructor(private readonly deps: Pick<UninstallDeps, "now">, private readonly output: Output) {
    this.started = deps.now();
  }

  overdue(): boolean {
    return this.deps.now() >= this.started + DRAIN_LIMIT_MS;
  }

  say(active: number): void {
    if (this.lastSaid === -Infinity) {
      this.output.line(`${active === 1 ? "One piece of work is" : `${active} pieces of work are`} still running on this machine (a planning session, for example). Konteks lets it finish before removing anything; this can take a few minutes, at most 15. No new work starts here meanwhile.`);
      this.lastSaid = this.deps.now();
    } else if (this.deps.now() - this.lastSaid >= 60_000) {
      this.output.line(`Still waiting for ${active} running task(s) to finish (${Math.round((this.deps.now() - this.started) / 60_000)} min so far)…`);
      this.lastSaid = this.deps.now();
    }
  }
}

/** Konteks revokes and tombstones this runtime; null when it could not be told. */
async function retireRuntime(control: Pick<SupervisorControl, "call">, deps: UninstallDeps): Promise<"removed" | "already_removed" | null> {
  const retireUntil = deps.now() + DRAIN_LIMIT_MS;
  for (;;) {
    const retired = await control.call({ op: "instance.retire" }, RetireSchema).catch(() => null);
    if (!retired) return null;
    if (retired.outcome !== "draining") return retired.outcome;
    if (deps.now() >= retireUntil) return null;
    await deps.sleep(POLL_MS);
  }
}

/**
 * Stop and unregister; either may fail simply because it is not running or
 * was never registered, which is the state being asked for.
 */
async function removeService(deps: UninstallDeps): Promise<void> {
  const service = await deps.serviceDefinition().catch(() => null);
  if (!service) return;
  await deps.execute(service.stop).catch(() => null);
  for (const command of service.remove) await deps.execute(command).catch(() => null);
  await rm(service.path, { force: true });
}

/**
 * A stopped or retired connector still closes its agents and writes its
 * receipt into this folder for a moment; deleting under it failed with
 * ENOTEMPTY and left a folder behind. Wait until it has let go.
 */
async function waitForShutdown(deps: UninstallDeps, receiptBefore: string | null): Promise<void> {
  if (!deps.shutDown) return;
  const until = deps.now() + SHUTDOWN_WAIT_MS;
  while (!(await deps.shutDown(receiptBefore).catch(() => false)) && deps.now() < until) await deps.sleep(500);
}

function removedLine(runtime: UninstallResult["runtime"], repositoryPath: string | undefined): string {
  const kept = repositoryPath ? ` Your repository at ${repositoryPath} and your coding agents' logins were not touched.` : " Your repositories and your coding agents' logins were not touched.";
  if (runtime === "removed" || runtime === "already_removed") return `Konteks is removed from this machine, and this machine's runtime is removed from your workspace.${kept}`;
  if (runtime === "not_told") return `Konteks is removed from this machine, but Konteks could not be told: remove this machine in Customize → Runtimes on the site so it stops counting as connected.${kept}`;
  return `Konteks is removed from this machine.${kept}`;
}

/**
 * Delete the connector's folder, its program last: a removal that stops
 * part way can then still be run again. A write that lands during the delete is retried.
 */
async function removeFolder(root: string, deps: Pick<UninstallDeps, "sleep">): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= REMOVE_ATTEMPTS;
    try {
      await deleteProgramLast(root);
    } catch (error) {
      if (last) throw new RemoteInstanceError("temporarily_unavailable", `Konteks is stopped on this machine, but its folder ${root} could not be deleted (${(error as Error).message}). Run konteks-remote uninstall again in a moment.`);
    }
    if (!(await exists(root))) return;
    if (last) throw new RemoteInstanceError("temporarily_unavailable", `Konteks is stopped on this machine, but something kept writing to its folder ${root}. Run konteks-remote uninstall again in a moment.`);
    await deps.sleep(1_000);
  }
}

async function deleteProgramLast(root: string): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const entry of entries.filter(name => name !== "bin")) await rm(join(root, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  await rm(join(root, "bin"), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** Production dependencies: the connector's own control socket and OS service. */
export function productionUninstallDeps(input: {
  root: string;
  serviceDefinition: (root: string) => Promise<NativeServiceDefinition>;
  execute: (command: NativeServiceCommand) => Promise<number | null>;
}): UninstallDeps {
  return {
    control: async () => {
      const control = await recordControl(input.root);
      return control && await answers(control, 5_000) ? control : null;
    },
    serviceDefinition: () => input.serviceDefinition(input.root),
    execute: input.execute,
    receipt: () => readReceipt(input.root),
    shutDown: async before => {
      const control = await recordControl(input.root);
      if (control && await answers(control, 1_000)) return false;
      const receipt = await readReceipt(input.root);
      return receipt !== null && receipt !== before;
    },
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    now: () => Date.now(),
  };
}

async function recordControl(root: string): Promise<SupervisorControl | null> {
  const record = await readNativeRecord(root).catch(() => null);
  return record ? new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort) : null;
}

function answers(control: SupervisorControl, timeoutMs: number): Promise<boolean> {
  return control.call({ op: "drain.status" }, DrainStatusSchema, { timeoutMs }).then(() => true).catch(() => false);
}

function readReceipt(root: string): Promise<string | null> {
  return readFile(join(root, "supervisor", NATIVE_SHUTDOWN_RECEIPT_FILE), "utf8").catch(() => null);
}
