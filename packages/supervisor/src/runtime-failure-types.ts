import type { RuntimeFailureObservation } from "@konteks/remote-common";

/** Capture owners provide facts; the supervisor supplies identity and scope. */
export type RuntimeFailureFact = Pick<
  RuntimeFailureObservation,
  "phase" | "stage" | "code" | "evidence" | "pathRole" | "toolCallId" | "retryable" | "requestId"
>;

export interface RuntimeFailureContext {
  assignmentId: string;
  attempt: number;
}

export type RuntimeFailureReporter = (
  fact: RuntimeFailureFact,
  context: RuntimeFailureContext,
) => void | Promise<void>;

/** Historical diagnostic delivery never joins preparation or turn settlement. */
export function reportRuntimeFailure(
  reporter: RuntimeFailureReporter | undefined,
  fact: RuntimeFailureFact,
  context: RuntimeFailureContext,
): void {
  if (!reporter) return;
  try {
    void Promise.resolve(reporter(fact, context)).catch(() => undefined);
  } catch {
    /* Diagnostic failure must not replace the operation's own result. */
  }
}
