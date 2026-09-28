import { ConnectedAgentViewSchema, HostAgentDownloadSchema, RemoteInstanceError, type ConnectedAgentView, type HostAgentDownload } from "@konteks/remote-common";
import type { NativeRuntimeRecord } from "./installation.js";
import { antigravityFetchUnderWay, antigravityPin, verifyNativeAntigravityFolder, verifyNativeAntigravityRecord, type AntigravityInstallDeps } from "./antigravity-installation.js";

/**
 * What the site shows about Google Antigravity's download (antigravity CP3
 * prep: `hostAgentDownload` on the connected agent), from the connector's own
 * fetch state. The runtime keeps no state enum of its own, so this reads it
 * off the checks every start runs (A16):
 * - a fetch running in this process, or in the launcher's `agent add
 *   antigravity` (its staging download still growing) → `downloading`,
 *   bytes received of the pinned zip's size;
 * - the recorded copy verifies → `ready`;
 * - nothing recorded, or nothing fetched → `not_downloaded`, with the zip's
 *   size;
 * - the record names another version while this release's pin is already
 *   fetched and verifies (an update fetched, not switched to yet, A17) →
 *   `update_available` with the pin's version;
 * - the kept copy does not match Google's release, or is a version this
 *   release does not run → `integrity_failed`.
 * Undefined where Google publishes no copy for this computer. Never a path.
 */
export async function antigravityDownloadState(
  root: string,
  record: Pick<NativeRuntimeRecord, "antigravityVersion" | "antigravityRoot"> | undefined,
  deps: AntigravityInstallDeps = {},
): Promise<HostAgentDownload | undefined> {
  let pin: ReturnType<typeof antigravityPin>;
  try { pin = antigravityPin(deps); } catch { return undefined; }
  const sizeBytes = pin.platform.archive.size;
  const running = await antigravityFetchUnderWay(root, deps);
  if (running) return HostAgentDownloadSchema.parse({ state: "downloading", sizeBytes: running.sizeBytes, receivedBytes: Math.min(running.receivedBytes, running.sizeBytes) });
  try {
    await verifyNativeAntigravityRecord(record ?? {}, root, deps);
    return { state: "ready" };
  } catch (error) {
    const diagnostic = error instanceof RemoteInstanceError ? error.diagnostic : undefined;
    if (diagnostic === "antigravity_unsupported_version") {
      const fetched = await verifyNativeAntigravityFolder(root, deps).then(() => true, () => false);
      return fetched ? HostAgentDownloadSchema.parse({ state: "update_available", availableVersion: pin.version }) : { state: "integrity_failed" };
    }
    if (diagnostic === "antigravity_unsafe_install") return { state: "integrity_failed" };
    return { state: "not_downloaded", sizeBytes };
  }
}

/**
 * Google Antigravity's download state on the agents the connector reports:
 * on its connected agent when a runner of it reports one, otherwise as an
 * unavailable agent of its own (not downloaded, or its copy fails the start
 * checks), so the site can say what to do. Nothing else changes.
 */
export function withAntigravityDownload(agents: readonly ConnectedAgentView[], download: HostAgentDownload): ConnectedAgentView[] {
  const index = agents.findIndex(agent => agent.agentId === "antigravity");
  if (index >= 0) return agents.map((agent, at) => (at === index ? { ...agent, hostAgentDownload: download } : agent));
  return [...agents, ConnectedAgentViewSchema.parse({
    agentId: "antigravity", displayName: "Google Antigravity", connectionState: "unavailable", authMode: "agent_local_subscription",
    accountScope: "personal", readiness: "unavailable", tokenUsageObservable: false,
    acpCapabilities: { sessionResume: false, forkSession: false, structuredOutputShim: true, toolControl: "approve" },
    hostAgentDownload: download,
  })];
}
