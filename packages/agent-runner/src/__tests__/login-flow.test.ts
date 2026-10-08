import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { spawnPiped, stopProcessGroupLeaderFirst } from "@konteks/remote-common";
import { findAgentBridge } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import { startLoginFlow } from "../auth/login-flow.js";
vi.mock("@konteks/remote-common", async original => ({ ...await original<object>(), spawnPiped: vi.fn(), stopProcessGroupLeaderFirst: vi.fn(async () => undefined) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  vi.mocked(spawnPiped).mockReturnValue(child as never);
  const events = new RunnerEventBus();
  const seen: RunnerEvent[] = [];
  events.subscribe(event => { seen.push(event); });
  const flow = startLoginFlow({ config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "claude-code" }), family: findAgentBridge("claude-code")!, env: {}, events, timeoutMs: 1000 });
  return { child, seen, flow };
}
it.each(["Paste the authorization code here: ", "Paste code here if prompted > "])("relays a split prompt without a trailing newline: %s", async prompt => {
  vi.useFakeTimers();
  const f = fixture();
  f.child.stdout.write(prompt.slice(0, 10));
  f.child.stdout.write(prompt.slice(10));
  await vi.advanceTimersByTimeAsync(200);
  expect(f.seen).toContainEqual(expect.objectContaining({ event: { type: "prompt", label: prompt.trim(), secret: false } }));
  f.child.emit("close", 0);
  await f.flow.done;
});
it("explains timeout to the caller and stops the login process", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.seen).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "display", text: expect.stringMatching(/timed out.*retry/i) }) }));
  expect(stopProcessGroupLeaderFirst).toHaveBeenCalled();
  f.child.emit("close", null);
  expect(await f.flow.done).toEqual({ code: null });
});
it("handles asynchronous executable launch errors without crashing the connector", async () => {
  const f = fixture();
  f.child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
  expect(await f.flow.done).toEqual({ code: null });
  expect(f.seen).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "display", text: expect.stringMatching(/could not start.*ENOENT/i) }) }));
  f.child.emit("close", -2);
});

it("clears timeout and progress after completion", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.child.emit("close", 0);
  await f.flow.done;
  const count = f.seen.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.seen).toHaveLength(count);
});

it("reports elapsed time during a silent wait without interrupting code entry", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  vi.mocked(spawnPiped).mockReturnValue(child as never);
  const events = new RunnerEventBus();
  const seen: RunnerEvent[] = [];
  events.subscribe(event => { seen.push(event); });
  const flow = startLoginFlow({ config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "claude-code" }), family: findAgentBridge("claude-code")!, env: {}, events, timeoutMs: 120_000 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(seen).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ text: expect.stringContaining("30 seconds") }) }));
  child.stdout.write("Paste the authorization code here: ");
  await vi.advanceTimersByTimeAsync(200);
  const count = seen.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(seen).toHaveLength(count);
  child.emit("close", 0);
  await flow.done;
});

it("keeps arbitrary partial output buffered across pauses", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.child.stdout.write("unfin");
  await vi.advanceTimersByTimeAsync(200);
  expect(f.seen).toEqual([]);
  f.child.stdout.write("ished line\n");
  expect(f.seen).toContainEqual(expect.objectContaining({ event: { type: "display", text: "unfinished line" } }));
  f.child.emit("close", 0);
  await f.flow.done;
});
