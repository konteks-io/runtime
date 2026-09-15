import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  ReconnectBackoff,
  humanizeTransportError,
  withJitter,
} from "../backoff.js";

describe("ReconnectBackoff", () => {
  it("grows exponentially and caps at max", () => {
    const backoff = new ReconnectBackoff();
    expect(backoff.nextDelayAfterClose(0)).toBe(DEFAULT_RECONNECT_BASE_DELAY_MS * 2);
    expect(backoff.nextDelayAfterClose(0)).toBe(DEFAULT_RECONNECT_BASE_DELAY_MS * 4);
    let delay = 0;
    for (let index = 0; index < 20; index += 1) delay = backoff.nextDelayAfterClose(0);
    expect(delay).toBe(DEFAULT_MAX_RECONNECT_DELAY_MS);
  });

  it("resets after a stable connection and only strictly beyond the threshold", () => {
    const backoff = new ReconnectBackoff({ stableConnectionMs: 10_000 });
    expect(backoff.nextDelayAfterClose(0)).toBe(2_000);
    expect(backoff.nextDelayAfterClose(10_000)).toBe(4_000);
    expect(backoff.nextDelayAfterClose(10_001)).toBe(1_000);
  });

  it("applies bounded jitter", () => {
    expect(withJitter(1_000, () => 0)).toBe(500);
    expect(withJitter(1_000, () => 1)).toBe(1_000);
  });
});

describe("humanizeTransportError", () => {
  it("maps errno codes to short reasons without leaking addresses", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    expect(humanizeTransportError(refused, "relay.konteks.example")).toBe(
      "can't reach relay.konteks.example — connection refused",
    );
  });
});
