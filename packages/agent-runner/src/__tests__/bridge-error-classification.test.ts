import { describe, expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { classifyBridgeError } from "../bridge/process.js";

describe("a Codex sign-in that can no longer refresh", () => {
  it("reads as sign-in required, not an internal error (WS2-141)", () => {
    const lapsed = new RequestError(-32603, "Internal error", { codexErrorInfo: "unauthorized", message: "Your access token could not be refreshed because you have since logged out or signed in to another account." });
    expect(classifyBridgeError(lapsed)).toMatchObject({ class: "agent_auth_required", retryable: false });
  });

  it("keeps other internal errors internal", () => {
    expect(classifyBridgeError(new RequestError(-32603, "Internal error", { detail: "tool crashed" }))).toMatchObject({ class: "internal" });
    expect(classifyBridgeError(new RequestError(-32603, "Internal error"))).toMatchObject({ class: "internal" });
  });
});

describe("a DeepSeek Harness turn without a usable API key (dsh-runtime-support CP0 #7)", () => {
  // Exact messages dsh 0.1.7-rc.2 rejects session/prompt with (-32603).
  it.each([
    "Internal error: turn failed: llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment",
    "Internal error: turn failed: llm-deepseek: the API key resolved from DEEPSEEK_API_KEY contains characters no HTTP header can carry; set DEEPSEEK_API_KEY to the raw key alone (the web Models page writes it)",
    "Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid (request_id: c624faa2-4f73-4fb2-a304-62e276657c65)",
  ])("reads as sign-in required: %s", message => {
    expect(classifyBridgeError(new RequestError(-32603, message))).toMatchObject({ class: "agent_auth_required", retryable: false, message: "agent authentication required" });
  });

  it("keeps other dsh turn failures internal", () => {
    expect(classifyBridgeError(new RequestError(-32603, "Internal error: turn failed: llm-deepseek: upstream returned 500"))).toMatchObject({ class: "internal" });
  });
});

describe("a DeepSeek Harness turn that failed on the provider after dsh's own retries", () => {
  // dsh retries RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT five times before failing the
  // turn, and a turn is not idempotent: name the provider, never retry the turn.
  it.each([
    "Internal error: turn failed: DeepSeek Messages stream idle timeout",
    "Internal error: turn failed: DeepSeek Messages transport failed",
    "Internal error: turn failed: DeepSeek Messages returned no response body",
  ])("reads as a provider failure, not retried: %s", message => {
    expect(classifyBridgeError(new RequestError(-32603, message))).toMatchObject({ class: "provider_failure", retryable: false });
  });
});

describe("OpenCode 2 turn failures (JSON-RPC -32603 with data.errorName, CP0-v2)", () => {
  const failed = (safeMessage: string, errorName: string) => new RequestError(-32603, `Internal error: ${safeMessage}`, { service: "session", errorName });

  it("reads an empty balance as out of credit, never retried", () => {
    // Captured from OpenCode 2.0.18 with an empty OpenCode Zen balance.
    expect(classifyBridgeError(failed("Upstream request failed: Insufficient account funds", "provider.quota")))
      .toEqual({ code: -32603, class: "provider_failure", retryable: false, message: expect.stringMatching(/out of credit/) });
  });

  it("reads a model outside the account as unavailable, never retried", () => {
    // Captured: a Go model through the Console sign-in.
    const result = classifyBridgeError(failed("Model unavailable: opencode/glm-5.1", "provider.no-route"));
    expect(result).toMatchObject({ class: "provider_failure", retryable: false, message: expect.stringMatching(/not available.*Pick another model/) });
  });

  it.each([
    ["ACP auth required", new RequestError(-32000, "provider authentication required")],
    ["a failed provider sign-in", failed("Invalid API key", "provider.auth")],
    ["a 401 behind another reason", failed("Upstream request failed: 401 Unauthorized", "provider.invalid-request")],
    ["a 403 behind another reason", failed("Upstream request failed with status 403", "provider.error")],
  ])("reads %s as sign-in required", (_name, error) => {
    expect(classifyBridgeError(error)).toMatchObject({ class: "agent_auth_required", retryable: false, message: "agent authentication required" });
  });

  it.each([
    ["provider.rate-limit", "Upstream request failed: 429 Too Many Requests"],
    ["provider.internal", "Upstream request failed: 503 Service Unavailable"],
    ["provider.timeout", "Upstream request timed out"],
    ["provider.transport", "fetch failed"],
    ["provider.unknown", "Upstream request failed: 503"],
  ])("reads %s as a provider failure the session resumes from", (errorName, message) => {
    expect(classifyBridgeError(failed(message, errorName))).toMatchObject({ class: "provider_failure", retryable: true, message: expect.stringMatching(/session is kept/) });
  });

  it("keeps the wording plain: no provider internals, no em dash", () => {
    const result = classifyBridgeError(failed("Upstream request failed: {\"error\":{\"message\":\"bad schema\"}}", "provider.invalid-request"));
    expect(result).toEqual({ code: -32603, class: "provider_failure", retryable: false, message: "The provider could not handle this request." });
    for (const name of ["provider.quota", "provider.no-route", "provider.rate-limit", "provider.internal", "provider.timeout", "provider.transport", "provider.content-filter"]) {
      expect(classifyBridgeError(failed("x", name)).message).not.toMatch(/—/);
    }
  });

  it("leaves OpenCode's non-provider failures to the generic rules", () => {
    expect(classifyBridgeError(new RequestError(-32603, "Internal service failure", { service: "session", errorName: "Error" }))).toMatchObject({ class: "internal" });
    expect(classifyBridgeError(new RequestError(-32602, "session not found: ses_1", { sessionId: "ses_1" }))).toMatchObject({ class: "invalid_params" });
  });
});

describe("Google Antigravity's sign-in, licence and organisation failures (antigravity-acp 1.2.1)", () => {
  // Shapes from the server's own sources (server.py, admin_controls_manager.py) and CP0 part 2.
  const licence = "Gemini Enterprise found no licence for this Google Cloud project. Turn on the Business AI Code API with `gcloud services enable businessaicode.googleapis.com --project <project id>`, then sign in again with `konteks-remote auth login antigravity`.";

  it("a missing licence names the Business AI Code API and the command that turns it on, never Google's text", () => {
    const error = new RequestError(-32000, "No valid Gemini Enterprise license for the configured project 'gemini-enterprise-qa-25d3' / location 'global'. Verify gcp.project and gcp.location in /Users/p/.gemini/antigravity-acp/settings.json, or contact your Google Cloud administrator to confirm your license.", { reason: "ge_license_failed" });
    const classified = classifyBridgeError(error);
    expect(classified).toEqual({ code: -32000, class: "agent_auth_required", message: licence, retryable: false });
    expect(classified.message).not.toMatch(/gemini-enterprise-qa-25d3|settings\.json|\/Users/);
    // A licence check refused by Google (401/403) reads the same.
    expect(classifyBridgeError(new RequestError(-32000, "Gemini Enterprise license resolution failed (HTTP 403): denied", { reason: "ge_license_failed" })).message).toBe(licence);
  });

  it("an unreachable or failing licence service is a retryable provider failure", () => {
    for (const message of ["Gemini Enterprise license resolution failed to reach the backend: timed out", "Gemini Enterprise license resolution failed (HTTP 503): unavailable"]) {
      expect(classifyBridgeError(new RequestError(-32000, message, { reason: "ge_license_failed" })), message)
        .toEqual({ code: -32000, class: "provider_failure", message: "Google Antigravity could not reach Gemini Enterprise. Try again shortly.", retryable: true });
    }
  });

  it("an incomplete setup, a licence not chosen and a failed sign-in each need a sign-in, in plain words", () => {
    expect(classifyBridgeError(new RequestError(-32000, "Gemini Enterprise setup incomplete: no Google Cloud project or location configured. Add gcp.project…", { reason: "ge_license_failed" })).message)
      .toBe("Gemini Enterprise needs a Google Cloud project and location. Sign in again with `konteks-remote auth login antigravity`.");
    for (const reason of ["ge_license_cancelled", "ge_license_superseded"]) {
      expect(classifyBridgeError(new RequestError(-32000, "License selection was cancelled. Sign in again to choose a license.", { reason }))).toMatchObject({ class: "agent_auth_required", message: "The Gemini Enterprise licence was not chosen. Sign in again with `konteks-remote auth login antigravity`." });
    }
    for (const reason of ["ge_auth_failed", "onboarding_failed"]) {
      expect(classifyBridgeError(new RequestError(-32000, "Gemini Enterprise sign-in failed: invalid_grant", { reason }))).toMatchObject({ class: "agent_auth_required", message: "Google Antigravity needs to sign in again. Run `konteks-remote auth login antigravity`." });
    }
  });

  it("organisation settings that could not be checked block the session as a sign-in problem (-32001)", () => {
    for (const reason of ["admin_controls_permission_denied", "admin_controls_verification_failed"]) {
      expect(classifyBridgeError(new RequestError(-32001, "Unable to verify enterprise administrator controls due to missing IAM permissions (PERMISSION_DENIED). Please verify your GCP IAM roles on project gemini-enterprise-qa-25d3…", { reason })))
        .toEqual({ code: -32001, class: "agent_auth_required", message: "Your organisation's Gemini Enterprise settings could not be checked. Sign in again or ask your Google Cloud admin.", retryable: false });
    }
  });

  it("no settings selected is the usual sign-in required", () => {
    expect(classifyBridgeError(new RequestError(-32000, "Authentication required", { message: "No authentication method selected. …" }))).toMatchObject({ class: "agent_auth_required", message: "agent authentication required" });
  });
});
