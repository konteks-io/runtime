import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { stopProcessGroupLeaderFirst, type PipedChildProcess } from "../process.js";
import { createLinuxExecutionSpawner } from "../linux-execution-process.js";

// OS primitive characterization, NOT a qualified agent/tool/MCP profile.
// Only generated test paths are writable; no user credentials are read.
const enabled = process.platform === "linux" && process.env.NATIVE_LINUX_CONTAINMENT_CHARACTERIZE === "1";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function size(path: string): Promise<number> {
  try { return (await readFile(path)).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}
async function until(check: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("owned namespace condition timed out"); await pause(25); }
}
function launch(root: string, name: string): PipedChildProcess {
  // The ticker deliberately creates another process session. Its independent
  // 8s deadline bounds it even if the lifecycle mechanism under test fails.
  return createLinuxExecutionSpawner({ executable: "/usr/bin/bwrap", writableRoots: [root] })({ command: "/usr/bin/sh", env: { PATH: "/usr/bin:/bin", LANG: "C" },
    args: ["-c",
      'setsid timeout 8 sh -c \'while :; do printf x >> "$1"; sleep 0.05; done\' ticker "$1" & wait',
      "owner", join(root, name)], detached: true });
}

it.skipIf(!enabled).each(["graceful", "owner-crash"])("%s stops a detached namespace writer without stopping its sibling owner", async mode => {
  const root = await mkdtemp(join(tmpdir(), "native-linux-owner-"));
  const children: PipedChildProcess[] = [];
  const startedAt = Date.now();
  try {
    const first = launch(root, "first"), sibling = launch(root, "sibling");
    children.push(first, sibling);
    for (const child of children) child.on("error", () => undefined);
    await until(async () => await size(join(root, "first")) >= 3 && await size(join(root, "sibling")) >= 3);
    if (mode === "owner-crash") {
      first.kill("SIGKILL"); // Exact child handle created above; never a PID scan.
      await until(async () => first.exitCode !== null || first.signalCode !== null);
    } else {
      await stopProcessGroupLeaderFirst({ child: first, timeoutMs: 500, killGraceMs: 500 });
    }
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
    const stoppedSize = await size(join(root, "first"));
    const siblingSize = await size(join(root, "sibling"));
    await until(async () => await size(join(root, "sibling")) >= siblingSize + 6);
    expect(await size(join(root, "first"))).toBe(stoppedSize);
    expect(sibling.exitCode).toBeNull();
    expect(sibling.signalCode).toBeNull();
  } finally {
    for (const child of children) await stopProcessGroupLeaderFirst({ child, timeoutMs: 500, killGraceMs: 500 });
    // Keep the test workspace until every fixture's independent maximum
    // lifetime has elapsed, including a failed lifecycle assertion.
    await pause(Math.max(0, 9_000 - (Date.now() - startedAt)));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
