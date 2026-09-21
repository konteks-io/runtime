import { WebSocket as NodeWebSocket } from "ws";
import {
  ReconnectBackoff,
  RelayRuntimeHandshakeResultSchema,
  RelayAckSchema,
  RelayReplayRequestSchema,
  RuntimeCancellationDeliveryRequestSchema,
  RemoteExecutionRevisionControlDeliveryRequestSchema,
  RuntimePermissionAnswerDeliveryRequestSchema,
  type RemoteExecutionRevisionControlDeliveryRequest,
  type RuntimePermissionAnswerDeliveryRequest,
  RemoteInstanceError,
  AssignmentReplyFrameSchema,
  ToRuntimeRelayFrameSchema,
  REMOTE_INSTANCE_LIMITS,
  createLogger,
  humanizeTransportError,
  signInstanceProof,
  withJitter,
  type Clock,
  type InstanceKeyPair,
  type JsonValue,
  type Logger,
  type RelayAck,
  type RuntimeCancellationDeliveryRequest,
  type AssignmentReplyFrame,
  type AssignmentRequestFrame,
  type RelayHandshakeRequest,
  type RelayRuntimeHandshakeResult,
  type RelayReplayRequest,
  type ToCoreRelayFrame,
  type ToRuntimeRelayFrame,
} from "@konteks/remote-common";
import { CORE_AUDIENCE } from "../core/client.js";
import { SupervisorConfigSchema } from "../config.js";
import type { ChannelMux } from "./channel-mux.js";

const HANDSHAKE_BUFFER_MAX_FRAMES = 256;
const HANDSHAKE_BUFFER_MAX_BYTES = SupervisorConfigSchema.shape.SUPERVISOR_REPLAY_BUFFER_BYTES.parse(undefined);

/**
 * The single outbound mutually-authenticated WebSocket to the runtime relay
 * (A2 §5). Adapted from bb `apps/host-daemon/connect-tunnel` +
 * `tunnel-client` reconnect mechanics: one socket, exponential backoff with
 * jitter, an epoch-stamped connection attempt so a late socket cannot win.
 *
 * Handshake: the first message is a signed `RelayHandshakeRequest` carrying
 * the current lease and the mux's per-channel cursors; the first reply must
 * be a runtime handshake result including reconciliation authority. Channel
 * envelopes go to the mux; cancellation-only control has a separate receiver.
 */
export type RelayState = "offline" | "connecting" | "handshaking" | "connected" | "reconnecting";

export interface RelayClientOptions {
  relayUrl: string;
  instanceId: () => string;
  /** Actual process incarnation established by Core; never derived from socket IDs. */
  runnerIncarnation: () => string;
  /** Candidate already durably applied locally; Core still resolves current authority. */
  appliedManifestId?: () => string | null;
  lease: () => string | null;
  key: () => InstanceKeyPair;
  clock: Clock;
  mux: ChannelMux;
  createWebSocket?: (url: string) => NodeWebSocket;
  onStateChange?: (state: RelayState, detail: { lastError: string | null; epoch: number }) => void;
  /** Idempotent owner check before epoch adoption/replay and again after cursor persistence. */
  validateHandshake?: (result: RelayRuntimeHandshakeResult) => Promise<void> | void;
  /** Called only after validation and durable mux adoption, with the complete authority result. */
  onConnected?: (result: RelayRuntimeHandshakeResult) => Promise<void> | void;
  /** Separate durable control admission; never a channel cursor or receipt ACK. */
  onCancellation?: (request: RuntimeCancellationDeliveryRequest, connection: {
    connectionEpoch: number;
    assertCurrent(): void;
  }) => Promise<void>;
  onPermissionAnswer?: (request: RuntimePermissionAnswerDeliveryRequest, connection: {
    connectionEpoch: number;
    assertCurrent(): void;
  }) => Promise<void>;
  /** Dedicated C02 safety-control intake; never a mux cursor or receipt ACK. */
  onExecutionRevisionControl?: (request: RemoteExecutionRevisionControlDeliveryRequest, connection: {
    connectionEpoch: number;
    assertCurrent(): void;
  }) => Promise<void>;
  handshakeTimeoutMs?: number;
  outboundHighWaterBytes?: number;
  outboundLowWaterBytes?: number;
  outboundMaxFrames?: number;
  outboundMaxBytes?: number;
  logger?: Logger;
}

