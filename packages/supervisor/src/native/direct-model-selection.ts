import {
  DirectModelSelectionSchema,
  DirectModelSelectionPolicySchema,
  directModelSelectionsEqual,
  REMOTE_DIRECT_MODEL_FALLBACK_CAPABILITY,
  RemoteInstanceError,
  type DirectModelSelection,
  type DirectModelSelectionPolicy,
  type RemoteWorkAssignment,
} from "@konteks/remote-common";

const refused = () =>
  new RemoteInstanceError(
    "capability_unavailable",
    "The direct model selection is not authorized by this assignment.",
  );

/** Optional authority comes only from this signed direct-session assignment. */
export function assertDirectModelAuthority(
  assignment: RemoteWorkAssignment,
  supported: boolean,
): void {
  const source = assignment.source;
  if (source.kind !== "direct_session") return;
  if (source.modelSelectionPolicy === undefined && source.modelSelection === undefined) return;
  if (
    assignment.kind !== "direct" ||
    !supported ||
    !assignment.requiredCapabilities.includes(REMOTE_DIRECT_MODEL_FALLBACK_CAPABILITY)
  )
    throw refused();
}

function matchesPolicy(assignment: RemoteWorkAssignment, receipt: DirectModelSelection): boolean {
  if (assignment.source.kind !== "direct_session") return false;
  const policy = DirectModelSelectionPolicySchema.safeParse(assignment.source.modelSelectionPolicy);
  if (!policy.success || policy.data.configId !== receipt.configId) return false;
  return policyMatchesSelection(
    policy.data,
    receipt,
    assignment.agentRoute.sessionConfig?.[receipt.configId],
  );
}

function policyMatchesSelection(
  policy: DirectModelSelectionPolicy,
  receipt: DirectModelSelection,
  admitted: string | undefined,
): boolean {
  if (policy.kind === "same_agent_default")
    return receipt.resolution === "agent_default" && admitted === undefined;
  return (
    receipt.resolution !== "agent_default" &&
    [policy.requestedValue, admitted].every((value) => value === receipt.requestedValue)
  );
}

function modelSource(assignment: RemoteWorkAssignment) {
  const source = assignment.source;
  if (source.kind !== "direct_session") return undefined;
  return source.modelSelectionPolicy !== undefined || source.modelSelection !== undefined
    ? source
    : undefined;
}

function assertRetainedSelection(
  receipt: DirectModelSelection,
  retained: DirectModelSelection | undefined,
): void {
  if (retained !== undefined && !directModelSelectionsEqual(retained, receipt)) throw refused();
}

/** Recovery may confirm the persisted pin, but must never choose a new default. */
export function admittedDirectModelReceipt(
  assignment: RemoteWorkAssignment,
  selection: unknown,
  retained?: DirectModelSelection,
): DirectModelSelection | undefined {
  const source = modelSource(assignment);
  if (!source) {
    if (selection !== undefined || retained !== undefined) throw refused();
    return undefined;
  }
  const parsed = DirectModelSelectionSchema.safeParse(selection);
  if (!parsed.success) throw refused();
  const receipt = parsed.data;
  const valid =
    source.modelSelection === undefined
      ? matchesPolicy(assignment, receipt)
      : directModelSelectionsEqual(source.modelSelection, receipt);
  if (!valid) throw refused();
  assertRetainedSelection(receipt, retained);
  return receipt;
}
