import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SECRET_CANARIES, containsCanary } from "@konteks/remote-common";
import { findAgentBridge } from "@konteks/remote-release";
import { fallbackLoginIdentity, normalizeSignal, probeIdentity } from "../auth/identity.js";
import { RunnerConfigSchema } from "../config.js";
import { INITIAL_SCOPE_STATE } from "../auth/scope-store.js";
import { projectReadiness } from "../readiness.js";
import { extractLoginSignals, withoutTerminalEscapes } from "../auth/login-flow.js";
import { writeDshApiKey } from "../auth/dsh-key.js";
import { dshRuntimePaths } from "../bridge/dsh-profile.js";

describe("identity signal normalization (D111)", () => {
  it("uses official Codex account identity rather than empty status stdout or shared login text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-identity-"));
    try {
      const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: dir });
      const run = vi.fn(async () => ({ code: 0, signal: null, stdout: "", stderr: "Logged in using ChatGPT\n" }));
      const readAccount = vi.fn(async () => "first@example.test");
      const first = await probeIdentity(config, findAgentBridge("codex")!, {}, { run, readAccount });
      expect(first.kind).toBe("signal");
      expect(await probeIdentity(config, findAgentBridge("codex")!, {}, { run, readAccount })).toEqual(first);
      readAccount.mockResolvedValue("second@example.test");
      expect(await probeIdentity(config, findAgentBridge("codex")!, {}, { run, readAccount })).not.toEqual(first);
      expect(JSON.stringify(first)).not.toContain("example.test");
      expect(run).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("fingerprints the stored DeepSeek key for DeepSeek Harness, without running anything or exposing the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-identity-"));
    try {
      const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: dir });
      const run = vi.fn();
      const family = findAgentBridge("dsh")!;
      expect(await probeIdentity(config, family, {}, { run })).toEqual({ kind: "logged_out" });
      const file = dshRuntimePaths(dir).credentialsFile;
      await writeDshApiKey(file, "sk-first-key-00000000000000000000");
      const first = await probeIdentity(config, family, {}, { run });
      expect(first.kind).toBe("signal");
      expect(await probeIdentity(config, family, {}, { run })).toEqual(first);
      await writeDshApiKey(file, "sk-second-key-0000000000000000000");
      const second = await probeIdentity(config, family, {}, { run });
      expect(second.kind).toBe("signal");
      expect(second).not.toEqual(first);
      expect(JSON.stringify([first, second])).not.toMatch(/sk-/);
      expect(run).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("treats Claude Code status as an identity only when it reports loggedIn true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-identity-"));
    try {
      const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "claude-code", RUNNER_CREDENTIAL_DIR: dir });
      const run = vi.fn(async () => ({ code: 0, signal: null, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), stderr: "" }));
      expect(await probeIdentity(config, findAgentBridge("claude-code")!, {}, { run })).toEqual({ kind: "logged_out" });
      run.mockResolvedValue({ code: 0, signal: null, stdout: "not json", stderr: "" });
      expect(await probeIdentity(config, findAgentBridge("claude-code")!, {}, { run })).toEqual({ kind: "logged_out" });
      run.mockResolvedValue({ code: 0, signal: null, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "person@example.test" }), stderr: "" });
      const signed = await probeIdentity(config, findAgentBridge("claude-code")!, {}, { run });
      expect(signed.kind).toBe("signal");
      expect(JSON.stringify(signed)).not.toContain("example.test");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("hashes a stable projection of official JSON status output, dropping volatile and secret fields", () => {
    const a = normalizeSignal(JSON.stringify({ email: "x@example.com", accountId: "acc-1", expiresAt: "2026-09-06T00:00:00Z", accessToken: SECRET_CANARIES.bearer }));
    const b = normalizeSignal(JSON.stringify({ accountId: "acc-1", email: "x@example.com", expiresAt: "2027-01-01T00:00:00Z", accessToken: "other" }));
    expect(a).toBe(b);
    expect(containsCanary(a)).toBe(false);
    expect(a).not.toContain("expires");
  });

  it("falls back to trimmed non-volatile lines for text output", () => {
    expect(normalizeSignal("Logged in as person@example.com\nToken expires 2026-09-06T00:00:00Z\n")).toBe("Logged in as person@example.com");
  });

  it("conservative fallback identities are unlinkable per login", () => {
    expect(fallbackLoginIdentity()).not.toBe(fallbackLoginIdentity());
  });
});

