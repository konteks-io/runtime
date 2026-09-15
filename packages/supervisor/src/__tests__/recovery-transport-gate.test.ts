import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof, type ToRuntimeRelayFrame } from "@konteks/remote-common";
import { ChannelMux } from "../relay/channel-mux.js";
import { RelayClient } from "../relay/relay-client.js";
import { HttpsFallbackTransport } from "../transport/https-fallback.js";
import { CORE_AUDIENCE } from "../core/client.js";

const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
const key = generateInstanceKey();
function fixture(authority?: () => string | null, onFrame = vi.fn(async () => undefined)) {
  const emit = vi.fn((_envelope: unknown) => true), persistCursors = vi.fn(async () => undefined);
  const mux = new ChannelMux({ clock, key: () => key, ackIntervalSeconds: 5, ackEveryFrames: 1,
    replayBufferBytes: 4096, replayBufferAgeMs: 60000, emit, persistCursors, onFrame,
    onStall: vi.fn(), onReset: vi.fn(), ...(authority ? { recoveryAuthority: authority } : {}),
  });
  return { mux, emit, persistCursors, onFrame };
}
function frame(): ToRuntimeRelayFrame {
  return { channel: "assignment", direction: "to_runtime", channelId: "assignment:i", connectionEpoch: 1,
    seq: 1, issuedAt: clock.nowIso(), body: { assignments: [] } };
}
const pull = { channel: "assignment", channelId: "assignment:i", body: { instanceId: "i", maxItems: 1, acceptedKinds: ["assistant_turn"] } } as const;

