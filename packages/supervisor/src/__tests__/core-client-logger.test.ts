import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

const ack = { type: "desired_configuration_ack", instanceId: "instance", revision: 3, digest: "A".repeat(43), status: "applied", acknowledgedAt: "2026-09-06T00:00:00Z", signature: "A".repeat(86) };

// 10-10 (E30): `konteks-remote update` printed retry lines as raw JSON under "Updated to 0.12.21."
describe("a Core client's request retries", () => {
  it("are logged with the logger the caller gave, never a default one on stdout", async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ instanceId: ack.instanceId, revision: ack.revision, status: ack.status }), { status: 202, headers: { "content-type": "application/json" } });
    });
    const write = vi.spyOn(process.stdout, "write");
    const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(ack.acknowledgedAt)), key: () => generateInstanceKey(),
      credential: () => "fixture-credential", fetchFn, logger: logger as never });
    await expect(client.controlAck("instance", ack)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "retry_scheduled" }), expect.any(String));
    expect(write.mock.calls.some(([chunk]) => String(chunk).includes("retry_scheduled"))).toBe(false);
    write.mockRestore();
  });
});
