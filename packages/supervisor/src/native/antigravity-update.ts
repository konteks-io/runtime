import { join } from "node:path";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import type { RunnerConfig } from "@konteks/remote-agent-runner";
import { antigravityPin, fetchNativeAntigravity, pruneNativeAntigravity, type AntigravityInstallDeps } from "./antigravity-installation.js";
import { nativeHostRunnerConfig, NativeRuntimeRecordSchema, readNativeRuntimeRecord, type NativeRuntimeRecord } from "./installation.js";
import { acquireNativeRootLock } from "./root-lock.js";

/**
 * Keeping Google Antigravity current (antigravity-runtime-support A17). The
 * pin travels with the runtime release, so after `konteks-remote update`
 * the new connector finds a record naming the old version (or, after a
 * rollback, a version whose folder a newer connector already pruned). The
 * person's first yes covers keeping it current (A20's consent text says so):
 * a record that lists Antigravity is that yes. So the connector fetches this
 * release's pin in the background, verifies it (A16), runs the start check
 * on it, and only then switches: the record names the new copy, new
 * sessions run it, and the other versions are removed. The old copy cannot
 * run under a release that no longer pins it, so no session is left on it
 * (the update restarted the service); a failed fetch or check keeps the old
 * folder, is tried again, and doctor says why.
 */

interface AntigravityUpdateDeps extends AntigravityInstallDeps {
  /** The start check on the new copy before switching (`antigravityInstallAdapter.selfCheck`). */
  selfCheck: (config: RunnerConfig) => Promise<void>;
  /** Log a record the connector could not write now (kept in memory, written on a later start). */
  onRecordDeferred?: (error: unknown) => void;
  /** The runner configuration of a record (default: the loader's, which re-verifies against this release's pin); tests replace it. */
  runnerConfig?: (root: string, record: NativeRuntimeRecord) => Promise<RunnerConfig>;
}

/** Whether a load's refusal is one the connector fixes itself: the pinned copy is missing or another version is recorded. */
export function antigravityUpdateNeeded(record: Pick<NativeRuntimeRecord, "agents">, error: unknown): boolean {
  if (!record.agents.includes("antigravity") || !(error instanceof RemoteInstanceError)) return false;
  return error.diagnostic === "antigravity_unsupported_version" || error.diagnostic === "antigravity_not_fetched";
}

/**
 * Fetch this release's pin on the person's first yes, check it, switch the
 * record to it, prune the other versions; the runner configuration of the
 * new copy.
 */
export async function updateNativeAntigravity(root: string, record: NativeRuntimeRecord, deps: AntigravityUpdateDeps): Promise<{ config: RunnerConfig; fetched: Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot"> }> {
  if (!record.agents.includes("antigravity")) throw new RemoteInstanceError("agent_unavailable", "Google Antigravity was not added on this computer; nothing was downloaded.");
  antigravityPin(deps);
  const fetched = await fetchNativeAntigravity({ root, consent: true }, deps);
  const switched = { ...record, ...fetched };
  const config = await (deps.runnerConfig ?? ((at, value) => nativeHostRunnerConfig(at, value, "antigravity")))(root, switched);
  await deps.selfCheck(config);
  await recordFetchedAntigravity(root, fetched).catch(error => deps.onRecordDeferred?.(error));
  await pruneNativeAntigravity(root, fetched.antigravityRoot!);
  return { config, fetched };
}

/**
 * Name the fetched copy in the runtime record, under the installer's lock
 * (never while `install`, `agent add`, `update` or `uninstall` holds it:
 * then it is refused and written on a later start). Only the two Antigravity
 * fields change, and only while the record still lists Antigravity.
 */
export async function recordFetchedAntigravity(root: string, fetched: Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot">): Promise<void> {
  const lock = acquireNativeRootLock(join(root, "installer"));
  try {
    const current = await readNativeRuntimeRecord(root);
    if (!current.agents.includes("antigravity")) return;
    if (current.antigravityVersion === fetched.antigravityVersion && current.antigravityRoot === fetched.antigravityRoot) return;
    const successor = NativeRuntimeRecordSchema.parse({ ...current, ...fetched });
    lock.assertOwned();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(successor));
  } finally {
    lock.release();
  }
}
