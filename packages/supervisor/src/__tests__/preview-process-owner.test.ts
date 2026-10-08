import { describe, expect, it } from "vitest";
import { previewGroupAbsent, readPreviewIdentity } from "../preview/process-owner.js";
import type { RetainedProcessOwner } from "@konteks/remote-common";

// Actual-source fixtures only; no OS/process observation or fixture execution
// was performed during this security correction.
const owner: RetainedProcessOwner = {
  version: 1,
  platform: "linux",
  pid: 501,
  processGroupId: 501,
  startToken: "boot:100",
  commandDigest: "shell",
};

describe("preview ownership uses stable kernel identity and positive absence", () => {
  it("accepts a legitimate exec label change but does not normalize PID/start/group replacement", () => {
    expect(
      readPreviewIdentity(owner, 501, () => ({ ...owner, commandDigest: "dev-server" })),
    ).toMatchObject(owner);
    const replacement = { ...owner, startToken: "boot:101", commandDigest: "unrelated" };
    expect(readPreviewIdentity(owner, 501, () => replacement)).toEqual(replacement);
    const moved = { ...owner, processGroupId: 502, commandDigest: "moved" };
    expect(readPreviewIdentity(owner, 501, () => moved)).toEqual(moved);
    expect(readPreviewIdentity(owner, 501, () => null)).toBeNull();
    expect(() =>
      readPreviewIdentity(owner, 501, () => {
        throw new Error("query failed");
      }),
    ).toThrow("query failed");
  });

  it("treats only ESRCH as POSIX group absence and preserves permission/unknown errors", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const absent = () => {
      throw Object.assign(new Error("absent"), { code: "ESRCH" });
    };
    expect(previewGroupAbsent(501, process.platform, absent)).toBe(true);
    expect(previewGroupAbsent(501, process.platform, () => undefined)).toBe(false);
    expect(() =>
      previewGroupAbsent(501, process.platform, () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }),
    ).toThrow("could not be observed");
    expect(() =>
      previewGroupAbsent(501, process.platform, () => {
        throw new Error("unknown");
      }),
    ).toThrow("could not be observed");
  });

  it("never uses the POSIX observation as Windows or cross-platform absence", () => {
    const absent = () => {
      throw Object.assign(new Error("absent"), { code: "ESRCH" });
    };
    expect(previewGroupAbsent(501, "win32", absent)).toBe(false);
    const other = process.platform === "darwin" ? "linux" : "darwin";
    expect(previewGroupAbsent(501, other, absent)).toBe(false);
  });
});
