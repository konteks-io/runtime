import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, computeExecutionRevisionControlIntentDigest, generateInstanceKey, logicalAssignmentRequestDigest, verifyInstanceProof, type RelayRuntimeHandshakeResult } from "@konteks/remote-common";
import { RelayClient, type RelayClientOptions } from "../relay/relay-client.js";
import { ChannelMux } from "../relay/channel-mux.js";
import { CORE_AUDIENCE } from "../core/client.js";

const confirmed = { connectionEpoch: 7, resume: {}, reset: [], runtimeReconciliation: {
  state: "confirmed", manifestId: "manifest", receiptDigest: "a".repeat(43), acceptedAt: "2026-09-06T00:00:00.000Z",
} } as const;
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn(); close = vi.fn(); terminate = vi.fn();
  message(value: unknown) { this.emit("message", JSON.stringify(value)); }
}
function fixture(overrides: Partial<RelayClientOptions> = {}) {
  const socket = new Socket(), key = generateInstanceKey();
  const mux = { connectionEpoch: 0, disconnected: vi.fn(), handshakeCursors: () => ({}), applyHandshake: vi.fn(async () => undefined), receive: vi.fn(async () => undefined), requestReplay: vi.fn(async () => undefined) };
  const onConnected = vi.fn();
  const client = new RelayClient({ relayUrl: "wss://relay.example/runtime", instanceId: () => "instance", runnerIncarnation: () => "process",
    lease: () => "lease", key: () => key, clock: new FixedClock(Date.parse(confirmed.runtimeReconciliation.acceptedAt)), mux: mux as never,
    createWebSocket: () => socket as never, onConnected, ...overrides });
  client.start(); socket.emit("open");
  return { client, socket, mux, key, onConnected };
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

function delayedAdoption(overrides: Partial<RelayClientOptions> = {}) {
  const adoption = Promise.withResolvers<void>(), key = generateInstanceKey();
  let authority = "manifest";
  const onFrame = vi.fn(async (_frame: { seq: number }) => undefined);
  const persistCursors = vi.fn(async () => undefined).mockImplementationOnce(() => adoption.promise);
  const mux = new ChannelMux({ recoveryAuthority: () => authority, clock: new FixedClock(Date.parse(confirmed.runtimeReconciliation.acceptedAt)),
    key: () => key, ackIntervalSeconds: 5, ackEveryFrames: 1, replayBufferAgeMs: 60000, replayBufferBytes: 4096,
    emit: value => f.client.emit(value), onFrame, persistCursors, onStall: vi.fn(), onReset: vi.fn() });
  const f = fixture({ mux, validateHandshake: () => { if (authority !== "manifest") throw new Error("generation changed"); }, ...overrides });
  const frame = (seq: number) => ({ channel: "assignment", direction: "to_runtime", channelId: "assignment:instance", connectionEpoch: 7,
    seq, issuedAt: confirmed.runtimeReconciliation.acceptedAt, body: { assignments: [] } });
  f.socket.send.mockClear(); f.socket.message(confirmed);
  return { ...f, mux, adoption, onFrame, persistCursors, frame, replaceGeneration: () => { authority = "replacement"; } };
}

describe("native runtime relay handshake validation boundary", () => {
  it("routes a current relay replay request to the mux without treating it as an ack or data frame", async () => {
    const f = fixture();
    try {
      f.socket.message(confirmed); await flush(); f.socket.send.mockClear();
      const request = { kind: "replay_request", channelId: "session:s", dataDirection: "to_core", connectionEpoch: 7 };
      f.socket.message(request); await flush();
      expect(f.mux.requestReplay).toHaveBeenCalledWith(request);
      expect(f.mux.receive).not.toHaveBeenCalled();
      expect(f.socket.send).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it("bounds socket backpressure and drains queued frames in order once writable", async () => {
    const f = fixture({ outboundHighWaterBytes: 256, outboundLowWaterBytes: 64, outboundMaxFrames: 2, outboundMaxBytes: 1_024 });
    try {
      f.socket.message(confirmed); await flush(); f.socket.send.mockClear();
      f.socket.bufferedAmount = 300;
      const frame = (seq: number) => ({ channel: "heartbeat", direction: "to_core", channelId: "heartbeat:instance", connectionEpoch: 7,
        seq, issuedAt: confirmed.runtimeReconciliation.acceptedAt, body: { sequence: seq } }) as never;
      expect(f.client.emit(frame(1))).toBe(true);
      expect(f.client.emit(frame(2))).toBe(true);
      expect(f.socket.send).not.toHaveBeenCalled();
      expect(f.client.emit(frame(3))).toBe(false);

      f.socket.bufferedAmount = 0;
      f.client.drain();
      expect(f.socket.send.mock.calls.map(call => JSON.parse(call[0]).seq)).toEqual([1, 2]);
    } finally { f.client.stop(); }
  });

  const answer = () => ({ type: "runtime_permission_answer_delivery", method: "POST", path: { instanceId: "instance" },
    nodeId: "node", connectionRef: "connection", connectionEpoch: 7,
    intent: { intentId: "intent", tenantId: "tenant", instanceId: "instance", executionId: "execution",
      operation: { kind: "authorized_operation", operationId: "operation", permit: "a.b.c", message: { kind: "acp_result", method: "session/request_permission", id: "pending", result: { outcome: { outcome: "cancelled" } } } } },
    keyId: "control", nonce: "N".repeat(22), issuedAt: confirmed.runtimeReconciliation.acceptedAt,
    expiresAt: "2026-09-06T00:00:30.000Z", signature: "A".repeat(86) });

  it.each(["direct", "buffered", "unavailable", "epoch"])("routes answer-only control with captured socket ownership: %s", async mode => {
    const receive = vi.fn<NonNullable<RelayClientOptions["onPermissionAnswer"]>>(async (_request, connection) => connection.assertCurrent());
    const options = mode === "unavailable" ? {} : { onPermissionAnswer: receive };
    if (mode === "buffered") {
      const f = delayedAdoption(options);
      try {
        await flush(); f.socket.message(answer()); await flush(); expect(receive).not.toHaveBeenCalled();
        f.adoption.resolve(); await flush(); expect(receive).toHaveBeenCalledOnce();
        expect(f.onFrame).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
      } finally { f.client.stop(); }
      return;
    }
    const f = fixture(options);
    try {
      f.socket.message(confirmed); await flush(); f.socket.send.mockClear();
      f.socket.message({ ...answer(), ...(mode === "epoch" ? { connectionEpoch: 8 } : {}) }); await flush();
      expect(f.mux.receive).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
      if (mode === "direct") {
        expect(receive).toHaveBeenCalledOnce(); const guard = receive.mock.calls[0]![1].assertCurrent;
        f.client.rehandshake("replacement"); expect(guard).toThrow("Answer socket ownership");
      } else { expect(receive).not.toHaveBeenCalled(); expect(f.socket.close).toHaveBeenCalledWith(1011, "durable_receive_failed"); }
    } finally { f.client.stop(); }
  });

  const cancellation = () => ({ type: "runtime_cancellation_delivery", method: "POST", path: { instanceId: "instance" },
    nodeId: "node", connectionRef: "connection", connectionEpoch: 7,
    intent: { intentId: "intent", tenantId: "tenant", instanceId: "instance", sessionId: "session", claimId: "claim", delegationRef: "delegation",
      directive: { assignmentId: "assignment", attempt: 1, reason: "policy_denied", issuedAt: confirmed.runtimeReconciliation.acceptedAt, signature: "A".repeat(86) } },
    keyId: "control", nonce: "N".repeat(22), issuedAt: confirmed.runtimeReconciliation.acceptedAt,
    expiresAt: "2026-09-06T00:00:30.000Z", signature: "A".repeat(86) });

  it("routes cancellation to its own captured socket receiver without mux or ACK", async () => {
    const onCancellation = vi.fn<NonNullable<RelayClientOptions["onCancellation"]>>(async (_request, connection) => connection.assertCurrent());
    const f = fixture({ onCancellation });
    try {
      f.socket.message(confirmed); await flush(); f.socket.send.mockClear();
      f.socket.message(cancellation()); await flush();
      expect(onCancellation).toHaveBeenCalledOnce();
      expect(onCancellation.mock.calls[0]?.[1].connectionEpoch).toBe(7);
      expect(f.mux.receive).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
      expect(f.socket.close).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it("routes C02 revision control only to its current dedicated receiver", async () => {
    const onExecutionRevisionControl = vi.fn(async (_request, connection) => connection.assertCurrent());
    const f = fixture({ onExecutionRevisionControl } as never);
    const intent = {
      schemaVersion: "remote-execution-revision-control-v1" as const,
      negotiatedCapability: "execution-revision-control-v1" as const,
      intentId: "intent",
      tenantId: "tenant",
      instanceId: "instance",
      executionId: "execution",
      executionRevision: 1,
      checkId: "check",
      policyRevision: null,
      connectionRef: "connection",
      connectionEpoch: 7,
      reason: "authority_revoked" as const,
      issuedAt: confirmed.runtimeReconciliation.acceptedAt,
      deadlineAt: "2026-09-06T00:00:02.000Z",
    };
    const request = {
      type: "runtime_execution_revision_control_delivery",
      method: "POST",
      path: { instanceId: "instance" },
      nodeId: "node",
      connectionRef: "connection",
      connectionEpoch: 7,
      intent,
      intentDigest: computeExecutionRevisionControlIntentDigest(intent),
      keyId: "control",
      nonce: "N".repeat(22),
      issuedAt: intent.issuedAt,
      expiresAt: intent.deadlineAt,
      signature: "A".repeat(86),
    };
    try {
      f.socket.message(confirmed); await flush(); f.socket.send.mockClear();
      f.socket.message(request); await flush();
      expect(onExecutionRevisionControl).toHaveBeenCalledOnce();
      expect(f.mux.receive).not.toHaveBeenCalled();
      expect(f.socket.send).not.toHaveBeenCalled();
      const guard = onExecutionRevisionControl.mock.calls[0]![1].assertCurrent;
      f.client.rehandshake("replacement");
      expect(guard).toThrow("Revision-control socket ownership is not current");
    } finally { f.client.stop(); }
  });

  it("buffers cancellation through cursor fsync and captures authority only after adoption", async () => {
    const onCancellation = vi.fn<NonNullable<RelayClientOptions["onCancellation"]>>(async (_request, connection) => connection.assertCurrent());
    const f = delayedAdoption({ onCancellation });
    try {
      await flush(); f.socket.message(cancellation()); await flush();
      expect(onCancellation).not.toHaveBeenCalled(); expect(f.socket.close).not.toHaveBeenCalled();
      f.adoption.resolve(); await flush();
      expect(onCancellation).toHaveBeenCalledOnce(); expect(f.onFrame).not.toHaveBeenCalled();
      expect(f.socket.send).not.toHaveBeenCalled(); expect(f.client.connected).toBe(true);
    } finally { f.client.stop(); }
  });

  it.each(["epoch", "unavailable", "write_failure"])("refuses cancellation on %s without ACK", async fault => {
    const onCancellation = vi.fn(async () => { if (fault === "write_failure") throw new Error("fsync failed"); });
    const f = fixture(fault === "unavailable" ? {} : { onCancellation });
    try {
      f.socket.message(confirmed); await flush(); f.socket.send.mockClear();
      f.socket.message({ ...cancellation(), ...(fault === "epoch" ? { connectionEpoch: 8 } : {}) }); await flush();
      expect(f.socket.close).toHaveBeenCalledWith(1011, "durable_receive_failed");
      expect(f.socket.send).not.toHaveBeenCalled(); expect(f.mux.receive).not.toHaveBeenCalled();
      if (fault !== "write_failure") expect(onCancellation).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it("discards buffered cancellation if reconciliation changes during cursor persistence", async () => {
    const onCancellation = vi.fn(async () => {});
    const f = delayedAdoption({ onCancellation });
    try {
      await flush(); f.socket.message(cancellation()); f.replaceGeneration(); f.adoption.resolve(); await flush();
      expect(onCancellation).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
      expect(f.client.connected).toBe(false);
    } finally { f.client.stop(); }
  });

  it("rejects wrong-epoch cancellation during cursor persistence before admission", async () => {
    const onCancellation = vi.fn(async () => {});
    const f = delayedAdoption({ onCancellation });
    try {
      await flush(); f.socket.message({ ...cancellation(), connectionEpoch: 8 });
      expect(f.socket.close).toHaveBeenCalledWith(1002, "protocol");
      f.adoption.resolve(); await flush();
      expect(onCancellation).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it("invalidates the captured socket while durable admission is awaiting fsync", async () => {
    const write = Promise.withResolvers<void>();
    let guard: (() => void) | undefined;
    const f = fixture({ onCancellation: async (_request, connection) => {
      guard = connection.assertCurrent; guard(); await write.promise; guard();
    } });
    try {
      f.socket.message(confirmed); await flush(); f.socket.send.mockClear();
      f.socket.message(cancellation()); await flush(); expect(guard).toBeDefined();
      f.client.rehandshake("replacement");
      expect(() => guard?.()).toThrow("Cancellation socket ownership is not current");
      write.resolve(); await flush(); expect(f.socket.send).not.toHaveBeenCalled();
    } finally { write.resolve(); f.client.stop(); }
  });

  it("admits the canonical full assignment reply to the mux after handshake validation", async () => {
    const f = fixture();
    const request = { channel: "assignment", direction: "to_core", channelId: "assignment:instance", seq: 1,
      issuedAt: confirmed.runtimeReconciliation.acceptedAt, origin: { runnerIncarnation: "process", manifestId: "manifest" },
      body: { instanceId: "instance", maxItems: 1, acceptedKinds: ["delivery"] } } as const;
    const reply = { channel: "assignment", direction: "to_runtime", channelId: request.channelId, connectionEpoch: 7, seq: 1,
      issuedAt: confirmed.runtimeReconciliation.acceptedAt,
      body: { requestSequence: 1, requestDigest: logicalAssignmentRequestDigest(request), requestKind: "pull", body: { assignments: [] } } } as const;
    try {
      f.socket.message(confirmed); await flush();
      f.socket.message(reply); await flush();
      expect(f.socket.close).not.toHaveBeenCalled();
      expect(f.mux.receive).toHaveBeenCalledWith(reply);
    } finally { f.client.stop(); }
  });

  it("retains valid post-result frames through cursor fsync, then delivers and acknowledges in order", async () => {
    const f = delayedAdoption();
    try {
      await flush(); f.socket.message(f.frame(1)); f.socket.message(f.frame(2));
      expect(f.socket.close).not.toHaveBeenCalled(); expect(f.onFrame).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
      f.adoption.resolve();
      await vi.waitFor(() => expect(f.mux.handshakeCursors()["assignment:instance"]?.to_runtime).toBe(2));
      expect(f.onFrame.mock.calls.map(call => (call[0] as { seq: number }).seq)).toEqual([1, 2]);
      expect(f.socket.send.mock.calls.map(call => JSON.parse(call[0])).filter(value => value.kind === "ack").at(-1)).toMatchObject({ cumulativeSeq: 2 });
      expect(f.client.connected).toBe(true);
    } finally { f.client.stop(); }
  });

  it.each(["write_failure", "stop", "rehandshake", "generation"])("discards retained post-result frames without handler/ACK after %s", async fault => {
    const f = delayedAdoption();
    try {
      await flush(); f.socket.message(f.frame(1));
      expect(f.socket.close).not.toHaveBeenCalled();
      if (fault === "stop") f.client.stop();
      if (fault === "rehandshake") f.client.rehandshake("replacement");
      if (fault === "generation") f.replaceGeneration();
      if (fault === "write_failure") f.adoption.reject(new Error("fsync failed")); else f.adoption.resolve();
      await flush();
      expect(f.onFrame).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled(); expect(f.client.connected).toBe(false);
    } finally { f.client.stop(); }
  });

  it("retains per-channel generation fencing when buffered delivery is admitted before the generation changes", async () => {
    const f = delayedAdoption();
    const receive = f.mux.receive.bind(f.mux);
    vi.spyOn(f.mux, "receive").mockImplementation(value => { const pending = receive(value); f.replaceGeneration(); return pending; });
    try {
      await flush(); f.socket.message(f.frame(1)); f.socket.message({ ...f.frame(1), channelId: "assignment:other" }); expect(f.socket.close).not.toHaveBeenCalled();
      f.adoption.resolve(); await flush();
      expect(f.onFrame).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
      expect(f.mux.handshakeCursors()["assignment:instance"]?.to_runtime).toBe(0);
    } finally { f.client.stop(); }
  });

  it("rejects duplicate handshake replies during cursor fsync", async () => {
    const f = delayedAdoption();
    try {
      await flush(); f.socket.message(confirmed); f.adoption.resolve(); await flush();
      expect(f.socket.close).toHaveBeenCalled(); expect(f.onFrame).not.toHaveBeenCalled(); expect(f.client.connected).toBe(false);
    } finally { f.client.stop(); }
  });

  it("bounds retained post-result frame count and rejects overflow without acknowledgement", async () => {
    const f = delayedAdoption();
    try {
      await flush(); for (let seq = 1; seq <= 256; seq++) f.socket.message(f.frame(seq));
      expect(f.socket.close).not.toHaveBeenCalled(); f.socket.message(f.frame(257));
      f.adoption.resolve(); await flush();
      expect(f.socket.close).toHaveBeenCalled(); expect(f.onFrame).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it("bounds retained serialized bytes, including whitespace discarded by JSON parsing", async () => {
    const f = delayedAdoption();
    const padded = (seq: number) => { const json = JSON.stringify(f.frame(seq)); return json + " ".repeat(1024 * 1024 - Buffer.byteLength(json)); };
    try {
      await flush(); for (let seq = 1; seq <= 8; seq++) f.socket.emit("message", padded(seq));
      expect(f.socket.close).not.toHaveBeenCalled(); f.socket.emit("message", padded(9));
      f.adoption.resolve(); await flush();
      expect(f.socket.close).toHaveBeenCalled(); expect(f.onFrame).not.toHaveBeenCalled(); expect(f.socket.send).not.toHaveBeenCalled();
    } finally { f.client.stop(); }
  });
  it("rejects the generic holder-shaped result without runtime confirmation", async () => {
    const f = fixture();
    try {
      f.socket.message({ connectionEpoch: 7, resume: {}, reset: [] }); await flush();
      expect(f.socket.close).toHaveBeenCalledWith(1002, "handshake");
      expect(f.mux.applyHandshake).not.toHaveBeenCalled(); expect(f.client.connected).toBe(false);
    } finally { f.client.stop(); }
  });

  it.each(["pending", "wrong_manifest", "wrong_digest", "wrong_acceptance"])("does not adopt %s rejected by the durable owner", async fault => {
    const validateHandshake = vi.fn((result: RelayRuntimeHandshakeResult) => {
      if (JSON.stringify(result.runtimeReconciliation) !== JSON.stringify(confirmed.runtimeReconciliation)) throw new Error("recovery authority mismatch");
    });
    const f = fixture({ validateHandshake });
    const runtimeReconciliation = fault === "pending" ? { state: "pending" } : { ...confirmed.runtimeReconciliation,
      ...(fault === "wrong_manifest" ? { manifestId: "other" } : {}), ...(fault === "wrong_digest" ? { receiptDigest: "b".repeat(43) } : {}),
      ...(fault === "wrong_acceptance" ? { acceptedAt: "2026-09-06T00:00:01.000Z" } : {}) };
    try {
      f.socket.message({ ...confirmed, runtimeReconciliation }); await flush();
      expect(validateHandshake).toHaveBeenCalledTimes(1); expect(f.mux.applyHandshake).not.toHaveBeenCalled();
      expect(f.onConnected).not.toHaveBeenCalled(); expect(f.client.connected).toBe(false); expect(f.socket.close).toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it("waits for async validation before epoch adoption, outbound replay and connected notification", async () => {
    const gate = Promise.withResolvers<void>();
    const f = fixture({ validateHandshake: () => gate.promise });
    try {
      f.socket.message(confirmed); await flush();
      expect(f.mux.applyHandshake).not.toHaveBeenCalled(); expect(f.client.connected).toBe(false);
      expect(f.client.emit({} as never)).toBe(false);
      gate.resolve(); await flush();
      expect(f.mux.applyHandshake).toHaveBeenCalledWith(confirmed); expect(f.onConnected).toHaveBeenCalledWith(confirmed);
      expect(f.client.connected).toBe(true);
    } finally { f.client.stop(); }
  });

  it.each(["stop", "close", "closing", "rehandshake", "timeout", "inbound"])("does not promote after %s interrupts pending validation", async interruption => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const f = fixture({ validateHandshake: () => gate.promise });
    try {
      f.socket.message(confirmed); await flush();
      if (interruption === "stop") f.client.stop();
      if (interruption === "close") f.socket.emit("close", 1006, Buffer.from(""));
      if (interruption === "closing") f.socket.readyState = 2;
      if (interruption === "rehandshake") f.client.rehandshake("new lease");
      if (interruption === "timeout") await vi.advanceTimersByTimeAsync(15_001);
      if (interruption === "inbound") f.socket.message({ channel: "assignment", direction: "to_runtime" });
      gate.resolve(); await flush();
      expect(f.mux.applyHandshake).not.toHaveBeenCalled(); expect(f.mux.receive).not.toHaveBeenCalled();
      expect(f.onConnected).not.toHaveBeenCalled(); expect(f.client.connected).toBe(false);
      if (interruption === "inbound") expect(f.socket.close).toHaveBeenCalled();
    } finally { f.client.stop(); vi.useRealTimers(); }
  });

  it("rejects malformed inbound frames while mux cursor adoption is awaiting durability", async () => {
    const gate = Promise.withResolvers<void>();
    const f = fixture(); f.mux.applyHandshake.mockImplementation(() => gate.promise);
    try {
      f.socket.message(confirmed); await flush();
      f.socket.message({ channel: "assignment", direction: "to_runtime" });
      gate.resolve(); await flush();
      expect(f.mux.receive).not.toHaveBeenCalled(); expect(f.onConnected).not.toHaveBeenCalled();
      expect(f.client.connected).toBe(false); expect(f.socket.close).toHaveBeenCalled();
    } finally { f.client.stop(); }
  });

  it("retains actual mux replay until validation succeeds, then sends through the socket", async () => {
    const gate = Promise.withResolvers<void>(), key = generateInstanceKey();
    const mux = new ChannelMux({ recoveryAuthority: () => "manifest", clock: new FixedClock(Date.parse(confirmed.runtimeReconciliation.acceptedAt)),
      key: () => key, ackIntervalSeconds: 5, ackEveryFrames: 1, replayBufferAgeMs: 60000, replayBufferBytes: 4096,
      emit: value => f.client.emit(value), onFrame: vi.fn(), persistCursors: async () => undefined, onStall: vi.fn(), onReset: vi.fn() });
    mux.send("assignment:instance", "assignment", { instanceId: "instance", maxItems: 1, acceptedKinds: ["assistant_turn"] } as never);
    const f = fixture({ mux, validateHandshake: () => gate.promise });
    try {
      f.socket.send.mockClear();
      f.socket.message({ ...confirmed, resume: { "assignment:instance": { to_core: 0, to_runtime: 0 } } }); await flush();
      expect(f.socket.send).not.toHaveBeenCalled(); expect(mux.connectionEpoch).toBe(0);
      gate.resolve(); await flush();
      expect(f.socket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(f.socket.send.mock.calls[0]![0])).toMatchObject({ channelId: "assignment:instance", connectionEpoch: 7, seq: 1 });
      expect(f.client.connected).toBe(true);
    } finally { f.client.stop(); }
  });

  it("fences a rejected async validator without adopting or delivering frames", async () => {
    const gate = Promise.withResolvers<void>();
    const f = fixture({ validateHandshake: () => gate.promise });
    try {
      f.socket.message(confirmed); gate.reject(new Error("durable receipt changed")); await flush();
      f.socket.message(confirmed); await flush();
      expect(f.mux.applyHandshake).not.toHaveBeenCalled(); expect(f.onConnected).not.toHaveBeenCalled();
      expect(f.client.connected).toBe(false); expect(f.socket.close).toHaveBeenCalledTimes(1);
    } finally { f.client.stop(); }
  });

  it.each(["manifest", null])("signs the exact optional accepted candidate %s", candidate => {
    const f = fixture({ appliedManifestId: () => candidate });
    try {
      const request = JSON.parse(f.socket.send.mock.calls[0]![0]); const { proof, ...body } = request;
      expect(request.appliedManifestId).toBe(candidate ?? undefined);
      expect(verifyInstanceProof(f.key.publicKey, { method: "relay_handshake", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
      if (candidate) expect(verifyInstanceProof(f.key.publicKey, { method: "relay_handshake", audience: CORE_AUDIENCE, subject: "instance", body: { ...body, appliedManifestId: "other" } }, proof)).toBe(false);
    } finally { f.client.stop(); }
  });
});
