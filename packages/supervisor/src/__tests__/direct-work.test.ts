import { describe, expect, it } from "vitest";
import { RemoteWorkAssignmentSchema, type RemoteWorkAssignment } from "@konteks/remote-common";
import { continuedSession, isDirectAssignment, isNativeTurn } from "../work/continued-session.js";
import { cancellationNamesAssignment } from "../control/cancellation-receiver.js";

const base = {
  id: "asg", placementId: "pl", instanceId: "inst", workspaceId: "ws", taskId: "task", correlationId: "c", attempt: 1,
  expiresAt: "2026-09-30T00:00:00Z", requiredCapabilities: [],
  agentRoute: { requiredRole: "assistant", agentId: "claude-code" },
  policy: { maxDurationSeconds: 60, maxArtifactBytes: 1, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted",
    latestResumeAt: "2026-09-30T00:00:00Z", permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
} as const;
const direct = RemoteWorkAssignmentSchema.parse({ ...base, kind: "direct",
  source: { kind: "direct_session", portability: "instance_bound", ownerInstanceId: "inst", sessionId: "direct-1", turnRef: "t2", acpSessionRef: "acp-1" } });
const conversation = RemoteWorkAssignmentSchema.parse({ ...base, kind: "assistant_execution",
  source: { kind: "conversation", portability: "portable_before_claim", sessionId: "conv-1", turnRef: "t1" } });

describe("direct work on the connector (runtime-view R11)", () => {
  it("continues its session like a conversation, but is told apart from one", () => {
    expect(continuedSession(direct.source)).toMatchObject({ sessionId: "direct-1", turnRef: "t2", acpSessionRef: "acp-1" });
    expect(continuedSession(conversation.source)).toMatchObject({ sessionId: "conv-1" });
    expect(isDirectAssignment(direct)).toBe(true);
    expect(isDirectAssignment(conversation)).toBe(false);
    // One prompt per assignment, admitted by Core's permits, closed at its turn's end.
    expect(isNativeTurn(direct)).toBe(true);
    expect(isNativeTurn(conversation)).toBe(true);
    expect(isNativeTurn({ kind: "planning", source: { kind: "planning_intake" } } as unknown as RemoteWorkAssignment)).toBe(false);
  });

  it("a Core cancellation may name a direct prompt only by its own session", () => {
    const started = direct as Parameters<typeof cancellationNamesAssignment>[0];
    expect(cancellationNamesAssignment(started, "direct-1")).toBe(true);
    expect(cancellationNamesAssignment(started, "conv-1")).toBe(false);
    expect(cancellationNamesAssignment(conversation as Parameters<typeof cancellationNamesAssignment>[0], "conv-1")).toBe(true);
  });
});
