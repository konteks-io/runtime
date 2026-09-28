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
