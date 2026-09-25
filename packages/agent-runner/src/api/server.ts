import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { RemoteInstanceError, RemoteSessionLabelSchema, createLogger, type Logger } from "@konteks/remote-common";
import type { AgentRuntime } from "../runtime.js";
import { SessionContextSchema } from "../sessions/manager.js";

/**
 * The runner's internal API, reachable only from the supervisor on the
 * control network. Closed routes; strict bodies; the event stream is a
 * WebSocket at `/events`. Nothing here is reachable from another runner, a
 * component, or the host.
 *
 * // CONTRACT-GAP: both domain components expect a local ACP ATTACH STREAM
 * // from this runner rather than this HTTP session API — the Harness's
 * // `AgentRunnerProcess` and the Validation Runtime's `agentRunnerSpawner`
 * // each open a duplex socket and speak ACP as the client. This runner is
 * // itself the ACP client and serves no such stream, so neither component can
 * // reach an agent. See `proof/AGENT-ATTACH-SEAM.md` for the convergence:
 * // a per-connection attach listener that spawns the pinned bridge and pipes
 * // its stdio, which keeps credentials and the pinned artifact on this side.
 */
const McpServerSchema = z.union([
  z.object({ type: z.literal("http"), name: z.string().min(1), url: z.string().url(), headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()) }).strict(),
  z.object({ type: z.literal("sse"), name: z.string().min(1), url: z.string().url(), headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()) }).strict(),
]);

const CreateSessionSchema = z
  .object({
    context: SessionContextSchema,
    cwd: z.string().min(1),
    mcpServers: z.array(McpServerSchema).max(8),
    sessionConfig: z.record(z.string(), z.string()).optional(),
    acpSessionRef: z.string().min(1).max(256).optional(),
    sessionLabel: RemoteSessionLabelSchema.optional(),
  })
  .strict();

const RequestEnvelopeSchema = z.object({ id: z.string().min(1).max(128), params: z.record(z.string(), z.unknown()) }).strict();
const AnswerSchema = z.object({ requestId: z.string().min(1), response: z.record(z.string(), z.unknown()) }).strict();
const LoginSchema = z.object({ organization: z.boolean(), loginId: z.string().min(1).max(128).optional() }).strict();
const LoginInputSchema = z.object({ loginId: z.string().min(1), text: z.string().max(8_192) }).strict();
const LoginIdSchema = z.object({ loginId: z.string().min(1) }).strict();

export interface RunnerApiOptions {
  port: number;
  runtime: AgentRuntime;
  logger?: Logger;
}

export function startRunnerApi(options: RunnerApiOptions): Promise<Server> {
  const logger = options.logger ?? createLogger({ name: "runner-api" });
  const { runtime } = options;
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof RemoteInstanceError) {
        sendJson(response, statusFor(error), error.toJSON());
        return;
      }
      logger.warn({ err: error }, "runner api request failed");
      sendJson(response, 500, { code: "internal", message: "runner request failed", recoveryActions: [] });
    });
  });

  const events = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/events") {
      socket.destroy();
      return;
    }
    events.handleUpgrade(request, socket, head, (ws) => attachEventStream(ws));
  });

  function attachEventStream(ws: WebSocket): void {
    const unsubscribe = runtime.events.subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
    ws.send(JSON.stringify({ kind: "readiness_changed", agent: runtime.readiness() }));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://runner");
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/health") return sendJson(response, 200, { ok: true });
    if (method === "GET" && path === "/readiness") return sendJson(response, 200, { agent: runtime.readiness(), utilization: runtime.utilization() });
    if (method === "POST" && path === "/probe") return sendJson(response, 200, await runtime.probe(false));

    if (method === "POST" && path === "/auth/login") {
      const body = LoginSchema.parse(await readJson(request));
      const flow = runtime.startLogin(body.loginId === undefined ? { organization: body.organization } : { organization: body.organization, loginId: body.loginId });
      return sendJson(response, 202, { loginId: flow.loginId });
    }
    if (method === "POST" && path === "/auth/input") {
      const body = LoginInputSchema.parse(await readJson(request));
      return sendJson(response, runtime.loginInput(body.loginId, body.text) ? 200 : 404, {});
    }
    if (method === "POST" && path === "/auth/cancel") {
      const body = LoginIdSchema.parse(await readJson(request));
      return sendJson(response, (await runtime.loginCancel(body.loginId)) ? 200 : 404, {});
    }
    if (method === "POST" && path === "/auth/logout") return sendJson(response, 200, await runtime.logout());

    if (method === "POST" && path === "/sessions") {
      const body = CreateSessionSchema.parse(await readJson(request));
      const created = await runtime.sessions.create({
        context: body.context,
        cwd: body.cwd,
        mcpServers: body.mcpServers,
        ...(body.sessionConfig === undefined ? {} : { sessionConfig: body.sessionConfig }),
        ...(body.acpSessionRef === undefined ? {} : { acpSessionRef: body.acpSessionRef }),
        ...(body.sessionLabel === undefined ? {} : { sessionLabel: body.sessionLabel }),
      });
      return sendJson(response, 201, created);
    }
    const session = /^\/sessions\/([^/]+)(?:\/(prompt|cancel|set_mode|set_config_option|answers))?$/.exec(path);
    if (session) {
      const ref = decodeURIComponent(session[1] ?? "");
      const action = session[2];
      if (method === "DELETE" && action === undefined) {
        runtime.sessions.close(ref);
        return sendJson(response, 200, {});
      }
      if (method === "POST" && action === "cancel") {
        runtime.sessions.cancel(ref);
        return sendJson(response, 202, {});
      }
      if (method === "POST" && action === "answers") {
        const body = AnswerSchema.parse(await readJson(request));
        const delivered = runtime.sessions.answer(ref, body.requestId, body.response);
        return sendJson(response, delivered ? 200 : 409, { delivered });
      }
      if (method === "POST" && (action === "prompt" || action === "set_mode" || action === "set_config_option")) {
        const body = RequestEnvelopeSchema.parse(await readJson(request));
        if (action === "prompt") runtime.sessions.prompt(ref, body.id, body.params as never);
        else if (action === "set_mode") runtime.sessions.setMode(ref, body.id, body.params as never);
        else runtime.sessions.setConfigOption(ref, body.id, body.params as never);
        return sendJson(response, 202, {});
      }
    }
    sendJson(response, 404, { code: "not_found", message: "unknown runner route", recoveryActions: [] });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      logger.info({ port: options.port }, "runner api listening");
      resolve(server);
    });
  });
}

function statusFor(error: RemoteInstanceError): number {
  switch (error.code) {
    case "agent_auth_required":
      return 401;
    case "agent_unavailable":
    case "gateway_unavailable":
      return 503;
    case "recovery_required":
    case "operation_conflict":
      return 409;
    default:
      return 400;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 4 * 1024 * 1024) throw new RemoteInstanceError("temporarily_unavailable", "request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}
