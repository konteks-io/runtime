import { describe, expect, it, vi } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { stopRetiredRuntimeForInstall } from "../native/commands.js";
import { createOutput } from "../output.js";

function fixture() {
  let now = 0;
  const events: string[] = [];
  const state = { assignments: 0, sessions: 0, changed: false };
  const stop = vi.fn(async () => { events.push("stop"); });
  const prepareStop = vi.fn(async () => { events.push("capture-owner"); return stop; });
  let reads = 0;
  const call = vi.fn(async (request: { op: string }, schema: { parse(value: unknown): unknown }) => {
    events.push(request.op);
    if (request.op === "status") {
      reads++;
      return schema.parse({ instanceId: state.changed && reads > 1 ? "other-runtime" : "retired-runtime", workspaceId: "test-workspace" });
    }
    if (request.op === "drain.status") return schema.parse({ draining: true, reason: "update", activeAssignments: state.assignments, openSessions: state.sessions });
    return schema.parse({});
  });
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const deps = { control: () => ({ call }) as never, prepareStop, now: () => now, sleep, deadlineMs: 2_000 };
  const input = { root: "/synthetic/reinstall-root", output: createOutput({ json: true }) };
  const record = { instanceId: "retired-runtime", workspaceId: "test-workspace" } as never;
  return { input, record, deps, stop, call, prepareStop, events, state };
}

describe("verified retired-runtime installation stop", () => {
  it("captures ownership, drains, rechecks identity, then uses the existing physical stop", async () => {
    const f = fixture();
    await stopRetiredRuntimeForInstall(f.input, f.record, f.deps);
    expect(f.events).toEqual(["status", "capture-owner", "drain", "drain.status", "status", "stop"]);
    expect(f.prepareStop).toHaveBeenCalledWith(f.input);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each(["assignments", "sessions"] as const)("does not stop while %s remain", async field => {
    const f = fixture();
    f.state[field] = 1;
    await expect(stopRetiredRuntimeForInstall(f.input, f.record, f.deps)).rejects.toMatchObject({ code: "active_work" });
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("waits for both work and sessions to settle", async () => {
    const f = fixture();
    f.state.assignments = 1;
    f.state.sessions = 1;
    const sleep = f.deps.sleep;
    f.deps.sleep = async ms => { await sleep(ms); f.state.assignments = 0; f.state.sessions = 0; };
    await stopRetiredRuntimeForInstall(f.input, f.record, f.deps);
    expect(sleep).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("refuses a different runtime answering the same local endpoint", async () => {
    const f = fixture();
    await expect(stopRetiredRuntimeForInstall(f.input, { instanceId: "unexpected", workspaceId: "test-workspace" } as never, f.deps)).rejects.toThrow();
    expect(f.prepareStop).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("does not stop an identity that changed while draining", async () => {
    const f = fixture();
    f.state.changed = true;
    await expect(stopRetiredRuntimeForInstall(f.input, f.record, f.deps)).rejects.toThrow();
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("does not drain or stop when physical ownership cannot be captured", async () => {
    const f = fixture();
    f.prepareStop.mockRejectedValueOnce(new RemoteInstanceError("recovery_required", "ownership unknown"));
    await expect(stopRetiredRuntimeForInstall(f.input, f.record, f.deps)).rejects.toMatchObject({ code: "recovery_required" });
    expect(f.events).toEqual(["status"]);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("preserves a refused physical stop instead of continuing installation", async () => {
    const f = fixture();
    f.stop.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "stop was not verified"));
    await expect(stopRetiredRuntimeForInstall(f.input, f.record, f.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(f.stop).toHaveBeenCalledOnce();
  });
});
