import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { createOutput } from "../output.js";
import { statusOrStopped } from "../native/commands.js";

describe("native status when the connector is stopped", () => {
  it("keeps --json machine-readable while preserving the successful stopped result", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-stopped-status-"));
    let stdout = "";
    try {
      const output = createOutput({ json: true, stdout: { write: text => { stdout += text; return true; } } as never });
      await statusOrStopped(
        { output, control: { call: vi.fn().mockRejectedValue(new RemoteInstanceError("control_socket_unavailable", "offline")) } },
        { root, output, operation: "status" } as never,
        { running: async () => false },
      );
      expect(JSON.parse(stdout)).toMatchObject({ running: false, lastStartFailure: null, logTail: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
