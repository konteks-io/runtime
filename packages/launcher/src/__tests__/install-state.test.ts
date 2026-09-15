import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallStateFile, advance, initialInstallState, phaseReached, resumePhase } from "../install-state.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-install-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const agents = [{ agentId: "codex", authMode: "agent_local_subscription" as const }];

describe("install state", () => {
  it("advances forward only and records the agent set", () => {
    const initial = initialInstallState("act-1", "2026-09-06T00:00:00Z", agents);
    const exchanged = advance(initial, "exchanged", "t1", { instanceId: "inst-1" });
    expect(exchanged.phase).toBe("exchanged");
    expect(exchanged.instanceId).toBe("inst-1");
    expect(exchanged.agents).toEqual(agents);
    // A backwards move is a no-op.
    expect(advance(exchanged, "preflight", "t2")).toBe(exchanged);
    expect(phaseReached(exchanged, "exchanged")).toBe(true);
    expect(phaseReached(exchanged, "pulled")).toBe(false);
  });

  it("keeps durable facts on failure and resumes after the exchange", () => {
    const initial = initialInstallState("act-1", "t0", agents);
    const exchanged = advance(initial, "exchanged", "t1", { instanceId: "inst-1", manifestDigest: "d" });
    const failed = advance(exchanged, "failed", "t2", { lastError: "pull failed" });
    expect(failed.phase).toBe("failed");
    expect(failed.instanceId).toBe("inst-1");
    expect(failed.lastError).toBe("pull failed");
    expect(phaseReached(failed, "exchanged")).toBe(false);
    expect(resumePhase(failed)).toBe("verified");
    expect(resumePhase(advance(initial, "failed", "t3", { lastError: "preflight" }))).toBe("preflight");
  });

  it("persists 0600 and round-trips strictly", async () => {
    const file = new InstallStateFile(join(dir, "install-state.json"));
    expect(await file.read()).toBeNull();
    const state = advance(initialInstallState("act-1", "t0", agents), "exchanged", "t1", { instanceId: "inst-1" });
    await file.write(state);
    expect(await file.read()).toEqual(state);
    if (process.platform !== "win32") expect((await stat(join(dir, "install-state.json"))).mode & 0o777).toBe(0o600);
    const text = await readFile(join(dir, "install-state.json"), "utf8");
    expect(text).not.toContain("activationCode");
  });
});
