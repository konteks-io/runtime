import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createLogger, FixedClock, generateInstanceKey, logicalAssignmentRequestDigest, logicalAssignmentResponseDigest, verifyBody, type AssignmentReplyFrame, type AssignmentRequestFrame, type LogicalAssignmentRequestFrame, type RelayAck, type ToCoreRelayFrame, type ToRuntimeRelayFrame } from "@konteks/remote-common";
import { CHANNEL_LIVENESS_MS, ChannelMux } from "../relay/channel-mux.js";
import type { MuxOptions } from "../relay/channel-mux.js";
import { ReplayBuffer } from "../relay/replay-buffer.js";

const key = generateInstanceKey();

function buildMux(overrides: Partial<ConstructorParameters<typeof ChannelMux>[0]> = {}) {
  const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const emitted: Array<ToCoreRelayFrame | AssignmentRequestFrame | RelayAck> = [];
  const frames: ToRuntimeRelayFrame[] = [];
  const stalls: string[] = [];
  const resets: string[] = [];
  const persisted: unknown[] = [];
  const mux = new ChannelMux({
    recoveryAuthority: () => "accepted-test-generation",
    clock,
    key: () => key,
    ackIntervalSeconds: 5,
    ackEveryFrames: 3,
    replayBufferBytes: 4_096,
    replayBufferAgeMs: 60_000,
    emit: (envelope) => {
      emitted.push(envelope);
      return true;
    },
    onFrame: (frame) => { frames.push(frame); },
    onStall: (channelId) => stalls.push(channelId),
    onReset: (channelId) => resets.push(channelId),
    persistCursors: async (cursors) => void persisted.push(cursors),
    ...overrides,
  });
  return { mux, clock, emitted, frames, stalls, resets, persisted };
}

const logicalAssignmentRequest = (): LogicalAssignmentRequestFrame => ({
  channel: "assignment", direction: "to_core", channelId: "assignment:i", seq: 1,
  issuedAt: "2026-09-06T00:00:00Z", origin: { runnerIncarnation: "process", manifestId: "manifest" },
  body: { instanceId: "i", maxItems: 1, acceptedKinds: ["delivery"] },
});

const assignmentReply = (epoch: number): AssignmentReplyFrame => {
  const request = logicalAssignmentRequest();
  return {
    channel: "assignment", direction: "to_runtime", channelId: request.channelId, connectionEpoch: epoch,
    seq: 1, issuedAt: "2026-09-06T00:00:01Z",
    body: { requestSequence: request.seq, requestDigest: logicalAssignmentRequestDigest(request), requestKind: "pull", body: { assignments: [] } },
  };
};

const heartbeat = { instanceId: "i", sequence: 1, observedAt: "2026-09-06T00:00:00Z", components: [], agents: [], roles: [], roleBindings: [], utilization: { acceptingWork: true, activeSessions: 0, activeTurns: 0, utilizationRatio: 0 }, activeAssignmentIds: [], configRevision: 0, bundleVersion: "1.0.0" };

function toRuntime(channelId: string, seq: number, epoch: number, body: ToRuntimeRelayFrame["body"] = { assignments: [] }): ToRuntimeRelayFrame {
  return { channel: "assignment", direction: "to_runtime", channelId, connectionEpoch: epoch, seq, issuedAt: "2026-09-06T00:00:00Z", body } as ToRuntimeRelayFrame;
}

describe("replay buffer (D99)", () => {
  it("frees frames only on cumulative ack and replays after a cursor", () => {
    const buffer = new ReplayBuffer<string>({ maxBytes: 1_000, maxAgeMs: 1_000 });
    buffer.push(1, "a", 10, 0);
    buffer.push(2, "b", 10, 0);
    buffer.push(3, "c", 10, 0);
    expect(buffer.ackUpTo(2)).toBe(2);
    expect(buffer.after(2)?.map((entry) => entry.seq)).toEqual([3]);
    expect(buffer.after(0)).toBeNull();
    expect(buffer.needsReset).toBe(false);
  });

  it("marks reset when an unacked frame is evicted for size or age", () => {
    const buffer = new ReplayBuffer<string>({ maxBytes: 15, maxAgeMs: 1_000 });
    buffer.push(1, "a", 10, 0);
    buffer.push(2, "b", 10, 0);
    expect(buffer.needsReset).toBe(true);
    const aged = new ReplayBuffer<string>({ maxBytes: 1_000, maxAgeMs: 100 });
    aged.push(1, "a", 1, 0);
    aged.push(2, "b", 1, 500);
    expect(aged.needsReset).toBe(true);
  });
});

