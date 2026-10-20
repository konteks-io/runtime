import { PreviewToRuntimeChunkSchema, createLogger, type Logger, type PreviewToCoreChunk, type PreviewToRuntimeChunk, type RelayChannel } from "@konteks/remote-common";
import type { OutboundMessage } from "../transport/transport.js";
import { COULD_NOT_START_PREFIX, PreviewForwarder, type PreviewForwarderOptions } from "./forwarder.js";

/**
 * The supervisor's side of the governed `preview` relay channel.
 *
 * Each `preview:<sessionId>` channel gets one forwarder, which may dial ONLY
 * the loopback port the process manager spawned for that session. A frame
 * for a session with no running preview is answered on its stream with a 503
 * (never silence); a lease that may not open new channels (drain) answers
 * 503 too. Replay and acknowledgements are the mux's, as for a session
 * channel, except that a receive gap resets this channel's streams instead
 * of the shared relay socket (`resyncChannel`).
 */
interface PreviewChannelDeps {
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
     * worktree exists and a preview is permitted; true while one is starting,
     * `{ reason }` when it cannot start (no worktree here, it failed and is
     * not retried yet, nothing to serve, this computer takes no work), false
     * to let the forwarder answer as it always has.
     */
    autoStart?(sessionId: string): Promise<boolean | { reason: string }>;
    /** The person's reason the session's last start failed, while it is failed; null otherwise. */
    failureFor?(sessionId: string): string | null;
  };
  /** True while the channel may take more to_core bytes (the mux's unacked window). */
  hasCapacity?: (channelId: string) => boolean;
  /** Whether Core takes the app's `set-cookie` back (D46); absent, it is dropped. */
  coreAcceptsSetCookies?: () => boolean;
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
/** A viewer's start that threw: never "nothing yet", which would refresh forever. */
const AUTO_START_FAILED_REASON = "This computer could not start the preview. Try again in a moment.";
/** WebSocket "service restart": the viewer's hot-reload client reconnects. */
const SERVICE_RESTART = 1012;

export class PreviewChannel {
  private readonly forwarders = new Map<string, PreviewForwarder>();
  private readonly logger: Logger;
  private disposed = false;
  /** Channels that require a known opening frame for body continuations after lost frames. */
  private readonly resyncing = new Set<string>();
  readonly counters = { malformed: 0, refusedDraining: 0, autoStarted: 0, couldNotStart: 0, resyncs: 0, refusedAfterGap: 0 };

  constructor(private readonly deps: PreviewChannelDeps) {
    this.logger = deps.logger ?? createLogger({ name: "preview-channel" });
  }

  /** A viewer chunk from the relay (a channel exists only under a preview-scoped grant). */
  onToRuntime(channelId: string, body: unknown): void {
    const sessionId = sessionIdOf(channelId);
    const parsed = PreviewToRuntimeChunkSchema.safeParse(body);
    if (sessionId === null || !parsed.success) return this.malformed(channelId, sessionId, body);
    const chunk = parsed.data;
    if (this.disposed || !this.deps.lease.canOpenChannel("preview")) return this.refuseDraining(channelId, chunk);
    if (this.refuseInterruptedRequest(channelId, sessionId, chunk)) return;
    if (this.startsSession(channelId, sessionId, chunk)) {
      void this.startForViewer(channelId, sessionId, chunk);
      return;
    }
    this.forwarderFor(channelId, sessionId).handle(chunk);
  }

  private refuseInterruptedRequest(channelId: string, sessionId: string, chunk: PreviewToRuntimeChunk): boolean {
    if (!this.resyncing.has(channelId) || chunk.kind !== "request" || chunk.body === undefined) return false;
    // Other streams cannot establish this stream's missing start. Core opens
    // a fresh upload with a bodyless frame before sending its body chunks.
    if (this.forwarderFor(channelId, sessionId).refuseAfterGap(chunk)) this.counters.refusedAfterGap += 1;
    return true;
  }

  private malformed(channelId: string, sessionId: string | null, body: unknown): void {
    this.counters.malformed += 1;
    const streamId = typeof (body as { streamId?: unknown } | null)?.streamId === "string" ? (body as { streamId: string }).streamId : null;
    if (sessionId !== null && streamId !== null && /^[A-Za-z0-9._:-]{1,256}$/.test(streamId)) this.reply(channelId, streamId, 400, "Malformed preview chunk.");
  }

  private refuseDraining(channelId: string, chunk: PreviewToRuntimeChunk): void {
    this.counters.refusedDraining += 1;
    if (chunk.kind === "request") this.reply(channelId, chunk.streamId, 503, "This computer is not taking preview traffic right now (it is draining or disconnected).");
  }

