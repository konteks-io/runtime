import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ControlRequestSchema,
  controlCall,
  startControlSocketServer,
  type ControlSocketServer,
} from "../control-socket.js";
import { RemoteInstanceError } from "../errors.js";

const servers: ControlSocketServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

const token = "t".repeat(32);

describe("loopback control socket", () => {
  it("returns an unavailable error when the service has stopped, without an uncaught stream error", async () => {
    const server = await startControlSocketServer({ token, port: 0, handler: async () => ({}) });
    await server.close();
    await expect(controlCall({ token, port: server.port, timeoutMs: 500 }, {
      request: { op: "status" }, schema: z.unknown(),
    })).rejects.toMatchObject({ code: "control_socket_unavailable" });
  });
  it("survives a client that resets the connection mid-read and keeps serving", async () => {
    // A `status` probe that exits before reading its reply resets the socket.
    // readline re-emits the read error on its Interface; unhandled, that was
    // an uncaught exception that killed the supervisor (live 2026-09-12).
    const server = await startControlSocketServer({ token, port: 0, handler: async () => ({ ok: true }) });
    servers.push(server);
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    try {
      const client = connect({ host: "127.0.0.1", port: server.port });
      await new Promise<void>(resolve => client.once("connect", resolve));
      client.write(`${JSON.stringify({ auth: token })}\n`);
      client.write(`${JSON.stringify({ id: "r1", request: { op: "status" } })}\n`);
      client.resetAndDestroy();
      await new Promise(resolve => setTimeout(resolve, 100));
      const result = await controlCall({ token, port: server.port, timeoutMs: 1_000 }, {
        request: { op: "status" }, schema: z.object({ ok: z.boolean() }),
      });
      expect(result).toEqual({ ok: true });
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
    }
  });
  it("answers an authenticated request and streams login events", async () => {
    const server = await startControlSocketServer({
      token,
      port: 0,
      handler: async (request, emit) => {
        if (request.op === "auth.login") {
          emit.event({ kind: "started", loginId: "l1", agentId: request.agentId });
          emit.event({
            kind: "open_url",
            loginId: "l1",
            url: "https://example.test/device",
            userCode: "ABCD-EFGH",
          });
          emit.event({ kind: "completed", loginId: "l1", readiness: "ready" });
          return { loginId: "l1" };
        }
        return { ok: true };
      },
    });
    servers.push(server);
    const events: string[] = [];
    const result = await controlCall(
      { token, port: server.port },
      {
        request: { op: "auth.login", agentId: "codex", organization: false },
        schema: z.object({ loginId: z.string() }),
        onEvent: (event) => events.push(event.kind),
      },
    );
    expect(result).toEqual({ loginId: "l1" });
    expect(events).toEqual(["started", "open_url", "completed"]);
  });

  it.each(["completed", "failed"] as const)("keeps login output connected until delayed %s, while status remains usable", async terminal => {
    const server = await startControlSocketServer({
      token, port: 0,
      handler: async (request, emit) => {
        if (request.op !== "auth.login") return { ok: true };
        emit.event({ kind: "started", loginId: "l1", agentId: "codex" });
        setTimeout(() => {
          emit.event({ kind: "display", loginId: "l1", text: "official tooling output" });
          emit.event(terminal === "completed"
            ? { kind: "completed", loginId: "l1", readiness: "ready" }
            : { kind: "failed", loginId: "l1", code: "login_failed", message: "official tooling failed" });
        }, 50);
        return { loginId: "l1" };
      },
    });
    servers.push(server);
    const events: string[] = [];
    const login = controlCall({ token, port: server.port, timeoutMs: 1000 }, {
      request: { op: "auth.login", agentId: "codex", organization: false },
      schema: z.object({ loginId: z.string() }), onEvent: event => { events.push(event.kind); },
    });
    await expect(controlCall({ token, port: server.port }, {
      request: { op: "status" }, schema: z.object({ ok: z.boolean() }),
    })).resolves.toEqual({ ok: true });
    await expect(login).resolves.toEqual({ loginId: "l1" });
    expect(events).toEqual(["started", "display", terminal]);
  });

  it("drops an unauthenticated connection before parsing any request", async () => {
    let handled = 0;
    const server = await startControlSocketServer({
      token,
      port: 0,
      handler: async () => (handled += 1),
    });
    servers.push(server);
    await expect(
      controlCall(
        { token: "wrong".padEnd(32, "x"), port: server.port, timeoutMs: 1_000 },
        { request: { op: "status" }, schema: z.unknown() },
      ),
    ).rejects.toBeInstanceOf(RemoteInstanceError);
    expect(handled).toBe(0);
  });

  it("closes a socket that sends non-JSON before authenticating", async () => {
    const server = await startControlSocketServer({ token, port: 0, handler: async () => ({}) });
    servers.push(server);
    const socket = connect({ host: "127.0.0.1", port: server.port });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write("not json\n");
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("surfaces RemoteInstanceError codes and recovery actions", async () => {
    const server = await startControlSocketServer({
      token,
      port: 0,
      handler: async () => {
        throw new RemoteInstanceError("agent_unavailable", "agent is down", {
          recoveryActions: [{ kind: "run_doctor" }],
        });
      },
    });
    servers.push(server);
    await expect(
      controlCall(
        { token, port: server.port },
        { request: { op: "auth.logout", agentId: "codex" }, schema: z.unknown() },
      ),
    ).rejects.toMatchObject({ message: "agent_unavailable: agent is down" });
  });

  it("rejects a request outside the closed protocol at once instead of waiting for a timeout", async () => {
    const handler = vi.fn(async () => ({}));
    const server = await startControlSocketServer({ token, port: 0, handler });
    servers.push(server);
    const started = Date.now();
    await expect(
      controlCall({ token, port: server.port, timeoutMs: 10_000 }, { request: { op: "exec", command: "id" } as never, schema: z.unknown() }),
    ).rejects.toThrow(/control_request_invalid/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("the protocol is closed: no exec or free-form config field parses", () => {
    expect(ControlRequestSchema.safeParse({ op: "exec", command: "rm -rf /" }).success).toBe(false);
    for (const op of ["update.check", "update.apply", "update.status", "drain.cancel"]) {
      expect(ControlRequestSchema.safeParse({ op }).success).toBe(true);
      expect(ControlRequestSchema.safeParse({ op, url: "https://evil.example/manifest.json" }).success).toBe(false);
    }
    expect(ControlRequestSchema.safeParse({ op: "status", extra: 1 }).success).toBe(false);
    expect(ControlRequestSchema.safeParse({ op: "auth.logout", agentId: "Codex Bad" }).success).toBe(false);
    // The retired appliance's BYOK gateway operations are gone.
    expect(ControlRequestSchema.safeParse({ op: "gateway.key.set", agentId: "codex", key: "k".repeat(16) }).success).toBe(false);
    // Relay previews left the protocol: no local port is ever exposed.
    expect(ControlRequestSchema.safeParse({ op: "preview.enable", port: 3000 }).success).toBe(false);
    expect(ControlRequestSchema.safeParse({ op: "preview.disable" }).success).toBe(false);
  });
});
