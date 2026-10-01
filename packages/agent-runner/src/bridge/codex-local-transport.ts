import { lstat, readlink, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";

const MAX_MESSAGE = 8 * 1024 * 1024;

export interface CodexSocketIdentity {
  path: string;
  entry: Stats;
  parent: Stats;
  physicalParent: Stats;
  socket: Stats | null;
}
const invalidSocket = () => new Error("The supervisor-owned shared Codex service is unavailable on its private same-user Unix socket.");
const privateOwner = (info: Stats) => info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.birthtimeMs === b.birthtimeMs;

/** Codex >=0.156 publishes a deterministic alias into its fixed private
 * daemon directory. Only that exact alias is allowed, never arbitrary links.
 * A missing target is useful solely for owner-controlled stale-alias cleanup.
 */
export async function inspectCodexLocalSocket(socketPath: string, options: { allowMissingTarget?: boolean; allowSocketPermissions?: boolean } = {}): Promise<CodexSocketIdentity> {
  if (process.platform === "win32" || !isAbsolute(socketPath) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(socketPath)) throw invalidSocket();
  const parent = await lstat(dirname(socketPath));
  if (!parent.isDirectory() || !privateOwner(parent)) throw invalidSocket();
  const entry = await lstat(socketPath);
  let path = socketPath;
  let physicalParent = parent;
  if (entry.isSymbolicLink()) {
    if (entry.uid !== process.getuid?.()) throw invalidSocket();
    const canonicalAlias = join(await realpath(dirname(socketPath)), basename(socketPath));
    const directory = join(await realpath("/tmp"), `codex-daemon-${process.getuid?.()}`);
    path = join(directory, createHash("sha256").update(canonicalAlias).digest("hex"));
    if (await readlink(socketPath) !== path) throw invalidSocket();
    physicalParent = await lstat(directory);
    if (!physicalParent.isDirectory() || !privateOwner(physicalParent) || (physicalParent.mode & 0o777) !== 0o700) throw invalidSocket();
  }
  const socket = await lstat(path).catch(error => {
    if (options.allowMissingTarget && entry.isSymbolicLink() && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (socket && (!socket.isSocket() || socket.uid !== process.getuid?.() || (!options.allowSocketPermissions && !privateOwner(socket)))) throw invalidSocket();
  return { path, entry, parent, physicalParent, socket };
}

export function sameCodexSocket(a: CodexSocketIdentity, b: CodexSocketIdentity): boolean {
  return a.path === b.path && sameFile(a.entry, b.entry) && sameFile(a.parent, b.parent) && sameFile(a.physicalParent, b.physicalParent)
    && (a.socket === null ? b.socket === null : b.socket !== null && sameFile(a.socket, b.socket));
}

/** Official JSONL <-> WebSocket-over-Unix transport. The native supervisor
 * owns the shared process under the local user's authority; closing this
 * client never kills that process or logs out its account.
 * No TCP endpoint, secret transport, or writable shared socket is accepted.
 */
export async function connectCodexLocalTransport(socketPath: string, interception?: {
  outgoing(message: unknown): unknown;
  incoming(message: unknown): unknown;
}): Promise<Duplex> {
  const invalid = invalidSocket;
  const before = await inspectCodexLocalSocket(socketPath).catch(() => { throw invalid(); });
  // Codex's control socket rejects extension negotiation, including deflate.
  const socket = new WebSocket("ws://localhost/", { createConnection: () => createConnection(before.path), perMessageDeflate: false, maxPayload: MAX_MESSAGE, handshakeTimeout: 10_000 });
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
    const after = await inspectCodexLocalSocket(socketPath);
    if (!sameCodexSocket(before, after)) throw invalid();
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
