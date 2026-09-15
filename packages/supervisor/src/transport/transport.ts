import type { AssignmentRequestReference, LogicalAssignmentRequestFrame, RelayChannel, ToRuntimeRelayFrame } from "@konteks/remote-common";

/**
 * The supervisor's transport seam. The relay and the HTTPS fallback carry the
 * same messages with the same idempotency keys; the orchestrator above this
 * interface never knows which one is active (D84/D91).
 */
import type { OutboundBody } from "../relay/channel-mux.js";
export type { OutboundBody };

export interface OutboundMessage {
  channel: RelayChannel;
  channelId: string;
  body: OutboundBody;
  /** Instance-key signature for control/heartbeat/observation bodies. */
  signature?: string;
  /** Local retained-allocation identity; never another wire field or authority. */
  assignmentRequest?: AssignmentRequestReference;
  /** Exact journal-owned logical frame. The carrier may add only its current hop epoch. */
  assignmentFrame?: LogicalAssignmentRequestFrame;
  /** Durable logical session sequence; relay must use exactly this value. */
  sourceSequence?: number;
}

export interface InboundMessage {
  channel: ToRuntimeRelayFrame["channel"];
  channelId: string;
  body: ToRuntimeRelayFrame["body"];
  assignmentRequest?: AssignmentRequestReference;
}

export type TransportKind = "relay" | "https";
export type InboundHandler = (message: InboundMessage) => void | Promise<void>;

export interface ControlPlaneTransport {
  readonly kind: TransportKind;
  /** Enqueue for delivery; durable callers keep their own outbox records until acked. */
  send(message: OutboundMessage): void;
  onInbound(handler: InboundHandler): void;
  openChannel(channelId: string, channel: RelayChannel): void;
  closeChannel(channelId: string): void;
  start(): void;
  stop(): void;
  resumeAfterRecovery?(): void;
  /** Temporary prepared-assignment HTTPS lane, independent of ordinary polling. */
  startPreparedAssignments?(): void;
  resumePreparedAssignments?(): void;
  pauseOrdinaryPolling?(): void;
  readonly available: boolean;
}
