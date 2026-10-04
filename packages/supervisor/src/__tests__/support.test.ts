import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_CANARIES, containsCanary } from "@konteks/remote-common";
import { buildSupportBundle } from "../support/bundle.js";
import { runDoctor } from "../support/doctor.js";
import { expectNoPath } from "./doctor-report.js";

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

  it("treats an agent this computer has not added as informational, never a failure", async () => {
    // 0.10.8 on a Mac with claude-code, codex and dsh: the inventory carries a
    // synthetic "Not added" Google Antigravity view for the site's add card;
    // the update health gate read its `unavailable` readiness as a failure.
    const report = await runDoctor({
      now: () => "2026-10-02T09:27:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active", expiresAt: null },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 }, transport: "relay", reconciliationComplete: true, components: [],
      agents: [{ agentId: "claude-code", readiness: "ready" }, { agentId: "codex", readiness: "unavailable", startFailure: "Codex did not start" }, { agentId: "antigravity", readiness: "unavailable" }],
      listedAgents: ["claude-code", "codex", "dsh"],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    });
    expect(report.checks.find(check => check.id === "agent-antigravity")).toMatchObject({ status: "skip", detail: "not added on this computer", recoveryActions: [] });
    // An agent this computer lists still fails when it cannot start.
    expect(report.checks.find(check => check.id === "agent-codex")).toMatchObject({ status: "fail" });
    expect(report.checks.find(check => check.id === "agent-claude-code")).toMatchObject({ status: "pass" });
  });

  it("says why an agent is left out and why Core refused the reconnect, in plain words (RCA 2026-10-01)", async () => {
    const base = {
      now: () => "2026-10-01T00:00:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "offline", lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: false, components: [],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    };
    const report = await runDoctor({ ...base, reconciliationRefusal: "Konteks no longer accepts this connector process; it restarts to reconnect as a new one",
      agents: [{ agentId: "claude-code", readiness: "ready" }, { agentId: "codex", readiness: "unavailable", startFailure: "The signed Codex app-server did not become ready in time" }] });
    expect(report.checks.find(check => check.id === "agent-codex")).toMatchObject({ status: "fail", detail: "could not start (The signed Codex app-server did not become ready in time); trying again in the background" });
    expect(report.checks.find(check => check.id === "reconciliation")).toMatchObject({ status: "warn", detail: "Konteks no longer accepts this connector process; it restarts to reconnect as a new one" });
    const waiting = await runDoctor({ ...base, agents: [] });
    expect(waiting.checks.find(check => check.id === "reconciliation")?.detail).toBe("waiting for Core reconciliation; no new work until it completes");
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
    expectNoPath(failed);
    const offline = await runDoctor({ ...base, preview: { advertised: false, running: 0, lastFailureAt: null } });
    expect(offline.checks.find(check => check.id === "preview")?.status).toBe("warn");
  });

  it("reports the release channel: an unreadable channel fails, an override warns, only the host is shown (RCA 2026-09-30)", async () => {
    const base = {
      now: () => "2026-09-06T00:00:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    };
    const channel = (report: Awaited<ReturnType<typeof runDoctor>>) => report.checks.find(check => check.id === "update-channel");
    const dead = await runDoctor({ ...base, updateChannel: { host: "127.0.0.1:7444", override: true, lastCheckedAt: "2026-09-30T00:00:00Z", lastError: "The native release channel could not be read", available: null } });
    expect(channel(dead)).toMatchObject({ status: "fail", detail: expect.stringContaining("override 127.0.0.1:7444 (KONTEKS_RELEASE_MANIFEST_URL) could not be read") });
    expect(channel(dead)?.detail).toContain("Remove the override");
    const override = await runDoctor({ ...base, updateChannel: { host: "127.0.0.1:7444", override: true, lastCheckedAt: "2026-09-30T00:00:00Z", lastError: null, available: null } });
    expect(channel(override)?.status).toBe("warn");
    const publicChannel = await runDoctor({ ...base, updateChannel: { host: "github.com", override: false, lastCheckedAt: "2026-09-30T00:00:00Z", lastError: null, available: "0.10.0" } });
    expect(channel(publicChannel)).toMatchObject({ status: "pass", detail: "github.com, checked 2026-09-30T00:00:00Z; 0.10.0 available" });
    const leaseless = await runDoctor({ ...base, lease: { mode: "none" as const, expiresAt: null }, updateChannel: { host: "github.com", override: false, lastCheckedAt: "2026-09-30T00:00:00Z", lastError: null, available: "0.10.0" } });
    expect(channel(leaseless)).toMatchObject({ status: "warn", detail: expect.stringContaining("automatic updates wait until this computer holds a lease again") });
    expect(channel(await runDoctor(base))).toBeUndefined();
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
    expectNoPath(chrome);
  });

  it("reports the person's own OpenCode: version, install, settings check, sign-ins by label, free models, browser, or why it is left out", async () => {
    const base = {
      now: () => "2026-09-06T00:00:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    };
    const running = { state: "running" as const, version: "2.0.18", installKind: "homepage installer", selfCheck: "passed" as const, freeModels: false, browser: true };
    const signedIn = await runDoctor({ ...base, openCode: { ...running, credentials: [{ label: "OpenCode Console account", state: "ready" }, { label: "OpenAI key", state: "needs_sign_in" }] } });
    expect(signedIn.checks.find(check => check.id === "opencode")).toMatchObject({ status: "pass", recoveryActions: [],
      detail: "OpenCode 2.0.18, installed with OpenCode's homepage installer; Konteks settings check passed; signed in with OpenCode Console account, OpenAI key (needs sign-in); OpenCode Zen free models off; its sessions get the QA browser" });
    expectNoPath(signedIn);
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
      expectNoPath(left);
    }
    const gaveUp = await runDoctor({ ...base, openCode: { ...running, state: "given_up", version: null, installKind: null, selfCheck: "not_run", failure: "opencode_not_found", credentials: [] } });
    expect(gaveUp.checks.find(check => check.id === "opencode")?.detail).toBe("OpenCode is not running Konteks work: OpenCode 2 is no longer installed where this computer found it; install it again from opencode.ai; it is no longer retried; restart the connector once it is fixed");
    // Not listed: no line at all.
    expect((await runDoctor(base)).checks.find(check => check.id === "opencode")).toBeUndefined();
  });

  it("reports Google Antigravity: pinned version, Google's signature, sign-ins with the no-licence remedy, MCP Servers off, Require review, disk, browser, or why it is left out", async () => {
    const base = {
      now: () => "2026-09-29T00:00:00Z", dataDir: dir, identity: { instanceId: "inst", administrativeStatus: "active" }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected", lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [],
      configRevision: 1, diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true,
    };
    const enterprise = { label: "Gemini Enterprise Plus", state: "ready", method: "oauth-business" };
    const key = { label: "Gemini API key", state: "needs_sign_in", method: "gemini-api-key" };
    const running = { state: "running" as const, pinnedVersion: "1.2.1", download: "ready" as const, selfCheck: "passed" as const, updating: false,
      credentials: [enterprise, key], quarantine: null, mcpServersOffAt: null, diskBytes: 397_584_640, browser: true };
    const check = async (antigravity: Record<string, unknown>) => {
      const report = await runDoctor({ ...base, antigravity: { ...running, ...antigravity } as never });
      expectNoPath(report);
      return report.checks.find(entry => entry.id === "antigravity")!;
    };
    expect(await check({})).toMatchObject({ status: "pass", title: "Google Antigravity", recoveryActions: [],
      detail: "Google Antigravity 1.2.1, downloaded from Google, signature checked; start check passed; signed in with Gemini Enterprise Plus, Gemini API key (needs sign-in); 398 MB on disk; its sessions get the QA browser" });
    // No sign-in at all: both commands; no licence: the Business AI Code API, never the project.
    expect(await check({ credentials: [], browser: false })).toMatchObject({ status: "warn", recoveryActions: [{ kind: "login_agent", agentId: "antigravity" }],
      detail: expect.stringContaining("not signed in (konteks-remote auth login antigravity --api-key, or --enterprise --project <project id>); 398 MB on disk; no QA browser for its sessions") });
    const noLicence = await check({ credentials: [{ ...enterprise, state: "needs_sign_in", reason: "no_license" }] });
    expect(noLicence.status).toBe("warn");
    expect(noLicence.detail).toContain("Gemini Enterprise Plus (no licence found: turn on the Business AI Code API with `gcloud services enable businessaicode.googleapis.com --project <project id>`, then sign in again with konteks-remote auth login antigravity --enterprise)");
    // The organisation's MCP Servers off, while Gemini Enterprise is in use: a warning with the setting.
    const mcpOff = await check({ mcpServersOffAt: "2026-09-29T01:02:03.000Z" });
    expect(mcpOff.status).toBe("warn");
    expect(mcpOff.detail).toContain("Konteks tools unavailable: turn on MCP Servers in Gemini Enterprise settings");
    expect((await check({ mcpServersOffAt: "2026-09-29T01:02:03.000Z", credentials: [{ ...key, state: "ready" }] })).detail).not.toContain("MCP Servers");
    // The Require review line.
    const a21 = await check({ quarantine: "Your organisation's Gemini Enterprise settings let Antigravity run commands without asking. Ask your Google Cloud admin to set Terminal auto-execution to Require review, then restart the connector." });
    expect(a21.status).toBe("fail");
    expect(a21.detail).toContain("Needs your organisation's Require review setting");
    expect(a21.detail).toContain('"Terminal auto-execution: Require review"');
    expect((await check({ quarantine: "Google Antigravity ran a tool without Konteks' approval. Update the connector, then restart it." })).detail)
      .toBe("Google Antigravity 1.2.1 was taken out of service: Google Antigravity ran a tool without Konteks' approval. Update the connector, then restart it.");
    // An update's new copy is downloaded; used from the next start.
    expect((await check({ download: "update_available" })).detail).toContain("a newer version is downloaded and is used from the next start");
    for (const [failure, words, action] of [
      ["antigravity_not_fetched", "not downloaded to this computer (konteks-remote agent add antigravity downloads it after you say yes)", "install_backend"],
      ["antigravity_unsafe_install", "does not match Google's release, so it never runs", "install_backend"],
      ["antigravity_no_disk_space", "about 1.2 GB free", "free_disk"],
      ["antigravity_unsupported_platform", "Google publishes no copy of it for this computer yet", undefined],
      ["antigravity_self_check_failed", "its start check could not run", "install_backend"],
    ] as const) {
      const left = await check({ state: "retrying", selfCheck: "failed", failure, credentials: [], download: undefined, diskBytes: null });
      expect(left.status).toBe("fail");
      expect(left.detail).toContain(words);
      expect(left.detail).toContain("tried again in the background");
      expect(left.recoveryActions).toEqual(action ? [{ kind: action, ...(action === "install_backend" || action === "free_disk" ? { agentId: "antigravity" } : {}) }] : []);
    }
    // After `konteks-remote update` carried a new pin: being fetched, checked, then used.
    expect((await check({ state: "retrying", failure: "antigravity_unsupported_version", updating: true, pinnedVersion: "1.2.4", credentials: [] })).detail)
      .toBe("Google Antigravity 1.2.4 is not running Konteks work: this connector release runs 1.2.4, which is being downloaded from Google and checked before it is used; it is tried again in the background, and the other agents keep running");
    // Not listed: no line at all.
    expect((await runDoctor(base)).checks.find(entry => entry.id === "antigravity")).toBeUndefined();
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
