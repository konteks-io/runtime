import { describe, expect, it } from "vitest";
import { nativePermissionEscalation } from "../session/native-permission-escalation.js";

const options = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

describe("a native escalation the person reads on the card", () => {
  it("says in plain words that the command reaches outside the session's folder", () => {
    // 10-09: the card read "Command outside normal session authority: …".
    const request = {
      sessionId: "acp-1",
      toolCall: { toolCallId: "tool-1", title: "Check if target file already exists", kind: "execute", locations: [{ path: "/tmp/tally-result.txt" }] },
      options,
    };
    const decision = nativePermissionEscalation(request as never,
      { agentId: "claude-code", cwd: "/work/session", workspaceRoot: "/work/session", readOnlyRoots: [] } as never,
      { kind: "native", tool: "Bash" } as never, () => true);
    expect(decision).toMatchObject({ kind: "defer", title: "Outside this session's folder: Check if target file already exists" });
  });
});
