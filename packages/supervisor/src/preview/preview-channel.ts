import { PreviewToRuntimeChunkSchema, createLogger, type Logger, type PreviewToCoreChunk, type PreviewToRuntimeChunk, type RelayChannel } from "@konteks/remote-common";
import type { OutboundMessage } from "../transport/transport.js";
import { PreviewForwarder, type PreviewForwarderCounters, type PreviewForwarderOptions } from "./forwarder.js";

/**
 * The supervisor's side of the governed `preview` relay channel.
 *
 * Each `preview:<sessionId>` channel gets one forwarder, which may dial ONLY
 * the loopback port the process manager spawned for that session. A frame
 * for a session with no running preview is answered on its stream with a 503
 * (never silence); a lease that may not open new channels (drain) answers
 * 503 too. Replay and acknowledgements are the mux's, exactly as for a
 * session channel.
 */
export interface PreviewChannelDeps {
  transport: { send(message: OutboundMessage): void; openChannel(channelId: string, channel: RelayChannel): void; closeChannel(channelId: string): void };
  lease: { canOpenChannel(channel: RelayChannel): boolean };
  previews: {
    /** Loopback origin of the session's running preview, or null. */
    originFor(sessionId: string): string | null;
    /** Viewer traffic counts as activity for the idle stop. */
    touch(sessionId: string): void;
    /**
     * A viewer asked for a preview that is not running. Start it (same process
     * manager, inference and caps as preview_start) when this session's
     * worktree exists and a preview is permitted; true while one is starting.
     */
    autoStart?(sessionId: string): Promise<boolean>;
  };
  /** True while the channel may take more to_core bytes (the mux's unacked window). */
  hasCapacity?: (channelId: string) => boolean;
  forwarder?: Partial<Pick<PreviewForwarderOptions, "createWebSocket" | "requestFn" | "now" | "limits">>;
  logger?: Logger;
}

const CAPACITY_POLL_MS = 25;
/**
 * The answer while a viewer's preview starts. Konteks recognises the phrase
 * (a 503, plain text, no-store) and shows a page that refreshes by itself.
 */
export const STARTING_MESSAGE = "Starting preview. This page refreshes when it is ready.";
const CAPACITY_WAIT_MS = 120_000;

export class PreviewChannel {
  private readonly forwarders = new Map<string, PreviewForwarder>();
  private readonly logger: Logger;
  private disposed = false;
  readonly counters = { malformed: 0, refusedDraining: 0, autoStarted: 0 };

  constructor(private readonly deps: PreviewChannelDeps) {
    this.logger = deps.logger ?? createLogger({ name: "preview-channel" });
  }

  /** A viewer chunk from the relay (a channel exists only under a preview-scoped grant). */
  onToRuntime(channelId: string, body: unknown): void {
    const sessionId = sessionIdOf(channelId);
    const parsed = PreviewToRuntimeChunkSchema.safeParse(body);
    const streamId = typeof (body as { streamId?: unknown } | null)?.streamId === "string" ? (body as { streamId: string }).streamId : null;
    if (sessionId === null || !parsed.success) {
      this.counters.malformed += 1;
      if (sessionId !== null && streamId !== null && /^[A-Za-z0-9._:-]{1,256}$/.test(streamId)) this.reply(channelId, streamId, 400, "Malformed preview chunk.");
      return;
    }
    const chunk = parsed.data;
    if (this.disposed || !this.deps.lease.canOpenChannel("preview")) {
      this.counters.refusedDraining += 1;
      if (chunk.kind === "request") this.reply(channelId, chunk.streamId, 503, "This computer is not taking preview traffic right now (it is draining or disconnected).");
      return;
    }
    // A viewer's first request for a session with nothing running: start it
    // and say so, instead of "nothing is running". Only a request that is
    // complete in one chunk (a page load, an asset, an upgrade): a multi-part
    // body keeps going to the forwarder, which answers it plainly.
    if (
      chunk.kind === "request" &&
      chunk.final &&
      this.deps.previews.autoStart &&
      this.deps.previews.originFor(sessionId) === null &&
      !this.forwarders.get(channelId)?.hasStream(chunk.streamId)
    ) {
      void this.startForViewer(channelId, sessionId, chunk);
      return;
    }
    this.forwarderFor(channelId, sessionId).handle(chunk);
  }