describe("ConnectedAgentView projection", () => {
  const family = findAgentBridge("codex")!;
  const base = {
    family,
    authMode: "agent_local_subscription" as const,
    connectionState: "ready" as const,
    initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } },
    scope: { ...INITIAL_SCOPE_STATE, authIdentityFingerprint: "fp-opaque-0123456789abcdef", lastLoginAt: "2026-09-06T00:00:00Z" },
    identity: "signal" as const,
    bridgeVersionCompatible: true,
    lastProbeAt: "2026-09-06T00:00:00Z",
  };

  it("is ready with sanitized capabilities and only the opaque fingerprint", () => {
    const view = projectReadiness(base);
    expect(view).toMatchObject({ agentId: "codex", readiness: "ready", accountScope: "personal", moneyObservable: false, tokenUsageObservable: true });
    expect(view.acpCapabilities).toEqual({ sessionResume: true, forkSession: true, structuredOutputShim: true, toolControl: "approve" });
    expect(view.authIdentityFingerprint).toBe("fp-opaque-0123456789abcdef");
    expect(JSON.stringify(view)).not.toMatch(/"(email|token|path|agentHome|agentHomePath|credentialPath|apiKey|subscriptionToken)":/i);
  });

  it("gateway_keyed implies moneyObservable and readiness without a login", () => {
    const view = projectReadiness({ ...base, authMode: "gateway_keyed", identity: "logged_out" });
    expect(view.moneyObservable).toBe(true);
    expect(view.readiness).toBe("ready");
  });

  it("a logged-out subscription agent is not_configured with login_locally", () => {
    const view = projectReadiness({ ...base, identity: "logged_out", scope: INITIAL_SCOPE_STATE });
    expect(view.readiness).toBe("not_configured");
    expect(view.recoveryAction).toBe("login_locally");
  });

  it("an incompatible bridge surfaces reconnect_required with update_agent_bridge", () => {
    const view = projectReadiness({ ...base, bridgeVersionCompatible: false });
    expect(view.readiness).toBe("reconnect_required");
    expect(view.recoveryAction).toBe("update_agent_bridge");
  });

  it("no official signal treats a prior login as ready and no login as not_configured", () => {
    expect(projectReadiness({ ...base, identity: "no_official_signal" }).readiness).toBe("ready");
    expect(projectReadiness({ ...base, identity: "no_official_signal", scope: INITIAL_SCOPE_STATE }).readiness).toBe("not_configured");
  });
});

describe("login flow signal extraction", () => {
  it("detects device-flow URLs, user codes, and paste prompts", () => {
    expect(extractLoginSignals("Open https://auth.example.com/device and enter code ABCD-EFGH")).toEqual({ url: "https://auth.example.com/device", userCode: "ABCD-EFGH" });
    expect(extractLoginSignals("Paste the authorization code here: ")).toMatchObject({ prompt: { secret: false } });
    expect(extractLoginSignals("Enter your API token: ")).toMatchObject({ prompt: { secret: true } });
    expect(extractLoginSignals("Logging in...")).toEqual({});
    // Codex's device login colours the link and the code on their own lines.
    expect(extractLoginSignals(withoutTerminalEscapes("   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m"))).toEqual({ url: "https://auth.openai.com/codex/device" });
    expect(extractLoginSignals(withoutTerminalEscapes("   \u001b[94mABCD-EFGH\u001b[0m"))).toEqual({ userCode: "ABCD-EFGH" });
  });
});
