import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey } from "@konteks/remote-common";
import { ChannelMux } from "../relay/channel-mux.js";
import { RelayClient } from "../relay/relay-client.js";
import { HttpsFallbackTransport } from "../transport/https-fallback.js";
import { Supervisor } from "../supervisor.js";
import type { InboundMessage } from "../transport/transport.js";

describe("awaitable transport receipt", () => {
  it.each(["session", "assignment", "control"] as const)("propagates the production %s routing promise and durability rejection", async channel => {
    const gate = Promise.withResolvers<void>(), handler = vi.fn(() => gate.promise);
    const receiver = { stopping: false, work: { onSessionMessage: handler, onAssignmentMessage: handler }, control: { handle: handler } };
    const inbound = (Supervisor.prototype as unknown as { onInbound(message: InboundMessage): Promise<void> }).onInbound;
    const received = inbound.call(receiver, { channel, channelId: `${channel}:i`, body: {} as never });
    let settled = false; void received.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    const rejection = expect(received).rejects.toThrow("commit failed");
    gate.reject(new Error("commit failed")); await rejection;
  });

  it("keeps an HTTPS assignment operation pending until its response commits", async () => {
    const gate = Promise.withResolvers<void>(), entered = vi.fn();
    const transport = new HttpsFallbackTransport({ recoveryAuthority: () => "accepted-test-generation", instanceId: () => "i", pollIntervalMs: 1_000,
      core: { pull: async () => ({ assignments: [] }) } as never,
    });
    transport.onInbound(async () => { entered(); await gate.promise; });
    transport.send({ channel: "assignment", channelId: "assignment:i", body: {} as never });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    expect((transport as unknown as { pending: unknown[] }).pending).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect((transport as unknown as { pending: unknown[] }).pending).toHaveLength(0));
  });

  it("keeps HTTPS heartbeat pending until renewed lease adoption commits", async () => {
    const gate = Promise.withResolvers<void>(), entered = vi.fn();
    const transport = new HttpsFallbackTransport({ recoveryAuthority: () => "accepted-test-generation", instanceId: () => "i", pollIntervalMs: 1_000,
      core: { heartbeat: async () => ({ lease: "renewed" }) } as never,
      onLease: async () => { entered(); await gate.promise; },
    });
    transport.send({ channel: "heartbeat", channelId: "heartbeat:i", body: {} as never });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    expect((transport as unknown as { pending: unknown[] }).pending).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect((transport as unknown as { pending: unknown[] }).pending).toHaveLength(0));
  });

  it("retains an HTTPS operation for retry when its response handler rejects", async () => {
    const failure = Promise.reject(new Error("journal write failed")); void failure.catch(() => undefined);
    const transport = new HttpsFallbackTransport({ recoveryAuthority: () => "accepted-test-generation", instanceId: () => "i", pollIntervalMs: 1_000,
      core: { pull: async () => ({ assignments: [] }) } as never,
    });
    transport.onInbound(() => failure);
    transport.send({ channel: "assignment", channelId: "assignment:i", body: {} as never });
    await vi.waitFor(() => expect(transport.available).toBe(false));
    expect((transport as unknown as { pending: unknown[] }).pending).toHaveLength(1);
  });

  it("closes the socket instead of acknowledging a failed durable frame handler", async () => {
    const failure = Promise.reject(new Error("journal write failed")); void failure.catch(() => undefined);
    class Socket extends EventEmitter {
      readyState = 1;
      send = vi.fn(); close = vi.fn(); terminate = vi.fn();
    }
    const socket = new Socket(), key = generateInstanceKey(), clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
    const onConnected = vi.fn();
    const mux = new ChannelMux({ recoveryAuthority: () => "accepted-test-generation", clock, key: () => key, ackIntervalSeconds: 5, ackEveryFrames: 1, replayBufferAgeMs: 60_000, replayBufferBytes: 4_096,
      emit: envelope => client.emit(envelope), onFrame: () => failure, persistCursors: async () => undefined, onStall: () => undefined, onReset: () => undefined,
    });
    const client = new RelayClient({ relayUrl: "wss://relay.example/runtime", instanceId: () => "i", runnerIncarnation: () => "test-process", lease: () => "lease", key: () => key, clock, mux, onConnected, createWebSocket: () => socket as never });
    try {
      client.start(); socket.emit("open");
      socket.emit("message", JSON.stringify({ connectionEpoch: 1, resume: {}, reset: [], runtimeReconciliation: { state: "confirmed", manifestId: "accepted-test-generation", receiptDigest: "a".repeat(43), acceptedAt: clock.nowIso() } }));
      await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
      socket.send.mockClear();
      socket.emit("message", JSON.stringify({ channel: "assignment", direction: "to_runtime", channelId: "assignment:i", connectionEpoch: 1, seq: 1, issuedAt: clock.nowIso(), body: { assignments: [] } }));
      await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(1011, "durable_receive_failed"));
      expect(socket.send).not.toHaveBeenCalled();
      expect(mux.handshakeCursors()["assignment:i"]?.to_runtime).toBe(0);
    } finally { client.stop(); }
  });
});


it('keeps session frames on durable relay replay when ordinary traffic falls back to HTTPS', async () => {
  const { TransportManager } = await import('../transport/relay-transport.js');
  const relay = { kind: 'relay', available: false, send: vi.fn(), start: vi.fn(), stop: vi.fn(), resumeAfterRecovery: vi.fn() };
  const https = { kind: 'https', available: true, send: vi.fn(), start: vi.fn(), stop: vi.fn(), resumeAfterRecovery: vi.fn() };
  const manager = new TransportManager(relay as never, https as never, 3, () => ({ connected: false, consecutiveFailures: 3 }));
  manager.evaluate();
  const frame = { channel: 'session', channelId: 'session:s', body: { kind: 'session_closed', reason: 'agent_exited' } };
  manager.send(frame as never);
  expect(relay.send).toHaveBeenCalledWith(frame);
  expect(https.send).not.toHaveBeenCalled();
  manager.resumeAfterRecovery();
  expect(relay.resumeAfterRecovery).toHaveBeenCalled();
});


it('never polls unmounted legacy endpoints for native HTTPS fallback', async () => {
  const core = { controlPoll: vi.fn(), sessionInbound: vi.fn(), sessionOutbound: vi.fn() };
  const transport = new HttpsFallbackTransport({ core: core as never, instanceId: () => 'i', pollIntervalMs: 1000, relayOnlySessions: true });
  transport.start();
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(core.controlPoll).not.toHaveBeenCalled(); expect(core.sessionInbound).not.toHaveBeenCalled();
    expect(() => transport.send({ channel: 'session', channelId: 'session:s', body: {} } as never)).toThrow('durable relay replay');
    expect(core.sessionOutbound).not.toHaveBeenCalled();
  } finally { transport.stop(); }
});
