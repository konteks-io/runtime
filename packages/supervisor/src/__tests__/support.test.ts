import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_CANARIES, containsCanary } from "@konteks/remote-common";
import { buildSupportBundle } from "../support/bundle.js";
import { assertDoctorHasNoSecrets, runDoctor } from "../support/doctor.js";

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

  it("reports whether previews are offered and when the last one failed, without paths or commands", async () => {
    const base = {
      now: () => "2026-09-06T00:00:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    };
    const healthy = await runDoctor({ ...base, preview: { advertised: true, running: 1, lastFailureAt: null } });
    expect(healthy.checks.find(check => check.id === "preview")).toMatchObject({ status: "pass", detail: "preview capability advertised; 1 preview(s) running" });
    const failed = await runDoctor({ ...base, preview: { advertised: true, running: 0, lastFailureAt: "2026-09-06T00:00:00.000Z" } });
    expect(failed.checks.find(check => check.id === "preview")).toMatchObject({ status: "warn", detail: expect.stringContaining("the last preview failed to start") });
    expect(assertDoctorHasNoSecrets(failed)).toBeUndefined();
    const offline = await runDoctor({ ...base, preview: { advertised: false, running: 0, lastFailureAt: null } });
    expect(offline.checks.find(check => check.id === "preview")?.status).toBe("warn");
  });

  it("reports the QA browser's version, the agents that carry it, and Chrome or Playwright's Chromium", async () => {
    const base = {
      now: () => "2026-09-06T00:00:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    };
    const chrome = await runDoctor({ ...base, browser: { version: "0.0.82", agents: ["claude-code", "codex"], chrome: true } });
    expect(chrome.checks.find(check => check.id === "browser")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^Playwright MCP 0\.0\.82 for claude-code, codex; uses the installed Google Chrome/) });
    const chromium = await runDoctor({ ...base, browser: { version: "0.0.82", agents: ["codex"], chrome: false } });
    expect(chromium.checks.find(check => check.id === "browser")?.detail).toContain("Playwright's Chromium is installed on first use");
    const none = await runDoctor({ ...base, browser: { version: null, agents: [], chrome: true } });
    expect(none.checks.find(check => check.id === "browser")?.status).toBe("warn");
    expect(assertDoctorHasNoSecrets(chrome)).toBeUndefined();
  });

  it("reports the person's own OpenCode: version, install, settings check, sign-ins by label, free models, browser, or why it is left out (opencode CP6)", async () => {
    const base = {
      now: () => "2026-09-06T00:00:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    };
    const running = { state: "running" as const, version: "2.0.18", installKind: "homepage installer", selfCheck: "passed" as const, freeModels: false, browser: true };
    const signedIn = await runDoctor({ ...base, openCode: { ...running, credentials: [{ label: "OpenCode Console account", state: "ready" }, { label: "OpenAI key", state: "needs_sign_in" }] } });
    expect(signedIn.checks.find(check => check.id === "opencode")).toMatchObject({ status: "pass", recoveryActions: [],
      detail: "OpenCode 2.0.18, installed with OpenCode's homepage installer; Konteks settings check passed; signed in with OpenCode Console account, OpenAI key (needs sign-in); OpenCode Zen free models off; its sessions get the QA browser" });
    expect(assertDoctorHasNoSecrets(signedIn)).toBeUndefined();
    // Nothing signed in, but Core's free-models switch on: it runs on Zen's free models.
    const free = await runDoctor({ ...base, openCode: { ...running, installKind: "another location", credentials: [], freeModels: true, browser: false } });
    expect(free.checks.find(check => check.id === "opencode")).toMatchObject({ status: "pass",
      detail: "OpenCode 2.0.18, installed in a custom location; Konteks settings check passed; not signed in to any provider (konteks-remote auth login opencode); OpenCode Zen free models on; no QA browser for its sessions" });
    for (const [failure, words] of [
      ["opencode_not_found", "no longer installed where this computer found it"],
      ["opencode_unsupported_version", "a version Konteks does not support"],
      ["opencode_unsafe_install", "can be changed by other users"],
      ["opencode_unsupported_installation", "does not keep the Konteks settings"],
      ["opencode_self_check_failed", "settings check could not run"],
      [undefined, "the connector log says why"],
    ] as const) {
      const left = await runDoctor({ ...base, openCode: { ...running, state: "retrying", selfCheck: "failed", failure, credentials: [] } });
      const check = left.checks.find(entry => entry.id === "opencode");
      expect(check).toMatchObject({ status: "fail", recoveryActions: [{ kind: "install_backend", agentId: "opencode" }] });
      expect(check?.detail).toContain(words);
      expect(check?.detail).toContain("tried again in the background");
      expect(assertDoctorHasNoSecrets(left)).toBeUndefined();
    }
    const gaveUp = await runDoctor({ ...base, openCode: { ...running, state: "given_up", version: null, installKind: null, selfCheck: "not_run", failure: "opencode_not_found", credentials: [] } });
    expect(gaveUp.checks.find(check => check.id === "opencode")?.detail).toBe("OpenCode is not running Konteks work: OpenCode 2 is no longer installed where this computer found it; install it again from opencode.ai; it is no longer retried; restart the connector once it is fixed");
    // Not listed: no line at all.
    expect((await runDoctor(base)).checks.find(check => check.id === "opencode")).toBeUndefined();
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