describe("channel mux", () => {
  it("replays a fresh holder's channel immediately without advancing durable acknowledgement", async () => {
    const { mux, emitted } = buildMux();
    await mux.applyHandshake({ connectionEpoch: 7, resume: {}, reset: [] });
    mux.send("session:s", "session", { kind: "session_closed", assignmentId: "assignment", reason: "completed" });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    await mux.requestReplay({ kind: "replay_request", channelId: "session:s", dataDirection: "to_core", connectionEpoch: 7 });

    expect(emitted.map(frame => ({ seq: "seq" in frame ? frame.seq : undefined, epoch: frame.connectionEpoch }))).toEqual([
      { seq: 1, epoch: 7 },
      { seq: 1, epoch: 7 },
    ]);
    expect(mux.snapshot().find(channel => channel.channelId === "session:s")).toMatchObject({ unacked: 1 });
    expect(mux.handshakeCursors()["session:s"]?.to_core).toBe(0);
    await mux.requestReplay({ kind: "replay_request", channelId: "session:s", dataDirection: "to_core", connectionEpoch: 6 });
    expect(emitted).toHaveLength(2);
    expect(mux.counters.epochStale).toBe(1);
  });

  it("persists an outbound frame and its allocation before the socket can observe it", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    let armed = false;
    const { mux } = buildMux({
      persistRelayState: async () => { if (!armed) return; order.push("persist:start"); await gate.promise; order.push("persist:done"); },
      emit: () => { order.push("emit"); return true; },
    });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    armed = true;
    order.length = 0;

    expect(mux.send("heartbeat", "heartbeat", heartbeat)).toBe(1);
    await vi.waitFor(() => expect(order).toEqual(["persist:start"]));
    gate.resolve();
    await vi.waitFor(() => expect(order).toEqual(["persist:start", "persist:done", "emit"]));
  });

  it("restores unacknowledged outbound frames after restart and deletes them only after a validated ACK", async () => {
    let durable: import("../relay/channel-mux.js").RelayDurableState | undefined;
    const first = buildMux({ persistRelayState: async state => { durable = structuredClone(state); } });
    await first.mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    first.mux.send("heartbeat", "heartbeat", heartbeat, "sig");
    await vi.waitFor(() => expect(durable?.outbound.heartbeat).toHaveLength(1));

    const persisted: import("../relay/channel-mux.js").RelayDurableState[] = [];
    const restarted = buildMux({ persistRelayState: async state => { persisted.push(structuredClone(state)); } });
    restarted.mux.restoreDurableState(durable!, () => "heartbeat");
    await restarted.mux.applyHandshake({ connectionEpoch: 2, resume: { heartbeat: { to_core: 0, to_runtime: 0 } }, reset: [] });
    await vi.waitFor(() => expect(restarted.emitted).toHaveLength(1));
    expect(restarted.emitted[0]).toMatchObject({ channelId: "heartbeat", seq: 1, connectionEpoch: 2 });

    await restarted.mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1,
      issuedAt: restarted.clock.nowIso(), dataDirection: "to_core", origin: "core" });
    expect(restarted.mux.snapshot()[0]?.unacked).toBe(1);
    expect(persisted.at(-1)?.outbound.heartbeat).toHaveLength(1);

    await restarted.mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 2, cumulativeSeq: 1,
      issuedAt: restarted.clock.nowIso(), dataDirection: "to_core", origin: "core" });
    expect(restarted.mux.snapshot()[0]?.unacked).toBe(0);
    expect(persisted.at(-1)?.outbound.heartbeat).toEqual([]);
  });

  it("never hands a to_core sequence out twice: allocation survives restarts and resets", async () => {
    // Before a restart the runtime had allocated seq 5 and seen ACKs up to 4;
    // the holder had already received 5 durably (its ACK was in flight).
    // Restoring `nextSeq = to_core + 1` and then resetting on the relay's
    // cache miss reissued seq 5 for a fresh session_ready, which the holder
    // dropped as an already-durable duplicate (live 2026-09-12 20:25Z).
    const { mux, persisted } = buildMux();
    mux.restoreCursors({ "session:s": { to_core: 4, to_runtime: 0, allocated: 5 } }, () => "session");
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: ["session:s"] });
    const seq = mux.send("session:s", "session", { kind: "session_closed", assignmentId: "a", reason: "completed" } as never);
    expect(seq).toBe(6);
    const last = persisted.at(-1) as Record<string, { to_core: number; allocated: number }>;
    expect(last["session:s"]).toMatchObject({ to_core: 4, allocated: 5 });
    await mux.applyHandshake({ connectionEpoch: 2, resume: {}, reset: ["session:s"] });
    expect(mux.send("session:s", "session", { kind: "session_closed", assignmentId: "a", reason: "completed" } as never)).toBe(7);
  });

  it("replays a retained session frame after an authoritative peer reset without self-reconnecting", async () => {
    const { mux, clock, emitted, stalls } = buildMux();
    const channelId = "session:s";
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    expect(mux.send(channelId, "session", { kind: "session_closed", assignmentId: "old", reason: "completed" } as never)).toBe(1);
    clock.advance(CHANNEL_LIVENESS_MS + 1);
    mux.tick();
    expect(mux.snapshot().find(entry => entry.channelId === channelId)?.stalled).toBe(false);
    expect(stalls).toEqual([]);

    const emittedBeforeReset = emitted.length;
    await mux.applyHandshake({ connectionEpoch: 2, resume: {}, reset: [channelId] });
    expect(mux.snapshot().find(entry => entry.channelId === channelId)).toMatchObject({ stalled: false, unacked: 1 });
    expect(emitted).toHaveLength(emittedBeforeReset + 1);
    expect(emitted.at(-1)).toMatchObject({ connectionEpoch: 2, channelId, seq: 1 });
  });

  it("exposes the socket emitter as the exact epoch-bound assignment frame union", () => {
    expectTypeOf<MuxOptions["emit"]>().parameter(0).toMatchTypeOf<ToCoreRelayFrame | AssignmentRequestFrame | RelayAck>();
  });

  it("puts the exact retained assignment frame on the current socket without allocating a mux identity", async () => {
    const { mux, emitted, clock } = buildMux();
    await mux.applyHandshake({ connectionEpoch: 7, resume: {}, reset: [] });
    const logical = logicalAssignmentRequest();
    expect(mux.sendAssignment(logical)).toBe(true);
    expect(emitted).toEqual([{ ...logical, connectionEpoch: 7 } satisfies AssignmentRequestFrame]);
    expect(mux.handshakeCursors()[logical.channelId]).toMatchObject({ to_core: 0, to_runtime: 0 });

    clock.advance(1_000);
    await mux.applyHandshake({ connectionEpoch: 8, resume: {}, reset: [] });
    expect(emitted).toHaveLength(1); // The durable AssignmentSender, not the mux, decides replay.
  });

  it("routes assignment request and reply acknowledgements through their durable stream owner", async () => {
    const requestAcks: RelayAck[] = [], replies: AssignmentReplyFrame[] = [];
    const { mux, emitted, persisted } = buildMux({
      ackEveryFrames: 1,
      onAssignmentRequestAck: async ack => { requestAcks.push(ack); },
      onAssignmentFrame: async frame => { replies.push(frame); return frame.seq; },
    });
    await mux.applyHandshake({ connectionEpoch: 3, resume: {}, reset: [] });
    const request = logicalAssignmentRequest();
    mux.sendAssignment(request);
    const before = persisted.length;

    await mux.receive({ kind: "ack", channelId: request.channelId, connectionEpoch: 3, cumulativeSeq: 1,
      issuedAt: "2026-09-06T00:00:01Z", dataDirection: "to_core", origin: "core" });
    const reply = assignmentReply(3);
    await mux.receive(reply);

    expect(requestAcks).toHaveLength(1);
    expect(replies).toEqual([reply]);
    expect(persisted).toHaveLength(before); // Generic cursor storage is not assignment authority.
    expect(emitted.at(-1)).toMatchObject({ kind: "ack", origin: "supervisor", dataDirection: "to_runtime",
      channelId: request.channelId, cumulativeSeq: 1, connectionEpoch: 3 });
    const { connectionEpoch: _epoch, ...logicalReply } = reply;
    expect(logicalAssignmentResponseDigest(logicalReply)).toHaveLength(43);
  });

  it("refuses bare assignment frames once the durable assignment carrier is composed", async () => {
    const owner = vi.fn(async () => 1);
    const { mux, frames, emitted } = buildMux({ onAssignmentFrame: owner,
      assignmentCursors: () => ({ channelId: "assignment:i", to_core: 0, to_runtime: 0 }) });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    expect(() => mux.send("assignment:i", "assignment", { instanceId: "i", maxItems: 1, acceptedKinds: ["delivery"] })).toThrow();
    await expect(mux.receive(toRuntime("assignment:i", 1, 1))).rejects.toMatchObject({ code: "assignment_channel_invalid" });
    expect(owner).not.toHaveBeenCalled(); expect(frames).toEqual([]);
    expect(emitted.filter(value => "kind" in value && value.kind === "ack")).toEqual([]);
  });

  it("does not let a queued endpoint ACK adopt a closed and reopened channel", async () => {
    const gate = Promise.withResolvers<void>(), entered = vi.fn();
    const { mux } = buildMux({ persistCursors: async cursors => { if (cursors.assignment?.to_runtime === 1) { entered(); await gate.promise; } } });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("heartbeat", "heartbeat", heartbeat);
    const frame = mux.receive(toRuntime("assignment", 1, 1));
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    const ack = mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "core" });
    mux.closeChannel("heartbeat"); mux.send("heartbeat", "heartbeat", heartbeat);
    gate.resolve(); await Promise.all([frame, ack]);
    expect(mux.snapshot().find(channel => channel.channelId === "heartbeat")?.unacked).toBe(1);
    expect(mux.handshakeCursors().heartbeat?.to_core).toBe(0);
  });

  it.each(["session", "preview"] as const)("accepts a current grant-holder acknowledgement only for the %s channel", async channel => {
    const { mux } = buildMux();
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send(channel, channel, heartbeat as never);
    await mux.receive({ kind: "ack", channelId: channel, connectionEpoch: 1, cumulativeSeq: 1, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "grant_holder", grantId: "grant" });
    expect(mux.snapshot()[0]?.unacked).toBe(0);
    expect(mux.handshakeCursors()[channel]?.to_core).toBe(1);
  });

  it("commits independent control frames and endpoint acknowledgements while assignment acceptance is blocked", async () => {
    const gate = Promise.withResolvers<void>(), entered = vi.fn();
    const { mux, emitted } = buildMux({ ackEveryFrames: 1, onFrame: async frame => { entered(frame.channel); if (frame.channel === "assignment") await gate.promise; } });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("heartbeat", "heartbeat", heartbeat);
    const assignment = mux.receive(toRuntime("assignment", 1, 1));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledWith("assignment"));
    const control = mux.receive({ ...toRuntime("control", 1, 1), channel: "control", body: { type: "drain", instanceId: "i", reason: "user", issuedAt: "2026-09-06T00:00:00Z", signature: "c2ln" } });
    const ack = mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "core" });
    try {
      await vi.waitFor(() => expect(mux.handshakeCursors().control?.to_runtime).toBe(1));
      expect(mux.handshakeCursors().heartbeat?.to_core).toBe(1);
      expect(mux.handshakeCursors().assignment?.to_runtime).toBe(0);
      expect(emitted).toContainEqual(expect.objectContaining({ kind: "ack", channelId: "control", cumulativeSeq: 1 }));
    } finally { gate.resolve(); await Promise.all([assignment, control, ack]); }
  });

  it.each(["future", "grant_on_core", "core_on_session", "supervisor_to_core"])("rejects %s acknowledgements without persisting or freeing replay", async failure => {
    const { mux, persisted } = buildMux();
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    const channel = failure === "core_on_session" ? "session" : "heartbeat";
    mux.send(channel, channel, heartbeat as never);
    await vi.waitFor(() => expect(persisted.length).toBeGreaterThan(1));
    const before = persisted.length;
    await mux.receive({ kind: "ack", channelId: channel, connectionEpoch: 1, cumulativeSeq: failure === "future" ? 2 : 1, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core",
      origin: failure === "grant_on_core" ? "grant_holder" : failure === "supervisor_to_core" ? "supervisor" : "core",
      ...(failure === "grant_on_core" ? { grantId: "grant" } : {}), ...(failure === "supervisor_to_core" ? { signature: "c2ln" } : {}),
    });
    expect(mux.snapshot()[0]?.unacked).toBe(1);
    expect(mux.handshakeCursors()[channel]?.to_core).toBe(0);
    expect(persisted).toHaveLength(before);
  });

  it("retains sender replay when a valid endpoint acknowledgement cannot persist", async () => {
    const failure = Promise.reject(new Error("cursor unavailable")); void failure.catch(() => undefined);
    const { mux } = buildMux({ persistCursors: cursors => cursors.heartbeat?.to_core === 1 ? failure : Promise.resolve() });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("heartbeat", "heartbeat", heartbeat);
    await expect(mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "core" })).rejects.toThrow("cursor unavailable");
    expect(mux.snapshot()[0]?.unacked).toBe(1);
    expect(mux.handshakeCursors().heartbeat?.to_core).toBe(0);
  });

  it.each(["handler", "cursor"])("does not acknowledge a failed durable %s operation", async boundary => {
    const error = new Error("durability unavailable");
    const failed = Promise.reject(error); void failed.catch(() => undefined);
    const onFrame = vi.fn(() => boundary === "handler" ? failed : Promise.resolve());
    let fail = true;
    const { mux, emitted } = buildMux({ ackEveryFrames: 1, onFrame, persistCursors: cursors => boundary === "cursor" && fail && cursors.assignment?.to_runtime === 1 ? failed : Promise.resolve() });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    await expect(mux.receive(toRuntime("assignment", 1, 1))).rejects.toThrow("durability unavailable");
    mux.tick();
    expect(mux.handshakeCursors().assignment?.to_runtime).toBe(0);
    expect(emitted).toEqual([]);
    fail = false; onFrame.mockResolvedValue(undefined);
    await mux.receive(toRuntime("assignment", 1, 1));
    expect(mux.handshakeCursors().assignment?.to_runtime).toBe(1);
    expect(emitted).toMatchObject([{ kind: "ack", cumulativeSeq: 1 }]);
  });

  it("serializes concurrent delivery and replay duplicates through durable commit", async () => {
    const handlerGate = Promise.withResolvers<void>(), cursorGate = Promise.withResolvers<void>();
    const order: string[] = [];
    const { mux, emitted } = buildMux({ ackEveryFrames: 1,
      onFrame: async frame => { order.push(`accept:${frame.seq}`); if (frame.seq === 1) await handlerGate.promise; },
      persistCursors: async cursors => { if (cursors.assignment?.to_runtime === 1) { order.push("persist:1"); await cursorGate.promise; } },
    });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    const one = mux.receive(toRuntime("assignment", 1, 1));
    const duplicate = mux.receive(toRuntime("assignment", 1, 1));
    const two = mux.receive(toRuntime("assignment", 2, 1));
    await vi.waitFor(() => expect(order).toEqual(["accept:1"]));
    expect(mux.handshakeCursors().assignment?.to_runtime).toBe(0);
    mux.tick(); expect(emitted).toEqual([]);
    handlerGate.resolve();
    await vi.waitFor(() => expect(order).toEqual(["accept:1", "persist:1"]));
    expect(mux.handshakeCursors().assignment?.to_runtime).toBe(0);
    mux.tick(); expect(emitted).toEqual([]);
    cursorGate.resolve(); await Promise.all([one, duplicate, two]);
    expect(order).toEqual(["accept:1", "persist:1", "accept:2"]);
    expect(mux.counters.duplicates).toBe(1);
    expect(mux.handshakeCursors().assignment?.to_runtime).toBe(2);
    expect(emitted.map(frame => "cumulativeSeq" in frame ? frame.cumulativeSeq : null)).toEqual([1, 1, 2]);
  });

  it.each(["handler:reconnect", "cursor:reconnect", "handler:close", "cursor:close", "handler:reset", "cursor:reset"])("fences %s while durable receive awaits", async scenario => {
    const [boundary, action] = scenario.split(":"), gate = Promise.withResolvers<void>();
    const entered = vi.fn();
    const { mux, emitted } = buildMux({ ackEveryFrames: 1,
      onFrame: async () => { if (boundary === "handler") { entered(); await gate.promise; } },
      persistCursors: async cursors => { if (boundary === "cursor" && cursors.assignment?.to_runtime === 1) { entered(); await gate.promise; } },
    });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    const receiving = mux.receive(toRuntime("assignment", 1, 1));
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    let handshake: void | Promise<void>;
    if (action === "close") mux.closeChannel("assignment");
    else {
      mux.disconnected();
      handshake = mux.applyHandshake({ connectionEpoch: 2, resume: {}, reset: action === "reset" ? ["assignment"] : [] });
    }
    gate.resolve(); await receiving; await handshake;
    mux.tick(); expect(emitted).toEqual([]);
    expect(mux.handshakeCursors().assignment?.to_runtime ?? 0).toBe(0);
  });

  it("retains and replays all locally unacknowledged frames even when the handshake resume cursor is ahead", async () => {
    const { mux, emitted } = buildMux();
    mux.send("heartbeat", "heartbeat", heartbeat, "sig");
    mux.send("heartbeat", "heartbeat", { ...heartbeat, sequence: 2 }, "sig");
    expect(emitted).toHaveLength(0);
    await mux.applyHandshake({ connectionEpoch: 7, resume: { heartbeat: { to_core: 1, to_runtime: 0 } }, reset: [] });
    expect(emitted.map((frame) => ("seq" in frame ? [frame.seq, frame.connectionEpoch] : null))).toEqual([[1, 7], [2, 7]]);
    expect(mux.snapshot()[0]?.unacked).toBe(2);
    expect(mux.handshakeCursors().heartbeat?.to_core).toBe(0);
    mux.send("heartbeat", "heartbeat", { ...heartbeat, sequence: 3 }, "sig");
    await vi.waitFor(() => expect((emitted[2] as ToCoreRelayFrame | undefined)?.seq).toBe(3));
    await mux.receive({ kind: "ack", channelId: "heartbeat", cumulativeSeq: 3, connectionEpoch: 7, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "core" });
    expect(mux.snapshot()[0]?.unacked).toBe(0);
  });

  it.each(["future", "freed_history"])("requests existing reset recovery for a handshake %s cursor without inventing an ACK", async failure => {
    const logger = createLogger({ name: "mux-test", silent: true });
    const warn = vi.spyOn(logger, "warn");
    const { mux, resets } = buildMux({ logger });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("heartbeat", "heartbeat", heartbeat);
    if (failure === "freed_history") await mux.receive({ kind: "ack", channelId: "heartbeat", cumulativeSeq: 1, connectionEpoch: 1, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "core" });
    await mux.applyHandshake({ connectionEpoch: 2, resume: { heartbeat: { to_core: failure === "future" ? 2 : 0, to_runtime: 0 } }, reset: [] });
    expect(resets).toEqual(["heartbeat"]);
    expect(mux.handshakeCursors().heartbeat?.to_core).toBe(failure === "future" ? 0 : 1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "relay.channel.reset", connectionEpoch: 2,
      reason: failure === "future" ? "resume_cursor_ahead" : "resume_cursor_regressed",
      nextSeq: 2, ackedByEndpoint: failure === "future" ? 0 : 1,
      peerToCore: failure === "future" ? 2 : 0 }), "channel replay reset");
  });

  it("rebuilds a reset peer from complete sender-owned replay without creating a sequence hole", async () => {
    const logger = createLogger({ name: "mux-test", silent: true });
    const warn = vi.spyOn(logger, "warn");
    const { mux, resets, emitted, persisted } = buildMux({ logger });
    mux.send("heartbeat", "heartbeat", { ...heartbeat, bundleVersion: "private-body-canary" }, "private-signature-canary");
    await vi.waitFor(() => expect(persisted.length).toBeGreaterThan(0));
    await mux.applyHandshake({ connectionEpoch: 2, resume: {}, reset: ["heartbeat"] });
    expect(resets).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ channelId: "heartbeat", seq: 1, connectionEpoch: 2 });
    expect(mux.snapshot()[0]?.unacked).toBe(1);
    expect(mux.send("heartbeat", "heartbeat", { ...heartbeat, sequence: 2 })).toBe(2);
    await mux.applyHandshake({ connectionEpoch: 3, resume: { heartbeat: { to_core: 0, to_runtime: 0 } }, reset: [] });
    expect(resets).toEqual([]);
    expect(emitted.slice(-2).map(frame => "seq" in frame ? frame.seq : null)).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "relay.channel.reset", reason: "peer_reset",
      channelId: "heartbeat", nextSeq: 2, unackedCount: 1, ackedByEndpoint: 0 }), "channel replay reset");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("canary");
  });

  it.each(["opened", "acknowledged"])("allows an idle %s channel a full ACK interval after starting a new pending batch", async mode => {
    const logger = createLogger({ name: "mux-test", silent: true });
    const warn = vi.spyOn(logger, "warn");
    const { mux, clock, stalls } = buildMux({ logger });
    mux.openChannel("heartbeat", "heartbeat");
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    if (mode === "acknowledged") {
      mux.send("heartbeat", "heartbeat", heartbeat);
      await mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1,
        issuedAt: clock.nowIso(), dataDirection: "to_core", origin: "core" });
    }
    clock.advance(60_000);
    mux.send("heartbeat", "heartbeat", heartbeat);
    mux.tick();
    expect(stalls).toEqual([]);
    clock.advance(9_000);
    mux.send("heartbeat", "heartbeat", heartbeat);
    mux.tick();
    expect(stalls).toEqual([]);
    // Additional sends cannot postpone the first pending frame's deadline.
    clock.advance(1_001);
    mux.tick();
    expect(stalls).toEqual(["heartbeat"]);
    expect(mux.snapshot()[0]?.unacked).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "relay.channel.stalled", channelId: "heartbeat",
      connectionEpoch: 1, ackWaitMs: 10_001, ackDeadlineMs: 10_000, unackedCount: 2 }), expect.any(String));
  });

  it("backs off repeated stalls of one unacknowledged channel and resets on progress", async () => {
    // Re-handshaking the shared socket every deadline changed the runtime's
    // connection authority and refused unrelated assignments mid-preparation.
    const { mux, clock, stalls } = buildMux();
    mux.openChannel("heartbeat", "heartbeat");
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("heartbeat", "heartbeat", heartbeat);
    // A silent socket re-handshakes once the liveness window has also passed.
    clock.advance(CHANNEL_LIVENESS_MS + 1);
    mux.tick();
    expect(stalls).toEqual(["heartbeat"]);

    // The peer never returns: later stalls wait for the liveness window until
    // the doubling backoff (20 s, 40 s, 80 s, 160 s) exceeds it.
    for (const deadline of [60_000, 60_000, 80_000, 160_000]) {
      await mux.applyHandshake({ connectionEpoch: 1, resume: { heartbeat: { to_core: 0, to_runtime: 0 } }, reset: [] });
      const before = stalls.length;
      clock.advance(deadline - 1_000);
      mux.tick();
      expect(stalls).toHaveLength(before);
      clock.advance(1_001);
      mux.tick();
      expect(stalls).toHaveLength(before + 1);
    }

    // An acknowledgement is progress: the backoff resets, so the stall fires
    // once the socket is merely silent past the liveness window again.
    await mux.applyHandshake({ connectionEpoch: 1, resume: { heartbeat: { to_core: 0, to_runtime: 0 } }, reset: [] });
    await mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1,
      issuedAt: clock.nowIso(), dataDirection: "to_core", origin: "core" });
    mux.send("heartbeat", "heartbeat", heartbeat);
    const before = stalls.length;
    clock.advance(CHANNEL_LIVENESS_MS + 1);
    mux.tick();
    expect(stalls).toHaveLength(before + 1);
  });

  it("keeps a live socket indefinitely for a channel awaiting its independently attached holder", async () => {
    // The relay parks frames for an unattached holder; other channels' traffic
    // proves the socket is alive, so one quiet channel must not reconnect it.
    const { mux, clock, stalls } = buildMux();
    mux.openChannel("session:s", "session");
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("session:s", "session", { kind: "session_closed", assignmentId: "a", reason: "completed" } as never);
    mux.send("heartbeat", "heartbeat", heartbeat);
    for (let elapsed = 0; elapsed < 5 * 60_000 - 30_000; elapsed += 30_000) {
      clock.advance(30_000);
      await mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1, issuedAt: clock.nowIso(), dataDirection: "to_core", origin: "core" });
      mux.tick();
    }
    expect(stalls).toEqual([]);
    clock.advance(30_001);
    await mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1, issuedAt: clock.nowIso(), dataDirection: "to_core", origin: "core" });
    mux.tick();
    expect(stalls).toEqual([]);
  });

  it("never rolls the shared runtime socket merely because a session holder is detached", async () => {
    const { mux, clock, stalls } = buildMux();
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("session:waiting", "session", { kind: "session_ready", assignmentId: "a" } as never);
    mux.send("heartbeat", "heartbeat", heartbeat);

    for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 60_000) {
      clock.advance(60_000);
      await mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 1,
        issuedAt: clock.nowIso(), dataDirection: "to_core", origin: "core" });
      mux.tick();
    }

    expect(stalls).toEqual([]);
    expect(mux.snapshot().find(channel => channel.channelId === "session:waiting")).toMatchObject({ unacked: 1, stalled: false });
  });

  it("durably removes a closed channel so restart handshakes cannot resurrect it", async () => {
    let durable: import("../relay/channel-mux.js").RelayDurableState | undefined;
    const { mux } = buildMux({ persistRelayState: async state => { durable = structuredClone(state); } });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.openChannel("session:terminal", "session");
    mux.send("session:terminal", "session", { kind: "session_closed", assignmentId: "a", reason: "completed" } as never);
    await vi.waitFor(() => expect(durable?.outbound["session:terminal"]).toHaveLength(1));
    await mux.receive({ kind: "ack", channelId: "session:terminal", connectionEpoch: 1, cumulativeSeq: 1,
      issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "grant_holder", grantId: "grant" });
    expect(durable?.cursors["session:terminal"]?.to_core).toBe(1);
    mux.closeChannel("session:terminal");
    await vi.waitFor(() => expect(durable?.cursors["session:terminal"]).toBeUndefined());

    const restarted = buildMux();
    restarted.mux.restoreDurableState(durable!, () => "session");
    expect(restarted.mux.handshakeCursors()).not.toHaveProperty("session:terminal");
  });

  it("does not re-handshake a late-acknowledged channel whose peer is still sending on it", async () => {
    const { mux, clock, stalls } = buildMux();
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("heartbeat", "heartbeat", heartbeat);
    for (let seq = 1; seq <= 10; seq += 1) {
      clock.advance(10_001);
      await mux.receive({ kind: "ack", channelId: "heartbeat", connectionEpoch: 1, cumulativeSeq: 0, issuedAt: clock.nowIso(), dataDirection: "to_core", origin: "core" });
      mux.tick();
    }
    expect(stalls).toEqual([]);
  });

  it("frees the replay buffer only on a Core ack under the current epoch", async () => {
    const { mux } = buildMux();
    mux.applyHandshake({ connectionEpoch: 2, resume: {}, reset: [] });
    mux.send("heartbeat", "heartbeat", heartbeat, "sig");
    mux.send("heartbeat", "heartbeat", heartbeat, "sig");
    const stale: RelayAck = { kind: "ack", channelId: "heartbeat", cumulativeSeq: 2, connectionEpoch: 1, issuedAt: "2026-09-06T00:00:00Z", dataDirection: "to_core", origin: "core" };
    await mux.receive(stale);
    expect(mux.snapshot()[0]?.unacked).toBe(2);
    expect(mux.counters.epochStale).toBe(1);
    await mux.receive({ ...stale, connectionEpoch: 2 });
    expect(mux.snapshot()[0]?.unacked).toBe(0);
    expect(mux.handshakeCursors().heartbeat?.to_core).toBe(2);
  });

  it("dedups to_runtime frames by seq, fences other epochs, and emits a signed ack every N frames", async () => {
    const { mux, emitted, frames } = buildMux();
    mux.applyHandshake({ connectionEpoch: 3, resume: {}, reset: [] });
    await mux.receive(toRuntime("assignment", 1, 3));
    await mux.receive(toRuntime("assignment", 1, 3));
    await mux.receive(toRuntime("assignment", 2, 2));
    await mux.receive(toRuntime("assignment", 2, 3));
    await mux.receive(toRuntime("assignment", 3, 3));
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(mux.counters.duplicates).toBe(1);
    expect(mux.counters.epochStale).toBe(1);
    const acks = emitted.filter((envelope): envelope is RelayAck => "kind" in envelope && envelope.kind === "ack");
    expect(acks.length).toBeGreaterThan(0);
    const last = acks[acks.length - 1]!;
    expect(last).toMatchObject({ dataDirection: "to_runtime", origin: "supervisor", cumulativeSeq: 3, connectionEpoch: 3 });
    expect(verifyBody(key.publicKey, { channelId: "assignment", dataDirection: "to_runtime", cumulativeSeq: 3, issuedAt: last.issuedAt }, (last as { signature: string }).signature)).toBe(true);
    expect(mux.handshakeCursors().assignment?.to_runtime).toBe(3);
  });

  it("treats a to_runtime gap and a missing ack as stalls that request a re-handshake without discarding frames", async () => {
    const { mux, clock, stalls } = buildMux();
    mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    await mux.receive(toRuntime("assignment", 1, 1));
    await mux.receive(toRuntime("assignment", 5, 1));
    expect(stalls).toEqual(["assignment"]);
    mux.send("heartbeat", "heartbeat", heartbeat, "sig");
    clock.advance(11_000);
    mux.tick();
    // Late but not yet silent past the liveness window: busy, not dead.
    expect(stalls).toEqual(["assignment"]);
    clock.advance(50_000);
    mux.tick();
    expect(stalls).toEqual(["assignment", "heartbeat"]);
    expect(mux.snapshot().find((entry) => entry.channelId === "heartbeat")?.unacked).toBe(1);
  });

  it("fences new allocations after replay eviction without manufacturing another sequence", async () => {
    const { mux, resets } = buildMux({ replayBufferBytes: 300 });
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    const observation = { instanceId: "i", assignmentId: "a", attempt: 1, agentId: "x", moneyBasis: "unavailable_local_subscription", observedAt: "2026-09-06T00:00:00Z" } as const;
    mux.send("observation", "observation", observation, "sig");
    expect(resets).toContain("observation");
    expect(() => mux.send("observation", "observation", observation, "sig")).toThrowError(expect.objectContaining({ code: "recovery_required" }));
    expect(mux.handshakeCursors().observation?.to_core).toBe(0);
  });

  it("restores durable cursors so a restarted supervisor resumes instead of replaying from zero", () => {
    const { mux } = buildMux();
    mux.restoreCursors({ control: { to_core: 4, to_runtime: 9 } }, () => "control");
    expect(mux.handshakeCursors()).toEqual({ control: { to_core: 4, to_runtime: 9 } });
    mux.applyHandshake({ connectionEpoch: 1, resume: { control: { to_core: 4, to_runtime: 9 } }, reset: [] });
    expect(mux.send("control", "control", { type: "drain_ack", instanceId: "i", activeAssignments: 0, acknowledgedAt: "2026-09-06T00:00:00Z", signature: "s" }, "s")).toBe(5);
  });
});
