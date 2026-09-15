import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { GatewayCallObservationSchema, createLogger, signBody, type GatewayCallObservation, type InstanceKeyPair, type JsonValue, type Logger, type PreviewToCoreChunk, type PreviewToRuntimeChunk } from "@konteks/remote-common";
import { ForwarderToSupervisorSchema, type SupervisorToForwarder } from "@konteks/remote-preview-forwarder";
import { ComponentFactSchema } from "../work/components.js";
import { componentInboundRoutes, type ComponentInboundDeps } from "./component-routes.js";

/** The shortest platform bound on `sockaddr_un.sun_path`, minus the terminator. */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/**
 * The supervisor's internal API on the control network. Closed routes:
 *   POST /internal/observations/gateway    GatewayCallObservation from the gateway
 *   POST /internal/components/facts        progress/checkpoint/terminal/permission facts from Harness/Validation
 *   WS   /internal/preview                 the preview forwarder link
 *   GET  /health
 * Nothing here is reachable from a runner (network policy) or the host.
 *
 * The two domain components speak their OWN outbound contracts
 * (`/component/harness/*`, `/component/validation_runtime/*`,
 * `internal/component-routes.ts`). Those are served on a unix socket on the
 * shared volume rather than the control port, because the Harness accepts
 * only a unix or loopback endpoint and neither component should be reachable
 * over the control network.
 */
export interface InternalServerDeps {
  port: number;
  /** Unix socket the Harness and Validation Runtime dial; omitted in tests that exercise only the control port. */
  componentSocketPath?: string;
  component?: ComponentInboundDeps;
  key: () => InstanceKeyPair;
  onGatewayObservation: (observation: GatewayCallObservation, signature: string) => Promise<void>;
  onComponentFact: (fact: z.infer<typeof ComponentFactSchema>) => Promise<void>;
  onPreviewToCore: (channelId: string, chunk: PreviewToCoreChunk) => void;
  onForwarderStatus: (status: { enabled: boolean; port: number | null; activeStreams: number }) => void;
  logger?: Logger;
}

export interface InternalServer {
  server: Server;
  /** Push a preview chunk to the forwarder; false when no forwarder is linked. */
  sendPreview(channelId: string, chunk: PreviewToRuntimeChunk): boolean;
  configurePreview(enabled: boolean, port: number | null): void;
  forwarderLinked(): boolean;
  close(): Promise<void>;
}

export function startInternalServer(deps: InternalServerDeps): Promise<InternalServer> {
  const logger = deps.logger ?? createLogger({ name: "internal-api" });
  let forwarder: WebSocket | null = null;
  let previewConfig: { enabled: boolean; port: number | null } = { enabled: false, port: null };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.warn({ err: error }, "internal request failed");
      sendJson(response, 500, { accepted: false });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/internal/preview") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      forwarder?.close(1000, "replaced");
      forwarder = ws;
      ws.send(JSON.stringify({ type: "config", ...previewConfig } satisfies SupervisorToForwarder));
      ws.on("message", (data) => {
        const parsed = ForwarderToSupervisorSchema.safeParse(safeJson(String(data)));
        if (!parsed.success) return;
        if (parsed.data.type === "to_core") deps.onPreviewToCore(parsed.data.channelId, parsed.data.chunk);
        else deps.onForwarderStatus({ enabled: parsed.data.enabled, port: parsed.data.port, activeStreams: parsed.data.activeStreams });
      });
      ws.on("close", () => {
        if (forwarder === ws) forwarder = null;
      });
    });
  });

  const components = deps.component ? componentInboundRoutes(deps.component) : null;
  const componentServer = components
    ? createServer((request, response) => {
        components(request, response)
          .then((handled) => {
            if (!handled) sendJson(response, 404, { code: "not_found" });
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "component request failed");
            sendJson(response, 500, { code: "temporarily_unavailable" });
          });
      })
    : null;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "GET" && request.url === "/health") return sendJson(response, 200, { ok: true, forwarderLinked: forwarder !== null });
    if (method === "POST" && request.url === "/internal/observations/gateway") {
      const parsed = GatewayCallObservationSchema.safeParse(await readJson(request));
      if (!parsed.success) return sendJson(response, 400, { accepted: false });
      await deps.onGatewayObservation(parsed.data, signBody(deps.key(), parsed.data as unknown as { [key: string]: JsonValue }));
      return sendJson(response, 200, { accepted: true });
    }
    if (method === "POST" && request.url === "/internal/components/facts") {
      const parsed = ComponentFactSchema.safeParse(await readJson(request));
      if (!parsed.success) return sendJson(response, 400, { accepted: false });
      await deps.onComponentFact(parsed.data);
      return sendJson(response, 200, { accepted: true });
    }
    sendJson(response, 404, { accepted: false });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, "0.0.0.0", async () => {
      logger.info({ port: deps.port }, "internal api listening");
      if (componentServer && deps.componentSocketPath) {
        // A unix socket path is bounded by the platform's sockaddr_un (104
        // bytes on macOS, 108 on Linux) and is TRUNCATED rather than refused,
        // which binds a socket at a path no component can dial. Say so.
        if (Buffer.byteLength(deps.componentSocketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
          logger.warn({ path: deps.componentSocketPath, limit: MAX_UNIX_SOCKET_PATH_BYTES }, "component socket path is longer than the platform allows and would be truncated; components could not reach it");
        }
        // A stale socket from a killed supervisor would refuse the bind.
        await rm(deps.componentSocketPath, { force: true }).catch(() => undefined);
        await new Promise<void>((bound, failed) => {
          componentServer.once("error", failed);
          componentServer.listen(deps.componentSocketPath, () => bound());
        })
          .then(() => logger.info({ path: deps.componentSocketPath }, "component socket listening"))
          .catch((error: unknown) => logger.warn({ err: error, path: deps.componentSocketPath }, "component socket unavailable"));
      }
      resolve({
        server,
        sendPreview: (channelId, chunk) => {
          if (!forwarder || forwarder.readyState !== forwarder.OPEN) return false;
          forwarder.send(JSON.stringify({ type: "to_runtime", channelId, chunk } satisfies SupervisorToForwarder));
          return true;
        },
        configurePreview: (enabled, port) => {
          previewConfig = { enabled, port };
          if (forwarder?.readyState === forwarder?.OPEN) forwarder?.send(JSON.stringify({ type: "config", enabled, port } satisfies SupervisorToForwarder));
        },
        forwarderLinked: () => forwarder !== null,
        close: async () => {
          if (componentServer) await new Promise<void>((done) => componentServer.close(() => done()));
          await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
        },
      });
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) return null;
    chunks.push(buffer);
  }
  return safeJson(Buffer.concat(chunks).toString("utf8"));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}
