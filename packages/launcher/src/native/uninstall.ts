import { rm, stat } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { RemoteInstanceError } from "@konteks/remote-common";
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
}

export interface UninstallResult {
  state: "uninstalled";
  /** Whether Konteks removed this runtime, or the person still has to in Settings. */
  runtime: "removed" | "already_removed" | "not_told" | "never_connected";
  root: string;
  repositoryPath?: string;
}

const DRAIN_LIMIT_MS = 15 * 60_000;
const POLL_MS = 5_000;

/**
 * Remove Konteks from this machine (W1-L2): let running work finish, have
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
  const root = resolve(input.root);
  if (root === parse(root).root || root === resolve(homedir())) throw new RemoteInstanceError("schema_invalid", "Refusing to remove a home or filesystem root as the Konteks folder.");
  if (!(await stat(root).then(() => true).catch(() => false))) {
    input.output.line("Konteks is not installed on this machine; there is nothing to remove.");
    return { state: "uninstalled", runtime: "never_connected", root };
  }
  const connected = deps.connected ? await deps.connected(root) : Boolean(await readNativeRecord(root).catch(() => null));
  const onboard = await readOnboardState(root).catch(() => null);
  const repositoryPath = onboard?.repositoryPath;

  let runtime: UninstallResult["runtime"] = connected ? "not_told" : "never_connected";
  const control = connected ? await deps.control() : null;
  if (control) {
    // Finish what is running before anything is revoked: a removal must never
    // cut an agent off mid-turn.
    await control.call({ op: "drain", reason: "remove" }, z.unknown());
    const drainStarted = deps.now();
    const drainUntil = drainStarted + DRAIN_LIMIT_MS;
    let lastSaid = -Infinity;
    for (;;) {
      const state = await control.call({ op: "drain.status" }, DrainStatusSchema);
      if (state.activeAssignments === 0) break;
      if (deps.now() >= drainUntil) {
        throw new RemoteInstanceError("active_work", "Konteks waited 15 minutes for work still running on this machine, so nothing was removed. The runtime is drained and takes no new work; try again once it finishes.");
      }
      // Say what the wait is for once, then a short line a minute — the same
      // line every five seconds read as if nothing were happening (pass 26).
      if (lastSaid === -Infinity) {
        input.output.line(`${state.activeAssignments === 1 ? "One piece of work is" : `${state.activeAssignments} pieces of work are`} still running on this machine (a planning session, for example). Konteks lets it finish before removing anything; this can take a few minutes, at most 15. No new work starts here meanwhile.`);
        lastSaid = deps.now();
      } else if (deps.now() - lastSaid >= 60_000) {
        input.output.line(`Still waiting for ${state.activeAssignments} running task(s) to finish (${Math.round((deps.now() - drainStarted) / 60_000)} min so far)…`);
        lastSaid = deps.now();
      }
      await deps.sleep(POLL_MS);
    }
    const retireUntil = deps.now() + DRAIN_LIMIT_MS;
    for (;;) {
      const retired = await control.call({ op: "instance.retire" }, RetireSchema).catch(() => null);
      if (!retired) break;
      if (retired.outcome !== "draining") {
        runtime = retired.outcome;
        break;
      }
      if (deps.now() >= retireUntil) break;
      await deps.sleep(POLL_MS);
    }
  }

  const service = await deps.serviceDefinition().catch(() => null);
  if (service) {
    // Stop and unregister; either may fail simply because it is not running
    // or was never registered, which is the state being asked for.
    await deps.execute(service.stop).catch(() => null);
    for (const command of service.remove) await deps.execute(command).catch(() => null);
    await rm(service.path, { force: true });
  }
  await rm(root, { recursive: true, force: true });

  const kept = repositoryPath ? ` Your repository at ${repositoryPath} and your coding agents' logins were not touched.` : " Your repositories and your coding agents' logins were not touched.";
  if (runtime === "removed" || runtime === "already_removed") {
    input.output.line(`Konteks is removed from this machine, and this machine's runtime is removed from your workspace.${kept}`);
  } else if (runtime === "not_told") {
    input.output.line(`Konteks is removed from this machine, but Konteks could not be told: remove this machine in Customize → Runtimes on the site so it stops counting as connected.${kept}`);
  } else {
    input.output.line(`Konteks is removed from this machine.${kept}`);
  }
  return { state: "uninstalled", runtime, root, ...(repositoryPath ? { repositoryPath } : {}) };
}

/** Production dependencies: the connector's own control socket and OS service. */
export function productionUninstallDeps(input: {
  root: string;
  serviceDefinition: (root: string) => Promise<NativeServiceDefinition>;
  execute: (command: NativeServiceCommand) => Promise<number | null>;
}): UninstallDeps {
  return {
    control: async () => {
      const record = await readNativeRecord(input.root).catch(() => null);
      if (!record) return null;
      const control = new SupervisorControl({ supervisorData: join(input.root, "supervisor") }, record.controlPort);
      const alive = await control.call({ op: "drain.status" }, DrainStatusSchema, { timeoutMs: 5_000 }).then(() => true).catch(() => false);
      return alive ? control : null;
    },
    serviceDefinition: () => input.serviceDefinition(input.root),
    execute: input.execute,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    now: () => Date.now(),
  };
}
