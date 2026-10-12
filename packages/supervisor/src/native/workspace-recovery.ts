import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { canonicalize, RemoteWorkspaceChunkSchema, RemoteInstanceError, RemoteWorkspaceAnyCheckpointSchema, RemoteWorkspaceRecoveryReferenceSchema, sha256Hex,
  type RemoteAssignmentInputsEnvelope, type RemoteWorkAssignment } from "@konteks/remote-common";
import { restoreWorkspaceCheckpoint, verifyRestoredWorkspaceCheckpoint } from "./workspace-checkpoint.js";
import { privateWorkspaceDirectory, readPrivateWorkspaceFile, readWorkspaceControlFile, writePrivateWorkspaceJson } from "./workspace-storage.js";
import { verifyNativeGitTool, type NativeGitTool } from "./git-workspace.js";
import type { NativeInputClient } from "./input-client.js";

const unavailable = () => new RemoteInstanceError("recovery_required", "The preserved workspace could not be restored and verified. Existing work was kept.");
const ReceiptSchema = z.object({ version: z.literal(1), workspaceId: z.string(), sessionId: z.string(),
  reference: RemoteWorkspaceRecoveryReferenceSchema, configDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), writing: z.boolean(), retired: z.boolean() }).strict();
type Receipt = z.infer<typeof ReceiptSchema>;
type Input = { assignment: RemoteWorkAssignment; claimId: string; selectionDigest: string; selection: RemoteAssignmentInputsEnvelope["selection"] };
type Workspace = { recoveredCheckpointDigest: string; cwd: string; container: string; baselineCommit: string; verify: () => Promise<void>; markWritable: () => Promise<void> };

/** One active recovered checkout per repository role. Every superseded folder
 * is retained; recovery never replaces an existing checkout's bytes. */
export class NativeRecoveredWorkspaceStore {
  constructor(private readonly options: { root: string; client: () => Pick<NativeInputClient, "workspace">; tool: NativeGitTool }) {}

  async prepare(input: Input): Promise<Workspace | null> {
    const repository = input.selection.repository;
    if (!repository) return null;
    await privateWorkspaceDirectory(this.options.root);
    const folder = join(await realpath(this.options.root), ".recovered-workspaces");
    await mkdir(folder, { recursive: true, mode: 0o700 }); await privateWorkspaceDirectory(folder);
    const { workspaceId, sessionId } = input.selection.binding;
    const key = sha256Hex(JSON.stringify([workspaceId, sessionId, repository.repositoryId]));
    const pointer = join(folder, `${key}.active.json`);
    const saved = await readPrivateWorkspaceFile(pointer, 16 * 1024);
    const active = saved && ReceiptSchema.parse(JSON.parse(saved.toString("utf8")));
    const reference = input.selection.workspaceRecovery;
    if (needsRestore(reference, active)) return this.restore(input, { folder, key, pointer });
    if (!active || active.retired) return null;
    assertSameReference(reference, active.reference);
    assertRepositoryOwner(active, workspaceId, sessionId, repository.repositoryId);
    if (active.reference.baselineCommit !== repository.revision) return this.changedRevision(input, pointer, folder, active);
    return this.workspace(input, folder, key, pointer, active);
  }

  private async changedRevision(input: Input, pointer: string, folder: string, active: Receipt): Promise<null> {
    if (input.selection.repositoryWorkspace?.mode !== "reset_to_revision") throw unavailable();
    await writePrivateWorkspaceJson(folder, pointer, { ...active, retired: true });
    return null;
  }

  private request(input: Input, checkpointId: string) {
    return { attempt: input.assignment.attempt, claimId: input.claimId, selectionDigest: input.selectionDigest, checkpointId };
  }

