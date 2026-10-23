/** DSH 0.1.7-rc.2: dsh-acp's committed toolCallUpdate, id-only approval
 * after drainUpdates, and paired toolResultUpdate. The tool name is the
 * provider event's data.name, not the approval's display title. */
export const dshCoordinationArguments = {
  target: { kind: "ticket", id: "ticket-b" },
  kind: "question",
  body: "Which response schema should this ticket use?",
};

export const dshCoordinationCall = {
  sessionUpdate: "tool_call",
  toolCallId: "dsh-call-1",
  title: "mcp__konteks-platform__platform__coordination__send",
  kind: "other",
  status: "in_progress",
  rawInput: dshCoordinationArguments,
};

/** As the agent runner forwards it: the bridge's own session id removed. */
export const dshCoordinationPermission = {
  toolCall: { toolCallId: "dsh-call-1" },
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
};

export const dshCoordinationResult = {
  sessionUpdate: "tool_call_update",
  toolCallId: "dsh-call-1",
  status: "completed",
  content: [],
};
