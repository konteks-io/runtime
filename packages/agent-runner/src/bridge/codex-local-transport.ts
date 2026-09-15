import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";

const MAX_MESSAGE = 8 * 1024 * 1024;

/** Official JSONL <-> WebSocket-over-Unix transport. The native supervisor
 * owns the shared process under the local user's authority; closing this
 * client never kills that process or logs out its account.
 * No TCP endpoint, secret transport, or writable shared socket is accepted.
 */
export async function connectCodexLocalTransport(socketPath: string, interception?: {
  outgoing(message: unknown): unknown;
  incoming(message: unknown): unknown;
}): Promise<Duplex> {
  const invalid = () => new Error("The supervisor-owned shared Codex service is unavailable on its private same-user Unix socket.");
  if (process.platform === "win32" || !isAbsolute(socketPath) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(socketPath)) throw invalid();
  const parent = await lstat(dirname(socketPath)).catch(() => { throw invalid(); });
  const before = await lstat(socketPath).catch(() => { throw invalid(); });
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0 || !before.isSocket() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0) throw invalid();
  // Codex's control socket rejects extension negotiation, including deflate.
  const socket = new WebSocket("ws://localhost/", { createConnection: () => createConnection(socketPath), perMessageDeflate: false, maxPayload: MAX_MESSAGE, handshakeTimeout: 10_000 });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const stream = new Duplex({
    read() { socket.resume(); },
    write(chunk: Buffer, _encoding, done) {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending) > MAX_MESSAGE) { done(new Error("Codex local transport message exceeds its bound")); return; }
      const lines = pending.split("\n"); pending = lines.pop()!;
      try {
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed: unknown = JSON.parse(line);
          const outgoing = interception ? JSON.stringify(interception.outgoing(parsed)) : line;
          if (socket.bufferedAmount + Buffer.byteLength(outgoing) > MAX_MESSAGE) throw new Error("Codex local transport backpressure limit exceeded");
          socket.send(outgoing);
        }
        done();
      } catch { done(new Error("Codex local transport rejected a malformed or oversized request")); }
    },
    final(done) { if (pending.trim() || decoder.end()) { done(new Error("Codex local transport ended with an incomplete request")); return; } socket.close(); done(); },
    destroy(error, done) { socket.terminate(); done(error); },
  });
  // Initialization errors are returned to the caller, not unhandled events.
  const onError = () => stream.destroy(new Error("Codex local transport disconnected"));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const after = await lstat(socketPath);
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode || !after.isSocket()) throw invalid();
    socket.on("error", onError);
    socket.on("message", (data, binary) => {
      if (binary) { stream.destroy(new Error("Codex local transport requires JSON text frames")); return; }
      try {
        const incoming = interception ? JSON.stringify(interception.incoming(JSON.parse(data.toString()))) : data.toString();
        if (Buffer.byteLength(incoming) > MAX_MESSAGE) throw new Error("oversized response");
        if (!stream.push(Buffer.from(`${incoming}\n`))) socket.pause();
      } catch { stream.destroy(new Error("Codex local transport rejected a malformed or oversized response")); }
    });
    socket.on("close", () => { stream.push(null); if (!stream.destroyed) stream.destroy(); });
    return stream;
  } catch {
    socket.on("error", () => undefined);
    socket.terminate();
    throw invalid();
  }
}
