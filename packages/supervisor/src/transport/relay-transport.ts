import { RemoteInstanceError, jcsDigest, logicalAssignmentRequestDigest, type JsonValue, type RelayChannel } from "@konteks/remote-common";
import type { ChannelMux } from "../relay/channel-mux.js";
import type { RelayClient } from "../relay/relay-client.js";
import type { ControlPlaneTransport, InboundHandler, OutboundMessage } from "./transport.js";

/** The relay as a ControlPlaneTransport: the mux frames, the client carries. */
export class RelayTransport implements ControlPlaneTransport {
  readonly kind = "relay" as const;

  constructor(private readonly client: RelayClient, private readonly mux: ChannelMux, private readonly deliver: { setHandler: (handler: InboundHandler) => void }) {}

  get available(): boolean {
    return this.client.connected;
  }

  send(message: OutboundMessage): void {
    if (message.assignmentRequest) {
      const frame = message.assignmentFrame;
      const requestKind = frame && "maxItems" in frame.body ? "pull" : frame && "reportId" in frame.body ? "report" : "claim";
      if (!frame || message.channel !== "assignment" || message.channelId !== frame.channelId ||
        message.assignmentRequest.requestSequence !== frame.seq || message.assignmentRequest.requestDigest !== logicalAssignmentRequestDigest(frame) ||
        message.assignmentRequest.requestKind !== requestKind || jcsDigest(message.body as JsonValue) !== jcsDigest(frame.body as JsonValue)) {
        throw new RemoteInstanceError("assignment_channel_invalid", "Allocated assignment relay carrier requires its exact retained frame and reference.");
      }
      this.mux.sendAssignment(frame); return;
    }
    if (message.assignmentFrame) throw new RemoteInstanceError("assignment_channel_invalid", "An assignment frame has no retained request owner.");
    this.mux.send(message.channelId, message.channel, message.body, message.signature, message.sourceSequence);
  }

  onInbound(handler: InboundHandler): void {
    this.deliver.setHandler(handler);
  }

  openChannel(channelId: string, channel: RelayChannel): void {
    this.mux.openChannel(channelId, channel);
  }

  closeChannel(channelId: string): void {
    this.mux.closeChannel(channelId);
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  resumeAfterRecovery(): void { this.mux.resumeAfterRecovery(); }
}

/**
 * Chooses the transport: the relay whenever it is up; HTTPS polling after
 * `fallbackAfterFailures` consecutive relay failures; back to the relay as
 * soon as it reconnects. Senders write to the outbox first, so a message in
 * flight during a switch is retried with the same idempotency key.
 */
export class TransportManager {
  private active: ControlPlaneTransport;

  constructor(
    private readonly relay: RelayTransport | null,
    private readonly https: ControlPlaneTransport,
    private readonly fallbackAfterFailures = 3,
    private readonly relayStatus: () => { consecutiveFailures: number; connected: boolean } = () => ({ consecutiveFailures: 0, connected: false }),
  ) {
    this.active = relay ?? https;
  }

  get kind(): "relay" | "https" {
    return this.active.kind;
  }

  onInbound(handler: InboundHandler): void {
    this.relay?.onInbound(handler);
    this.https.onInbound(handler);
  }

  start(): void {
    this.https.startPreparedAssignments?.();
    this.relay?.start();
    if (!this.relay) this.https.start();
  }

  stop(): void {
    this.relay?.stop();
    this.https.stop();
  }

  /** Re-evaluate which transport is active; called on relay state changes and on a timer. */
  evaluate(): void {
    if (!this.relay) return;
    const status = this.relayStatus();
    if (status.connected) {
      if (this.active !== this.relay) {
        if (this.https.pauseOrdinaryPolling) this.https.pauseOrdinaryPolling();
        else this.https.stop();
        this.active = this.relay;
      }
      return;
    }
    if (status.consecutiveFailures >= this.fallbackAfterFailures && this.active !== this.https) {
      this.https.start();
      this.active = this.https;
    }
  }

  send(message: OutboundMessage): void {
    // Temporary explicit carrier composition, not protocol cutover: the legacy
    // mux must never allocate a second sequence for a retained D143 frame.
    if (message.assignmentRequest) {
      if (message.channel !== "assignment") throw new RemoteInstanceError("assignment_channel_invalid", "Prepared assignment reference on another channel.");
      if (this.relay?.available) this.relay.send(message);
      else this.https.send(message);
      return;
    }
    if (message.assignmentFrame) throw new RemoteInstanceError("assignment_channel_invalid", "An assignment frame has no retained request owner.");
    // The relay assignment channel admits only retained D143 frames. Explicit
    // protocol-1 composition uses Core's authenticated bare HTTPS endpoints;
    // a healthy socket does not make that incompatible envelope relayable.
    if (message.channel === "assignment") {
      this.https.send(message);
      return;
    }
    // Session frames have one durable sequence/replay owner. Core has no
    // native session HTTPS ingress; switching here stranded terminal results.
    if (message.channel === "session") {
      if (!this.relay) throw new RemoteInstanceError("protocol_incompatible", "Session delivery requires the configured relay.");
      this.relay.send(message);
      return;
    }
    this.active.send(message);
  }

  resumeAfterRecovery(): void {
    // Resume the selected carrier and the session relay; neither creates authority.
    this.active.resumeAfterRecovery?.();
    if (this.active !== this.relay) this.relay?.resumeAfterRecovery();
    if (this.active !== this.https) this.https.resumePreparedAssignments?.();
  }

  openChannel(channelId: string, channel: RelayChannel): void {
    this.relay?.openChannel(channelId, channel);
  }

  closeChannel(channelId: string): void {
    this.relay?.closeChannel(channelId);
  }

  get available(): boolean {
    return this.active.available;
  }

}
