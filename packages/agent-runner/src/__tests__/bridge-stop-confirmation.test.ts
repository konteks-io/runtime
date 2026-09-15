import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { spawnPiped, type PipedChildProcess } from "@konteks/remote-common";
import { spawnBridge, type BridgeStopOwner } from "../bridge/process.js";
import type { BridgeSpawnSpec } from "../bridge/spec.js";

vi.mock("@konteks/remote-common", async importOriginal => ({
  ...await importOriginal<object>(), spawnPiped: vi.fn(), stopProcessGroupLeaderFirst: vi.fn(async () => undefined),
}));

it("refuses an unobserved process exit and retains the provisional stop owner for retry", async () => {
  const child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawnPiped).mockReturnValueOnce(child as PipedChildProcess);
  const owners: BridgeStopOwner[] = [];
  await expect(spawnBridge({
    spec: { family: { agentId: "codex" }, command: "/fixture/bridge", args: [], env: {} } as BridgeSpawnSpec,
    initializeTimeoutMs: 100, clientVersion: "fixture",
    // Abort before SDK initialization: this exercises the real provisional
    // owner without creating an agent, a model prompt or user credentials.
    onProcessOwner: owner => { owners.push(owner); throw new Error("fixture initialization aborted"); },
    handlers: { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCreateElicitation: async () => ({ action: "cancel" }), onExit: () => undefined },
  })).rejects.toThrow();
  expect(owners).toHaveLength(1);
  expect(owners[0]!.exited).toBe(false);
  await expect(owners[0]!.stop()).rejects.toThrow("Bridge process exit remains unconfirmed");
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await expect(owners[0]!.stop()).resolves.toBeUndefined();
  expect(owners[0]!.exited).toBe(true);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});
