import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_CANARIES, containsCanary } from "@konteks/remote-common";
import { buildSupportBundle } from "../support/bundle.js";
import { runDoctor } from "../support/doctor.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-support-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("doctor and support bundle", () => {
  it("reports allowlisted checks with recovery actions and no paths or secrets", async () => {
    const report = await runDoctor({
      now: () => "2026-09-06T00:00:00Z",
      dataDir: dir,
      identity: { instanceId: "inst", administrativeStatus: "active" },
      lease: { mode: "active", expiresAt: "2026-09-06T01:00:00Z" },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 },
      transport: "relay",
      reconciliationComplete: true,
      components: [{ kind: "agent_runner", healthStatus: "healthy", version: "1" }],
      agents: [{ agentId: "codex", readiness: "not_configured" }],
      configRevision: 3,
      diskFreeBytes: 100 * 1024 ** 3,
      minimumDiskBytes: 30 * 1024 ** 3,
      outboxDepth: 0,
      recoveryRequired: 0,
      coreSignatureConfigured: true,
    });
    const agent = report.checks.find((check) => check.id === "agent-codex");
    expect(agent?.recoveryActions).toEqual([{ kind: "login_agent", agentId: "codex" }]);
    expect(report.checks.find((check) => check.id === "preview")).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(dir);
  });

  it("the support bundle carries config keys without values, is redacted, chunked, and secret-scanned", () => {
    const bundle = buildSupportBundle({
      bundleVersion: "1.0.0",
      protocolVersion: "1.0",
      instanceId: "inst",
      administrativeStatus: "active",
      doctor: { checks: [], generatedAt: "2026-09-06T00:00:00Z" },
      configurationKeys: ["heartbeatIntervalSeconds", "evidenceUpload"],
      counters: { relay: { epochStale: 1 } },
      recentLogLines: [`token ${SECRET_CANARIES.openAiKey} seen`, "Bearer abcdefghijklmnop"],
      generatedAt: "2026-09-06T00:00:00Z",
    });
    expect(containsCanary(JSON.stringify(bundle.document))).toBe(false);
    expect(JSON.stringify(bundle.document)).not.toContain("abcdefghijklmnop");
    expect(bundle.chunks[0]).toMatchObject({ index: 0, total: 1, contentType: "application/json" });
  });
});
