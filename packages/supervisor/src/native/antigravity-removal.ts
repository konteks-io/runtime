import { rm } from "node:fs/promises";
import { join } from "node:path";
import { antigravityRunnerAdapter, sweepAntigravityProcesses, type HostSpawn } from "@konteks/remote-agent-runner";
import { removeNativeAntigravity } from "./antigravity-installation.js";
import { nativeHostRunnerConfig, type NativeRuntimeRecord } from "./installation.js";

/**
 * Removing Google Antigravity (antigravity-runtime-support A18), the parts
 * that are not the install record: `konteks-remote agent remove antigravity`
 * stops the service, signs out here, drops Antigravity from the record, then
 * deletes the files. Uninstalling the connector deletes both folders with the
 * rest of it.
 */

/**
 * Sign out on a process of the connector's own, before anything is deleted:
 * Gemini Enterprise through ACP `logout` (when the server offers it), the
 * key forgotten, the token files removed whatever the server did. Needs the
 * fetched copy to verify; a copy that is gone or does not verify cannot run,
 * so its sign-ins go with the folder below. Then any process still carrying
 * the private home is stopped. True when the sign-out ran.
 */
export async function signOutNativeAntigravity(root: string, record: NativeRuntimeRecord, deps: { spawn?: HostSpawn } = {}): Promise<boolean> {
  const credentials = join(root, "credentials", "antigravity");
  let signedOut = false;
  try {
    const config = await nativeHostRunnerConfig(root, record, "antigravity");
    await antigravityRunnerAdapter.logout!(config, undefined, deps.spawn);
    signedOut = true;
  } catch {
    // Not fetched or not verifying: nothing may run; its files are deleted next.
  }
  await sweepAntigravityProcesses(credentials).catch(() => 0);
  return signedOut;
}

/** Every downloaded version, the private home with its sign-ins, and its workspace folder. */
export async function deleteNativeAntigravity(root: string): Promise<void> {
  await removeNativeAntigravity(root);
  await rm(join(root, "credentials", "antigravity"), { recursive: true, force: true });
  await rm(join(root, "workspaces", "antigravity"), { recursive: true, force: true });
}
