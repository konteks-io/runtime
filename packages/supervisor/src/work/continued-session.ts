import { isDirectWorkKind, type RemoteWorkAssignment } from "@konteks/remote-common";

/**
 * The source of a turn that continues one ACP session across assignments: an
 * Assistant conversation, or a person's direct session on this computer
 * (`direct` work with a `direct_session` source). Both name
 * the logical session, the turn, and the previous turn's ACP reference; both
 * work in the session's private folder. What sets a direct session apart
 * (no instructions, no Konteks tools, the tighter file root) is asked with
 * {@link isDirectAssignment}.
 */
type ContinuedSessionSource = Extract<RemoteWorkAssignment["source"], { kind: "conversation" | "direct_session" }>;

export function continuedSession(source: RemoteWorkAssignment["source"]): ContinuedSessionSource | null {
  return source.kind === "conversation" || source.kind === "direct_session" ? source : null;
}

/**
 * The logical session a turn runs in: a native delivery's execution session,
 * else the conversation or direct session it continues; undefined for work
 * with no logical session.
 */
export function logicalSessionId(source: RemoteWorkAssignment["source"]): string | undefined {
  if (source.kind === "harness_delivery") return source.executionSessionId;
  return continuedSession(source)?.sessionId;
}

/** A person's direct session prompt: no Konteks preamble, tools or result contract. */
export function isDirectAssignment(assignment: Pick<RemoteWorkAssignment, "kind">): boolean {
  return isDirectWorkKind(assignment.kind);
}

/**
 * One assignment per turn on a native session, closed when its turn ends and
 * admitted per operation through Core's signed permits: an Assistant turn, a
 * direct session prompt, or a native delivery turn.
 */
export function isNativeTurn(assignment: Pick<RemoteWorkAssignment, "kind" | "source">): boolean {
  return assignment.kind === "assistant_execution" || isDirectWorkKind(assignment.kind) || assignment.source.kind === "harness_delivery";
}
