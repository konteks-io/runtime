import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../support/doctor.js";
import { expectNoPath } from "./doctor-report.js";
import { WINDOWS_LAUNCHER_MARKER, windowsInstalledLauncher } from "../native/windows-launcher.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function programFiles(files: string[]) {
  const base = await mkdtemp(join(tmpdir(), "windows-launcher-")); roots.push(base);
  await mkdir(join(base, "konteks-remote"));
  for (const file of files) await writeFile(join(base, "konteks-remote", file), "x");
  return base;
}

describe("the Windows konteks-remote command the MSI installed", () => {
  it("is current when its installer put the marker next to it, older without, and absent when there is no MSI command", async () => {
    await expect(windowsInstalledLauncher({ ProgramFiles: await programFiles(["konteks-remote.exe", WINDOWS_LAUNCHER_MARKER]) })).resolves.toBe("current");
    await expect(windowsInstalledLauncher({ ProgramFiles: await programFiles(["konteks-remote.exe"]) })).resolves.toBe("older");
    await expect(windowsInstalledLauncher({ ProgramFiles: await programFiles([]) })).resolves.toBeNull();
    await expect(windowsInstalledLauncher({})).resolves.toBeNull();
  });

  it("doctor says once, without a path, that an older installer's command must be updated with -Update", async () => {
    const base = { now: () => "2026-10-02T00:00:00.000Z", dataDir: tmpdir(), identity: { instanceId: "i", administrativeStatus: "active" as const }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected" as const, lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [], configRevision: 1,
      diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true };
    const older = await runDoctor({ ...base, launcher: "older" });
    const line = older.checks.find(check => check.id === "launcher");
    expect(line).toMatchObject({ status: "warn", title: "konteks-remote command" });
    expect(line!.detail).toMatch(/older installer/);
    expect(line!.detail).toMatch(/-Update/);
    expectNoPath(older);
    for (const launcher of ["current", null, undefined] as const) {
      const report = await runDoctor({ ...base, ...(launcher !== undefined ? { launcher } : {}) });
      expect(report.checks.find(check => check.id === "launcher")).toBeUndefined();
    }
  });
});
