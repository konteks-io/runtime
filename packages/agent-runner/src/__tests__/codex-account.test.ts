import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PipedChildProcess } from "@konteks/remote-common";
import { findAgentBridge } from "@konteks/remote-release";
import { readCodexAccount } from "../auth/codex-account.js";
import { RunnerConfigSchema } from "../config.js";

function fixture(account: unknown) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString());
    requests.push(request);
    queueMicrotask(() => {
      if (request.method === "initialize") stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "codex" } })}\n`);
      if (request.method === "account/read") stdout.write(`${JSON.stringify({ id: 2, result: { account, requiresOpenaiAuth: true } })}\n`);
    });
    done();
  } });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr }) as PipedChildProcess;
  const spawn = vi.fn(() => child);
  const stop = vi.fn(async () => { stdin.destroy(); stdout.destroy(); stderr.destroy(); });
  const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex" });
  return { requests, spawn, stop, run: () => readCodexAccount(config, findAgentBridge("codex")!, {}, { spawn, stop }) };
}

describe("official Codex read-only account protocol", () => {
  it("initializes before reading without refreshing or changing login and always stops the probe", async () => {
    const f = fixture({ type: "chatgpt", email: "owner@example.test", planType: "pro", token: "not-projected" });
    await expect(f.run()).resolves.toBe("owner@example.test");
    expect(f.requests.map(row => row.method)).toEqual(["initialize", "initialized", "account/read"]);
    expect(f.requests[2]?.params).toEqual({ refreshToken: false });
    expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ args: ["app-server"] }));
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("reports the official absent account as logged out", async () => {
    const f = fixture(null);
    await expect(f.run()).resolves.toBeNull();
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it.each([{ type: "apiKey" }, { type: "chatgpt", email: null }, { type: "chatgpt", email: "" }])("refuses unproven account identity and cleans up", async account => {
    const f = fixture(account);
    await expect(f.run()).rejects.toThrow("probe unavailable");
    expect(f.stop).toHaveBeenCalledOnce();
  });
});
