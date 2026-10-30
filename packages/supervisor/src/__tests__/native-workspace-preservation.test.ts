import { testGitTool, testGitCommand } from './native-git-fixture.js';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeWorkspaceCheckpointStore } from '../native/workspace-preservation.js';
import { NativeRecoveredWorkspaceStore } from '../native/workspace-recovery.js';
import { captureWorkspaceCheckpoint } from '../native/workspace-checkpoint.js';
import { RemoteWorkspaceBeginRequestSchema, RemoteWorkspaceSealRequestSchema, RemoteWorkspaceAnySealRequestSchema, RemoteWorkspaceChunkWriteRequestSchema, computeRemoteFileTreeDigest, computeRemoteSkillCatalogDigest,
  type RemoteWorkAssignment, type RemoteAssignmentInputsEnvelope } from '@konteks/remote-common';
import type { NativeInputClient } from '../native/input-client.js';
import type { RuntimeFailureReporter } from '../runtime-failure-types.js';
let root: string; let cwd: string; let baseline: string;
let tool: Awaited<ReturnType<typeof testGitTool>>;
const assignment: RemoteWorkAssignment = { id: 'assignment', instanceId: 'old', workspaceId: 'tenant', attempt: 1, kind: 'assistant_execution', placementId: 'placement', taskId: 'task', correlationId: 'correlation', expiresAt: '2026-10-13T02:00:00Z', requiredCapabilities: [], agentRoute: { agentId: 'codex', requiredRole: 'assistant' }, source: { kind: 'conversation', portability: 'portable_before_claim', sessionId: 'session', turnRef: 'turn' }, policy: { maxDurationSeconds: 600, maxArtifactBytes: 1024, evidenceUpload: 'structured_only', allowedArtifactKinds: [], recoveryMode: 'report_interrupted', latestResumeAt: '2026-10-13T02:00:00Z', permissionResponderDeadlineSeconds: 30, humanDeferralAllowed: false } };
const admission = { assignmentId: 'assignment', attempt: 1, claimId: 'claim' };
const selectionDigest = `sha256:${'a'.repeat(64)}`;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kr-workspace-preservation-')); cwd = join(root, 'source'); await mkdir(cwd, { mode: 0o700 });
  tool = await testGitTool();
  await testGitCommand(tool, cwd, ['init', '-q']); await writeFile(join(cwd, 'file.txt'), 'base');
  await testGitCommand(tool, cwd, ['add', '.']);
  await testGitCommand(tool, cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'base']);
  baseline = (await testGitCommand(tool, cwd, ['rev-parse', 'HEAD'])).trim();
});
afterEach(async () => rm(root, { recursive: true, force: true }));
function client() {
  return { workspace: vi.fn(async (...[_assignment, operation, raw]: Parameters<NativeInputClient['workspace']>) => {
    const request = operation === 'begin' ? RemoteWorkspaceBeginRequestSchema.parse(raw) : RemoteWorkspaceSealRequestSchema.parse(raw);
    return { checkpointId: request.checkpointId, state: operation === 'begin' ? 'writing' : 'sealed', ...(operation === 'seal' ? { checkpointDigest: RemoteWorkspaceSealRequestSchema.parse(raw).checkpoint.checkpointDigest } : {}) };
  }) };
}
it('persists the exact stopped workspace across a supervisor restart and retries an uncertain upload without recapturing', async () => {
  const api = client(); const store = new NativeWorkspaceCheckpointStore({ root, client: () => api });
  await store.begin({ assignment, claimId: 'claim', selectionDigest, cwd, baselineCommit: baseline, tool });
  await writeFile(join(cwd, 'file.txt'), 'unfinished edits');
  api.workspace.mockRejectedValueOnce(new Error('network unavailable'));
  await expect(store.seal(admission, () => undefined)).rejects.toThrow('network unavailable');
  await rm(cwd, { recursive: true });
  await new NativeWorkspaceCheckpointStore({ root, client: () => api }).seal(admission, () => undefined);
  const upload = RemoteWorkspaceSealRequestSchema.parse(api.workspace.mock.calls.at(-1)![2]);
  expect(Buffer.from(fileContent(upload.checkpoint.entries), 'base64').toString()).toBe('unfinished edits');
});
it.each(['returns', 'throws', 'rejects', 'pending'] as const)(
  'reports a failed checkpoint seal without replacing its error or losing retained edits when the diagnostic callback %s',
  async diagnostic => {
    const api = client();
    const failure = new Error('private-seal-response EACCES /private/retained-checkout');
    const onRuntimeFailure = vi.fn<RuntimeFailureReporter>(() => {
      if (diagnostic === 'throws') throw new Error('private-diagnostic-throw');
      if (diagnostic === 'rejects') return Promise.reject(new Error('private-diagnostic-rejection'));
      if (diagnostic === 'pending') return new Promise<void>(() => undefined);
    });
    const options = { root, client: () => api, onRuntimeFailure };
    const store = new NativeWorkspaceCheckpointStore(options);
    await store.begin({ assignment, claimId: 'claim', selectionDigest, cwd, baselineCommit: baseline, tool });
    await writeFile(join(cwd, 'file.txt'), 'retained unfinished edits');
    api.workspace.mockRejectedValueOnce(failure);

    await expect(store.seal(admission, () => undefined)).rejects.toBe(failure);
    expect(api.workspace.mock.calls.map(call => call[1])).toEqual(['begin', 'seal']);
    expect(onRuntimeFailure).toHaveBeenCalledExactlyOnceWith({
      phase: 'checkpoint', stage: 'workspace_seal', code: 'checkpoint_seal_failed',
      evidence: { kind: 'runtime_exception' },
    }, { assignmentId: assignment.id, attempt: assignment.attempt });
    expect(JSON.stringify(onRuntimeFailure.mock.calls)).not.toMatch(/private-|EACCES|"message"|"stack"|"errno"/);
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('retained unfinished edits');
    const uncertain = RemoteWorkspaceSealRequestSchema.parse(api.workspace.mock.calls[1]![2]);

    await writeFile(join(cwd, 'file.txt'), 'later unsaved edits');
    await new NativeWorkspaceCheckpointStore(options).seal(admission, () => undefined);
    const retried = RemoteWorkspaceSealRequestSchema.parse(api.workspace.mock.calls[2]![2]);
    expect(retried).toEqual(uncertain);
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('later unsaved edits');
    expect(onRuntimeFailure).toHaveBeenCalledOnce();
  },
);
it('refuses changed Git configuration after work begins and keeps the source edits', async () => {
  const api = client(); const onRuntimeFailure = vi.fn<RuntimeFailureReporter>();
  const options = { root, client: () => api, onRuntimeFailure };
  const store = new NativeWorkspaceCheckpointStore(options);
  await store.begin({ assignment, claimId: 'claim', selectionDigest, cwd, baselineCommit: baseline, tool });
  await writeFile(join(cwd, 'file.txt'), 'keep these edits');
  await testGitCommand(tool, cwd, ['config', 'core.autocrlf', 'true']);
  await expect(new NativeWorkspaceCheckpointStore(options).seal(admission, () => undefined)).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(onRuntimeFailure).toHaveBeenCalledExactlyOnceWith({
    phase: 'checkpoint', stage: 'workspace_capture_git_control_changed', code: 'checkpoint_capture_failed',
    evidence: { kind: 'runtime_condition' },
  }, { assignmentId: assignment.id, attempt: assignment.attempt });
  expect(api.workspace).toHaveBeenCalledTimes(1);
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('keep these edits');
});
it('rejects Git pointers outside connector-owned roots before recording dirty ownership', async () => {
  const api = client();
  const ownerRoot = join(root, 'agent'); await mkdir(ownerRoot, { mode: 0o700 });
  const linked = join(ownerRoot, 'linked');
  await testGitCommand(tool, cwd, ['worktree', 'add', '--detach', linked, 'HEAD']);
  await expect(new NativeWorkspaceCheckpointStore({ root: ownerRoot, client: () => api }).begin({
    assignment, claimId: 'claim', selectionDigest, cwd: linked, baselineCommit: baseline, tool,
  })).rejects.toMatchObject({ code: 'capability_unavailable' });
  expect(api.workspace).not.toHaveBeenCalled();
  expect(await readFile(join(linked, 'file.txt'), 'utf8')).toBe('base');
});
it('never reads or seals workspace bytes while local execution ownership cannot be proved', async () => {
  const api = client(); const store = new NativeWorkspaceCheckpointStore({ root, client: () => api });
  await store.begin({ assignment, claimId: 'claim', selectionDigest, cwd, baselineCommit: baseline, tool });
  await expect(store.seal(admission, () => { throw new Error('owner changed'); })).rejects.toThrow('owner changed');
  expect(api.workspace).toHaveBeenCalledTimes(1);
});
it('restores before acknowledging the handoff and reuses later uncommitted changes in the recovered checkout', async () => {
  await writeFile(join(cwd, 'file.txt'), 'unfinished edits');
  const checkpoint = await captureWorkspaceCheckpoint({ cwd, baselineCommit: baseline, tool });
  const targetRoot = join(root, 'target'); await mkdir(targetRoot, { mode: 0o700 });
  await rm(cwd, { recursive: true });
  const workspaceRecovery = { checkpointId: '00000000-0000-4000-8000-000000000001', checkpointDigest: checkpoint.checkpointDigest, baselineCommit: baseline, repositoryId: 'https://gitea.example/acme/repo' };
  const binding = { workspaceId: 'tenant', sessionId: 'session', assignmentId: assignment.id, instanceId: 'target', attempt: 1 };
  const catalog = { version: 1 as const, binding, skills: [] };
  const selection: RemoteAssignmentInputsEnvelope['selection'] = { version: 1, claimId: 'new-claim', binding,
    source: { version: 1, binding, transferId: 'source', direction: 'to_runtime', purpose: 'source', revision: baseline, artifactRef: 'source',
      treeDigest: computeRemoteFileTreeDigest([]), sizeBytes: 0, fileCount: 0, expiresAt: assignment.expiresAt },
    skills: { ...catalog, catalogDigest: computeRemoteSkillCatalogDigest(catalog) },
    repository: { version: 1, transport: 'core_git_bundle_v1', capabilityId: 'repo', expiresAt: assignment.expiresAt, repositoryId: workspaceRecovery.repositoryId, revision: baseline }, repositoryWorkspace: { mode: 'preserve' }, workspaceRecovery };
  const api = { workspace: vi.fn(async (...[_assignment, operation, raw]: Parameters<NativeInputClient['workspace']>) => {
    if (operation === 'read') return checkpoint;
    const request = raw as { checkpointId: string; checkpointDigest: string };
    return { checkpointId: request.checkpointId, checkpointDigest: request.checkpointDigest, state: 'restored' };
  }) };
  const store = new NativeRecoveredWorkspaceStore({ root: targetRoot, client: () => api, tool });
  const input = { assignment, claimId: 'new-claim', selectionDigest, selection };
  const recovered = await store.prepare(input);
  expect(await readFile(join(recovered!.cwd, 'file.txt'), 'utf8')).toBe('unfinished edits');
  expect(api.workspace.mock.calls.map(call => call[1])).toEqual(['read', 'acknowledge']);
  await recovered!.markWritable(); await writeFile(join(recovered!.cwd, 'file.txt'), 'next unfinished edit');
  const next = await new NativeRecoveredWorkspaceStore({ root: targetRoot, client: () => api, tool }).prepare({ ...input, selection: { ...selection, workspaceRecovery: undefined } });
  expect(next!.cwd).toBe(recovered!.cwd); expect(await readFile(join(next!.cwd, 'file.txt'), 'utf8')).toBe('next unfinished edit');
  await expect(new NativeRecoveredWorkspaceStore({ root: targetRoot, client: () => api, tool }).prepare({ ...input,
    selection: { ...selection, workspaceRecovery: { ...workspaceRecovery, checkpointDigest: `sha256:${'b'.repeat(64)}` } },
  })).rejects.toMatchObject({ code: 'recovery_required' });
  if (process.platform !== 'win32') {
    const configPath = join(next!.cwd, '.git', 'config'); const external = join(root, 'config-copy');
    await writeFile(external, await readFile(configPath)); await unlink(configPath); await symlink(external, configPath);
    await expect(new NativeRecoveredWorkspaceStore({ root: targetRoot, client: () => api, tool }).prepare(input)).rejects.toMatchObject({ code: 'recovery_required' });
  }

  const changedTool = { ...tool, digest: `sha256:${'0'.repeat(64)}` };
  await expect(new NativeRecoveredWorkspaceStore({ root: targetRoot, client: () => api, tool: changedTool }).prepare(input)).rejects.toMatchObject({ code: 'capability_unavailable' });
  // D105: the session comes back here at a newer published commit. Without
  // leave to continue it still waits; with it, the restored folder is kept
  // exactly as it is and the turn continues from the published commit.
  const moved = { ...selection, workspaceRecovery: undefined, repository: { ...selection.repository!, revision: 'c'.repeat(40) } };
  await expect(new NativeRecoveredWorkspaceStore({ root: targetRoot, client: () => api, tool }).prepare({ ...input, selection: moved }))
    .rejects.toMatchObject({ code: 'recovery_required' });
  await expect(new NativeRecoveredWorkspaceStore({ root: targetRoot, client: () => api, tool }).prepare({ ...input, selection: moved },
    { retireStale: true })).resolves.toBeNull();
  expect(await readFile(join(next!.cwd, 'file.txt'), 'utf8')).toBe('next unfinished edit');
});

