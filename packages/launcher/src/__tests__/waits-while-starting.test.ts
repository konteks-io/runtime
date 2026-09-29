import { describe, expect, it, vi } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { waitWhileStarting } from "../native/commands.js";

const unavailable = () => new RemoteInstanceError("control_socket_unavailable", "cannot reach the supervisor control socket");

describe("a command run while the connector is still starting (WS1-167)", () => {
  it("waits for it and says so once, then goes on", async () => {
    let now = 0;
    const call = vi.fn().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValue({});
    const lines: string[] = [];
    await waitWhileStarting({ control: { call } as never, output: { line: text => lines.push(text) } },
      { running: async () => true, sleep: async ms => { now += ms; }, now: () => now });
    expect(call).toHaveBeenCalledTimes(3);
    expect(lines).toEqual(["Konteks is still starting on this computer; waiting for it…"]);
  });

  it("does not wait for a stopped connector, nor past its limit", async () => {
    const call = vi.fn().mockRejectedValue(unavailable());
    const lines: string[] = [];
    await waitWhileStarting({ control: { call } as never, output: { line: text => lines.push(text) } },
      { running: async () => false, sleep: async () => undefined, now: () => 0 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
    let now = 0;
    const running = vi.fn(async () => true);
    await waitWhileStarting({ control: { call } as never, output: { line: () => undefined } },
      { running, sleep: async ms => { now += ms; }, now: () => now, waitMs: 6_000 });
    expect(now).toBe(6_000);
  });
});
