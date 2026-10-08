import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { stopRetainedProcessOwner, type RetainedProcessOwner } from "../retained-process-owner.js";

// Unexecuted source regression: every OS query is mocked; production parser is used.
const query = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: query }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const record = {
  ProcessId: 123,
  ParentProcessId: 0,
  CreationDate: "123456789",
  CommandLine: "",
  ExecutablePath: "",
};
const owner: RetainedProcessOwner = {
  version: 1,
  platform: "win32",
  pid: 123,
  processGroupId: 123,
  startToken: record.CreationDate,
  commandDigest: createHash("sha256").update(`123\0${record.CreationDate}`).digest("base64url"),
};
const result = (stdout: string, status: number | null = 0) => ({
  stdout,
  status,
  error: undefined,
});
const absent = () => result(JSON.stringify({ complete: true, first: null, second: null }));
const present = () => result(JSON.stringify({ complete: true, first: record, second: record }));
const noTree = () => result(JSON.stringify({ present: false }));

beforeEach(() => {
  query.mockReset();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("default Windows retained observations", () => {
  it.each([
    result("", null),
    result("", 1),
    result(""),
    result("not-json"),
    result("[]"),
    result("{}"),
    result('{"complete":true}'),
    result(JSON.stringify({ complete: true, first: record, second: null })),
    result(
      JSON.stringify({
        complete: true,
        first: record,
        second: { ...record, CreationDate: "replacement" },
      }),
    ),
  ])("never acknowledges a failed or unstable identity observation", async (observation) => {
    query.mockReturnValue(observation);
    const terminateTree = vi.fn();
    await expect(stopRetainedProcessOwner(owner, { terminateTree })).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it.each([
    result("", null),
    result("", 1),
    result(""),
    result("{}"),
    result('{"present":"false"}'),
  ])("requires a successful structured descendant observation", async (observation) => {
    query.mockReturnValueOnce(absent()).mockReturnValueOnce(observation);
    const terminateTree = vi.fn();
    await expect(stopRetainedProcessOwner(owner, { terminateTree })).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it("accepts confirmed absent leader and descendants without signaling", async () => {
    query.mockReturnValueOnce(absent()).mockReturnValueOnce(noTree());
    const terminateTree = vi.fn();
    await expect(stopRetainedProcessOwner(owner, { terminateTree })).resolves.toBeUndefined();
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it("keeps post-termination query failure unconfirmed", async () => {
    query.mockReturnValueOnce(present()).mockReturnValueOnce(result("", null));
    const terminateTree = vi.fn();
    await expect(stopRetainedProcessOwner(owner, { terminateTree })).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(terminateTree).toHaveBeenCalledWith(123, false);
  });

  it("confirms real query absence after the matched termination attempt", async () => {
    query
      .mockReturnValueOnce(present())
      .mockReturnValueOnce(absent())
      .mockReturnValueOnce(noTree());
    const terminateTree = vi.fn();
    await expect(stopRetainedProcessOwner(owner, { terminateTree })).resolves.toBeUndefined();
    expect(terminateTree).toHaveBeenCalledWith(123, false);
  });
});
