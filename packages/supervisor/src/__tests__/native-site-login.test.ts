import { describe, expect, it, vi } from "vitest";
import { RuntimeAgentLoginReportSchema } from "@konteks/remote-common";
import { openCodeRunnerCapabilities, siteLoginRelay, type SiteLoginReport } from "../native/site-login.js";

function relay(agentId: "codex" | "claude-code" | "opencode", loginOption?: "opencode-console" | "gitlab" | "chatgpt") {
  const reports: SiteLoginReport[] = [];
  const cancel = vi.fn(), onFinished = vi.fn(), onSucceeded = vi.fn();
  const login = siteLoginRelay({ loginId: "login-1", agentId, ...(loginOption ? { loginOption } : {}), report: value => reports.push(value), cancel, onFinished, onSucceeded });
  return { login, reports, cancel, onFinished, onSucceeded };
}

describe("a sign-in started from the site (WS1-115, OpenCode CP3)", () => {
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
