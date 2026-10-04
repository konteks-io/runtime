import { context, propagation, ROOT_CONTEXT, trace, isSpanContextValid, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ObservabilityContextV1Schema, type ObservabilityContextV1 } from "@konteks/backstage-plugin-common";
import { RemoteInstanceError } from "./errors.js";

export interface NativeTracing {
  enabled: boolean;
  reason?: "not_configured" | "invalid_endpoint" | "initialization_failed";
  shutdown(): Promise<void>;
}

/** Explicit opt-in only: a customer connector never discovers a telemetry destination. */
export function initializeNativeTracing(env: NodeJS.ProcessEnv = process.env): NativeTracing {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const disabled = (reason: NonNullable<NativeTracing["reason"]>): NativeTracing => ({ enabled: false, reason, shutdown: async () => undefined });
  if (!endpoint || env.OTEL_SDK_DISABLED === "true") return disabled("not_configured");
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return disabled("invalid_endpoint");
  } catch { return disabled("invalid_endpoint"); }
  try {
    const revision = env.KONTEKS_BUILD_GIT_SHA;
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ "service.name": "native-connector",
        ...(revision && /^[a-f0-9]{40}$/.test(revision) ? { "vcs.ref.head.revision": revision } : {}),
      }),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, timeoutMillis: 2_000 }), {
        maxQueueSize: 1_024, maxExportBatchSize: 128, scheduledDelayMillis: 1_000, exportTimeoutMillis: 2_000,
      })],
    });
    provider.register();
    return { enabled: true, shutdown: () => provider.shutdown() };
  } catch { return disabled("initialization_failed"); }
}

export interface NativeSpanFacts {
  assignmentId?: unknown;
  attempt?: unknown;
  stage?: string;
  tool?: string;
}

export interface NativeSpanOutcome {
  outcome: "succeeded" | "failed" | "unavailable" | "refused";
  errorCode?: string;
  exitCode?: number;
  timedOut?: boolean;
  httpStatus?: number;
}

/** Emit only bounded identifiers and typed outcomes; never exception messages or payloads. */
export async function withNativeSpan<T>(
  name: "native.bootstrap.stage" | "native.preview.tool" | "native.preview.request",
  parent: ObservabilityContextV1 | undefined,
  facts: NativeSpanFacts,
  operation: () => Promise<T>,
  classify?: (result: T) => NativeSpanOutcome,
): Promise<T> {
  const parsed = ObservabilityContextV1Schema.safeParse(parent);
  const active = trace.getSpanContext(context.active());
  const parentTraceId = parsed.success ? parsed.data.traceparent.split("-")[1] : undefined;
  const scope = active && isSpanContextValid(active) && (!parentTraceId || active.traceId === parentTraceId)
    ? context.active()
    : parsed.success ? propagation.extract(ROOT_CONTEXT, {
        traceparent: parsed.data.traceparent, ...(parsed.data.tracestate ? { tracestate: parsed.data.tracestate } : {}),
      }) : ROOT_CONTEXT;
  const attributes: Record<string, string | number | boolean> = { "konteks.diagnostic.coverage": parsed.success ? "correlated" : "local_only" };
  for (const [key, value] of Object.entries({ assignmentId: facts.assignmentId, stage: facts.stage, tool: facts.tool,
    tenantId: parsed.success ? parsed.data.tenantId : undefined, sessionId: parsed.success ? parsed.data.sessionId : undefined,
    invocationId: parsed.success ? parsed.data.invocationId : undefined })) {
    if (typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value)) attributes[`konteks.${key}`] = value;
  }
  // Keep assignment diagnostics even before the cloud context is bound. The
  // collector retains this audit attribute instead of sampling successful work.
  if (attributes["konteks.assignmentId"]) attributes["konteks.audit.required"] = true;
  if (attributes["konteks.sessionId"]) attributes["konteks.session.id"] = attributes["konteks.sessionId"];
  if (typeof facts.attempt === "number" && Number.isSafeInteger(facts.attempt) && facts.attempt > 0) attributes["konteks.attempt"] = facts.attempt;
  return trace.getTracer("konteks-native").startActiveSpan(name, { attributes }, scope, async span => {
    try {
      const result = await operation();
      const outcome = classify?.(result) ?? { outcome: "succeeded" as const };
      span.setAttribute("konteks.outcome", outcome.outcome);
      if (outcome.errorCode) span.setAttribute("konteks.error.code", outcome.errorCode);
      if (outcome.exitCode !== undefined) span.setAttribute("process.exit.code", outcome.exitCode);
      if (outcome.timedOut !== undefined) span.setAttribute("konteks.timed_out", outcome.timedOut);
      if (outcome.httpStatus !== undefined) span.setAttribute("http.response.status_code", outcome.httpStatus);
      span.setStatus({ code: outcome.outcome === "failed" || outcome.outcome === "refused" ? SpanStatusCode.ERROR : outcome.outcome === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.UNSET });
      return result;
    } catch (error) {
      span.setAttribute("konteks.outcome", "failed");
      span.setAttribute("konteks.error.code", error instanceof RemoteInstanceError ? error.code : "unexpected_error");
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally { span.end(); }
  });
}

/** Correlate an event with the actual active span, preserving only validated causal identifiers. */
export function nativeSpanLogContext(parent?: ObservabilityContextV1): ObservabilityContextV1 | undefined {
  const active = trace.getSpanContext(context.active());
  if (!active || !isSpanContextValid(active)) return parent;
  return ObservabilityContextV1Schema.parse({ ...parent, schemaVersion: "observability-context-v1",
    traceparent: `00-${active.traceId}-${active.spanId}-${active.traceFlags.toString(16).padStart(2, "0")}`,
    ...(active.traceState ? { tracestate: active.traceState.serialize() } : {}),
  });
}
