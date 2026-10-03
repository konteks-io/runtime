import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeExecutableIdentity, claudeExecutableCapability, parseClaudeVersion } from "../native/claude-executable-identity.js";
import { NativeInventoryCollector } from "../native/inventory.js";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("the personal Claude executable's identity (S0-5)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function executable(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "claude-identity-")); dirs.push(dir);
    const path = join(dir, "claude");
    writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`); chmodSync(path, 0o755);
    return path;
  }

  it("reads the version Claude Code prints and nothing else", () => {
    expect(parseClaudeVersion("2.1.259 (Claude Code)\n")).toBe("2.1.259");
    expect(parseClaudeVersion("2.2.0-beta.1 (Claude Code)")).toBe("2.2.0-beta.1");
    expect(parseClaudeVersion("claude: command failed")).toBeNull();
    expect(parseClaudeVersion(`${"9".repeat(40)} (Claude Code)`)).toBeNull();
  });

  it("is one advertised capability binding the version and the digest, within the wire's 128 characters", () => {
    const capability = claudeExecutableCapability("2.1.259", "a".repeat(64));
    expect(capability).toBe(`claude-code-executable:2.1.259:sha256:${"a".repeat(64)}`);
    expect(claudeExecutableCapability("2.1.259-very.long.prerelease.tag", "a".repeat(64))!.length).toBeLessThanOrEqual(128);
    expect(claudeExecutableCapability("2.1.259", "not-a-digest")).toBeNull();
  });

  it("reports the executable a personal profile runs, and a new one the moment it changes", async () => {
    const path = executable("2.1.259");
    const identity = new ClaudeExecutableIdentity(path);
    await expect(identity.capability()).resolves.toBe(`claude-code-executable:2.1.259:sha256:${sha(path)}`);
    writeFileSync(path, `#!/bin/sh\necho "2.1.270 (Claude Code)"\n# updated\n`);
    await expect(identity.capability()).resolves.toBe(`claude-code-executable:2.1.270:sha256:${sha(path)}`);
  });

  it("hashes and runs the executable again only when the file changed", async () => {
    const path = executable("2.1.259");
    const version = vi.fn(async () => "2.1.259 (Claude Code)");
    const identity = new ClaudeExecutableIdentity(path, { version });
    const first = await identity.capability();
    await expect(identity.capability()).resolves.toBe(first);
    expect(version).toHaveBeenCalledOnce();
  });

  it("reports nothing when the executable is gone or will not say its version", async () => {
    const path = executable("2.1.259");
    await expect(new ClaudeExecutableIdentity(path, { version: async () => "oops" }).capability()).resolves.toBeNull();
    rmSync(path);
    await expect(new ClaudeExecutableIdentity(path).capability()).resolves.toBeNull();
  });

  it("rides the agent_runner component's capabilities on every heartbeat", async () => {
    const agent = { agentId: "claude-code", displayName: "Claude Code", connectionState: "ready", authMode: "agent_local_subscription", accountScope: "personal", readiness: "ready", tokenUsageObservable: true,
      acpCapabilities: { sessionResume: false, forkSession: false, structuredOutputShim: true, toolControl: "approve" } } as const;
    const signals = { cpuRatio: 0.2, memoryRatio: 0.3, diskFreeBytes: 100, diskTotalBytes: 200, loadAverage1m: 0, cpuCount: 4, observedAt: "2026-10-01T00:00:00.000Z" };
    const capability = `claude-code-executable:2.1.259:sha256:${"b".repeat(64)}`;
    const inventory = new NativeInventoryCollector({ runners: new Map([["claude-code", { readiness: async () => ({ agent, utilization: { activeSessions: 0, activeTurns: 0 } }) }]]),
      sampler: { sample: async () => signals }, bundleVersion: "1.0.0", claudeExecutable: async () => capability });
    expect((await inventory.collect()).components[0]?.capabilities).toContain(capability);
    const failing = new NativeInventoryCollector({ runners: new Map([["claude-code", { readiness: async () => ({ agent, utilization: { activeSessions: 0, activeTurns: 0 } }) }]]),
      sampler: { sample: async () => signals }, bundleVersion: "1.0.0", claudeExecutable: async () => { throw new Error("probe failed"); } });
    expect((await failing.collect()).components[0]?.capabilities.some(value => value.startsWith("claude-code-executable:"))).toBe(false);
  });
});