export class RelayClient {
  private socket: NodeWebSocket | null = null;
  private state: RelayState = "offline";
  private lastError: string | null = null;
  private attemptEpoch = 0;
  private connectionFence = 0;
  /** Only the validated handshake may emit the mux's retained replay before connected publication. */
  private replaySocket: NodeWebSocket | null = null;
  private discardHandshakeBuffer: (() => void) | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly backoff = new ReconnectBackoff();
  private readonly logger: Logger;
  private connectedAt = 0;
  private lastConnectedAt: string | null = null;
  private consecutiveFailures = 0;
  private readonly outboundQueue: Array<{ socket: NodeWebSocket; payload: string; bytes: number }> = [];
  private outboundQueuedBytes = 0;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RelayClientOptions) {
    this.logger = options.logger ?? createLogger({ name: "relay-client" });
  }

  status(): { state: RelayState; lastError: string | null; epoch: number; lastConnectedAt: string | null; consecutiveFailures: number } {
    return { state: this.state, lastError: this.lastError, epoch: this.options.mux.connectionEpoch, lastConnectedAt: this.lastConnectedAt, consecutiveFailures: this.consecutiveFailures };
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearOutboundQueue();
    this.attemptEpoch += 1;
    this.replaySocket = null;
    this.discardHandshakeBuffer?.();
    this.discardHandshakeBuffer = null;
    this.options.mux.disconnected();
    this.socket?.terminate();
    this.socket = null;
    this.setState("offline");
  }

  /** Forces a fresh handshake (stall, sequence gap, lease change). Unacked frames stay buffered. */
  rehandshake(reason: string): void {
    this.logger.info({ reason }, "re-handshaking the relay socket");
    this.connectionFence += 1;
    this.clearOutboundQueue();
    this.replaySocket = null;
    this.discardHandshakeBuffer?.();
    this.discardHandshakeBuffer = null;
    if (!this.stopped) this.setState("reconnecting");
    this.options.mux.disconnected();
    this.socket?.close(1012, reason);
  }

  /** Serialize on the current socket; false when not connected. */
  emit(envelope: ToCoreRelayFrame | AssignmentRequestFrame | RelayAck): boolean {
    if (!this.socket || this.socket.readyState !== NodeWebSocket.OPEN || (this.state !== "connected" && this.replaySocket !== this.socket)) return false;
    const payload = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(payload);
    const highWater = this.options.outboundHighWaterBytes ?? HANDSHAKE_BUFFER_MAX_BYTES / 2;
    if (this.outboundQueue.length > 0 || this.socket.bufferedAmount + bytes > highWater) {
      const maxFrames = this.options.outboundMaxFrames ?? HANDSHAKE_BUFFER_MAX_FRAMES;
      const maxBytes = this.options.outboundMaxBytes ?? HANDSHAKE_BUFFER_MAX_BYTES;
      if (this.outboundQueue.length >= maxFrames || this.outboundQueuedBytes + bytes > maxBytes) {
        this.logger.warn({ queuedFrames: this.outboundQueue.length, queuedBytes: this.outboundQueuedBytes }, "relay socket backpressure queue is full; durable owner retains the envelope");
        return false;
      }
      this.outboundQueue.push({ socket: this.socket, payload, bytes });
      this.outboundQueuedBytes += bytes;
      this.scheduleDrain();
      return true;
    }
    try {
      this.socket.send(payload, error => {
        if (error) {
          this.lastError = "relay send failed";
          this.logger.warn({ err: error }, "relay send failed; durable owner retains the envelope");
          return;
        }
        this.drain();
      });
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, "relay send failed");
      return false;
    }
  }

  /** Resume queued writes after the socket drops below the configured low-water mark. */
  drain(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== NodeWebSocket.OPEN || (this.state !== "connected" && this.replaySocket !== socket)) return;
    const highWater = this.options.outboundHighWaterBytes ?? HANDSHAKE_BUFFER_MAX_BYTES / 2;
    const lowWater = Math.min(this.options.outboundLowWaterBytes ?? highWater / 2, highWater);
    while (this.outboundQueue.length > 0 && socket.bufferedAmount <= lowWater) {
      const next = this.outboundQueue[0];
      if (!next || next.socket !== socket) { this.clearOutboundQueue(); return; }
      this.outboundQueue.shift();
      this.outboundQueuedBytes -= next.bytes;
      try {
        socket.send(next.payload, error => {
          if (error) {
            this.lastError = "relay send failed";
            this.logger.warn({ err: error }, "relay queued send failed; durable owner retains replay");
          }
          this.drain();
        });
      } catch (error) {
        this.lastError = "relay send failed";
        this.logger.warn({ err: error }, "relay queued send failed; durable owner retains replay");
        return;
      }
    }
    if (this.outboundQueue.length > 0) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.stopped) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, 25);
    this.drainTimer.unref();
  }

  private clearOutboundQueue(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.outboundQueue.length = 0;
    this.outboundQueuedBytes = 0;
  }

  private setState(state: RelayState): void {
    this.state = state;
    this.options.onStateChange?.(state, { lastError: this.lastError, epoch: this.options.mux.connectionEpoch });
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const lease = this.options.lease();
    if (!lease) {
      this.lastError = "no lease";
      this.scheduleReconnect(0);
      return;
    }
    const attempt = ++this.attemptEpoch;
    const fence = this.connectionFence;
    this.setState(this.state === "offline" ? "connecting" : "reconnecting");
    let socket: NodeWebSocket;
    try {
      socket = (this.options.createWebSocket ?? ((url) => new NodeWebSocket(url, { perMessageDeflate: false, maxPayload: REMOTE_INSTANCE_LIMITS.maxFrameBytes })))(this.options.relayUrl);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect(0);
      return;
    }
    this.socket = socket;
    let handshook = false;
    let handshakeProcessing = false;
    let validatedEpoch: number | null = null;
    const pending: Array<ToRuntimeRelayFrame | AssignmentReplyFrame | RelayAck | RelayReplayRequest | RuntimeCancellationDeliveryRequest | RuntimePermissionAnswerDeliveryRequest | RemoteExecutionRevisionControlDeliveryRequest> = [];
    let pendingBytes = 0;
    const discardPending = () => { pending.length = 0; pendingBytes = 0; };
    this.discardHandshakeBuffer = discardPending;
    let receiveFailed = false;
    const current = () => attempt === this.attemptEpoch && fence === this.connectionFence && !this.stopped && this.socket === socket && !receiveFailed;
    const rejectProtocol = (reason: string, message: string) => {
      if (!current()) return;
      receiveFailed = true;
      this.replaySocket = null;
      discardPending();
      this.lastError = message;
      this.options.mux.disconnected();
      this.setState("reconnecting");
      socket.close(1002, reason);
    };
    const failReceive = (error: unknown) => {
      if (!current()) return;
      receiveFailed = true;
      this.replaySocket = null;
      discardPending();
      this.lastError = "relay durable receive failed";
      this.logger.warn({ err: error }, "relay durable receive failed; retaining replay for reconnect");
      this.options.mux.disconnected();
      this.setState("reconnecting");
      socket.close(1011, "durable_receive_failed");
    };
    const receive = async (value: unknown) => {
      const replay = RelayReplayRequestSchema.safeParse(value);
      if (replay.success) {
        if (replay.data.connectionEpoch !== validatedEpoch) {
          throw new RemoteInstanceError("relay_epoch_stale", "Replay request socket ownership is not current");
        }
        await this.options.mux.requestReplay(replay.data);
        return;
      }
      if (typeof value === "object" && value !== null && "type" in value && value.type === "runtime_permission_answer_delivery") {
        const request = RuntimePermissionAnswerDeliveryRequestSchema.parse(value);
        const epoch = validatedEpoch;
        const assertCurrent = () => {
          if (!current() || socket.readyState !== NodeWebSocket.OPEN || epoch === null ||
            validatedEpoch !== epoch || request.connectionEpoch !== epoch) {
            throw new RemoteInstanceError("recovery_required", "Answer socket ownership is not current");
          }
        };
        assertCurrent();
        if (!this.options.onPermissionAnswer) throw new RemoteInstanceError("recovery_required", "Permission answer receiver is unavailable");
        await this.options.onPermissionAnswer(request, { connectionEpoch: request.connectionEpoch, assertCurrent });
        assertCurrent();
        return;
      }
      if (typeof value === "object" && value !== null && "type" in value && value.type === "runtime_cancellation_delivery") {
        const request = RuntimeCancellationDeliveryRequestSchema.parse(value);
        const epoch = validatedEpoch;
        const assertCurrent = () => {
          if (!current() || socket.readyState !== NodeWebSocket.OPEN || epoch === null ||
              validatedEpoch !== epoch || request.connectionEpoch !== epoch) {
            throw new RemoteInstanceError("recovery_required", "Cancellation socket ownership is not current");
          }
        };
        assertCurrent();
        if (!this.options.onCancellation) throw new RemoteInstanceError("recovery_required", "Cancellation receiver is unavailable");
        await this.options.onCancellation(request, { connectionEpoch: request.connectionEpoch, assertCurrent });
        assertCurrent();
        return;
      }
      if (typeof value === "object" && value !== null && "type" in value && value.type === "runtime_execution_revision_control_delivery") {
        const request = RemoteExecutionRevisionControlDeliveryRequestSchema.parse(value);
        const epoch = validatedEpoch;
        const assertCurrent = () => {
          if (!current() || socket.readyState !== NodeWebSocket.OPEN || epoch === null ||
              validatedEpoch !== epoch || request.connectionEpoch !== epoch) {
            throw new RemoteInstanceError("recovery_required", "Revision-control socket ownership is not current");
          }
        };
        assertCurrent();
        if (!this.options.onExecutionRevisionControl) throw new RemoteInstanceError("recovery_required", "Revision-control receiver is unavailable");
        await this.options.onExecutionRevisionControl(request, { connectionEpoch: request.connectionEpoch, assertCurrent });
        assertCurrent();
        return;
      }
      await this.options.mux.receive(value);
    };
    const handshakeTimer = setTimeout(() => {
      if (!handshook && current()) {
        receiveFailed = true;
        this.replaySocket = null;
        discardPending();
        this.lastError = "relay handshake timed out";
        this.options.mux.disconnected();
        this.setState("reconnecting");
        socket.terminate();
      }
    }, this.options.handshakeTimeoutMs ?? 15_000);
    handshakeTimer.unref();

    socket.on("open", () => {
      if (!current()) {
        socket.terminate();
        return;
      }
      this.setState("handshaking");
      const appliedManifestId = this.options.appliedManifestId?.();
      const body = { instanceId: this.options.instanceId(), runnerIncarnation: this.options.runnerIncarnation(), lease, lastAckedSeq: this.options.mux.handshakeCursors(), ...(appliedManifestId == null ? {} : { appliedManifestId }) };
      const request: RelayHandshakeRequest = {
        ...body,
        proof: signInstanceProof(this.options.key(), { method: "relay_handshake", audience: CORE_AUDIENCE, subject: body.instanceId, body: body as unknown as { [key: string]: JsonValue } }),
      };
      socket.send(JSON.stringify(request));
    });
    socket.on("message", (data) => {
      if (!current()) return;
      if (handshakeProcessing && validatedEpoch === null) {
        rejectProtocol("not_ready", "relay sent data before handshake authority validation completed");
        return;
      }
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : Array.isArray(data)
        ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
      if (bytes > REMOTE_INSTANCE_LIMITS.maxFrameBytes) {
        rejectProtocol("frame_too_large", "relay message exceeded the frame size limit");
        return;
      }
      let parsed: unknown;
      try {
        const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8")
          : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
        parsed = JSON.parse(text);
      } catch {
        rejectProtocol("protocol", "relay sent a non-JSON message");
        return;
      }
      if (handshakeProcessing) {
        const ack = RelayAckSchema.safeParse(parsed);
        const assignment = ack.success ? null : AssignmentReplyFrameSchema.safeParse(parsed);
        const cancellation = RuntimeCancellationDeliveryRequestSchema.safeParse(parsed);
        const revisionControl = RemoteExecutionRevisionControlDeliveryRequestSchema.safeParse(parsed);
        const answer = RuntimePermissionAnswerDeliveryRequestSchema.safeParse(parsed);
        const replay = RelayReplayRequestSchema.safeParse(parsed);
        const frame = answer.success ? answer : cancellation.success ? cancellation : revisionControl.success ? revisionControl : replay.success ? replay : ack.success ? ack : assignment?.success ? assignment : ToRuntimeRelayFrameSchema.safeParse(parsed);
        if (!frame.success || frame.data.connectionEpoch !== validatedEpoch) {
          rejectProtocol("protocol", "relay sent an invalid post-handshake envelope");
          return;
        }
        if (pending.length >= HANDSHAKE_BUFFER_MAX_FRAMES || pendingBytes + bytes > HANDSHAKE_BUFFER_MAX_BYTES) {
          rejectProtocol("handshake_buffer_full", "relay post-handshake buffer exceeded its bounded capacity");
          return;
        }
        pending.push(frame.data);
        pendingBytes += bytes;
        return;
      }
      if (!handshook) {
        const result = RelayRuntimeHandshakeResultSchema.safeParse(parsed);
        if (!result.success) {
          rejectProtocol("handshake", "relay handshake result did not match the runtime schema");
          return;
        }
        handshakeProcessing = true;
        void (async () => {
          const validation = this.options.validateHandshake?.(result.data);
          // A synchronous durable-owner check and mux adoption stay in the
          // same turn; do not introduce an avoidable authority-change gap.
          if (validation !== undefined) await validation;
          if (!current() || socket.readyState !== NodeWebSocket.OPEN) return;
          validatedEpoch = result.data.connectionEpoch;
          this.replaySocket = socket;
          await this.options.mux.applyHandshake(result.data);
          if (!current() || socket.readyState !== NodeWebSocket.OPEN) return;
          // Cursor fsync yielded. A queued envelope cannot inherit a later
          // generation just because that new generation is now authorized.
          const revalidation = this.options.validateHandshake?.(result.data);
          if (revalidation !== undefined) await revalidation;
          if (!current() || socket.readyState !== NodeWebSocket.OPEN) return;
          // Admission is synchronous; mux.receive captures its per-channel
          // authority before awaiting its lane. Never await a whole agent turn
          // here: another channel may carry that turn's permission response.
          for (const envelope of pending) {
            const admission = this.options.validateHandshake?.(result.data);
            if (admission !== undefined) await admission;
            if (!current() || socket.readyState !== NodeWebSocket.OPEN) return;
            void receive(envelope).catch(failReceive);
          }
          discardPending();
          this.replaySocket = null;
          handshook = true;
          handshakeProcessing = false;
          clearTimeout(handshakeTimer);
          this.connectedAt = Date.now();
          this.lastConnectedAt = this.options.clock.nowIso();
          this.consecutiveFailures = 0;
          this.lastError = null;
          this.setState("connected");
          if (current()) await this.options.onConnected?.(result.data);
        })().catch(failReceive);
        return;
      }
      void receive(parsed).catch(failReceive);
    });
    socket.on("unexpected-response", (_request, response) => {
      this.lastError = `relay rejected the connection: HTTP ${response.statusCode ?? 0}`;
      response.resume();
      socket.terminate();
    });
    socket.on("error", (error: Error) => {
      if (attempt !== this.attemptEpoch) return;
      this.lastError = humanizeTransportError(error, new URL(this.options.relayUrl).host);
    });
    socket.on("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      if (attempt !== this.attemptEpoch) return;
      this.socket = null;
      this.clearOutboundQueue();
      this.replaySocket = null;
      discardPending();
      this.discardHandshakeBuffer = null;
      this.options.mux.disconnected();
      if (this.stopped) {
        this.setState("offline");
        return;
      }
      if (this.lastError === null) this.lastError = `relay socket closed (code ${code}${reason.length > 0 ? `, ${reason.toString()}` : ""})`;
      this.consecutiveFailures += handshook ? 0 : 1;
      this.setState("reconnecting");
      this.scheduleReconnect(handshook ? Date.now() - this.connectedAt : 0);
    });
  }

  private scheduleReconnect(connectedForMs: number): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = withJitter(this.backoff.nextDelayAfterClose(connectedForMs));
    this.logger.warn({ operation: "relay.connect", attempt: Math.max(1, this.consecutiveFailures), delayMs: delay,
      classification: relayFailureClassification(this.lastError), retryMode: "durable_unbounded" }, "relay disconnected; reconnecting with backoff");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
}

function relayFailureClassification(error: string | null): string {
  if (!error) return "socket_closed";
  if (/timed out|timeout/i.test(error)) return "timeout";
  if (/certificate|tls/i.test(error)) return "tls";
  if (/refused/i.test(error)) return "connection_refused";
  if (/not found/i.test(error)) return "dns";
  if (/reset/i.test(error)) return "connection_reset";
  if (/HTTP 429/i.test(error)) return "rate_limited";
  if (/HTTP 5\d\d/i.test(error)) return "upstream";
  return "socket_closed";
}
