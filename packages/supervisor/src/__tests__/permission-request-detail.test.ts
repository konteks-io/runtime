import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { SECRET_CANARIES } from "@konteks/remote-common";
import { describe, expect, it } from "vitest";
import { PERMISSION_REQUEST_DETAIL_MAX, permissionRequestDetail } from "../session/permission-request-detail.js";

type Request = RequestPermissionRequest;

function request(toolCall: Record<string, unknown>): Request {
  return { sessionId: "acp-1", options: [], toolCall } as unknown as Request;
}

describe("permission request detail", () => {
  it("captures the exact shell command as one redacted line", () => {
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "execute", rawInput: { command: "npm run build\n\t--workspace=supervisor" } })))
      .toBe("npm run build --workspace=supervisor");
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "execute", rawInput: { command: `echo ${SECRET_CANARIES.anthropicKey}` } })))
      .toBe("echo [redacted]");
  });

  it("captures a file path from the request, whichever field names it", () => {
    const filePath = "/private/native/checkout/notes.txt";
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "edit", rawInput: { file_path: filePath } }))).toBe(filePath);
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "read", locations: [{ path: filePath }] }))).toBe(filePath);
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "edit", rawInput: { file_path: filePath }, locations: [{ path: "/private/native/other.txt" }] })))
      .toBe(`${filePath}, /private/native/other.txt`);
  });

  it("captures a fetch URL", () => {
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "fetch", rawInput: { url: "https://example.com/report" } })))
      .toBe("https://example.com/report");
  });

  it("returns nothing when the request names no identifying detail", () => {
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "execute", rawInput: { command: ["size", "--memory"] } }))).toBeUndefined();
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "execute", rawInput: {} }))).toBeUndefined();
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "edit", rawInput: {} }))).toBeUndefined();
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "edit", locations: [null] }))).toBeUndefined();
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "other", rawInput: { command: "rm -rf /" } }))).toBeUndefined();
  });

  it("redacts before it bounds, and never exceeds the detail bound", () => {
    const detail = permissionRequestDetail(request({ toolCallId: "t", kind: "execute", rawInput: { command: `echo ${"a".repeat(700)}` } }));
    expect(detail).toBeDefined();
    expect([...detail!].length).toBeLessThanOrEqual(PERMISSION_REQUEST_DETAIL_MAX);
    expect(detail!.endsWith("…")).toBe(true);
    const secretAtTheCut = permissionRequestDetail(request({ toolCallId: "t", kind: "execute",
      rawInput: { command: `${"b".repeat(500)} ${SECRET_CANARIES.anthropicKey} ${"c".repeat(50)}` } }));
    expect(secretAtTheCut).not.toContain(SECRET_CANARIES.anthropicKey);
    expect(secretAtTheCut).toContain("[redacted]");
  });

  it("drops the code points the card sanitizer drops", () => {
    expect(permissionRequestDetail(request({ toolCallId: "t", kind: "execute", rawInput: { command: "a\u202eb\u0000c\u2066d" } })))
      .toBe("a b c d");
  });
});