function fileContent(entries: ReturnType<typeof RemoteWorkspaceSealRequestSchema.parse>['checkpoint']['entries']): string {
  const entry = entries.find(value => value.path === 'file.txt');
  if (entry?.kind !== 'file') throw new Error('Expected preserved file');
  return entry.contentBase64;
}

it('replays the same durable chunks after an uncertain upload and a restart without the original checkout', async () => {
  const saved = new Map<string, string>(); let fail = true;
  const onRuntimeFailure = vi.fn<RuntimeFailureReporter>();
  const api = { workspace: vi.fn(async (...[_assignment, operation, raw]: Parameters<NativeInputClient['workspace']>) => {
    if (operation === 'begin') return { checkpointId: RemoteWorkspaceBeginRequestSchema.parse(raw).checkpointId, state: 'writing' };
    if (operation === 'write-chunk') {
      const request = RemoteWorkspaceChunkWriteRequestSchema.parse(raw); saved.set(request.chunk.digest, request.chunk.contentBase64);
      if (fail) { fail = false; throw new Error('upload reply lost'); }
      return { checkpointId: request.checkpointId, chunkDigest: request.chunk.digest, sizeBytes: request.chunk.sizeBytes, state: 'stored' };
    }
    const request = RemoteWorkspaceAnySealRequestSchema.parse(raw);
    return { checkpointId: request.checkpointId, checkpointDigest: request.checkpoint.checkpointDigest, state: 'sealed' };
  }) };
  const options = { root, client: () => api, chunksSupported: () => true, onRuntimeFailure };
  const store = new NativeWorkspaceCheckpointStore(options);
  await store.begin({ assignment, claimId: 'claim', selectionDigest, cwd, baselineCommit: baseline, tool, format: 'konteks-workspace-checkpoint-v2' });
  await writeFile(join(cwd, 'file.txt'), 'keep this unfinished work');
  await expect(store.seal(admission, () => undefined)).rejects.toThrow('upload reply lost');
  expect(onRuntimeFailure).toHaveBeenCalledExactlyOnceWith({
    phase: 'checkpoint', stage: 'workspace_chunk_upload', code: 'checkpoint_upload_failed',
    evidence: { kind: 'runtime_exception' },
  }, { assignmentId: assignment.id, attempt: assignment.attempt });
  expect(JSON.stringify(onRuntimeFailure.mock.calls)).not.toMatch(/upload reply lost|contentBase64|"errno"/);
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('keep this unfinished work');
  await rm(cwd, { recursive: true });
  await new NativeWorkspaceCheckpointStore(options).seal(admission, () => undefined);
  const request = RemoteWorkspaceAnySealRequestSchema.parse(api.workspace.mock.calls.at(-1)![2]);
  const file = request.checkpoint.entries.find(entry => entry.path === 'file.txt');
  if (request.checkpoint.format !== 'konteks-workspace-checkpoint-v2' || file?.kind !== 'file' || !('chunks' in file)) throw new Error('Expected chunked work');
  expect(Buffer.from(saved.get(file.chunks[0]!.digest)!, 'base64').toString()).toBe('keep this unfinished work');
  expect(onRuntimeFailure).toHaveBeenCalledOnce();
});