  private async startForViewer(channelId: string, sessionId: string, chunk: Extract<PreviewToRuntimeChunk, { kind: "request" }>): Promise<void> {
    let starting = false;
    try {
      starting = await this.deps.previews.autoStart!(sessionId);
    } catch (error) {
      this.logger.warn({ event: "preview.auto_start_failed", err: error }, "a viewer's preview could not be started");
    }
    if (starting) {
      this.counters.autoStarted += 1;
      this.reply(channelId, chunk.streamId, 503, STARTING_MESSAGE);
      return;
    }
    // Not permitted or not possible here: the forwarder answers as it always has.
    this.forwarderFor(channelId, sessionId).handle(chunk);
  }

  /** The preview for this session stopped: every open viewer stream is closed. */
  previewStopped(sessionId: string): void {
    this.forwarders.get(`preview:${sessionId}`)?.closeAll(1001);
  }

  /** Relay reset or retirement of the channel: drop its streams and its mux state. */
  closeChannel(channelId: string): void {
    const forwarder = this.forwarders.get(channelId);
    if (!forwarder) return;
    this.forwarders.delete(channelId);
    forwarder.dispose();
    this.deps.transport.closeChannel(channelId);
  }

  /** Whether a viewer has reached this session's preview through the relay. */
  hasViewer(sessionId: string): boolean {
    return this.forwarders.has(`preview:${sessionId}`);
  }

  activeStreams(): number {
    let total = 0;
    for (const forwarder of this.forwarders.values()) total += forwarder.activeStreams;
    return total;
  }

  counterTotals(): PreviewForwarderCounters & { channels: number; malformed: number; refusedDraining: number; autoStarted: number } {
    const totals: PreviewForwarderCounters = { streams: 0, rejectedPaths: 0, rejectedHeaders: 0, refusedNoPreview: 0, refusedStreamCap: 0, oversized: 0, idleClosed: 0, upstreamFailures: 0 };
    for (const forwarder of this.forwarders.values()) {
      for (const key of Object.keys(totals) as Array<keyof PreviewForwarderCounters>) totals[key] += forwarder.counters[key];
    }
    return { ...totals, channels: this.forwarders.size, ...this.counters };
  }

  dispose(): void {
    this.disposed = true;
    for (const forwarder of this.forwarders.values()) forwarder.dispose();
    this.forwarders.clear();
  }

  private forwarderFor(channelId: string, sessionId: string): PreviewForwarder {
    let forwarder = this.forwarders.get(channelId);
    if (forwarder) return forwarder;
    this.deps.transport.openChannel(channelId, "preview");
    forwarder = new PreviewForwarder({
      ...this.deps.forwarder,
      origin: () => this.deps.previews.originFor(sessionId),
      send: chunk => this.send(channelId, chunk),
      onActivity: () => this.deps.previews.touch(sessionId),
      ...(this.deps.hasCapacity ? { waitForCapacity: () => this.waitForCapacity(channelId) } : {}),
      logger: this.logger,
    });
    forwarder.start();
    this.forwarders.set(channelId, forwarder);
    this.logger.info({ event: "preview.channel.opened", channelId }, "a viewer reached this session's preview channel");
    return forwarder;
  }

  private send(channelId: string, chunk: PreviewToCoreChunk): void {
    try {
      this.deps.transport.send({ channel: "preview", channelId, body: chunk });
    } catch (error) {
      this.logger.warn({ event: "preview.channel.send_failed", channelId, err: error }, "a preview chunk could not be queued for the relay");
    }
  }

  private async waitForCapacity(channelId: string): Promise<boolean> {
    const deadline = Date.now() + CAPACITY_WAIT_MS;
    while (this.forwarders.has(channelId) && !this.disposed) {
      if (this.deps.hasCapacity!(channelId)) return true;
      if (Date.now() > deadline) return false;
      await new Promise(resolve => setTimeout(resolve, CAPACITY_POLL_MS));
    }
    return false;
  }

  private reply(channelId: string, streamId: string, status: number, message: string): void {
    this.send(channelId, { streamId, kind: "response", status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: Buffer.from(message).toString("base64url"), final: true });
  }
}

/** `preview:<sessionId>` → `<sessionId>`; anything else is not a preview channel. */
export function sessionIdOf(channelId: string): string | null {
  if (!channelId.startsWith("preview:")) return null;
  const id = channelId.slice("preview:".length);
  return /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/.test(id) ? id : null;
}
