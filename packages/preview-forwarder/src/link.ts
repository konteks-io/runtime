import { WebSocket as NodeWebSocket } from "ws";
import { z } from "zod";
import {
  PreviewToCoreChunkSchema,
  PreviewToRuntimeChunkSchema,
  ReconnectBackoff,
  createLogger,
  withJitter,
  type Logger,
  type PreviewToCoreChunk,
} from "@konteks/remote-common";
import { PreviewForwarder } from "./forwarder.js";

/**
 * The forwarder's link to the supervisor over the control network. The
 * supervisor owns the relay `preview` channel; it tells the forwarder whether
 * preview is enabled (operator opt-in) and on which local port, and relays
 * chunks in both directions. The forwarder itself never listens for viewers.
 */
export const SupervisorToForwarderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("config"), enabled: z.boolean(), port: z.number().int().min(1).max(65_535).nullable() }).strict(),
  z.object({ type: z.literal("to_runtime"), channelId: z.string().min(1), chunk: PreviewToRuntimeChunkSchema }).strict(),
]);
export type SupervisorToForwarder = z.infer<typeof SupervisorToForwarderSchema>;

export const ForwarderToSupervisorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("to_core"), channelId: z.string().min(1), chunk: PreviewToCoreChunkSchema }).strict(),
  z.object({ type: z.literal("status"), enabled: z.boolean(), port: z.number().int().nullable(), activeStreams: z.number().int().nonnegative() }).strict(),
]);
export type ForwarderToSupervisor = z.infer<typeof ForwarderToSupervisorSchema>;

export interface ForwarderLinkOptions {
  supervisorUrl: string;
  createWebSocket?: (url: string) => NodeWebSocket;
  logger?: Logger;
}

export class ForwarderLink {
  private socket: NodeWebSocket | null = null;
  private stopped = false;
  private enabled = false;
  private port: number | null = null;
  private readonly backoff = new ReconnectBackoff();
  private readonly logger: Logger;
  private readonly forwarders = new Map<string, PreviewForwarder>();

  constructor(private readonly options: ForwarderLinkOptions) {
    this.logger = options.logger ?? createLogger({ name: "preview-link" });
  }

  status(): { enabled: boolean; port: number | null; activeStreams: number; connected: boolean } {
    let activeStreams = 0;
    for (const forwarder of this.forwarders.values()) activeStreams += forwarder.activeStreams;
    return { enabled: this.enabled, port: this.port, activeStreams, connected: this.socket?.readyState === NodeWebSocket.OPEN };
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const forwarder of this.forwarders.values()) forwarder.dispose();
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = (this.options.createWebSocket ?? ((url) => new NodeWebSocket(url)))(new URL("/internal/preview", this.options.supervisorUrl).toString());
    this.socket = socket;
    const connectedAt = Date.now();
    socket.on("open", () => {
      this.logger.info("linked to supervisor");
      this.sendStatus();
    });
    socket.on("message", (data) => this.onMessage(String(data)));
    socket.on("close", () => {
      for (const forwarder of this.forwarders.values()) forwarder.dispose();
      this.forwarders.clear();
      if (this.stopped) return;
      const delay = withJitter(this.backoff.nextDelayAfterClose(Date.now() - connectedAt));
      setTimeout(() => this.connect(), delay).unref();
    });
    socket.on("error", (error) => this.logger.warn({ err: error }, "supervisor link error"));
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const message = SupervisorToForwarderSchema.safeParse(parsed);
    if (!message.success) return;
    if (message.data.type === "config") {
      this.enabled = message.data.enabled;
      this.port = message.data.port;
      if (!this.enabled) {
        for (const forwarder of this.forwarders.values()) forwarder.dispose();
        this.forwarders.clear();
      }
      this.sendStatus();
      return;
    }
    const { channelId, chunk } = message.data;
    let forwarder = this.forwarders.get(channelId);
    if (!forwarder) {
      const created = new PreviewForwarder({
        loopbackOrigin: () => (this.port === null ? null : `http://127.0.0.1:${this.port}`),
        enabled: () => this.enabled,
        send: (out: PreviewToCoreChunk) => this.send({ type: "to_core", channelId, chunk: out }),
        logger: this.logger,
      });
      created.start();
      this.forwarders.set(channelId, created);
      forwarder = created;
    }
    forwarder.handle(chunk);
  }

  private send(message: ForwarderToSupervisor): void {
    if (this.socket?.readyState === NodeWebSocket.OPEN) this.socket.send(JSON.stringify(ForwarderToSupervisorSchema.parse(message)));
  }

  private sendStatus(): void {
    const status = this.status();
    this.send({ type: "status", enabled: status.enabled, port: status.port, activeStreams: status.activeStreams });
  }
}
