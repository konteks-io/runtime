import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_CANARIES, containsCanary } from "@konteks/remote-common";
import { buildSupportBundle } from "../support/bundle.js";
import { runDoctor } from "../support/doctor.js";
import { PreviewChannel } from "../preview/preview-channel.js";
import { LeaseState } from "../lease/lease.js";
import { FixedClock } from "@konteks/remote-common";
import type { TransportManager } from "../transport/relay-transport.js";
import type { OutboundMessage } from "../transport/transport.js";

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
      components: [{ kind: "harness", healthStatus: "healthy", version: "1" }],
      agents: [{ agentId: "codex", readiness: "not_configured" }],
      gateway: { healthy: true, capEnforcementStage: "observe", egressAllowlistRevision: "a1", rollupIncompleteSince: null },
      configRevision: 3,
      expectedAllowlistRevision: "a1",
      diskFreeBytes: 100 * 1024 ** 3,
      minimumDiskBytes: 30 * 1024 ** 3,
      preview: { enabled: true, port: 5173, grantPresent: false },
      outboxDepth: 0,
      recoveryRequired: 0,
      coreSignatureConfigured: true,
    });
    const agent = report.checks.find((check) => check.id === "agent-codex");
    expect(agent?.recoveryActions).toEqual([{ kind: "login_agent", agentId: "codex" }]);
    expect(report.checks.find((check) => check.id === "preview")?.status).toBe("warn");
    expect(JSON.stringify(report)).not.toContain(dir);
  });

  it("the support bundle carries config keys without values, is redacted, chunked, and secret-scanned", () => {
    const bundle = buildSupportBundle({
      bundleVersion: "1.0.0",
      protocolVersion: "1.0",
      instanceId: "inst",
      administrativeStatus: "active",
      doctor: { checks: [], generatedAt: "2026-09-06T00:00:00Z" },
      configurationKeys: ["heartbeatIntervalSeconds", "gateway.capEnforcementStage"],
      counters: { relay: { epochStale: 1 } },
      recentLogLines: [`token ${SECRET_CANARIES.openAiKey} seen`, "Bearer abcdefghijklmnop"],
      generatedAt: "2026-09-06T00:00:00Z",
    });
    expect(containsCanary(JSON.stringify(bundle.document))).toBe(false);
    expect(JSON.stringify(bundle.document)).not.toContain("abcdefghijklmnop");
    expect(bundle.chunks[0]).toMatchObject({ index: 0, total: 1, contentType: "application/json" });
  });
});

describe("preview channel policy on the supervisor", () => {
  it("refuses while disabled or under a drain_only lease, enforces policy, and re-checks response headers", () => {
    const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
    const lease = new LeaseState(clock);
    lease.set({ lease: "2026-09-06T00:00:00Z", mode: "active", expiresAt: "2026-09-07T00:00:00Z", drainDeadline: null, issuedAt: "2026-09-06T00:00:00Z", workspaceId: "w" });
    const sent: OutboundMessage[] = [];
    const forwarded: unknown[] = [];
    const transport = { send: (message: OutboundMessage) => void sent.push(message), openChannel: () => undefined, closeChannel: () => undefined } as unknown as TransportManager;
    const preview = new PreviewChannel({ transport, lease, sendToForwarder: (_channelId, chunk) => (forwarded.push(chunk), true), configureForwarder: () => undefined });
    preview.onToRuntime("preview:1", { streamId: "s", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(preview.counters.refusedDisabled).toBe(1);
    preview.enable(5173);
    preview.onToRuntime("preview:1", { streamId: "s", kind: "request", method: "GET", path: "http://evil/", headers: {}, final: true });
    expect(preview.counters.rejectedPaths).toBe(1);
    preview.onToRuntime("preview:1", { streamId: "s", kind: "request", method: "GET", path: "/", headers: { cookie: "x" }, final: true });
    expect(preview.counters.rejectedHeaders).toBe(1);
    preview.onToRuntime("preview:1", { streamId: "s", kind: "request", method: "GET", path: "/ok", headers: { accept: "*/*" }, final: true });
    expect(forwarded).toHaveLength(1);
    preview.onToCore("preview:1", { streamId: "s", kind: "response", status: 200, headers: { "content-type": "text/html", "set-cookie": "leak" } as never, final: true });
    expect((sent.at(-1)?.body as { headers: Record<string, string> }).headers).toEqual({ "content-type": "text/html" });
    lease.set({ lease: "2026-09-06T00:00:00Z", mode: "drain_only", expiresAt: "2026-09-07T00:00:00Z", drainDeadline: "2026-09-07T00:00:00Z", issuedAt: "2026-09-06T00:00:00Z", workspaceId: "w" });
    preview.onToRuntime("preview:2", { streamId: "s", kind: "request", method: "GET", path: "/", headers: {}, final: true });
    expect(preview.counters.refusedDisabled).toBe(2);
    expect(preview.exposure()).toMatchObject({ enabled: true, port: 5173, grantPresent: true });
  });
});
