import { describe, expect, it } from "vitest";
import { createRuntimeAdmissionObservabilityContext } from "../observability.js";

describe("createRuntimeAdmissionObservabilityContext", () => {
  it("continues a validated W3C trace after durable admission without changing durable identity", () => {
    const context = createRuntimeAdmissionObservabilityContext({
      runtimeIncarnationId: "runtime-7",
      assignmentId: "assignment-1",
      attempt: 2,
      claimId: "claim-1",
      executionId: "execution-1",
      trace: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "konteks=runtime",
      },
    }, () => "1111111111111111");

    expect(context).toEqual({
      schemaVersion: "observability-context-v1",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
      tracestate: "konteks=runtime",
      runtimeIncarnationId: "runtime-7",
      assignmentId: "assignment-1",
      attempt: 2,
      claimId: "claim-1",
      executionId: "execution-1",
    });
  });

  it("rejects an invalid W3C parent instead of logging an unvalidated carrier", () => {
    expect(() => createRuntimeAdmissionObservabilityContext({
      runtimeIncarnationId: "runtime-7",
      assignmentId: "assignment-1",
      attempt: 2,
      claimId: "claim-1",
      executionId: "execution-1",
      trace: { traceparent: "not-a-traceparent" },
    }, () => "1111111111111111")).toThrow();
  });
});