describe("receipt-owned transport recovery gate", () => {
  it("defaults closed for work send, handshake replay and inbound cursor acceptance", async () => {
    const { mux, emit, onFrame } = fixture();
    mux.send("assignment:i", "assignment", pull.body as never);
    await mux.applyHandshake({ connectionEpoch: 1, resume: { "assignment:i": { to_core: 0, to_runtime: 0 } }, reset: [] });
    expect(emit).not.toHaveBeenCalled();
    await expect(mux.receive(frame())).rejects.toThrow();
    expect(onFrame).not.toHaveBeenCalled();
    expect(mux.handshakeCursors()["assignment:i"]?.to_runtime).toBe(0);
  });

  it("releases retained replay only after an explicit accepted-generation refresh", async () => {
    let authority: string | null = null;
    const { mux, emit } = fixture(() => authority);
    mux.send("assignment:i", "assignment", pull.body as never);
    await mux.applyHandshake({ connectionEpoch: 1, resume: { "assignment:i": { to_core: 0, to_runtime: 0 } }, reset: [] });
    expect(emit).not.toHaveBeenCalled();
    authority = "accepted-manifest-1";
    mux.resumeAfterRecovery();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ channel: "assignment", seq: 1, connectionEpoch: 1 }));
  });

  it("does not acknowledge a work handler completed under a different recovery generation", async () => {
    let authority: string | null = "accepted-1";
    const gate = Promise.withResolvers<void>();
    const onFrame = vi.fn(() => gate.promise);
    const { mux, emit } = fixture(() => authority, onFrame);
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    const received = mux.receive(frame());
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalled());
    authority = "accepted-2";
    const rejected = expect(received).rejects.toThrow();
    gate.resolve(); await rejected;
    expect(mux.handshakeCursors()["assignment:i"]?.to_runtime).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("retains outbound replay when an ACK arrives while recovery is pending", async () => {
    let authority: string | null = "accepted-1";
    const { mux } = fixture(() => authority);
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("assignment:i", "assignment", pull.body as never);
    authority = null;
    await expect(mux.receive({ kind: "ack", channelId: "assignment:i", connectionEpoch: 1, dataDirection: "to_core", cumulativeSeq: 1, issuedAt: clock.nowIso(), origin: "core" })).rejects.toThrow();
    expect(mux.handshakeCursors()["assignment:i"]?.to_core).toBe(0);
  });

  it("does not adopt a newer authority for an inbound frame already queued under the old generation", async () => {
    let authority = "accepted-1";
    const gate = Promise.withResolvers<void>();
    const onFrame = vi.fn(() => gate.promise);
    const { mux } = fixture(() => authority, onFrame);
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    const first = mux.receive(frame());
    const second = mux.receive(frame());
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1));
    authority = "accepted-2"; gate.resolve();
    expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(mux.handshakeCursors()["assignment:i"]?.to_runtime).toBe(0);
  });

  it("keeps mux control and heartbeat sends available while work is gated", async () => {
    const { mux, emit } = fixture();
    await mux.applyHandshake({ connectionEpoch: 1, resume: {}, reset: [] });
    mux.send("control:i", "control", {} as never);
    mux.send("heartbeat:i", "heartbeat", {} as never);
    expect(emit.mock.calls.map(call => (call[0] as { channel: string }).channel)).toEqual(["control", "heartbeat"]);
  });

  it("does not let blocked work head-of-line block HTTPS control delivery before start", async () => {
    let authority: string | null = null;
    const core = { pull: vi.fn(async () => ({ assignments: [] })), controlAck: vi.fn(async () => undefined) };
    const transport = new HttpsFallbackTransport({ core: core as never, instanceId: () => "i", pollIntervalMs: 1000, recoveryAuthority: () => authority });
    transport.send(pull as never);
    transport.send({ channel: "control", channelId: "control:i", body: {} as never });
    await vi.waitFor(() => expect(core.controlAck).toHaveBeenCalledTimes(1));
    expect(core.pull).not.toHaveBeenCalled();
    authority = "accepted-1";
    transport.resumeAfterRecovery();
    await vi.waitFor(() => expect(core.pull).toHaveBeenCalledTimes(1));
  });

  it("consumes a registered deferral frame over HTTPS without re-posting it in the wrong shape", async () => {
    const core = { sessionOutbound: vi.fn(async () => undefined), deferPermission: vi.fn(async () => undefined) };
    const transport = new HttpsFallbackTransport({ core: core as never, instanceId: () => "i", pollIntervalMs: 1000, recoveryAuthority: () => "accepted-1" });
    transport.resumeAfterRecovery();
    transport.send({ channel: "session", channelId: "session:s", body: { kind: "acp", method: "session/request_permission", id: "perm-1", params: {} } as never });
    transport.send({ channel: "session", channelId: "session:s", body: { kind: "acp", method: "session/update", params: {} } as never });
    await vi.waitFor(() => expect(core.sessionOutbound).toHaveBeenCalledTimes(1));
    expect(core.deferPermission).not.toHaveBeenCalled();
    expect((transport as unknown as { pending: unknown[] }).pending).toHaveLength(0);
  });

  it("defaults HTTPS work closed even when send is called before start", async () => {
    const core = { pull: vi.fn(async () => ({ assignments: [] })) };
    const transport = new HttpsFallbackTransport({ core: core as never, instanceId: () => "i", pollIntervalMs: 1000 });
    transport.send(pull as never);
    await Promise.resolve();
    expect(core.pull).not.toHaveBeenCalled();
  });

  it("does not deliver or dequeue an HTTPS work result after authority changes", async () => {
    let authority = "accepted-1";
    const response = Promise.withResolvers<{ assignments: [] }>();
    const core = { pull: vi.fn(() => response.promise) };
    const handler = vi.fn();
    const transport = new HttpsFallbackTransport({ core: core as never, instanceId: () => "i", pollIntervalMs: 1000, recoveryAuthority: () => authority });
    transport.onInbound(handler); transport.send(pull as never);
    await vi.waitFor(() => expect(core.pull).toHaveBeenCalledTimes(1));
    authority = "accepted-2"; response.resolve({ assignments: [] });
    await vi.waitFor(() => expect(transport.available).toBe(false));
    expect(handler).not.toHaveBeenCalled();
    expect((transport as unknown as { pending: unknown[] }).pending).toHaveLength(1);
  });

  it("polls control but never fetches session work while recovery is pending", async () => {
    const core = { controlPoll: vi.fn(async () => []), sessionInbound: vi.fn(async () => []) };
    const transport = new HttpsFallbackTransport({ core: core as never, instanceId: () => "i", pollIntervalMs: 1000 });
    transport.start();
    try {
      await (transport as unknown as { poll(): Promise<void> }).poll();
      expect(core.controlPoll).toHaveBeenCalledTimes(1);
      expect(core.sessionInbound).not.toHaveBeenCalled();
    } finally { transport.stop(); }
  });

  it("does not deliver a session poll result under a replacement generation", async () => {
    let authority = "accepted-1";
    const response = Promise.withResolvers<ToRuntimeRelayFrame[]>();
    const core = { controlPoll: vi.fn(async () => []), sessionInbound: vi.fn(() => response.promise) };
    const handler = vi.fn();
    const transport = new HttpsFallbackTransport({ core: core as never, instanceId: () => "i", pollIntervalMs: 1000, recoveryAuthority: () => authority });
    transport.onInbound(handler); transport.start();
    try {
      const poll = (transport as unknown as { poll(): Promise<void> }).poll();
      await vi.waitFor(() => expect(core.sessionInbound).toHaveBeenCalledTimes(1));
      authority = "accepted-2"; response.resolve([frame()]); await poll;
      expect(handler).not.toHaveBeenCalled();
      expect(transport.available).toBe(false);
    } finally { transport.stop(); }
  });

  it("signs the caller's actual runner incarnation in the handshake", () => {
    class Socket extends EventEmitter { readyState = 1; send = vi.fn((_data: string) => undefined); close = vi.fn(); terminate = vi.fn(); }
    const socket = new Socket();
    const { mux } = fixture();
    const client = new RelayClient({ relayUrl: "wss://relay.example/runtime", instanceId: () => "i", runnerIncarnation: () => "actual-process", lease: () => "lease", key: () => key, clock, mux, createWebSocket: () => socket as never });
    try {
      client.start(); socket.emit("open");
      const { proof, ...body } = JSON.parse(socket.send.mock.calls[0]![0]);
      expect(body.runnerIncarnation).toBe("actual-process");
      expect(verifyInstanceProof(key.publicKey, { method: "relay_handshake", audience: CORE_AUDIENCE, subject: "i", body }, proof)).toBe(true);
      expect(verifyInstanceProof(key.publicKey, { method: "relay_handshake", audience: CORE_AUDIENCE, subject: "i", body: { ...body, runnerIncarnation: "forged-process" } }, proof)).toBe(false);
    } finally { client.stop(); }
  });
});
