import { WebSocket as NodeWebSocket } from "ws";
import {
  ReconnectBackoff,
  RelayRuntimeHandshakeResultSchema,
  RelayAckSchema,
  RelayReplayRequestSchema,
  RuntimeCancellationDeliveryRequestSchema,
  DiagnosticCarrierCompanionDeliveryRequestSchema,
  RemoteExecutionRevisionControlDeliveryRequestSchema,
  RuntimePermissionAnswerDeliveryRequestSchema,
  RuntimeAgentLoginDeliveryRequestSchema,
  type RuntimeAgentLoginDeliveryRequest,
  RuntimeUpdateDeliveryRequestSchema,
  type RuntimeUpdateDeliveryRequest,
  type RemoteExecutionRevisionControlDeliveryRequest,
  type RuntimePermissionAnswerDeliveryRequest,
  type DiagnosticCarrierCompanionDeliveryRequest,
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
 * Adapted from bb `apps/host-daemon/connect-tunnel` +
 * `tunnel-client` reconnect mechanics: one socket, exponential backoff with
 * jitter, an epoch-stamped connection attempt so a late socket cannot win.
 *
 * Handshake: the first message is a signed `RelayHandshakeRequest` carrying
 * the current lease and the mux's per-channel cursors; the first reply must
 * be a runtime handshake result including reconciliation authority. Channel
 * envelopes go to the mux; cancellation-only control has a separate receiver.
 */
type RelayState = "offline" | "connecting" | "handshaking" | "connected" | "reconnecting";

/** What the relay may send once its handshake result has arrived, buffered until the handshake is adopted. */
type InboundEnvelope = ToRuntimeRelayFrame | AssignmentReplyFrame | RelayAck | RelayReplayRequest | RuntimeCancellationDeliveryRequest
  | RuntimePermissionAnswerDeliveryRequest | RemoteExecutionRevisionControlDeliveryRequest | RuntimeAgentLoginDeliveryRequest | RuntimeUpdateDeliveryRequest;

type DeliveryReceiver<R> = (request: R, connection: { connectionEpoch: number; assertCurrent(): void }) => Promise<void>;

/** One connection attempt: its socket and handshake progress. */
interface SocketAttempt {
  socket: NodeWebSocket;
  lease: string;
  handshook: boolean;
  handshakeProcessing: boolean;
  validatedEpoch: number | null;
  pending: InboundEnvelope[];
  pendingBytes: number;
  receiveFailed: boolean;
  handshakeTimer: NodeJS.Timeout | undefined;
  /** This attempt still owns the client's socket. */
  current(): boolean;
  discardPending(): void;
}

/** Post-handshake envelopes in the order they are recognised; anything else must be a channel frame. */
const POST_HANDSHAKE_SCHEMAS: ReadonlyArray<{ safeParse(value: unknown): { success: boolean; data?: unknown } }> = [
  RuntimePermissionAnswerDeliveryRequestSchema, RuntimeAgentLoginDeliveryRequestSchema, RuntimeUpdateDeliveryRequestSchema, RuntimeCancellationDeliveryRequestSchema,
  RemoteExecutionRevisionControlDeliveryRequestSchema, RelayReplayRequestSchema, RelayAckSchema, AssignmentReplyFrameSchema,
];

function postHandshakeEnvelope(parsed: unknown): InboundEnvelope | null {
  for (const schema of POST_HANDSHAKE_SCHEMAS) {
    const result = schema.safeParse(parsed);
    if (result.success) return result.data as InboundEnvelope;
  }
  const frame = ToRuntimeRelayFrameSchema.safeParse(parsed);
  return frame.success ? frame.data : null;
}

function rawDataBytes(data: NodeWebSocket.RawData | string): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  return Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
}

function rawDataText(data: NodeWebSocket.RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
}

function parsedMessage(data: NodeWebSocket.RawData | string): { value: unknown } | null {
  try {
    return { value: JSON.parse(rawDataText(data)) };
  } catch {
    return null;
  }
}

