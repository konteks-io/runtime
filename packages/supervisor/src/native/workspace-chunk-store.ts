import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REMOTE_WORKSPACE_CHUNK_LIMITS, sha256Hex, type RemoteWorkspaceCheckpointV2 } from "@konteks/remote-common";
import { privateWorkspaceDirectory, readPrivateWorkspaceFile, writePrivateWorkspaceBytes } from "./workspace-storage.js";
import { NamedRefusal } from "./named-refusal.js";

const unavailable = (diagnostic: string) => new NamedRefusal("recovery_required", "The retained workspace chunk could not be verified.", diagnostic);

/** Content-addressed private outbox; manifest publication follows all durable writes. */
export class NativeWorkspaceChunkStore {
  constructor(private readonly folder: string) {}

  private async path(digest: string): Promise<string> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw unavailable("chunk_digest_invalid");
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    await privateWorkspaceDirectory(this.folder);
    return join(this.folder, digest.slice(7));
  }

  async put(bytes: Buffer): Promise<void> {
    if (bytes.length === 0 || bytes.length > REMOTE_WORKSPACE_CHUNK_LIMITS.chunkBytes) throw unavailable("chunk_size_invalid");
    const digest = `sha256:${sha256Hex(bytes)}`;
    const path = await this.path(digest);
    const existing = await readPrivateWorkspaceFile(path, REMOTE_WORKSPACE_CHUNK_LIMITS.chunkBytes);
    if (existing) { if (!existing.equals(bytes)) throw unavailable("chunk_conflict"); return; }
    await writePrivateWorkspaceBytes(this.folder, path, bytes);
  }

  async get(digest: string): Promise<Buffer> {
    const bytes = await readPrivateWorkspaceFile(await this.path(digest), REMOTE_WORKSPACE_CHUNK_LIMITS.chunkBytes);
    if (!bytes) throw unavailable("chunk_missing");
    if (`sha256:${sha256Hex(bytes)}` !== digest) throw unavailable("chunk_mismatch");
    return bytes;
  }
}

export function workspaceCheckpointChunks(checkpoint: RemoteWorkspaceCheckpointV2): Array<{ digest: string; sizeBytes: number }> {
  const blobs = [checkpoint.index, checkpoint.bundle, ...checkpoint.entries.filter(entry => entry.kind === "file")];
  const unique = new Map(blobs.flatMap(blob => blob.chunks.map(chunk => [chunk.digest, chunk] as const)));
  return [...unique.values()];
}
