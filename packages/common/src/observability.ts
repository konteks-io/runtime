import { randomUUID } from "node:crypto";
import {
  OBSERVABILITY_CONTRACT_VERSIONS,
  ObservabilityContextV1Schema,
  type ObservabilityContextV1,
} from "@konteks/backstage-plugin-common";

const TraceCarrierSchema = ObservabilityContextV1Schema.pick({
  traceparent: true,
  tracestate: true,
});

export interface RuntimeAdmissionObservabilityInput {
  runtimeIncarnationId: string;
  assignmentId: string;
  attempt: number;
  claimId: string;
  executionId: string;
  /** A diagnostic carrier from a supported future ingress, revalidated here. */
  trace?: {
    traceparent: string;
    tracestate?: string;
  };
}

/** Generate a non-zero W3C trace or child span identifier from a UUID source. */
function nextTraceId(newId: () => string): string {
  return newId().replaceAll("-", "");
}

/**
 * Create validated, diagnostic-only causal context after an admission is durable.
 *
 * This function never supplies authority, routing, idempotency, or journal
 * identity. A supplied W3C parent carries only trace correlation: its trace ID,
 * version, flags, and tracestate continue while this runtime receives a new
 * span ID.
 */
export function createRuntimeAdmissionObservabilityContext(
  input: RuntimeAdmissionObservabilityInput,
  newSpanId: () => string = () => nextTraceId(randomUUID).slice(0, 16),
): ObservabilityContextV1 {
  const trace = input.trace ? TraceCarrierSchema.parse(input.trace) : undefined;
  const [version = "00", traceId = nextTraceId(randomUUID), _parentId, flags = "01"] = trace?.traceparent.split("-") ?? [];

  return ObservabilityContextV1Schema.parse({
    schemaVersion: OBSERVABILITY_CONTRACT_VERSIONS.context,
    traceparent: `${version}-${traceId}-${newSpanId()}-${flags}`,
    ...(trace?.tracestate ? { tracestate: trace.tracestate } : {}),
    runtimeIncarnationId: input.runtimeIncarnationId,
    assignmentId: input.assignmentId,
    attempt: input.attempt,
    claimId: input.claimId,
    executionId: input.executionId,
  });
}
