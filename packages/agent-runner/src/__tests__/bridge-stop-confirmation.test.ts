import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import {
  RemoteInstanceError,
  captureRetainedProcessOwner,
  isProcessGroupAlive,
  spawnPiped,
  stopProcessGroupLeaderFirst,
  type PipedChildProcess,
} from "@konteks/remote-common";
import { spawnBridge, type BridgeStopOwner } from "../bridge/process.js";
import type { BridgeSpawnSpec } from "../bridge/spec.js";

vi.mock("@konteks/remote-common", async importOriginal => ({
  ...await importOriginal<object>(), captureRetainedProcessOwner: vi.fn(), spawnPiped: vi.fn(),
  stopProcessGroupLeaderFirst: vi.fn(async () => undefined), isProcessGroupAlive: vi.fn(() => false),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isProcessGroupAlive).mockReturnValue(false);
  vi.mocked(stopProcessGroupLeaderFirst).mockResolvedValue(undefined);
});

function childProcess(): PipedChildProcess {
  return Object.assign(new ChildProcess(), {
    pid: 4123,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }) as PipedChildProcess;
}

const spec = { family: { agentId: "codex" }, command: "/fixture/bridge", args: [], env: {} } as BridgeSpawnSpec;
const handlers = { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  onCreateElicitation: async () => ({ action: "cancel" as const }), onExit: () => undefined };

it("makes a cold identity-capture failure retryable only after the spawned process is confirmed stopped", async () => {
  const child = childProcess();
  vi.mocked(spawnPiped).mockReturnValueOnce(child);
  vi.mocked(captureRetainedProcessOwner).mockImplementationOnce(() => {
    throw new RemoteInstanceError("recovery_required", "Bridge process identity cannot be captured.");
  });
  vi.mocked(stopProcessGroupLeaderFirst).mockImplementationOnce(async () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });

  await expect(spawnBridge({ spec, initializeTimeoutMs: 100, clientVersion: "fixture", handlers }))
    .rejects.toMatchObject({ code: "agent_unavailable", retryable: true, diagnostic: "bridge_process_identity_capture_failed" });
  expect(stopProcessGroupLeaderFirst).toHaveBeenCalledOnce();
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});

it("keeps identity-capture failure terminal when spawned-process exit is unconfirmed", async () => {
  const child = childProcess();
  vi.mocked(spawnPiped).mockReturnValueOnce(child);
  vi.mocked(captureRetainedProcessOwner).mockImplementationOnce(() => {
    throw new RemoteInstanceError("recovery_required", "Bridge process identity cannot be captured.");
  });

  await expect(spawnBridge({ spec, initializeTimeoutMs: 100, clientVersion: "fixture", handlers }))
    .rejects.toMatchObject({ code: "recovery_required" });
  expect(stopProcessGroupLeaderFirst).toHaveBeenCalledOnce();
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});

it("refuses an unobserved process exit and retains the provisional stop owner for retry", async () => {
  const child = childProcess();
  vi.mocked(spawnPiped).mockReturnValueOnce(child);
  vi.mocked(captureRetainedProcessOwner).mockReturnValueOnce({ version: 1, platform: "darwin", pid: child.pid!, processGroupId: child.pid!, startToken: "start", commandDigest: "digest" });
  const owners: BridgeStopOwner[] = [];
  await expect(spawnBridge({
    spec,
    initializeTimeoutMs: 100, clientVersion: "fixture",
    // Abort before SDK initialization: this exercises the real provisional
    // owner without creating an agent, a model prompt or user credentials.
    onProcessOwner: owner => { owners.push(owner); throw new Error("fixture initialization aborted"); },
    handlers,
  })).rejects.toThrow();
  expect(owners).toHaveLength(1);
  expect(owners[0]!.exited).toBe(false);
  await expect(owners[0]!.stop()).rejects.toThrow("Bridge process exit remains unconfirmed");
  child.exitCode = 0;
  child.emit("exit", 0, null);
  vi.mocked(isProcessGroupAlive).mockReturnValueOnce(true);
  await expect(owners[0]!.stop()).rejects.toThrow("Bridge process group exit remains unconfirmed");
  await expect(owners[0]!.stop()).resolves.toBeUndefined();
  expect(owners[0]!.exited).toBe(true);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});
