import { describe, expect, it } from "vitest";
import { SessionToCoreMessageSchema, type SessionToCoreMessage } from "@konteks/remote-common";
import { SecretTextRelay } from "../session/secret-text-relay.js";

function message(text: string, messageId = "one"): SessionToCoreMessage {
  return SessionToCoreMessageSchema.parse({ kind: "acp", method: "session/update", params: {
    sessionId: "session", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
  } });
}
function texts(messages: SessionToCoreMessage[]): string {
  return messages.map(frame => {
    expect(SessionToCoreMessageSchema.safeParse(frame).success).toBe(true);
    return frame.kind === "acp" && frame.method === "session/update" && frame.params.update.sessionUpdate === "agent_message_chunk" && frame.params.update.content.type === "text" ? frame.params.update.content.text : "";
  }).join("");
}
const key = "sk-proj-*SYNTHETICNONFUNCTIONAL0123456789ABCDEF";

describe("secret text relay lifecycle", () => {
  it.each(["acp_result", "acp_error"])("flushes before %s without carrying state into the next turn", kind => {
    const relay = new SecretTextRelay();
    const terminal = SessionToCoreMessageSchema.parse(kind === "acp_result"
      ? { kind, id: "prompt", method: "session/prompt", result: { stopReason: "end_turn" } }
      : { kind, id: "prompt", method: "session/prompt", error: { code: -32603, class: "internal", message: "failed", retryable: false } });
    expect(texts(relay.messages(message(key)))).toBe("");
    const frames = relay.messages(terminal);
    expect(texts(frames)).toBe("[redacted]");
    expect(frames.at(-1)).toEqual(terminal);
    expect(texts(relay.messages(message("hello")))).toBe("hello");
  });

  it("preserves tool lifecycle order while suppressing a split candidate's tail", () => {
    const relay = new SecretTextRelay();
    const tool = SessionToCoreMessageSchema.parse({ kind: "acp", method: "session/update", params: {
      sessionId: "session", update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "Check", kind: "read", status: "pending" },
    } });
    expect(texts(relay.messages(message("sk-")))).toBe("");
    const frames = relay.messages(tool);
    expect(texts(frames)).toBe("[redacted]");
    expect(frames.at(-1)).toEqual(tool);
    expect(texts(relay.messages(message(key.slice(3) + " done")))).toBe(" done");
  });

  it("flushes a distinct message's harmless suffix and preserves its original metadata", () => {
    const relay = new SecretTextRelay();
    expect(texts(relay.messages(message("s")))).toBe("");
    const frames = relay.messages(message("hello", "two"));
    expect(texts(frames)).toBe("shello");
    expect(frames[0]).toMatchObject({ params: { update: { messageId: "one" } } });
    expect(frames[1]).toMatchObject({ params: { update: { messageId: "two" } } });
  });
});
