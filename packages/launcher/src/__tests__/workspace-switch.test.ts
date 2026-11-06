import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { switchNativeWorkspace } from "../native/workspace-switch.js";
import { readOnboardState } from "../native/onboard-state.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "workspace-switch-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture() {
  const record = { instanceId: "old-instance", workspaceId: "old-workspace", controlPort: 41337 };
  const replies: Record<string, unknown> = {
    status: { instanceId: record.instanceId, workspaceId: record.workspaceId },
    drain: {}, "drain.status": { activeAssignments: 0, openSessions: 0 },
    "instance.retire": { outcome: "removed", activeAssignments: 0 },
  };
  const call = vi.fn(async (request: { op: string }, schema: { parse(value: unknown): unknown }) => schema.parse(replies[request.op]));
  const stop = vi.fn(async () => {}), confirm = vi.fn(async () => true);
  const output = { line: vi.fn(), result: vi.fn() };
  const load = vi.fn(async () => record as never);
  const input = { root, yes: true, output: output as never };
  const deps = { load, confirm, prepareStop: vi.fn(async () => stop), control: () => ({ call }) as never };
  return { input, deps, record, replies, call, stop, confirm, load, output };
}

it("retires only the matching runtime, confirms stop, and keeps identity, journal and agent logins", async () => {
  const f = fixture();
  for (const name of ["supervisor", "credentials"]) await mkdir(join(root, name));
  const preserved = ["supervisor/identity.json", "supervisor/journal", "credentials/provider-profile"];
  for (const path of preserved) await writeFile(join(root, path), `kept-${path}`);
  await switchNativeWorkspace(f.input, f.deps);
  expect(f.call.mock.calls.map(([request]) => request.op)).toEqual(["status", "drain", "drain.status", "instance.retire"]);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.call.mock.invocationCallOrder.at(-1)).toBeLessThan(f.stop.mock.invocationCallOrder[0]!);
  for (const path of preserved) expect(await readFile(join(root, path), "utf8")).toBe(`kept-${path}`);
  expect(await readOnboardState(root)).toMatchObject({ step: "reconnect" });
  expect(f.output.result).toHaveBeenCalledWith(expect.objectContaining({ state: "disconnected", workspaceId: "old-workspace" }));
});

it("does nothing when the person declines", async () => {
  const f = fixture(); f.input.yes = false; f.confirm.mockResolvedValue(false);
  await switchNativeWorkspace(f.input, f.deps);
  expect(f.call).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  expect(await readOnboardState(root)).toBeNull();
});

it.each([{ activeAssignments: 1, openSessions: 0 }, { activeAssignments: 0, openSessions: 1 }])("keeps the connection when work or sessions remain: %j", async state => {
  const f = fixture(); f.replies["drain.status"] = state;
  await expect(switchNativeWorkspace(f.input, f.deps)).rejects.toMatchObject({ code: "active_work" });
  expect(f.call.mock.calls.map(([request]) => request.op)).not.toContain("instance.retire");
  expect(f.stop).not.toHaveBeenCalled(); expect(await readOnboardState(root)).toBeNull();
});

it("refuses another workspace or runtime answering on the port", async () => {
  const f = fixture(); f.replies.status = { instanceId: "someone-else", workspaceId: "another-workspace" };
  await expect(switchNativeWorkspace(f.input, f.deps)).rejects.toThrow();
  expect(f.call).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
  expect(await readOnboardState(root)).toBeNull();
});

it("rechecks the confirmed identity after acquiring installer ownership", async () => {
  const f = fixture(); f.load.mockResolvedValueOnce(f.record as never).mockResolvedValueOnce({ ...f.record, instanceId: "replacement" } as never);
  await expect(switchNativeWorkspace(f.input, f.deps)).rejects.toMatchObject({ code: "registration_mismatch" });
  expect(f.call).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
});

it.each([{ outcome: "draining", activeAssignments: 0 }, { outcome: "removed", activeAssignments: 1 }])("requires an unambiguous completed retirement: %j", async reply => {
  const f = fixture(); f.replies["instance.retire"] = reply;
  await expect(switchNativeWorkspace(f.input, f.deps)).rejects.toMatchObject({ code: "active_work" });
  expect(f.stop).not.toHaveBeenCalled(); expect(f.output.result).not.toHaveBeenCalled();
});

it("keeps a reconnection intent after a lost retirement reply without claiming disconnection", async () => {
  const f = fixture();
  f.call.mockImplementation(async (request, schema) => { if (request.op === "instance.retire") throw new Error("reply lost"); return schema.parse(f.replies[request.op]); });
  await expect(switchNativeWorkspace(f.input, f.deps)).rejects.toThrow("reply lost");
  expect(await readOnboardState(root)).toMatchObject({ step: "reconnect" });
  expect(f.stop).not.toHaveBeenCalled(); expect(f.output.result).not.toHaveBeenCalled();
});

it("never reports success when physical stop cannot be confirmed", async () => {
  const f = fixture(); f.stop.mockRejectedValue(new Error("physical exit unknown"));
  await expect(switchNativeWorkspace(f.input, f.deps)).rejects.toThrow("physical exit unknown");
  expect(f.output.result).not.toHaveBeenCalled();
  expect(await readOnboardState(root)).toMatchObject({ step: "reconnect" });
});

it("does not retire anything when the original process ownership cannot be captured", async () => {
  const f = fixture(); f.deps.prepareStop.mockRejectedValue(new Error("process ownership unknown"));
  await expect(switchNativeWorkspace(f.input, f.deps)).rejects.toThrow("process ownership unknown");
  expect(f.call.mock.calls.map(([request]) => request.op)).not.toContain("instance.retire");
  expect(await readOnboardState(root)).toBeNull();
  expect(f.stop).not.toHaveBeenCalled();
});