  /**
   * A viewer's first request for a session with nothing running: start it
   * and say so, instead of "nothing is running". Only a request that is
   * complete in one chunk (a page load, an asset, an upgrade): a multi-part
   * body keeps going to the forwarder, which answers it plainly.
   */
  private startsSession(channelId: string, sessionId: string, chunk: PreviewToRuntimeChunk): chunk is Extract<PreviewToRuntimeChunk, { kind: "request" }> {
    return chunk.kind === "request" && chunk.final === true && this.deps.previews.autoStart !== undefined &&
      this.deps.previews.originFor(sessionId) === null && !this.forwarders.get(channelId)?.hasStream(chunk.streamId);
  }

  private async startForViewer(channelId: string, sessionId: string, chunk: Extract<PreviewToRuntimeChunk, { kind: "request" }>): Promise<void> {
    let started: boolean | { reason: string };
    try {
      started = await this.deps.previews.autoStart!(sessionId);
    } catch (error) {
      this.logger.warn({ event: "preview.auto_start_failed", sessionId, err: error }, "a viewer's preview could not be started");
      started = { reason: AUTO_START_FAILED_REASON };
    }
    if (started === true) {
      this.counters.autoStarted += 1;
      this.reply(channelId, chunk.streamId, 503, STARTING_MESSAGE);
      return;
    }
    if (typeof started === "object") {
      // Nothing will appear until something changes: say why, not "nothing yet".
      this.counters.couldNotStart += 1;
      this.reply(channelId, chunk.streamId, 503, `${COULD_NOT_START_PREFIX}${started.reason}`);
      return;
    }
    // Not permitted or not possible here: the forwarder answers as it always has.
    this.forwarderFor(channelId, sessionId).handle(chunk);
  }

  /** Withdraw streams at stop intent or failure; this is not process-exit proof. */
  previewUnavailable(sessionId: string): void {
    this.forwarders.get(`preview:${sessionId}`)?.closeAll(1001);
  }

  /** Confirmed stop also withdraws any streams opened during cleanup. */
  previewStopped(sessionId: string): void { this.previewUnavailable(sessionId); }

  /**
   * The relay lost viewer frames on this channel (the mux already moved its
   * receive cursor past them). Close the channel's open streams so Core and
   * the browser retry; the channel, its numbering and every other channel
   * stay as they are.
   */
  resyncChannel(channelId: string): void {
    this.counters.resyncs += 1;
    this.resyncing.add(channelId);
    const streams = this.forwarders.get(channelId)?.closeAll(SERVICE_RESTART, "preview channel resync") ?? 0;
    this.logger.info({ event: "preview.channel.resync", channelId, streams }, "closed this preview channel's open streams after the relay lost frames");
  }

  /** Relay reset or retirement of the channel: drop its streams and its mux state. */
  closeChannel(channelId: string): void {
    this.resyncing.delete(channelId);
    const forwarder = this.forwarders.get(channelId);
    if (forwarder) {
      this.forwarders.delete(channelId);
      forwarder.dispose();
    }
    // Its counts go even when no viewer reached this process yet: a reset
    // that left them kept the channel out of step with Core.
    this.deps.transport.closeChannel(channelId);
  }

  /** Whether a viewer has reached this session's preview through the relay. */
  hasViewer(sessionId: string): boolean {
    return this.forwarders.has(`preview:${sessionId}`);
  }

  /** The viewer streams open on this session's preview channel now (an event stream, a download). */
  activeStreamsFor(sessionId: string): number {
    return this.forwarders.get(`preview:${sessionId}`)?.activeStreams ?? 0;
  }

  activeStreams(): number {
    let total = 0;
    for (const forwarder of this.forwarders.values()) total += forwarder.activeStreams;
    return total;
  }

  dispose(): void {
    this.disposed = true;
    for (const forwarder of this.forwarders.values()) forwarder.dispose();
    this.forwarders.clear();
    this.resyncing.clear();
  }

  private forwarderFor(channelId: string, sessionId: string): PreviewForwarder {
    let forwarder = this.forwarders.get(channelId);
    if (forwarder) return forwarder;
    this.deps.transport.openChannel(channelId, "preview");
    forwarder = new PreviewForwarder({
      ...this.deps.forwarder,
      origin: () => this.deps.previews.originFor(sessionId),
      failure: () => this.deps.previews.failureFor?.(sessionId) ?? null,
      send: chunk => this.send(channelId, chunk),
      onActivity: () => this.deps.previews.touch(sessionId),
      forwardSetCookies: () => this.deps.coreAcceptsSetCookies?.() === true,
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
