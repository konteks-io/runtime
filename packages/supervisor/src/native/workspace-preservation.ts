import { privateWorkspaceDirectory, readPrivateWorkspaceFile, writePrivateWorkspaceJson } from "./workspace-storage.js";
import { mkdir, readdir, realpath, rm, lstat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { RemoteWorkAssignmentSchema, RemoteWorkspaceAnyCheckpointSchema, sha256Hex,
  type RemoteWorkAssignment, type RemoteWorkspaceAnyCheckpoint, type RemoteWorkspaceCheckpointV2 } from "@konteks/remote-common";
import { NativeInputResponseError, type NativeInputClient } from "./input-client.js";
import { logicalSessionId } from "../work/continued-session.js";
import { NativeWorkspaceChunkStore, workspaceCheckpointChunks } from "./workspace-chunk-store.js";
import { captureWorkspaceCheckpoint } from "./workspace-checkpoint.js";
import { inspectWorkspaceGitControl, WorkspaceGitControlSchema } from "./workspace-git-control.js";
import type { NativeGitTool } from "./git-workspace.js";
import { reportRuntimeFailure, type RuntimeFailureReporter } from "../runtime-failure-types.js";
import { NamedRefusal } from "./named-refusal.js";
import { checkpointFailure } from "./workspace-checkpoint-failure.js";

const unavailable = (diagnostic: string) => new NamedRefusal("recovery_required", "The latest unfinished workspace could not be preserved. Its original checkout was kept.", diagnostic);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Long enough for a restart to retry an uncertain upload. Past it, a copy only holds disk; losing one withholds migration, nothing else. */
const ABANDONED_AFTER_MS = 7 * 24 * 60 * 60_000;
const RecordSchema = z.object({ version: z.literal(1), assignment: RemoteWorkAssignmentSchema,
  claimId: z.string().min(1).max(255), selectionDigest: digest, checkpointId: z.string().uuid(), cwd: z.string().min(1),
  gitControl: WorkspaceGitControlSchema, format: z.literal("konteks-workspace-checkpoint-v2").optional(),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/), tool: z.object({ executable: z.string().min(1), digest }).strict(),
}).strict();
type Record = z.infer<typeof RecordSchema>;
type Admission = { assignmentId: string; attempt: number; claimId: string };
type Owner = { folder: string; record: Record };
type Begin = { assignment: RemoteWorkAssignment; claimId: string; selectionDigest: string; cwd: string; baselineCommit: string; tool: NativeGitTool; format?: "konteks-workspace-checkpoint-v2" };

/** Private durable outbox. A lost upload answer never causes another capture
 * or deletes the original checkout. Only the process-stop owner may seal it. */
