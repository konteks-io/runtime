import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

const observation = { instanceId: "instance", assignmentId: "assignment", attempt: 1, agentId: "claude-code", totalTokens: 10, inputTokens: 4, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, moneyBasis: "unavailable_local_subscription", observedAt: "2026-09-15T00:00:00.000Z" };

describe("observation HTTPS client", () => {
  it.each([true, false])("sends Core's singular wire body and accepts stored=%s", async stored => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ stored }), { status: 202, headers: { "content-type": "application/json" } }));
    const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(observation.observedAt)), key: () => generateInstanceKey(), credential: () => "lease", fetchFn });
    await expect(client.observation("instance", observation)).resolves.toBe(stored);
    const [, init] = fetchFn.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual(observation);
    expect(init?.headers).toMatchObject({ "idempotency-key": expect.stringMatching(/^observation:instance:/) });
  });

  it("rejects a stale batch-shaped response instead of dropping durable evidence", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202, headers: { "content-type": "application/json" } }));
    const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(observation.observedAt)), key: () => generateInstanceKey(), credential: () => "lease", fetchFn });
    await expect(client.observation("instance", observation)).rejects.toThrow();
  });
});
