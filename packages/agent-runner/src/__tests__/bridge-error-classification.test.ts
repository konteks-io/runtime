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
