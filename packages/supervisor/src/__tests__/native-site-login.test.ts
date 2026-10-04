import { describe, expect, it, vi } from "vitest";
import { RuntimeAgentLoginReportSchema } from "@konteks/remote-common";
import { antigravityRunnerCapabilities, openCodeRunnerCapabilities, siteLoginRelay, type SiteLoginReport } from "../native/site-login.js";
import { antigravityOptionBilling } from "../native/model-capability-snapshot.js";

function relay(agentId: "codex" | "claude-code" | "opencode" | "antigravity", loginOption?: "opencode-console" | "gitlab" | "chatgpt" | "gemini-enterprise", coreAcceptsNoLicense?: boolean) {
  const reports: SiteLoginReport[] = [];
  const cancel = vi.fn(), onFinished = vi.fn(), onSucceeded = vi.fn();
  const login = siteLoginRelay({ loginId: "login-1", agentId, ...(loginOption ? { loginOption } : {}), ...(coreAcceptsNoLicense === undefined ? {} : { coreAcceptsNoLicense }),
    report: value => reports.push(value), cancel, onFinished, onSucceeded });
  return { login, reports, cancel, onFinished, onSucceeded };
}

describe("a sign-in started from the site", () => {
  it("relays OpenCode's device link and code, echoing the option in every report", () => {
    const f = relay("opencode", "opencode-console");
    // A link on another host is never shown, whatever the agent printed.
    f.login.emit({ kind: "open_url", loginId: "login-1", url: "https://evil.example/device?code=ABCD-EFGH", userCode: "ABCD-EFGH" });
    f.login.emit({ kind: "display", loginId: "login-1", text: "Enter code: WXYZ-1234" });
    expect(f.reports).toEqual([]);
    f.login.emit({ kind: "open_url", loginId: "login-1", url: "https://opencode.ai/console/device?user_code=GKPB-FNLD&client_id=opencode-cli", userCode: "GKPB-FNLD" });
    f.login.emit({ kind: "completed", loginId: "login-1", readiness: "ready" });
    expect(f.reports).toEqual([
      { loginId: "login-1", agentId: "opencode", loginOption: "opencode-console", state: "awaiting_person", verificationUrl: "https://opencode.ai/console/device?user_code=GKPB-FNLD&client_id=opencode-cli", userCode: "GKPB-FNLD" },
      { loginId: "login-1", agentId: "opencode", loginOption: "opencode-console", state: "succeeded" },
    ]);
    for (const report of f.reports) expect(RuntimeAgentLoginReportSchema.safeParse(report).success).toBe(true);
    expect(f.onFinished).toHaveBeenCalledOnce();
    expect(f.onSucceeded).toHaveBeenCalledOnce();
  });

  it("stops a login that asks for typed input: nothing the person types crosses Konteks", () => {
    const f = relay("opencode", "chatgpt");
    f.login.emit({ kind: "prompt", loginId: "login-1", label: "API key", secret: true });
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.reports).toEqual([{ loginId: "login-1", agentId: "opencode", loginOption: "chatgpt", state: "failed", failure: "login_failed" }]);
    f.login.emit({ kind: "completed", loginId: "login-1", readiness: "ready" });
    expect(f.reports).toHaveLength(1);
  });

  it("finishes OpenCode's browser sign-ins on this machine, like Claude Code's", () => {
    const f = relay("opencode", "gitlab");
    expect(f.login.browser).toBe(true);
    f.login.started();
    f.login.emit({ kind: "prompt", loginId: "login-1", label: "Paste", secret: false });
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.reports).toEqual([{ loginId: "login-1", agentId: "opencode", loginOption: "gitlab", state: "awaiting_person" }]);
    expect(RuntimeAgentLoginReportSchema.safeParse(f.reports[0]).success).toBe(true);
  });

  it("keeps Codex's relay as it was (code on its own line, no option)", () => {
    const f = relay("codex");
    f.login.emit({ kind: "open_url", loginId: "login-1", url: "https://auth.openai.com/codex/device" });
    f.login.emit({ kind: "display", loginId: "login-1", text: "Enter this one-time code: ABCD-12345" });
    expect(f.reports.at(-1)).toEqual({ loginId: "login-1", agentId: "codex", state: "awaiting_person", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" });
    f.login.fail("already_in_progress");
    expect(f.reports.at(-1)).toEqual({ loginId: "login-1", agentId: "codex", state: "failed", failure: "already_in_progress" });
  });
});

describe("what a connector with OpenCode advertises", () => {
  it("the free-models switch always, and each sign-in its OpenCode offers while the relay can carry one", () => {
    expect(openCodeRunnerCapabilities({ installed: false, relayReady: true, options: ["opencode-console"], desktop: true })).toEqual([]);
    expect(openCodeRunnerCapabilities({ installed: true, relayReady: false, options: ["opencode-console"], desktop: true })).toEqual(["opencode-free-models-v1"]);
    expect(openCodeRunnerCapabilities({ installed: true, relayReady: true, options: [], desktop: true })).toEqual(["opencode-free-models-v1"]);
    expect(openCodeRunnerCapabilities({ installed: true, relayReady: true, options: ["opencode-console", "chatgpt", "gitlab", "poe"], desktop: true })).toEqual([
      "opencode-free-models-v1", "agent-login-opencode-v1", "agent-login-opencode:opencode-console", "agent-login-opencode:chatgpt", "agent-login-opencode:gitlab", "agent-login-opencode:poe",
    ]);
    // Without a desktop, the browser sign-ins (GitLab, Poe) are not offered.
    expect(openCodeRunnerCapabilities({ installed: true, relayReady: true, options: ["opencode-console", "gitlab", "poe"], desktop: false })).toEqual([
      "opencode-free-models-v1", "agent-login-opencode-v1", "agent-login-opencode:opencode-console",
    ]);
    expect(openCodeRunnerCapabilities({ installed: true, relayReady: true, options: ["gitlab"], desktop: false })).toEqual(["opencode-free-models-v1"]);
  });
});

