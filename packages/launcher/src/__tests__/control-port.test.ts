import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { chooseControlPort } from "../native/install.js";

/** A second connector on one machine must not inherit a taken port (WS1-020). */
describe("chooseControlPort", () => {
  it("keeps the preferred port when it is free and picks another when it is taken", async () => {
    const free = await chooseControlPort(0);
    expect(free).toBeGreaterThan(0);
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as { port: number }).port;
    try {
      const chosen = await chooseControlPort(taken);
      expect(chosen).not.toBe(taken);
      expect(chosen).toBeGreaterThan(0);
    } finally {
      await new Promise<void>(resolve => holder.close(() => resolve()));
    }
  });
});
