import { describe, expect, it } from "vitest";
import type { ConnectedAgentView } from "@konteks/remote-common";
import { cancellationNamesAssignment } from "../control/cancellation-receiver.js";
import { agentSatisfiesRole } from "../inventory/roles.js";
import { acceptedWorkKinds } from "../work/accepted-kinds.js";
import { conversationTurnSource, isAssistantTurnKind, isNativeTurn } from "../work/continued-session.js";

/**
 * An ops session's turn (prod 10-30): Core placed an `operations` assignment
 * on a runtime that never asked for the kind, so it stayed queued until it
 * expired and the ops session never ran. The kind is a conversation turn under
 * the `ops` role, asked for from a Core that signs contract 7.1.
 */
const conversation = { kind: "conversation", sessionId: "session-1" } as const;

describe("operations work", () => {
  it("is asked for from a Core that signs contract 7.1 or later", () => {
    expect(acceptedWorkKinds(undefined)).not.toContain("operations");
    expect(acceptedWorkKinds("7.1")).toContain("operations");
    expect(acceptedWorkKinds("7.27")).toEqual(expect.arrayContaining(["operations", "assistant_execution"]));
  });

  it("runs as a conversation turn, like an ordinary Assistant turn", () => {
    const operations = { kind: "operations", source: conversation } as never;
    expect(conversationTurnSource(operations)).toEqual(conversation);
    expect(isNativeTurn(operations)).toBe(true);
  });

  it("is an Assistant turn Core may cancel by its session", () => {
    expect(isAssistantTurnKind("operations")).toBe(true);
    expect(isAssistantTurnKind("onboarding")).toBe(false);
    expect(cancellationNamesAssignment({ kind: "operations", source: conversation } as never, "session-1")).toBe(true);
    expect(cancellationNamesAssignment({ kind: "operations", source: conversation } as never, "session-2")).toBe(false);
  });

  it("is carried by any ready agent under the ops role", () => {
    const ready = { agentId: "codex", readiness: "ready", connectionState: "ready" } as unknown as ConnectedAgentView;
    expect(agentSatisfiesRole(ready, "ops", { gitVersion: null })).toBe(true);
    expect(agentSatisfiesRole({ ...ready, readiness: "unavailable" } as ConnectedAgentView, "ops", { gitVersion: null })).toBe(false);
  });
});
