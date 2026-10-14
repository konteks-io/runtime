import { privateWorkspaceDirectory, readPrivateWorkspaceFile, writePrivateWorkspaceJson } from "./workspace-storage.js";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { RemoteWorkAssignmentSchema, RemoteWorkspaceAnyCheckpointSchema, sha256Hex, RemoteInstanceError,
  type RemoteWorkAssignment, type RemoteWorkspaceAnyCheckpoint, type RemoteWorkspaceCheckpointV2 } from "@konteks/remote-common";
import type { NativeInputClient } from "./input-client.js";
import { NativeWorkspaceChunkStore, workspaceCheckpointChunks } from "./workspace-chunk-store.js";
import { captureWorkspaceCheckpoint } from "./workspace-checkpoint.js";
import { inspectWorkspaceGitControl, WorkspaceGitControlSchema } from "./workspace-git-control.js";
import type { NativeGitTool } from "./git-workspace.js";

const unavailable = () => new RemoteInstanceError("recovery_required", "The latest unfinished workspace could not be preserved. Its original checkout was kept.");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RecordSchema = z.object({ version: z.literal(1), assignment: RemoteWorkAssignmentSchema,
  claimId: z.string().min(1).max(255), selectionDigest: digest, checkpointId: z.string().uuid(), cwd: z.string().min(1),
  gitControl: WorkspaceGitControlSchema, format: z.literal("konteks-workspace-checkpoint-v2").optional(),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/), tool: z.object({ executable: z.string().min(1), digest }).strict(),
}).strict();
type Record = z.infer<typeof RecordSchema>;
type Admission = { assignmentId: string; attempt: number; claimId: string };
type Begin = { assignment: RemoteWorkAssignment; claimId: string; selectionDigest: string; cwd: string; baselineCommit: string; tool: NativeGitTool; format?: "konteks-workspace-checkpoint-v2" };

/** Private durable outbox. A lost upload answer never causes another capture
 * or deletes the original checkout. Only the process-stop owner may seal it. */
export class NativeWorkspaceCheckpointStore {
  constructor(private readonly options: { root: string; repositoryCacheRoot?: string | undefined; client: () => Pick<NativeInputClient, "workspace">; chunksSupported?: (() => boolean) | undefined }) {}

  private async folder(): Promise<string> {
    await privateWorkspaceDirectory(this.options.root);
    const folder = join(await realpath(this.options.root), ".workspace-recovery");
    await mkdir(folder, { mode: 0o700, recursive: true });
    await privateWorkspaceDirectory(folder);
    return folder;
  }

  private key(admission: Admission): string {
    return sha256Hex(JSON.stringify([admission.assignmentId, admission.attempt, admission.claimId]));
  }

  async begin(input: Begin): Promise<void> {
    this.assertFormatSupported(input.format);
    const record = RecordSchema.parse({ version: 1, ...input, gitControl: await inspectWorkspaceGitControl({ cwd: input.cwd, ownerRoot: this.options.root, repositoryCacheRoot: this.options.repositoryCacheRoot }), checkpointId: randomUUID() });
    const root = await realpath(this.options.root);
    const cwd = await realpath(record.cwd);
    const path = relative(root, cwd);
    if (!isAbsolute(record.cwd) || !path || path.startsWith("..") || isAbsolute(path)) throw unavailable();
    record.cwd = cwd;
    const folder = await this.folder();
    const admission = { assignmentId: record.assignment.id, attempt: record.assignment.attempt, claimId: record.claimId };
    // Retain intent before Core's dirty-head write; a lost response is safe to
    // reconcile after stop, while no prompt can proceed without its receipt.
    await writePrivateWorkspaceJson(folder, join(folder, `${this.key(admission)}.owner.json`), record);
    const result = await this.options.client().workspace(record.assignment, "begin", this.request(record));
    if (!isReceipt(result, record.checkpointId, "writing")) throw unavailable();
  }

  private assertFormatSupported(format: Record["format"]): void {
    if (format && !this.options.chunksSupported?.()) throw unavailable();
  }

