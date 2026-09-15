import { describe, expect, it } from "vitest";
import { CodexInputCorrelation } from "../bridge/codex-input-correlation.js";

const user = (clientId: string | null, threadId = "thread", id = "item") => ({ method: "item/completed", params: { threadId, item: { type: "userMessage", id, clientId, content: [] } } });
function start(correlation: CodexInputCorrelation, method = "turn/start") {
  return correlation.outgoing({ id: 1, method, params: { threadId: "thread", input: [{ type: "text", text: "same text" }] } }) as { params: { clientUserMessageId: string } };
}
function source(correlation: CodexInputCorrelation, event: unknown) {
  return (correlation.incoming(event) as { params: { item: { konteksInputSource: string } } }).params.item.konteksInputSource;
}
describe("native Codex input correlation", () => {
  it("correlates before responses and preserves duplicate notifications for one item", () => {
    const c = new CodexInputCorrelation();
    const id = start(c).params.clientUserMessageId;
    expect(source(c, user(id))).toBe("connector");
    expect(source(c, user(id))).toBe("connector");
    expect(source(c, user(id, "thread", "another-item"))).toBe("unclassified");
  });
  it("does not infer origin from matching text, thread identity or provider claims", () => {
    const c = new CodexInputCorrelation();
    const id = start(c).params.clientUserMessageId;
    expect(source(c, user(id, "another-thread"))).toBe("unclassified");
    const event = user(null);
    Object.assign(event.params.item, { konteksInputSource: "connector" });
    expect(source(c, event)).toBe("unclassified");
  });
  it("tracks steering inputs separately and does not carry authority across restart", () => {
    const c = new CodexInputCorrelation();
    const id = start(c, "turn/steer").params.clientUserMessageId;
    expect(source(c, user(id))).toBe("connector");
    expect(source(new CodexInputCorrelation(), user(id))).toBe("unclassified");
  });
  it("bounds tracking and leaves evicted correlation unknown", () => {
    const c = new CodexInputCorrelation();
    const first = start(c).params.clientUserMessageId;
    for (let i = 0; i < 4096; i++) start(c);
    expect(source(c, user(first))).toBe("unclassified");
  });
});