function deliveryType(value: unknown): unknown {
  return typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
}

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
  /** A coding agent login the person started from the site. */
  onAgentLogin?: (request: RuntimeAgentLoginDeliveryRequest, connection: {
    connectionEpoch: number;
    assertCurrent(): void;
  }) => Promise<void>;
  /** A fixed signed runtime update, outside the work channel and its cursors. */
  onRuntimeUpdate?: DeliveryReceiver<RuntimeUpdateDeliveryRequest>;
  /** Dedicated safety-control intake; never a mux cursor or receipt ACK. */
  onExecutionRevisionControl?: (request: RemoteExecutionRevisionControlDeliveryRequest, connection: {
    connectionEpoch: number;
    assertCurrent(): void;
  }) => Promise<void>;
  /** Diagnostic-only sidecar; its failure must not interrupt work transport. */
  onDiagnosticCompanion?: (request: DiagnosticCarrierCompanionDeliveryRequest, connection: {
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
  /** Why this runtime closed a socket itself; a close without one came from the peer or the network. */
  private readonly localCloseReasons = new WeakMap<object, string>();
  private lastConnectedAt: string | null = null;
  private consecutiveFailures = 0;
  private readonly outboundQueue: Array<{ socket: NodeWebSocket; payload: string; bytes: number }> = [];
  private outboundQueuedBytes = 0;
  private drainTimer: NodeJS.Timeout | null = null;
  /** Re-handshakes with the current lease before the one this socket handshook with expires. */
  private leaseRotationTimer: NodeJS.Timeout | null = null;

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
    this.clearLeaseRotation();
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
    this.clearLeaseRotation();
    this.connectionFence += 1;
    this.clearOutboundQueue();
    this.replaySocket = null;
    this.discardHandshakeBuffer?.();
    this.discardHandshakeBuffer = null;
    if (!this.stopped) this.setState("reconnecting");
    this.options.mux.disconnected();
    if (this.socket) this.localCloseReasons.set(this.socket, `rehandshake:${reason}`);
    this.socket?.close(1012, reason);
  }

  /** Serialize on the current socket; false when not connected. */
  emit(envelope: ToCoreRelayFrame | AssignmentRequestFrame | RelayAck): boolean {
    const socket = this.writableSocket();
    if (!socket) return false;
    const payload = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(payload);
    if (this.outboundQueue.length > 0 || socket.bufferedAmount + bytes > this.highWater()) return this.enqueue(socket, payload, bytes);
    try {
      socket.send(payload, error => {
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

  /** The open socket that may carry frames: the connected one, or the validated handshake's while it replays. */
  private writableSocket(): NodeWebSocket | null {
    const socket = this.socket;
    if (!socket || socket.readyState !== NodeWebSocket.OPEN) return null;
    return this.state === "connected" || this.replaySocket === socket ? socket : null;
  }

  private highWater(): number {
    return this.options.outboundHighWaterBytes ?? HANDSHAKE_BUFFER_MAX_BYTES / 2;
  }

  /** Queues behind backpressure; false when the bounded queue is full (the durable owner keeps the envelope). */
  private enqueue(socket: NodeWebSocket, payload: string, bytes: number): boolean {
    const maxFrames = this.options.outboundMaxFrames ?? HANDSHAKE_BUFFER_MAX_FRAMES;
    const maxBytes = this.options.outboundMaxBytes ?? HANDSHAKE_BUFFER_MAX_BYTES;
    if (this.outboundQueue.length >= maxFrames || this.outboundQueuedBytes + bytes > maxBytes) {
      this.logger.warn({ queuedFrames: this.outboundQueue.length, queuedBytes: this.outboundQueuedBytes }, "relay socket backpressure queue is full; durable owner retains the envelope");
      return false;
    }
    this.outboundQueue.push({ socket, payload, bytes });
    this.outboundQueuedBytes += bytes;
    this.scheduleDrain();
    return true;
  }

  /** Resume queued writes after the socket drops below the configured low-water mark. */
  drain(): void {
    const socket = this.writableSocket();
    if (!socket) return;
    const lowWater = Math.min(this.options.outboundLowWaterBytes ?? this.highWater() / 2, this.highWater());
    while (this.outboundQueue.length > 0 && socket.bufferedAmount <= lowWater) {
      if (!this.sendQueued(socket)) return;
    }
    if (this.outboundQueue.length > 0) this.scheduleDrain();
  }

  /** Sends the oldest queued frame; false when the queue belonged to another socket or the send threw. */
  private sendQueued(socket: NodeWebSocket): boolean {
    const next = this.outboundQueue[0];
    if (!next || next.socket !== socket) {
      this.clearOutboundQueue();
      return false;
    }
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
      return true;
    } catch (error) {
      this.lastError = "relay send failed";
      this.logger.warn({ err: error }, "relay queued send failed; durable owner retains replay");
      return false;
    }
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
    const attemptNumber = ++this.attemptEpoch;
    const fence = this.connectionFence;
    this.setState(this.state === "offline" ? "connecting" : "reconnecting");
    const socket = this.openSocket();
    if (!socket) return;
    this.socket = socket;
    const attempt = this.newAttempt(socket, lease, () => attemptNumber === this.attemptEpoch && fence === this.connectionFence);
    attempt.handshakeTimer = setTimeout(() => this.handshakeTimedOut(attempt), this.options.handshakeTimeoutMs ?? 15_000);
    attempt.handshakeTimer.unref();
    socket.on("open", () => this.onOpen(attempt));
    socket.on("message", data => this.onMessage(attempt, data));
    socket.on("unexpected-response", (_request, response) => {
      this.lastError = `relay rejected the connection: HTTP ${response.statusCode ?? 0}`;
      response.resume();
      this.localCloseReasons.set(socket, `http_${response.statusCode ?? 0}`);
      socket.terminate();
    });
    socket.on("error", (error: Error) => {
      if (attemptNumber !== this.attemptEpoch) return;
      this.lastError = humanizeTransportError(error, new URL(this.options.relayUrl).host);
    });
    socket.on("close", (code, reason) => this.onClose(attempt, attemptNumber, code, reason));
  }

  private openSocket(): NodeWebSocket | null {
    try {
      return (this.options.createWebSocket ?? ((url) => new NodeWebSocket(url, { perMessageDeflate: false, maxPayload: REMOTE_INSTANCE_LIMITS.maxFrameBytes })))(this.options.relayUrl);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect(0);
      return null;
    }
  }

  private newAttempt(socket: NodeWebSocket, lease: string, ownsAttempt: () => boolean): SocketAttempt {
    const attempt: SocketAttempt = {
      socket, lease, handshook: false, handshakeProcessing: false, validatedEpoch: null, pending: [], pendingBytes: 0, receiveFailed: false, handshakeTimer: undefined,
      current: () => ownsAttempt() && !this.stopped && this.socket === socket && !attempt.receiveFailed,
      discardPending: () => { attempt.pending.length = 0; attempt.pendingBytes = 0; },
    };
    this.discardHandshakeBuffer = attempt.discardPending;
    return attempt;
  }

  /** The attempt still owns an open socket. */
  private socketCurrent(attempt: SocketAttempt): boolean {
    return attempt.current() && attempt.socket.readyState === NodeWebSocket.OPEN;
  }

  /** Gives up this socket: no further receive, no buffered envelopes, a reconnect follows its close. */
  private abandon(attempt: SocketAttempt, lastError: string, localReason: string, close: (socket: NodeWebSocket) => void): void {
    attempt.receiveFailed = true;
    this.replaySocket = null;
    attempt.discardPending();
    this.lastError = lastError;
    this.options.mux.disconnected();
    this.setState("reconnecting");
    this.localCloseReasons.set(attempt.socket, localReason);
    close(attempt.socket);
  }

  private rejectProtocol(attempt: SocketAttempt, reason: string, message: string): void {
    if (!attempt.current()) return;
    this.abandon(attempt, message, `protocol:${reason}`, socket => socket.close(1002, reason));
  }

  private failReceive(attempt: SocketAttempt, error: unknown): void {
    if (!attempt.current()) return;
    this.logger.warn({ err: error }, "relay durable receive failed; retaining replay for reconnect");
    this.abandon(attempt, "relay durable receive failed", "durable_receive_failed", socket => socket.close(1011, "durable_receive_failed"));
  }

  private handshakeTimedOut(attempt: SocketAttempt): void {
    if (attempt.handshook || !attempt.current()) return;
    this.abandon(attempt, "relay handshake timed out", "handshake_timeout", socket => socket.terminate());
  }

  private onOpen(attempt: SocketAttempt): void {
    if (!attempt.current()) {
      attempt.socket.terminate();
      return;
    }
    this.setState("handshaking");
    const appliedManifestId = this.options.appliedManifestId?.();
    const body = { instanceId: this.options.instanceId(), runnerIncarnation: this.options.runnerIncarnation(), lease: attempt.lease, lastAckedSeq: this.options.mux.handshakeCursors(), ...(appliedManifestId == null ? {} : { appliedManifestId }) };
    const request: RelayHandshakeRequest = {
      ...body,
      proof: signInstanceProof(this.options.key(), { method: "relay_handshake", audience: CORE_AUDIENCE, subject: body.instanceId, body: body as unknown as { [key: string]: JsonValue } }),
    };
    attempt.socket.send(JSON.stringify(request));
  }

  private onMessage(attempt: SocketAttempt, data: NodeWebSocket.RawData): void {
    if (!attempt.current()) return;
    if (attempt.handshakeProcessing && attempt.validatedEpoch === null) {
      return this.rejectProtocol(attempt, "not_ready", "relay sent data before handshake authority validation completed");
    }
    const bytes = rawDataBytes(data);
    if (bytes > REMOTE_INSTANCE_LIMITS.maxFrameBytes) return this.rejectProtocol(attempt, "frame_too_large", "relay message exceeded the frame size limit");
    const parsed = parsedMessage(data);
    if (parsed === null) return this.rejectProtocol(attempt, "protocol", "relay sent a non-JSON message");
    if (attempt.handshakeProcessing) return this.bufferDuringHandshake(attempt, parsed.value, bytes);
    if (!attempt.handshook) return this.handshakeResult(attempt, parsed.value);
    void this.receive(attempt, parsed.value).catch(error => this.failReceive(attempt, error));
  }

  /** Envelopes that arrive while the handshake is being adopted wait, bounded, for that adoption. */
  private bufferDuringHandshake(attempt: SocketAttempt, parsed: unknown, bytes: number): void {
    const envelope = postHandshakeEnvelope(parsed);
    if (envelope === null || envelope.connectionEpoch !== attempt.validatedEpoch) {
      return this.rejectProtocol(attempt, "protocol", "relay sent an invalid post-handshake envelope");
    }
    if (attempt.pending.length >= HANDSHAKE_BUFFER_MAX_FRAMES || attempt.pendingBytes + bytes > HANDSHAKE_BUFFER_MAX_BYTES) {
      return this.rejectProtocol(attempt, "handshake_buffer_full", "relay post-handshake buffer exceeded its bounded capacity");
    }
    attempt.pending.push(envelope);
    attempt.pendingBytes += bytes;
  }

  private handshakeResult(attempt: SocketAttempt, parsed: unknown): void {
    const result = RelayRuntimeHandshakeResultSchema.safeParse(parsed);
    if (!result.success) return this.rejectProtocol(attempt, "handshake", "relay handshake result did not match the runtime schema");
    attempt.handshakeProcessing = true;
    void this.adoptHandshake(attempt, result.data).catch(error => this.failReceive(attempt, error));
  }

  /**
   * Validate, then adopt the epoch and the mux cursors. A synchronous
   * durable-owner check and mux adoption stay in the same turn; do not
   * introduce an avoidable authority-change gap.
   */
  private async adoptHandshake(attempt: SocketAttempt, handshake: RelayRuntimeHandshakeResult): Promise<void> {
    const validation = this.options.validateHandshake?.(handshake);
    if (validation !== undefined) await validation;
    if (!this.socketCurrent(attempt)) return;
    attempt.validatedEpoch = handshake.connectionEpoch;
    this.replaySocket = attempt.socket;
    await this.options.mux.applyHandshake(handshake);
    if (!this.socketCurrent(attempt)) return;
    return this.revalidateHandshake(attempt, handshake);
  }

  /**
   * Cursor fsync yielded. A queued envelope cannot inherit a later generation
   * just because that new generation is now authorized.
   */
  private async revalidateHandshake(attempt: SocketAttempt, handshake: RelayRuntimeHandshakeResult): Promise<void> {
    const revalidation = this.options.validateHandshake?.(handshake);
    if (revalidation !== undefined) await revalidation;
    if (!this.socketCurrent(attempt)) return;
    return this.admitPendingAndConnect(attempt, handshake);
  }

  /**
   * Admission is synchronous; mux.receive captures its per-channel authority
   * before awaiting its lane. Never await a whole agent turn here: another
   * channel may carry that turn's permission response.
   */
  private async admitPendingAndConnect(attempt: SocketAttempt, handshake: RelayRuntimeHandshakeResult): Promise<void> {
    for (const envelope of attempt.pending) {
      const admission = this.options.validateHandshake?.(handshake);
      if (admission !== undefined) await admission;
      if (!this.socketCurrent(attempt)) return;
      void this.receive(attempt, envelope).catch(error => this.failReceive(attempt, error));
    }
    attempt.discardPending();
    this.replaySocket = null;
    attempt.handshook = true;
    attempt.handshakeProcessing = false;
    clearTimeout(attempt.handshakeTimer);
    this.connectedAt = Date.now();
    this.lastConnectedAt = this.options.clock.nowIso();
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.setState("connected");
    this.armLeaseRotation(attempt.lease);
    if (attempt.current()) await this.options.onConnected?.(handshake);
  }

  private async receive(attempt: SocketAttempt, value: unknown): Promise<void> {
    const replay = RelayReplayRequestSchema.safeParse(value);
    if (replay.success) {
      if (replay.data.connectionEpoch !== attempt.validatedEpoch) {
        throw new RemoteInstanceError("relay_epoch_stale", "Replay request socket ownership is not current");
      }
      await this.options.mux.requestReplay(replay.data);
      return;
    }
    return this.dispatch(attempt, value);
  }

  /** A control delivery to its own receiver; anything else is a channel envelope for the mux. */
  private async dispatch(attempt: SocketAttempt, value: unknown): Promise<void> {
    switch (deliveryType(value)) {
      case "runtime_permission_answer_delivery":
        return this.deliver(attempt, RuntimePermissionAnswerDeliveryRequestSchema.parse(value), "Answer", this.receiverFor(this.options.onPermissionAnswer), "Permission answer receiver is unavailable");
      case "runtime_agent_login_delivery":
        return this.deliverLogin(attempt, value);
      case "runtime_update_delivery":
        return this.deliverRuntimeUpdate(attempt, value);
      case "runtime_cancellation_delivery":
        return this.deliver(attempt, RuntimeCancellationDeliveryRequestSchema.parse(value), "Cancellation", this.receiverFor(this.options.onCancellation), "Cancellation receiver is unavailable");
      case "runtime_diagnostic_carrier_companion_delivery":
        return this.deliverDiagnostic(attempt, value);
      case "runtime_execution_revision_control_delivery":
        return this.deliver(attempt, RemoteExecutionRevisionControlDeliveryRequestSchema.parse(value), "Revision-control", this.receiverFor(this.options.onExecutionRevisionControl), "Revision-control receiver is unavailable");
      default:
        await this.options.mux.receive(value);
    }
  }

  /** The options' receiver, called as the options' own method. */
  private receiverFor<R>(receiver: DeliveryReceiver<R> | undefined): DeliveryReceiver<R> | undefined {
    return receiver?.bind(this.options);
  }

  /** A check that this socket and the epoch the request was delivered on are still current. */
  private deliveryGuard(attempt: SocketAttempt, request: { connectionEpoch: number }, label: string): () => void {
    const epoch = attempt.validatedEpoch;
    return () => {
      if (!this.socketCurrent(attempt) || epoch === null || attempt.validatedEpoch !== epoch || request.connectionEpoch !== epoch) {
        throw new RemoteInstanceError("recovery_required", `${label} socket ownership is not current`);
      }
    };
  }

  /** A control delivery outside the channel cursors, checked current before and after its receiver. */
  private async deliver<R extends { connectionEpoch: number }>(attempt: SocketAttempt, request: R, label: string, receiver: DeliveryReceiver<R> | undefined, unavailable: string, checkAfter = true): Promise<void> {
    const assertCurrent = this.deliveryGuard(attempt, request, label);
    assertCurrent();
    if (!receiver) throw new RemoteInstanceError("recovery_required", unavailable);
    await receiver(request, { connectionEpoch: request.connectionEpoch, assertCurrent });
    if (checkAfter) assertCurrent();
  }

  /**
   * A login is the person's convenience, never work transport: whatever goes
   * wrong with it is logged and dropped, and the socket stays up.
   */
  private async deliverLogin(attempt: SocketAttempt, value: unknown): Promise<void> {
    try {
      await this.deliver(attempt, RuntimeAgentLoginDeliveryRequestSchema.parse(value), "Login", this.receiverFor(this.options.onAgentLogin), "Agent login receiver is unavailable", false);
    } catch (error) {
      this.logger.warn({ err: error }, "agent login delivery dropped");
    }
  }

  private async deliverRuntimeUpdate(attempt: SocketAttempt, value: unknown): Promise<void> {
    try {
      await this.deliver(attempt, RuntimeUpdateDeliveryRequestSchema.parse(value), "Runtime update", this.receiverFor(this.options.onRuntimeUpdate), "Runtime update receiver is unavailable", false);
    } catch {
      // The operation carries no diagnostics or secrets back to the browser.
      // A refusal never tears down ordinary work transport.
      this.logger.warn({ event: "runtime.update_delivery_refused" }, "runtime update delivery refused");
    }
  }

  /**
   * Diagnostics are deliberately best effort: malformed, stale, or
   * unavailable sidecars become a coverage signal, never a work outage.
   */
  private async deliverDiagnostic(attempt: SocketAttempt, value: unknown): Promise<void> {
    try {
      const request = DiagnosticCarrierCompanionDeliveryRequestSchema.parse(value);
      const receiver = this.receiverFor(this.options.onDiagnosticCompanion);
      if (receiver) return await this.deliver(attempt, request, "Diagnostic companion", receiver, "");
      this.deliveryGuard(attempt, request, "Diagnostic companion")();
      this.logger.warn({
        event: "runtime.diagnostic_companion.coverage_incomplete",
        outcome: "unknown",
        reason: "receiver_unavailable",
        deliveryId: request.companion.deliveryId,
      }, "diagnostic companion coverage is incomplete");
    } catch (error) {
      this.logger.warn({ err: error }, "diagnostic companion delivery was not retained");
    }
  }

  private onClose(attempt: SocketAttempt, attemptNumber: number, code: number, reason: Buffer): void {
    clearTimeout(attempt.handshakeTimer);
    if (attemptNumber !== this.attemptEpoch) return;
    this.clearLeaseRotation();
    this.socket = null;
    this.clearOutboundQueue();
    this.replaySocket = null;
    attempt.discardPending();
    this.discardHandshakeBuffer = null;
    this.options.mux.disconnected();
    if (this.stopped) {
      this.setState("offline");
      return;
    }
    this.logClose(attempt, code, reason);
    if (this.lastError === null) this.lastError = `relay socket closed (code ${code}${reason.length > 0 ? `, ${reason.toString()}` : ""})`;
    this.consecutiveFailures += attempt.handshook ? 0 : 1;
    this.setState("reconnecting");
    this.scheduleReconnect(attempt.handshook ? Date.now() - this.connectedAt : 0);
  }

  /** Who closed the socket and why, every time: a close with no local reason came from the relay or the network (1006: no close frame). */
  private logClose(attempt: SocketAttempt, code: number, reason: Buffer): void {
    const localReason = this.localCloseReasons.get(attempt.socket) ?? null;
    this.logger.warn({ event: "relay.socket.closed", code, reason: reason.toString("utf8").slice(0, 120),
      closedBy: localReason ? "runtime" : "peer_or_network", localReason, handshook: attempt.handshook,
      connectedForMs: attempt.handshook ? Date.now() - this.connectedAt : null, lastError: this.lastError,
      connectionEpoch: this.options.mux.connectionEpoch }, "relay socket closed");
  }

  /**
   * Core holds a runtime's relay connection to the lease it handshook with,
   * while heartbeats keep adopting fresh ones. Before that first lease
   * expires, re-handshake with the current one (unacked frames stay
   * buffered); otherwise Core calls the socket stale and the relay closes it
   * with 4409 once per lease lifetime.
   */
  private armLeaseRotation(lease: string): void {
    this.clearLeaseRotation();
    const expiresAt = leaseExpiryMs(lease);
    if (expiresAt === null) return;
    const delay = Math.max(LEASE_ROTATION_MIN_DELAY_MS, expiresAt - Date.now() - LEASE_ROTATION_MARGIN_MS);
    this.leaseRotationTimer = setTimeout(() => {
      this.leaseRotationTimer = null;
      if (!this.stopped && this.state === "connected") this.rehandshake("lease_rotation");
    }, delay);
    this.leaseRotationTimer.unref();
  }

  private clearLeaseRotation(): void {
    if (this.leaseRotationTimer) clearTimeout(this.leaseRotationTimer);
    this.leaseRotationTimer = null;
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

const FAILURE_CLASSIFICATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/timed out|timeout/i, "timeout"],
  [/certificate|tls/i, "tls"],
  [/refused/i, "connection_refused"],
  [/not found/i, "dns"],
  [/reset/i, "connection_reset"],
  [/HTTP 429/i, "rate_limited"],
  [/HTTP 5\d\d/i, "upstream"],
];

/** How long before the connected lease expires the socket re-handshakes, and the least it waits. */
const LEASE_ROTATION_MARGIN_MS = 60_000;
const LEASE_ROTATION_MIN_DELAY_MS = 5_000;

/** The `exp` of a lease token, read only to schedule the rotation (Core verifies the lease itself). */
function leaseExpiryMs(lease: string): number | null {
  const payload = lease.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function relayFailureClassification(error: string | null): string {
  if (!error) return "socket_closed";
  return FAILURE_CLASSIFICATIONS.find(([pattern]) => pattern.test(error))?.[1] ?? "socket_closed";
}
