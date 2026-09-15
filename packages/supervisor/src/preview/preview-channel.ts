import { PreviewToRuntimeChunkSchema, applyPreviewRequestHeaderPolicy, applyPreviewResponseHeaderPolicy, createLogger, isPreviewMethod, validatePreviewPath, type Logger, type PreviewToCoreChunk, type PreviewToRuntimeChunk } from "@konteks/remote-common";
import type { LeaseState } from "../lease/lease.js";
import type { TransportManager } from "../transport/relay-transport.js";

/**
 * The supervisor's side of the governed `preview` channel. It enforces the
 * D124/D125 policy locally and independently of the forwarder, opens a
 * preview channel only while the operator enabled preview AND the lease
 * permits new channels, and displays its exposure through status.
 */
export interface PreviewChannelDeps {
  transport: TransportManager;
  lease: LeaseState;
  sendToForwarder: (channelId: string, chunk: PreviewToRuntimeChunk) => boolean;
  configureForwarder: (enabled: boolean, port: number | null) => void;
  logger?: Logger;
}

export class PreviewChannel {
  private enabled = false;
  private port: number | null = null;
  private grantChannels = new Set<string>();
  private forwarderStatus: { enabled: boolean; port: number | null; activeStreams: number } = { enabled: false, port: null, activeStreams: 0 };
  private readonly logger: Logger;
  readonly counters = { rejectedHeaders: 0, rejectedPaths: 0, rejectedMethods: 0, refusedDisabled: 0 };

  constructor(private readonly deps: PreviewChannelDeps) {
    this.logger = deps.logger ?? createLogger({ name: "preview" });
  }

  enable(port: number): void {
    this.enabled = true;
    this.port = port;
    this.deps.configureForwarder(true, port);
    this.logger.info({ port }, "preview enabled: local port mapped onto the governed preview channel while a grant exists");
  }

  disable(): void {
    this.enabled = false;
    this.port = null;
    for (const channelId of this.grantChannels) this.deps.transport.closeChannel(channelId);
    this.grantChannels.clear();
    this.deps.configureForwarder(false, null);
  }

  onForwarderStatus(status: { enabled: boolean; port: number | null; activeStreams: number }): void {
    this.forwarderStatus = status;
  }

  exposure(): { enabled: boolean; port: number | null; grantPresent: boolean; activeStreams: number; forwarderReports: { enabled: boolean; port: number | null } } {
    return { enabled: this.enabled, port: this.port, grantPresent: this.grantChannels.size > 0, activeStreams: this.forwarderStatus.activeStreams, forwarderReports: { enabled: this.forwarderStatus.enabled, port: this.forwarderStatus.port } };
  }

  /** Inbound viewer chunk from the relay (a channel exists only under a grant). */
  onToRuntime(channelId: string, body: unknown): void {
    if (!this.enabled || !this.deps.lease.canOpenChannel("preview")) {
      this.counters.refusedDisabled += 1;
      return;
    }
    const parsed = PreviewToRuntimeChunkSchema.safeParse(body);
    if (!parsed.success) {
      // The wire shape already refuses an absolute path, a forbidden header or
      // an unknown method; the refusal is still counted under the policy it
      // belongs to and answered on the stream when one was named.
      const members = new Set(parsed.error.issues.flatMap((issue) => issue.path.map(String)));
      const streamId = typeof (body as { streamId?: unknown })?.streamId === "string" ? (body as { streamId: string }).streamId : null;
      if (members.has("method")) {
        this.counters.rejectedMethods += 1;
        if (streamId) this.reply(channelId, streamId, 405);
      } else if (members.has("path")) {
        this.counters.rejectedPaths += 1;
        if (streamId) this.reply(channelId, streamId, 400);
      } else if (members.has("headers")) {
        this.counters.rejectedHeaders += 1;
        if (streamId) this.reply(channelId, streamId, 400);
      }
      return;
    }
    const chunk = parsed.data;
    if (chunk.kind === "request") {
      if (!isPreviewMethod(chunk.method)) {
        this.counters.rejectedMethods += 1;
        return this.reply(channelId, chunk.streamId, 405);
      }
      if (!validatePreviewPath(chunk.path).ok) {
        this.counters.rejectedPaths += 1;
        return this.reply(channelId, chunk.streamId, 400);
      }
      if (!applyPreviewRequestHeaderPolicy(chunk.headers, "receiver").ok) {
        this.counters.rejectedHeaders += 1;
        return this.reply(channelId, chunk.streamId, 400);
      }
    }
    if (!this.grantChannels.has(channelId)) {
      this.grantChannels.add(channelId);
      this.deps.transport.openChannel(channelId, "preview");
    }
    if (!this.deps.sendToForwarder(channelId, chunk)) this.reply(channelId, chunk.streamId, 503);
  }

  /** Outbound forwarder chunk; response headers are re-checked in sender mode before leaving. */
  onToCore(channelId: string, chunk: PreviewToCoreChunk): void {
    if (!this.enabled || !this.grantChannels.has(channelId)) return;
    if (chunk.kind === "response") {
      const headers = applyPreviewResponseHeaderPolicy(chunk.headers, "sender");
      if (!headers.ok) {
        this.counters.rejectedHeaders += 1;
        return;
      }
      this.deps.transport.send({ channel: "preview", channelId, body: { ...chunk, headers: headers.headers as never } });
      return;
    }
    this.deps.transport.send({ channel: "preview", channelId, body: chunk });
  }

  closeChannel(channelId: string): void {
    if (this.grantChannels.delete(channelId)) this.deps.transport.closeChannel(channelId);
  }

  private reply(channelId: string, streamId: string, status: number): void {
    this.deps.transport.send({ channel: "preview", channelId, body: { streamId, kind: "response", status, headers: {}, final: true } });
  }
}
