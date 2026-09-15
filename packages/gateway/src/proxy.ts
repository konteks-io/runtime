import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createLogger, type CapEnforcementStage, type Logger } from "@konteks/remote-common";
import type { EgressAllowlistIndex } from "./allowlist.js";
import { decideCap, type AssignmentRegistry } from "./caps.js";
import { dialectFor, type ProviderDialect } from "./dialects/index.js";
import type { KeyVault } from "./keys.js";
import { buildObservation, type ObservationSink } from "./observation.js";

/**
 * The egress proxy. A keyed runner's bridge is configured with a base URL of
 * the form `http://gateway:41810/agents/<agentId>/<provider>`; everything after
 * that is the provider path. The gateway:
 *   1. matches provider + path against the signed allowlist (host comes from
 *      the allowlist, never from the agent);
 *   2. stamps the in-memory key for that agent;
 *   3. applies the cap for the agent's bound assignment;
 *   4. streams the response back while observing on-wire usage;
 *   5. emits a GatewayCallObservation.
 * It never logs, stores, or relays a prompt, response body, header, or key.
 */
const ROUTE = /^\/agents\/([a-z0-9][a-z0-9-]{0,63})\/(anthropic|openai|google|deepseek)(\/.*)$/;
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const FORBIDDEN_INBOUND = new Set(["cookie", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via"]);

export interface GatewayProxyOptions {
  port: number;
  instanceId: () => string;
  allowlist: EgressAllowlistIndex;
  keys: KeyVault;
  assignments: AssignmentRegistry;
  stage: () => CapEnforcementStage;
  sink: ObservationSink;
  fetchFn?: typeof fetch;
  now?: () => Date;
  logger?: Logger;
}

export interface GatewayProxyStats {
  calls: number;
  blocked: number;
  streamCuts: number;
  unkeyed: number;
  unbound: number;
  upstreamFailures: number;
}

export interface GatewayProxy {
  server: Server;
  stats(): GatewayProxyStats;
  close(): Promise<void>;
}

export function startGatewayProxy(options: GatewayProxyOptions): Promise<GatewayProxy> {
  const logger = options.logger ?? createLogger({ name: "gateway-proxy" });
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const stats: GatewayProxyStats = { calls: 0, blocked: 0, streamCuts: 0, unkeyed: 0, unbound: 0, upstreamFailures: 0 };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.warn({ err: error }, "gateway request failed");
      if (!response.headersSent) sendJson(response, 502, { error: { type: "gateway_error", code: "upstream_failed" } });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = ROUTE.exec(request.url ?? "");
    if (!route) {
      sendJson(response, 404, { error: { type: "gateway_error", code: "route_unknown" } });
      return;
    }
    const agentId = route[1] ?? "";
    const provider = route[2] ?? "";
    const path = route[3] ?? "/";
    const method = request.method ?? "GET";
    const dialect = dialectFor(provider);
    const match = options.allowlist.match(provider, path);
    if (!dialect || !match) {
      stats.blocked += 1;
      sendJson(response, 403, { error: { type: "gateway_error", code: "egress_not_allowed" } });
      return;
    }
    const key = options.keys.use(agentId);
    if (key === null) {
      stats.unkeyed += 1;
      sendJson(response, 401, { error: { type: "gateway_error", code: "gateway_key_missing", agentId } });
      return;
    }
    const binding = options.assignments.get(agentId);
    if (binding === null) {
      stats.unbound += 1;
      sendJson(response, 403, { error: { type: "gateway_error", code: "no_active_assignment", agentId } });
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      sendJson(response, 413, { error: { type: "gateway_error", code: "request_too_large" } });
      return;
    }

    const isModelCall = dialect.isModelCall(method, path);
    const parsed = isModelCall ? dialect.parseRequest(path, body) : null;
    const stage = options.stage();
    let upstreamBody = body;
    let appliedMaxTokens: number | undefined;
    let cutAt: number | null = null;
    if (isModelCall && parsed !== null) {
      const decision = decideCap({ stage, dialect, request: parsed, body, binding });
      if (decision.kind === "block") {
        stats.blocked += 1;
        sendJson(response, 429, { error: { type: "gateway_error", code: "cap_blocked", reason: decision.reason } });
        return;
      }
      upstreamBody = decision.body;
      if (decision.kind === "forward" && decision.appliedMaxTokens !== undefined) appliedMaxTokens = decision.appliedMaxTokens;
      if (decision.kind === "forward_stream_cut") cutAt = decision.cutAtOutputTokens;
    }

    const headers = outboundHeaders(request, dialect);
    dialect.stampKey(headers, key);
    const upstreamUrl = new URL(`https://${match.host}${match.path}`);
    let upstream: Response;
    try {
      upstream = await fetchFn(upstreamUrl, {
        method,
        headers,
        // A fresh copy is a `Uint8Array<ArrayBuffer>`, which is what BodyInit accepts.
        ...(method === "GET" || method === "HEAD" ? {} : { body: Uint8Array.from(upstreamBody) }),
        redirect: "manual",
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      stats.upstreamFailures += 1;
      logger.warn({ provider, agentId, err: error }, "provider upstream unreachable");
      sendJson(response, 502, { error: { type: "gateway_error", code: "provider_unreachable" } });
      return;
    }
    stats.calls += 1;
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) {
      if (HOP_BY_HOP.has(name) || name === "content-encoding" || name === "set-cookie") continue;
      response.setHeader(name, value);
    }

    if (!isModelCall || parsed === null) {
      await pipeVerbatim(upstream, response);
      return;
    }

    const streamParser = dialect.createStreamUsageParser();
    let usage = null as ReturnType<typeof dialect.parseResponseUsage>;
    if (parsed.stream && upstream.body) {
      const reader = upstream.body.getReader();
      let cut = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          streamParser.push(value);
          response.write(value);
          const soFar = streamParser.outputTokensSoFar();
          if (cutAt !== null && soFar !== null && soFar >= cutAt) {
            cut = true;
            stats.streamCuts += 1;
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      } finally {
        response.end();
      }
      usage = streamParser.usage();
      // CONTRACT-GAP: installation-and-auth.md says stream cutting "is reported
      // as such", but GatewayCallObservation has no field for it. The degraded
      // mode is therefore visible as `capEnforcement: 'provider_enforce'`
      // WITHOUT `appliedMaxTokens` on the observation, plus the gateway's
      // `streamCuts` counter on /health (surfaced by doctor/support). CP1/CP3
      // may add an explicit marker; the gateway will populate it.
      if (cut) logger.info({ provider, agentId }, "stream cut at cap (degraded provider_enforce)");
    } else {
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      usage = dialect.parseResponseUsage(bytes);
      response.end(Buffer.from(bytes));
    }

    if (usage?.outputTokens !== undefined) options.assignments.debit(agentId, usage.outputTokens);
    const observation = buildObservation({
      instanceId: options.instanceId(),
      assignmentId: binding.assignmentId,
      attempt: binding.attempt,
      agentId,
      provider,
      requestModel: parsed.model,
      usage,
      capEnforcement: stage,
      ...(appliedMaxTokens === undefined ? {} : { appliedMaxTokens }),
      observedAt: now().toISOString(),
    });
    await options.sink.emit(observation);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      logger.info({ port: options.port }, "gateway proxy listening");
      resolve({
        server,
        stats: () => ({ ...stats }),
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

function outboundHeaders(request: IncomingMessage, dialect: ProviderDialect): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || FORBIDDEN_INBOUND.has(lower) || dialect.credentialHeaders.includes(lower)) continue;
    if (lower.startsWith("x-konteks-")) continue;
    headers.set(lower, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function pipeVerbatim(upstream: Response, response: ServerResponse): Promise<void> {
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(upstream.body as never)
      .on("error", reject)
      .on("end", resolve)
      .pipe(response);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}
