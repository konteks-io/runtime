import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { initializeNativeTracing, nativeSpanLogContext, withNativeSpan } from "../tracing.js";
import { RemoteInstanceError } from "../errors.js";

let provider: NodeTracerProvider;
let exporter: InMemorySpanExporter;
beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});
afterEach(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable(); });

const parent = { schemaVersion: "observability-context-v1" as const,
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01", tenantId: "tenant", assignmentId: "assignment", attempt: 1 };

describe("native tracing", () => {
  it("requires an explicit safe destination and never treats bad telemetry configuration as execution authority", async () => {
    expect(initializeNativeTracing({})).toMatchObject({ enabled: false, reason: "not_configured" });
    expect(initializeNativeTracing({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces" }).enabled).toBe(false);
    for (const endpoint of ["not-a-url", "file:///tmp/trace", "https://token@collector.example/v1/traces", "https://collector.example/v1/traces?token=secret"])
      expect(initializeNativeTracing({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint })).toMatchObject({ enabled: false, reason: "invalid_endpoint" });
  });

  it("records an ERROR span and its matching log context without private error text", async () => {
    let captured: ReturnType<typeof nativeSpanLogContext>;
    await expect(withNativeSpan("native.bootstrap.stage", parent, { assignmentId: "assignment", attempt: 1, stage: "input_preparation" }, async () => {
      captured = nativeSpanLogContext(parent);
      throw new RemoteInstanceError("workspace_binding_invalid", "private-command-and-provider-body-canary");
    })).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    await provider.forceFlush();
    const span = exporter.getFinishedSpans()[0]!;
    expect(captured!.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(captured!.tenantId).toBe("tenant");
    expect(span.parentSpanContext?.spanId).toBe("0123456789abcdef");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({ "konteks.outcome": "failed", "konteks.error.code": "workspace_binding_invalid" });
    expect(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status })).not.toContain("private-command-and-provider-body-canary");
    expect(nativeSpanLogContext()).toBeUndefined();
  });

  it("keeps concurrent causal scopes independent and reports an expected unavailable outcome honestly", async () => {
    const contexts = await Promise.all(["a", "b"].map(assignmentId => withNativeSpan("native.preview.tool", { ...parent, assignmentId }, { assignmentId, tool: "preview_start" }, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return nativeSpanLogContext({ ...parent, assignmentId })!;
    }, () => ({ outcome: "unavailable", errorCode: "no_app" }))));
    expect(contexts.map(item => item.assignmentId)).toEqual(["a", "b"]);
    expect(new Set(contexts.map(item => item.traceparent)).size).toBe(2);
    await provider.forceFlush();
    expect(exporter.getFinishedSpans().every(span => span.status.code === SpanStatusCode.UNSET && span.attributes["konteks.outcome"] === "unavailable")).toBe(true);
    expect(nativeSpanLogContext()).toBeUndefined();
  });
});
