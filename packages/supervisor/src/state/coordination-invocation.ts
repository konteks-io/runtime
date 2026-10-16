import { z } from "zod";
import { NativeCoordinationInvocationSchema, type NativeCoordinationInvocation } from "@konteks/remote-common";

/** Provider call identity and digest only; no incoming/outgoing coordination content. */
export const CoordinationInvocationRecordSchema = NativeCoordinationInvocationSchema.extend({
  state: z.enum(["captured", "completed"]), capturedAt: z.string().datetime(),
}).strict();
export type CoordinationInvocationRecord = z.infer<typeof CoordinationInvocationRecordSchema>;

export function coordinationInvocationKey(value: Pick<NativeCoordinationInvocation, "workspaceId" | "assignmentId" | "attempt" | "acpSessionRef" | "operationId" | "toolCallId">): string {
  return JSON.stringify([value.workspaceId, value.assignmentId, value.attempt, value.acpSessionRef, value.operationId, value.toolCallId]);
}
