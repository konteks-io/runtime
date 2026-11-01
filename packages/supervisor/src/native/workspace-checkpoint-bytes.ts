import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { REMOTE_WORKSPACE_CHECKPOINT_LIMITS, REMOTE_WORKSPACE_CHUNK_LIMITS,
  type RemoteWorkspaceAnyCheckpoint } from "@konteks/remote-common";
import { NamedRefusal } from "./named-refusal.js";

type Blob = RemoteWorkspaceAnyCheckpoint["index"];
export type WorkspaceChunkCapture = { put?: (bytes: Buffer) => Promise<void> };
export type WorkspaceChunkRead = { get: (digest: string) => Promise<Buffer> };
const unavailable = (diagnostic: string) => new NamedRefusal("recovery_required", "The unfinished workspace bytes could not be preserved or verified. Existing work was kept.", diagnostic);
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function workspaceFileUnchanged(before: Stats, after: Stats): boolean {
  return before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** A stable NOFOLLOW read; chunked files never allocate their full length. */
export async function readCheckpointBytes(path: string, observed?: Stats, chunks?: WorkspaceChunkCapture): Promise<Blob> {
  const before = observed ?? await lstat(path);
  assertByteSource(before, chunks);
  const handle = await open(path, noFollow());
  try {
    assertStable(before, await handle.stat());
    const value = chunks ? await chunkedBytes(handle, before.size, chunks) : inlineBytes(await handle.readFile());
    assertStable(before, await handle.stat()); assertStable(before, await lstat(path));
    if (value.sizeBytes !== before.size) throw unavailable("file_changed");
    return value;
  } finally { await handle.close(); }
}

function noFollow(): number { return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0); }
function assertStable(before: Stats, after: Stats): void { if (!workspaceFileUnchanged(before, after)) throw unavailable("file_changed"); }
function assertByteSource(stat: Stats, chunks?: WorkspaceChunkCapture): void {
  const limit = chunks ? REMOTE_WORKSPACE_CHUNK_LIMITS.bytes : REMOTE_WORKSPACE_CHECKPOINT_LIMITS.bytes;
  if (!stat.isFile()) throw unavailable("not_a_file");
  if (stat.nlink !== 1) throw unavailable("file_hardlinked");
  if (stat.size > limit) throw unavailable("file_too_large");
}

function inlineBytes(bytes: Buffer): Blob {
  return { digest: hash(bytes), sizeBytes: bytes.length, contentBase64: bytes.toString("base64") };
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(bytes, read, length - read, position + read);
    if (result.bytesRead === 0) throw unavailable("file_changed");
    read += result.bytesRead;
  }
  return bytes;
}

async function chunkedBytes(handle: FileHandle, sizeBytes: number, sink: WorkspaceChunkCapture): Promise<Blob> {
  const chunks: Array<{ digest: string; sizeBytes: number }> = [];
  const whole = createHash("sha256");
  for (let position = 0; position < sizeBytes; position += REMOTE_WORKSPACE_CHUNK_LIMITS.chunkBytes) {
    const bytes = await readExact(handle, Math.min(REMOTE_WORKSPACE_CHUNK_LIMITS.chunkBytes, sizeBytes - position), position);
    whole.update(bytes); chunks.push({ digest: hash(bytes), sizeBytes: bytes.length });
    await sink.put?.(bytes);
  }
  return { digest: `sha256:${whole.digest("hex")}`, sizeBytes, chunks };
}

async function* sourceBytes(blob: Blob, source?: WorkspaceChunkRead): AsyncGenerator<Buffer> {
  if ("contentBase64" in blob) { yield Buffer.from(blob.contentBase64, "base64"); return; }
  if (!source) throw unavailable("chunk_source_missing");
  for (const chunk of blob.chunks) {
    const bytes = await source.get(chunk.digest);
    if (bytes.length !== chunk.sizeBytes || hash(bytes) !== chunk.digest) throw unavailable("chunk_mismatch");
    yield bytes;
  }
}

/** Only new private files are written. Every chunk and the whole file must agree. */
export async function writeCheckpointBytes(path: string, blob: Blob, source?: WorkspaceChunkRead): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  const whole = createHash("sha256"); let size = 0;
  try {
    for await (const bytes of sourceBytes(blob, source)) {
      size += bytes.length;
      if (size > blob.sizeBytes) throw unavailable("bytes_mismatch");
      whole.update(bytes); await handle.writeFile(bytes);
    }
    if (size !== blob.sizeBytes || `sha256:${whole.digest("hex")}` !== blob.digest) throw unavailable("bytes_mismatch");
    await handle.sync();
  } finally { await handle.close(); }
}
