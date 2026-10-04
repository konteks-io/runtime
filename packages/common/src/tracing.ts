import { context, propagation, ROOT_CONTEXT, trace, isSpanContextValid, SpanStatusCode, type Span } from "@opentelemetry/api";
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
  if (!validTraceEndpoint(endpoint)) return disabled("invalid_endpoint");
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

function validTraceEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ["http:", "https:"].includes(url.protocol) && ![url.username, url.password, url.search, url.hash].some(Boolean);
  } catch { return false; }
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
  const validated = parsed.success ? parsed.data : undefined;
  return trace.getTracer("konteks-native").startActiveSpan(name,
    { attributes: nativeAttributes(facts, validated) }, nativeParentScope(validated),
    span => executeNativeSpan(span, operation, classify));
}

function nativeParentScope(parent: ObservabilityContextV1 | undefined) {
  const active = trace.getSpanContext(context.active());
  const parentTraceId = parent?.traceparent.split("-")[1];
  if (active && isSpanContextValid(active) && (!parentTraceId || active.traceId === parentTraceId)) return context.active();
  if (!parent) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, {
    traceparent: parent.traceparent, ...(parent.tracestate ? { tracestate: parent.tracestate } : {}),
  });
}

function safeSpanIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function nativeAttributes(facts: NativeSpanFacts, parent: ObservabilityContextV1 | undefined) {
  const attributes: Record<string, string | number | boolean> = {
    "konteks.diagnostic.coverage": parent ? "correlated" : "local_only",
  };
  const identifiers = { assignmentId: facts.assignmentId, stage: facts.stage, tool: facts.tool,
    tenantId: parent?.tenantId, sessionId: parent?.sessionId, invocationId: parent?.invocationId };
  for (const [key, value] of Object.entries(identifiers)) {
    if (safeSpanIdentifier(value)) attributes[`konteks.${key}`] = value;
  }
  return withAuditAttributes(attributes, facts.attempt);
}

function withAuditAttributes(attributes: Record<string, string | number | boolean>, attempt: unknown) {
  if (attributes["konteks.assignmentId"]) attributes["konteks.audit.required"] = true;
  if (attributes["konteks.sessionId"]) attributes["konteks.session.id"] = attributes["konteks.sessionId"];
  if (typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0) attributes["konteks.attempt"] = attempt;
  return attributes;
}

const OUTCOME_STATUS: Record<NativeSpanOutcome["outcome"], SpanStatusCode> = {
  failed: SpanStatusCode.ERROR, refused: SpanStatusCode.ERROR,
  succeeded: SpanStatusCode.OK, unavailable: SpanStatusCode.UNSET,
};

function recordNativeOutcome(span: Span, outcome: NativeSpanOutcome): void {
  span.setAttribute("konteks.outcome", outcome.outcome);
  if (outcome.errorCode) span.setAttribute("konteks.error.code", outcome.errorCode);
  if (outcome.exitCode !== undefined) span.setAttribute("process.exit.code", outcome.exitCode);
  if (outcome.timedOut !== undefined) span.setAttribute("konteks.timed_out", outcome.timedOut);
  if (outcome.httpStatus !== undefined) span.setAttribute("http.response.status_code", outcome.httpStatus);
  span.setStatus({ code: OUTCOME_STATUS[outcome.outcome] });
}

async function executeNativeSpan<T>(span: Span, operation: () => Promise<T>, classify?: (result: T) => NativeSpanOutcome): Promise<T> {
  try {
    const result = await operation();
    recordNativeOutcome(span, classify?.(result) ?? { outcome: "succeeded" });
    return result;
  } catch (error) {
    recordNativeOutcome(span, { outcome: "failed", errorCode: error instanceof RemoteInstanceError ? error.code : "unexpected_error" });
    throw error;
  } finally { span.end(); }
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