export class NativeWorkspaceCheckpointStore {
  constructor(private readonly options: { root: string; repositoryCacheRoot?: string | undefined; client: () => Pick<NativeInputClient, "workspace">; chunksSupported?: (() => boolean) | undefined; onRuntimeFailure?: RuntimeFailureReporter }) {}

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
    if (!isAbsolute(record.cwd) || !path || path.startsWith("..") || isAbsolute(path)) throw unavailable("cwd_outside_root");
    record.cwd = cwd;
    const folder = await this.folder();
    const admission = { assignmentId: record.assignment.id, attempt: record.assignment.attempt, claimId: record.claimId };
    // Retain intent before Core's dirty-head write; a lost response is safe to
    // reconcile after stop, while no prompt can proceed without its receipt.
    await writePrivateWorkspaceJson(folder, join(folder, `${this.key(admission)}.owner.json`), record);
    const result = await this.options.client().workspace(record.assignment, "begin", this.request(record));
    if (!isReceipt(result, record.checkpointId, "writing")) throw unavailable("begin_receipt_mismatch");
  }

  private assertFormatSupported(format: Record["format"]): void {
    if (format && !this.options.chunksSupported?.()) throw unavailable("checkpoint_format_unsupported");
  }

  async seal(admission: Admission, assertCurrent: () => void): Promise<void> {
    const send = await this.capture(admission, assertCurrent);
    await send(assertCurrent);
  }

  /**
   * Keeps the stopped workspace on this computer, and only that holds up the
   * stop: the next attempt may reuse the folder, so it can't wait. Sending the
   * copy can take an hour and needs nothing from the folder, so the returned
   * step can run after the stop has settled.
   */
  async capture(admission: Admission, assertCurrent: () => void): Promise<(assertCurrent: () => void) => Promise<void>> {
    assertCurrent();
    const operation = { stage: "workspace_owner", code: "checkpoint_owner_failed" };
    let owner: Owner | null = null;
    try {
      owner = await this.loadOwner(admission);
      if (!owner) return async () => undefined;
      Object.assign(operation, { stage: "workspace_capture", code: "checkpoint_capture_failed" });
      const checkpoint = await this.checkpoint(owner.folder, owner.record, assertCurrent);
      const captured = owner;
      return assertSending => this.send(admission, captured, checkpoint, assertSending);
    } catch (error) {
      reportRuntimeFailure(this.options.onRuntimeFailure, checkpointFailure(error, operation),
        { assignmentId: admission.assignmentId, attempt: admission.attempt });
      if (owner) await this.tidy(owner.folder, owner.record, false).catch(() => undefined);
      throw error;
    }
  }

  private async send(admission: Admission, owner: Owner, checkpoint: RemoteWorkspaceAnyCheckpoint, assertCurrent: () => void): Promise<void> {
    const operation = { stage: "workspace_seal", code: "checkpoint_seal_failed" };
    let settled = false;
    try {
      await this.sendOwner(owner.folder, owner.record, checkpoint, operation, assertCurrent);
      settled = true;
    } catch (error) {
      settled = isReplaced(error) || await this.discarded(owner);
      if (settled) return;
      reportRuntimeFailure(this.options.onRuntimeFailure, checkpointFailure(error, operation),
        { assignmentId: admission.assignmentId, attempt: admission.attempt });
      throw error;
    } finally {
      await this.tidy(owner.folder, owner.record, settled).catch(() => undefined);
    }
  }

  private async sendOwner(folder: string, record: Record, checkpoint: RemoteWorkspaceAnyCheckpoint, operation: { stage: string; code: string }, assertCurrent: () => void): Promise<void> {
    if (checkpoint.format === "konteks-workspace-checkpoint-v2") {
      Object.assign(operation, { stage: "workspace_chunk_upload", code: "checkpoint_upload_failed" });
      await this.uploadChunks(folder, record, checkpoint, assertCurrent);
    }
    assertCurrent();
    Object.assign(operation, { stage: "workspace_seal", code: "checkpoint_seal_failed" });
    const result = await this.options.client().workspace(record.assignment, "seal", { ...this.request(record), stop: "processes_stopped", checkpoint });
    assertCurrent();
    if (!isReceipt(result, record.checkpointId, "sealed") || result.checkpointDigest !== checkpoint.checkpointDigest) throw unavailable("seal_receipt_mismatch");
  }

  /** A later stop in this session removed this copy while it was being sent. */
  private async discarded(owner: Owner): Promise<boolean> {
    return !await lstat(join(owner.folder, `${this.recordKey(owner.record)}.owner.json`)).catch(() => null);
  }

  /** Local copies this seal has outlived; the original checkouts are never touched. A copy that failed for another reason stays, so a restart can retry it. */
  private async tidy(folder: string, record: Record, settled: boolean): Promise<void> {
    const own = `${this.recordKey(record)}.owner.json`;
    const begun = (await lstat(join(folder, own))).mtimeMs;
    const session = logicalSessionId(record.assignment.source);
    for (const name of await readdir(folder)) {
      if (name !== own && !name.startsWith(`${record.checkpointId}.`)) await this.tidyEntry(folder, name, begun, session);
    }
    if (settled) await this.discard(folder, record);
  }

  private async tidyEntry(folder: string, name: string, begun: number, session: string | undefined): Promise<void> {
    const changed = (await lstat(join(folder, name)).catch(() => null))?.mtimeMs;
    if (changed === undefined) return;
    if (changed < Date.now() - ABANDONED_AFTER_MS) { await rm(join(folder, name), { recursive: true, force: true }); return; }
    if (session && name.endsWith(".owner.json") && changed < begun) await this.discardIfSameSession(folder, name, session);
  }

  private async discardIfSameSession(folder: string, name: string, session: string): Promise<void> {
    const earlier = await this.readRecord(folder, name);
    if (earlier && logicalSessionId(earlier.assignment.source) === session) await this.discard(folder, earlier);
  }

  private async discard(folder: string, record: Record): Promise<void> {
    await rm(join(folder, `${record.checkpointId}.chunks`), { recursive: true, force: true });
    await rm(join(folder, `${record.checkpointId}.checkpoint.json`), { force: true });
    await rm(join(folder, `${this.recordKey(record)}.owner.json`), { force: true });
  }

  private recordKey(record: Record): string {
    return this.key({ assignmentId: record.assignment.id, attempt: record.assignment.attempt, claimId: record.claimId });
  }

  private async readRecord(folder: string, name: string): Promise<Record | null> {
    try {
      const bytes = await readPrivateWorkspaceFile(join(folder, name), 128 * 1024);
      return bytes && RecordSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch { return null; }
  }

  private async loadOwner(admission: Admission): Promise<Owner | null> {
    if (!await hasRecoveryFolder(this.options.root)) return null;
    const folder = await this.folder();
    const bytes = await readPrivateWorkspaceFile(join(folder, `${this.key(admission)}.owner.json`), 128 * 1024);
    if (!bytes) return null;
    const record = RecordSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (this.key({ assignmentId: record.assignment.id, attempt: record.assignment.attempt, claimId: record.claimId }) !== this.key(admission)) throw unavailable("owner_record_mismatch");
    this.assertFormatSupported(record.format);
    return { folder, record };
  }

  private async checkpoint(folder: string, record: Record, assertCurrent: () => void): Promise<RemoteWorkspaceAnyCheckpoint> {
    const snapshot = join(folder, `${record.checkpointId}.checkpoint.json`);
    let retained = await readPrivateWorkspaceFile(snapshot, 90 * 1024 * 1024);
    if (!retained) {
      const options = { cwd: record.cwd, ownerRoot: this.options.root, repositoryCacheRoot: this.options.repositoryCacheRoot, expectedControl: record.gitControl, baselineCommit: record.baselineCommit, tool: record.tool };
      const chunks = join(folder, `${record.checkpointId}.chunks`);
      const checkpoint = record.format ? await captureWorkspaceCheckpoint({ ...options, chunks: new NativeWorkspaceChunkStore(chunks) }).catch(async (error: unknown) => {
        await rm(chunks, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }) : await captureWorkspaceCheckpoint(options);
      assertCurrent();
      await writePrivateWorkspaceJson(folder, snapshot, checkpoint);
      retained = await readPrivateWorkspaceFile(snapshot, 90 * 1024 * 1024);
    }
    if (!retained) throw unavailable("snapshot_missing");
    const checkpoint = RemoteWorkspaceAnyCheckpointSchema.parse(JSON.parse(retained.toString("utf8")));
    if (checkpoint.format !== (record.format ?? "konteks-workspace-checkpoint-v1")) throw unavailable("snapshot_format_mismatch");
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

/** 409: a newer attempt on this session holds the checkpoint now, so this copy can never seal. */
function isReplaced(error: unknown): boolean {
  return error instanceof NativeInputResponseError && error.status === 409;
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
  if (receipt.checkpointId !== checkpointId || receipt.chunkDigest !== chunk.digest || receipt.sizeBytes !== chunk.sizeBytes) throw unavailable("chunk_receipt_mismatch");
}