describe("Google Antigravity's Gemini Enterprise sign-in from the site", () => {
  const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A50695%2F&scope=openid";

  it("finishes in the browser on this machine: awaiting at once, then Google's own page only, never the loopback licence picker", () => {
    const f = relay("antigravity", "gemini-enterprise", true);
    expect(f.login.browser).toBe(true);
    f.login.started();
    f.login.emit({ kind: "open_url", loginId: "login-1", url: "http://127.0.0.1:50694/" });
    f.login.emit({ kind: "open_url", loginId: "login-1", url: "https://accounts.google.com.evil.example/o/oauth2" });
    f.login.emit({ kind: "open_url", loginId: "login-1", url: GOOGLE });
    f.login.emit({ kind: "display", loginId: "login-1", text: "Google found no Gemini Enterprise licence for gemini-enterprise-qa-25d3." });
    f.login.emit({ kind: "prompt", loginId: "login-1", label: "Google Cloud project ID", secret: false, visible: true });
    f.login.emit({ kind: "completed", loginId: "login-1", readiness: "ready" });
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.reports).toEqual([
      { loginId: "login-1", agentId: "antigravity", loginOption: "gemini-enterprise", state: "awaiting_person" },
      { loginId: "login-1", agentId: "antigravity", loginOption: "gemini-enterprise", state: "awaiting_person", verificationUrl: GOOGLE },
      { loginId: "login-1", agentId: "antigravity", loginOption: "gemini-enterprise", state: "succeeded" },
    ]);
    for (const report of f.reports) expect(RuntimeAgentLoginReportSchema.safeParse(report).success).toBe(true);
    // The project never goes back to the site.
    expect(JSON.stringify(f.reports)).not.toContain("gemini-enterprise-qa-25d3");
  });

  it("says no_license to a Core that takes it, and login_failed to an older one", () => {
    const current = relay("antigravity", "gemini-enterprise", true);
    current.login.emit({ kind: "failed", loginId: "login-1", code: "agent_auth_required", message: "Google Antigravity did not finish signing in", reason: "no_license" });
    expect(current.reports).toEqual([{ loginId: "login-1", agentId: "antigravity", loginOption: "gemini-enterprise", state: "failed", failure: "no_license" }]);
    expect(RuntimeAgentLoginReportSchema.safeParse(current.reports[0]).success).toBe(true);
    const older = relay("antigravity", "gemini-enterprise", false);
    older.login.emit({ kind: "failed", loginId: "login-1", code: "agent_auth_required", message: "x", reason: "no_license" });
    expect(older.reports).toEqual([{ loginId: "login-1", agentId: "antigravity", loginOption: "gemini-enterprise", state: "failed", failure: "login_failed" }]);
    const plain = relay("antigravity", "gemini-enterprise", true);
    plain.login.emit({ kind: "failed", loginId: "login-1", code: "agent_auth_required", message: "x" });
    expect(plain.reports.at(-1)).toMatchObject({ failure: "login_failed" });
    // Only Gemini Enterprise can lack a licence.
    const other = relay("opencode", "opencode-console", true);
    other.login.emit({ kind: "failed", loginId: "login-1", code: "agent_auth_required", message: "x", reason: "no_license" });
    expect(other.reports.at(-1)).toMatchObject({ failure: "login_failed" });
  });

  it("is advertised only with the relay up and a browser here, never personal Google sign-in, and never borrows OpenCode's free-models switch", () => {
    expect(antigravityRunnerCapabilities({ installed: false, relayReady: true, options: ["gemini-enterprise"], desktop: true })).toEqual([]);
    expect(antigravityRunnerCapabilities({ installed: true, relayReady: false, options: ["gemini-enterprise"], desktop: true })).toEqual([]);
    expect(antigravityRunnerCapabilities({ installed: true, relayReady: true, options: ["gemini-enterprise"], desktop: false })).toEqual([]);
    expect(antigravityRunnerCapabilities({ installed: true, relayReady: true, options: ["gemini-enterprise", "google-account", "gitlab"], desktop: true }))
      .toEqual(["agent-login-antigravity-v1", "agent-login-antigravity:gemini-enterprise"]);
  });

  it("bills its offered models by how Google is signed in: the credential in use, listed first among the ready ones", () => {
    const enterprise = { providerId: "google", label: "Gemini Enterprise Plus", kind: "sign_in" as const, method: "oauth-business", billing: "subscription" as const, state: "ready" as const };
    const key = { providerId: "google", label: "Gemini API key", kind: "api_key" as const, method: "gemini-api-key", billing: "pay_per_use" as const, state: "ready" as const };
    expect(antigravityOptionBilling({ agentId: "antigravity", credentials: [enterprise, key] })).toBe("subscription");
    expect(antigravityOptionBilling({ agentId: "antigravity", credentials: [key, { ...enterprise, state: "needs_sign_in" }] })).toBe("pay_per_use");
    expect(antigravityOptionBilling({ agentId: "antigravity", credentials: [{ ...enterprise, state: "needs_sign_in" }] })).toBeUndefined();
    expect(antigravityOptionBilling({ agentId: "antigravity" })).toBeUndefined();
    expect(antigravityOptionBilling({ agentId: "opencode", credentials: [enterprise] })).toBeUndefined();
  });
});
