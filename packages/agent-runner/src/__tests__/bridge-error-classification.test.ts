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
