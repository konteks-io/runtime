import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { CapEnforcementStageSchema, createLogger, type CapEnforcementStage, type Logger } from "@konteks/remote-common";
import { AssignmentBindingSchema, type AssignmentRegistry } from "./caps.js";
import type { EgressAllowlistIndex } from "./allowlist.js";
import type { KeyVault } from "./keys.js";
import type { SupervisorObservationSink } from "./observation.js";
import type { GatewayProxy } from "./proxy.js";

/**
 * The gateway's admin API, reachable only from the supervisor on the control
 * network (Compose places no runner on it). Closed operations:
 *   PUT    /admin/keys/:agentId        { key }               in-memory key set
 *   DELETE /admin/keys/:agentId                              key clear
 *   PUT    /admin/config               { capEnforcementStage, egressAllowlistRevision }
 *   PUT    /admin/assignments/:agentId AssignmentBinding     bind current assignment/cap
 *   DELETE /admin/assignments/:agentId                       release
 *   GET    /health                                            sanitized state
 * Request bodies are parsed strictly; key values are never logged.
 */
const ConfigSchema = z
  .object({ capEnforcementStage: CapEnforcementStageSchema, egressAllowlistRevision: z.string().min(1) })
  .strict();

export interface GatewayAdminState {
  stage: CapEnforcementStage;
  configRevisionApplied: string | null;
}

export interface GatewayAdminOptions {
  port: number;
  version: string;
  keys: KeyVault;
  assignments: AssignmentRegistry;
  allowlist: EgressAllowlistIndex;
  state: GatewayAdminState;
  sink: SupervisorObservationSink;
  proxy: () => GatewayProxy | null;
  logger?: Logger;
}

const KEY_ROUTE = /^\/admin\/keys\/([a-z0-9][a-z0-9-]{0,63})$/;
const ASSIGNMENT_ROUTE = /^\/admin\/assignments\/([a-z0-9][a-z0-9-]{0,63})$/;

export function startGatewayAdmin(options: GatewayAdminOptions): Promise<Server> {
  const logger = options.logger ?? createLogger({ name: "gateway-admin" });
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.warn({ err: error }, "gateway admin request failed");
      sendJson(response, 500, { error: "internal" });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "/";
    const method = request.method ?? "GET";
    if (method === "GET" && url === "/health") {
      const proxy = options.proxy();
      sendJson(response, 200, {
        version: options.version,
        capEnforcementStage: options.state.stage,
        egressAllowlistRevision: options.allowlist.revision,
        dialects: options.allowlist.providers(),
        keyedAgents: options.keys.keyedAgentIds(),
        observationsPending: options.sink.pending,
        rollupIncompleteSince: options.sink.rollupIncompleteSince,
        stats: proxy?.stats() ?? null,
        healthy: proxy !== null,
      });
      return;
    }
    const keyRoute = KEY_ROUTE.exec(url);
    if (keyRoute) {
      const agentId = keyRoute[1] ?? "";
      if (method === "PUT") {
        const body = z.object({ key: z.string().min(8).max(4_096) }).strict().safeParse(await readJson(request));
        if (!body.success) return sendJson(response, 400, { error: "invalid_key" });
        options.keys.set(agentId, body.data.key);
        logger.info({ agentId }, "gateway key set (in memory)");
        return sendJson(response, 200, { agentId, keyed: true });
      }
      if (method === "DELETE") {
        const removed = options.keys.clear(agentId);
        logger.info({ agentId, removed }, "gateway key cleared");
        return sendJson(response, 200, { agentId, keyed: false });
      }
    }
    const assignmentRoute = ASSIGNMENT_ROUTE.exec(url);
    if (assignmentRoute) {
      const agentId = assignmentRoute[1] ?? "";
      if (method === "PUT") {
        const body = AssignmentBindingSchema.safeParse(await readJson(request));
        if (!body.success) return sendJson(response, 400, { error: "invalid_binding" });
        options.assignments.bind(agentId, body.data);
        return sendJson(response, 200, { agentId, bound: true });
      }
      if (method === "DELETE") {
        options.assignments.release(agentId);
        return sendJson(response, 200, { agentId, bound: false });
      }
    }
    if (method === "PUT" && url === "/admin/config") {
      const body = ConfigSchema.safeParse(await readJson(request));
      if (!body.success) return sendJson(response, 400, { error: "invalid_value" });
      if (body.data.egressAllowlistRevision !== options.allowlist.revision) {
        return sendJson(response, 409, { error: "unsupported_revision", loaded: options.allowlist.revision });
      }
      options.state.stage = body.data.capEnforcementStage;
      options.state.configRevisionApplied = body.data.egressAllowlistRevision;
      logger.info({ stage: body.data.capEnforcementStage }, "gateway cap stage applied");
      return sendJson(response, 200, { applied: true });
    }
    sendJson(response, 404, { error: "not_found" });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      logger.info({ port: options.port }, "gateway admin listening");
      resolve(server);
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 64 * 1024) return null;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}