  async seal(admission: Admission, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const owner = await this.loadOwner(admission);
    if (!owner) return;
    const { folder, record } = owner;
    const checkpoint = await this.checkpoint(folder, record, assertCurrent);
    if (checkpoint.format === "konteks-workspace-checkpoint-v2") await this.uploadChunks(folder, record, checkpoint, assertCurrent);
    assertCurrent();
    const result = await this.options.client().workspace(record.assignment, "seal", { ...this.request(record), stop: "processes_stopped", checkpoint });
    assertCurrent();
    if (!isReceipt(result, record.checkpointId, "sealed") || result.checkpointDigest !== checkpoint.checkpointDigest) throw unavailable();
  }

  private async loadOwner(admission: Admission): Promise<{ folder: string; record: Record } | null> {
    if (!await hasRecoveryFolder(this.options.root)) return null;
    const folder = await this.folder();
    const bytes = await readPrivateWorkspaceFile(join(folder, `${this.key(admission)}.owner.json`), 128 * 1024);
    if (!bytes) return null;
    const record = RecordSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (this.key({ assignmentId: record.assignment.id, attempt: record.assignment.attempt, claimId: record.claimId }) !== this.key(admission)) throw unavailable();
    this.assertFormatSupported(record.format);
    return { folder, record };
  }

  private async checkpoint(folder: string, record: Record, assertCurrent: () => void): Promise<RemoteWorkspaceAnyCheckpoint> {
    const snapshot = join(folder, `${record.checkpointId}.checkpoint.json`);
    let retained = await readPrivateWorkspaceFile(snapshot, 90 * 1024 * 1024);
    if (!retained) {
      const options = { cwd: record.cwd, ownerRoot: this.options.root, repositoryCacheRoot: this.options.repositoryCacheRoot, expectedControl: record.gitControl, baselineCommit: record.baselineCommit, tool: record.tool };
      const checkpoint = record.format ? await captureWorkspaceCheckpoint({ ...options, chunks: new NativeWorkspaceChunkStore(join(folder, `${record.checkpointId}.chunks`)) }) : await captureWorkspaceCheckpoint(options);
      assertCurrent();
      await writePrivateWorkspaceJson(folder, snapshot, checkpoint);
      retained = await readPrivateWorkspaceFile(snapshot, 90 * 1024 * 1024);
    }
    if (!retained) throw unavailable();
    const checkpoint = RemoteWorkspaceAnyCheckpointSchema.parse(JSON.parse(retained.toString("utf8")));
    if (checkpoint.format !== (record.format ?? "konteks-workspace-checkpoint-v1")) throw unavailable();
    return checkpoint;
  }

  private async uploadChunks(folder: string, record: Record, checkpoint: RemoteWorkspaceCheckpointV2, assertCurrent: () => void): Promise<void> {
    const store = new NativeWorkspaceChunkStore(join(folder, `${record.checkpointId}.chunks`));
    for (const chunk of workspaceCheckpointChunks(checkpoint)) {
      assertCurrent();
      const bytes = await store.get(chunk.digest);
      const result = await this.options.client().workspace(record.assignment, "write-chunk", { ...this.request(record),
        chunk: { ...chunk, contentBase64: bytes.toString("base64") } });
      assertCurrent();
      assertChunkReceipt(result, record.checkpointId, chunk);
    }
  }

  private request(record: Record) {
    return { attempt: record.assignment.attempt, claimId: record.claimId, selectionDigest: record.selectionDigest, checkpointId: record.checkpointId, ...(record.format ? { format: record.format } : {}) };
  }
}

function isReceipt(value: unknown, checkpointId: string, state: string): value is { checkpointId: string; state: string; checkpointDigest?: string } {
  return typeof value === "object" && value !== null && "checkpointId" in value && "state" in value &&
    value.checkpointId === checkpointId && value.state === state;
}

async function hasRecoveryFolder(root: string): Promise<boolean> {
  try { await lstat(join(root, ".workspace-recovery")); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertChunkReceipt(value: unknown, checkpointId: string, chunk: { digest: string; sizeBytes: number }): void {
  const receipt = z.object({ checkpointId: z.string().uuid(), chunkDigest: z.string(), sizeBytes: z.number(), state: z.literal("stored") }).strict().parse(value);
  if (receipt.checkpointId !== checkpointId || receipt.chunkDigest !== chunk.digest || receipt.sizeBytes !== chunk.sizeBytes) throw unavailable();
}