  private async restore(input: Input, target: { folder: string; key: string; pointer: string }): Promise<Workspace> {
    const reference = RemoteWorkspaceRecoveryReferenceSchema.parse(input.selection.workspaceRecovery);
    if (reference.repositoryId !== input.selection.repository?.repositoryId) throw unavailable();
    const checkpoint = RemoteWorkspaceAnyCheckpointSchema.parse(await this.options.client().workspace(input.assignment, "read", this.request(input, reference.checkpointId)));
    if (checkpoint.checkpointDigest !== reference.checkpointDigest || checkpoint.baselineCommit !== reference.baselineCommit || checkpoint.format !== (reference.format ?? "konteks-workspace-checkpoint-v1")) throw unavailable();
    const container = join(target.folder, `${target.key}-${reference.checkpointId}`);
    const cwd = join(container, "source");
    if (!await exists(container)) await restoreWorkspaceCheckpoint({ destination: container, tool: this.options.tool, checkpoint,
      chunks: { get: digest => this.readChunk(input, reference.checkpointId, digest) } });
    await privateWorkspaceDirectory(container); await privateWorkspaceDirectory(cwd);
    await verifyRestoredWorkspaceCheckpoint({ cwd, tool: this.options.tool, checkpoint });
    await writePrivateWorkspaceJson(container, join(container, "checkpoint.json"), checkpoint);
    const receipt = ReceiptSchema.parse({ version: 1, workspaceId: input.selection.binding.workspaceId, sessionId: input.selection.binding.sessionId,
      reference, configDigest: `sha256:${sha256Hex(await requiredGitConfig(cwd))}`, writing: false, retired: false });
    await writePrivateWorkspaceJson(target.folder, target.pointer, receipt);
    return this.workspace(input, target.folder, target.key, target.pointer, receipt);
  }

  private async readChunk(input: Input, checkpointId: string, chunkDigest: string): Promise<Buffer> {
    const chunk = RemoteWorkspaceChunkSchema.parse(await this.options.client().workspace(input.assignment, "read-chunk", {
      ...this.request(input, checkpointId), chunkDigest }));
    if (chunk.digest !== chunkDigest) throw unavailable();
    return Buffer.from(chunk.contentBase64, "base64");
  }

  private async workspace(input: Input, folder: string, key: string, pointer: string, receipt: Receipt): Promise<Workspace> {
    const container = join(folder, `${key}-${receipt.reference.checkpointId}`);
    const cwd = join(container, "source");
    const identity = await lstat(cwd);
    const verify = () => this.verify(cwd, identity, receipt);
    await verify();
    if (!receipt.writing) {
      const bytes = await readPrivateWorkspaceFile(join(container, "checkpoint.json"), 90 * 1024 * 1024);
      if (!bytes) throw unavailable();
      const checkpoint = RemoteWorkspaceAnyCheckpointSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (checkpoint.checkpointDigest !== receipt.reference.checkpointDigest) throw unavailable();
      await verifyRestoredWorkspaceCheckpoint({ cwd, tool: this.options.tool, checkpoint });
      const acknowledgement = await this.options.client().workspace(input.assignment, "acknowledge", {
        ...this.request(input, receipt.reference.checkpointId), checkpointDigest: receipt.reference.checkpointDigest });
      checkAcknowledgement(acknowledgement, receipt.reference);
    }
    return { recoveredCheckpointDigest: receipt.reference.checkpointDigest, cwd, container, baselineCommit: receipt.reference.baselineCommit, verify,
      markWritable: async () => { await verify(); await writePrivateWorkspaceJson(folder, pointer, { ...receipt, writing: true }); } };
  }

  private async verify(cwd: string, identity: { ino: number; dev: number }, receipt: Receipt): Promise<void> {
    await verifyNativeGitTool(this.options.tool);
    await privateWorkspaceDirectory(this.options.root); await privateWorkspaceDirectory(cwd); await privateWorkspaceDirectory(join(cwd, ".git"));
    const actual = await lstat(cwd);
    if (actual.ino !== identity.ino || actual.dev !== identity.dev) throw unavailable();
    const config = await requiredGitConfig(cwd);
    if (`sha256:${sha256Hex(config)}` !== receipt.configDigest) throw unavailable();
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function checkAcknowledgement(value: unknown, reference: Receipt["reference"]): void {
  const checked = z.object({ checkpointId: z.string().uuid(), checkpointDigest: z.string(), state: z.literal("restored") }).strict().parse(value);
  if (checked.checkpointId !== reference.checkpointId || checked.checkpointDigest !== reference.checkpointDigest) throw unavailable();
}

function needsRestore(reference: Input["selection"]["workspaceRecovery"], active: Receipt | null): boolean {
  return Boolean(reference && (!active || active.reference.checkpointId !== reference.checkpointId));
}

function assertRepositoryOwner(active: Receipt, workspaceId: string, sessionId: string, repositoryId: string): void {
  if (active.workspaceId !== workspaceId || active.sessionId !== sessionId || active.reference.repositoryId !== repositoryId) throw unavailable();
}

async function requiredGitConfig(cwd: string): Promise<Buffer> {
  const bytes = await readWorkspaceControlFile(join(cwd, ".git", "config"));
  if (!bytes) throw unavailable();
  return bytes;
}

function assertSameReference(reference: Input["selection"]["workspaceRecovery"], active: Receipt["reference"]): void {
  if (reference && canonicalize(reference as never) !== canonicalize(active as never)) throw unavailable();
}
