import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";
import { resolveCodexSocket } from "./codex-socket.js";

const MAX_MESSAGE = 8 * 1024 * 1024;

type Interception = {
  outgoing(message: unknown): unknown;
  incoming(message: unknown): unknown;
};

const unavailable = () => new Error("The supervisor-owned shared Codex service is unavailable on its private same-user Unix socket.");

/** Official JSONL <-> WebSocket-over-Unix transport. The native supervisor
 * owns the shared process under the local user's authority; closing this
 * client never kills that process or logs out its account.
 * No TCP endpoint, secret transport, or writable shared socket is accepted.
 */
export async function connectCodexLocalTransport(socketPath: string, interception?: Interception): Promise<Duplex> {
  const { target, before } = await verifiedSocket(socketPath);
  // Codex's control socket rejects extension negotiation, including deflate.
  // Connect to the verified socket itself, so a link swapped meanwhile is not followed.
  const socket = new WebSocket("ws://localhost/", { createConnection: () => createConnection(target), perMessageDeflate: false, maxPayload: MAX_MESSAGE, handshakeTimeout: 10_000 });
  const stream = requestStream(socket, interception);
  // Initialization errors are returned to the caller, not unhandled events.
  const onError = () => stream.destroy(new Error("Codex local transport disconnected"));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    if (!sameSocket(before, await lstat(target))) throw unavailable();
    socket.on("error", onError);
    socket.on("message", (data, binary) => pushResponse(stream, socket, data, binary, interception));
    socket.on("close", () => { stream.push(null); if (!stream.destroyed) stream.destroy(); });
    return stream;
  } catch {
    socket.on("error", () => undefined);
    socket.terminate();
    throw unavailable();
  }
}

/** The socket behind the path, owned by this user in a private directory and itself private. */
async function verifiedSocket(socketPath: string): Promise<{ target: string; before: Stats }> {
  if (!unixSocketPath(socketPath)) throw unavailable();
  const parent = await lstat(dirname(socketPath)).catch(() => { throw unavailable(); });
  // Codex 0.159+ leaves a link at the path to the socket it bound in its own private directory.
  const resolved = await resolveCodexSocket(socketPath).catch(() => { throw unavailable(); });
  if (resolved.kind !== "socket") throw unavailable();
  const target = resolved.target;
  const before = await lstat(target).catch(() => { throw unavailable(); });
  if (!parent.isDirectory() || !privateToThisUser(parent) || !before.isSocket() || !privateToThisUser(before)) throw unavailable();
  return { target, before };
}

function unixSocketPath(socketPath: string): boolean {
  return process.platform !== "win32" && isAbsolute(socketPath) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(socketPath);
}

function privateToThisUser(info: Stats): boolean {
  return info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

function sameSocket(before: Stats, after: Stats): boolean {
  return after.dev === before.dev && after.ino === before.ino && after.uid === before.uid && after.mode === before.mode && after.isSocket();
}

/** The agent-facing JSONL stream: each written line is one bounded WebSocket text frame. */
function requestStream(socket: WebSocket, interception: Interception | undefined): Duplex {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return new Duplex({
    read() { socket.resume(); },
    write(chunk: Buffer, _encoding, done) {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending) > MAX_MESSAGE) { done(new Error("Codex local transport message exceeds its bound")); return; }
      const lines = pending.split("\n"); pending = lines.pop()!;
      try {
        for (const line of lines) sendRequest(socket, line, interception);
        done();
      } catch { done(new Error("Codex local transport rejected a malformed or oversized request")); }
    },
    final(done) { if (pending.trim() || decoder.end()) { done(new Error("Codex local transport ended with an incomplete request")); return; } socket.close(); done(); },
    destroy(error, done) { socket.terminate(); done(error); },
  });
}

function sendRequest(socket: WebSocket, line: string, interception: Interception | undefined): void {
  if (!line.trim()) return;
  const parsed: unknown = JSON.parse(line);
  const outgoing = interception ? JSON.stringify(interception.outgoing(parsed)) : line;
  if (socket.bufferedAmount + Buffer.byteLength(outgoing) > MAX_MESSAGE) throw new Error("Codex local transport backpressure limit exceeded");
  socket.send(outgoing);
}

function pushResponse(stream: Duplex, socket: WebSocket, data: WebSocket.RawData, binary: boolean, interception: Interception | undefined): void {
  if (binary) { stream.destroy(new Error("Codex local transport requires JSON text frames")); return; }
  try {
    const incoming = interception ? JSON.stringify(interception.incoming(JSON.parse(data.toString()))) : data.toString();
    if (Buffer.byteLength(incoming) > MAX_MESSAGE) throw new Error("oversized response");
    if (!stream.push(Buffer.from(`${incoming}\n`))) socket.pause();
  } catch { stream.destroy(new Error("Codex local transport rejected a malformed or oversized response")); }
}
