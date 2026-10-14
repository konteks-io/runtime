import { testGitTool, testGitCommand } from './native-git-fixture.js';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from '../native/workspace-checkpoint.js';

let root: string;
let source: string;
let baseline: string;
let tool: Awaited<ReturnType<typeof testGitTool>>;
const git = (cwd: string, ...args: string[]) => testGitCommand(tool, cwd, args);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kr-workspace-checkpoint-'));
  source = join(root, 'source');
  await mkdir(source, { mode: 0o700 });
  tool = await testGitTool();
  await git(source, 'init', '-q');
  await writeFile(join(source, 'kept.txt'), 'base\n');
  await writeFile(join(source, 'deleted.txt'), 'delete\n');
  await writeFile(join(source, '.gitignore'), 'private-local/\n');
  await git(source, 'add', '.');
  await git(source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'base');
  baseline = (await git(source, 'rev-parse', 'HEAD')).trim();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function unfinishedWork() {
  await writeFile(join(source, 'kept.txt'), 'local committed work\n');
  await git(source, 'add', 'kept.txt');
  await git(source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'unfinished local commit');
  await writeFile(join(source, 'kept.txt'), 'staged work\n');
  await git(source, 'add', 'kept.txt');
  await writeFile(join(source, 'kept.txt'), 'unstaged work\n');
  await unlink(join(source, 'deleted.txt'));
  await writeFile(join(source, 'binary.bin'), Buffer.from([0, 255, 128, 10]));
  await mkdir(join(source, 'private-local'));
  await writeFile(join(source, 'private-local', 'draft.txt'), 'ignored unfinished work');
  await mkdir(join(source, 'empty'));
  await writeFile(join(source, 'run.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(source, 'run.sh'), 0o700);
}

describe('native workspace recovery checkpoint', () => {
  it('preserves a standalone recovered repository before a replacement runtime has an object cache', async () => {
    await unfinishedWork();
    const checkpoint = await captureWorkspaceCheckpoint({ cwd: source, ownerRoot: root, tool, baselineCommit: baseline,
      repositoryCacheRoot: join(root, 'not-created-yet') });
    const restored = await restoreWorkspaceCheckpoint({ destination: join(root, 'replacement'), tool, checkpoint });
    expect(await git(restored.cwd, 'show', ':kept.txt')).toBe('staged work\n');
    expect(await readFile(join(restored.cwd, 'kept.txt'), 'utf8')).toBe('unstaged work\n');
  });
  it('still refuses an external worktree pointer when the selected cache is absent', async () => {
    const ownerRoot = join(root, 'private-agent'); await mkdir(ownerRoot, { mode: 0o700 });
    const linked = join(ownerRoot, 'linked');
    await git(source, 'worktree', 'add', '--detach', linked, 'HEAD');
    await expect(captureWorkspaceCheckpoint({ cwd: linked, ownerRoot, tool, baselineCommit: baseline,
      repositoryCacheRoot: join(root, 'absent-cache') })).rejects.toThrow();
    expect(await readFile(join(linked, 'kept.txt'), 'utf8')).toBe('base\n');
  });
  it('restores local commits, staged versus unstaged edits, deletions, binary/untracked and ignored files on another runtime', async () => {
    await unfinishedWork();
    const before = await git(source, 'status', '--porcelain=v1', '-z');
    const index = await readFile(join(source, '.git', 'index'));
    const checkpoint = await captureWorkspaceCheckpoint({ cwd: source, tool, baselineCommit: baseline });
    expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
    expect(await git(source, 'status', '--porcelain=v1', '-z')).toBe(before);
    const head = await git(source, 'rev-parse', 'HEAD');
    const staged = await git(source, 'show', ':kept.txt');
    await rm(source, { recursive: true });
    const restored = await restoreWorkspaceCheckpoint({ destination: join(root, 'another-runtime'), tool, checkpoint });
    const destination = restored.cwd;
    expect(await git(destination, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(destination, 'status', '--porcelain=v1', '-z')).toBe(before);
    expect(await git(destination, 'show', ':kept.txt')).toBe(staged);
    expect(await readFile(join(destination, 'kept.txt'), 'utf8')).toBe('unstaged work\n');
    expect(await readFile(join(destination, 'binary.bin'))).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(await readFile(join(destination, 'private-local', 'draft.txt'), 'utf8')).toBe('ignored unfinished work');
    expect((await lstat(join(destination, 'empty'))).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect((await lstat(join(destination, 'run.sh'))).mode & 0o100).toBe(0o100);
  });
  it('preserves a real linked Git worktree without copying another session private refs', async () => {
    const cacheRoot = join(root, 'cache'); await mkdir(cacheRoot, { mode: 0o700 });
    const ownerRoot = join(root, 'agent'); await mkdir(ownerRoot, { mode: 0o700 });
    const cache = join(cacheRoot, 'repository.git');
    await git(root, 'clone', '--bare', source, cache);
    const linked = join(ownerRoot, 'linked');
    await git(cache, 'worktree', 'add', '--detach', linked, 'HEAD');
    await git(cache, 'update-ref', 'refs/heads/another-session-private', baseline);
    await writeFile(join(linked, 'kept.txt'), 'linked unfinished edit');
    await git(linked, 'add', 'kept.txt');
    await writeFile(join(linked, 'kept.txt'), 'linked staged plus unstaged edit');
    const checkpoint = await captureWorkspaceCheckpoint({ cwd: linked, ownerRoot, repositoryCacheRoot: cacheRoot, tool, baselineCommit: baseline });
    expect(checkpoint.refs).toEqual([]);
    const restored = await restoreWorkspaceCheckpoint({ destination: join(root, 'recovered-linked'), tool, checkpoint });
    expect(await git(restored.cwd, 'show', ':kept.txt')).toBe('linked unfinished edit');
    expect(await readFile(join(restored.cwd, 'kept.txt'), 'utf8')).toBe('linked staged plus unstaged edit');
    expect(await git(restored.cwd, 'for-each-ref', '--format=%(refname)')).toBe('');
  });

  it.each([false, true])('retains stash stacks until their metadata can be preserved (linked=%s)', async linked => {
    let checkout = source; let ownerRoot = root; let cacheRoot: string | undefined;
    if (linked) {
      cacheRoot = join(root, 'stash-cache'); await mkdir(cacheRoot, { mode: 0o700 });
      ownerRoot = join(root, 'stash-agent'); await mkdir(ownerRoot, { mode: 0o700 });
      const cache = join(cacheRoot, 'repository.git'); await git(root, 'clone', '--bare', source, cache);
      checkout = join(ownerRoot, 'linked'); await git(cache, 'worktree', 'add', '--detach', checkout, 'HEAD');
    }
    await writeFile(join(checkout, 'kept.txt'), 'unfinished stashed work');
    await git(checkout, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'stash', 'push', '-m', 'saved unfinished work');
    await writeFile(join(checkout, 'kept.txt'), 'second stashed work');
    await git(checkout, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'stash', 'push', '-m', 'another saved change');
    const original = await git(checkout, 'stash', 'list', '-p');
    await expect(captureWorkspaceCheckpoint({ cwd: checkout, ownerRoot, repositoryCacheRoot: cacheRoot, tool, baselineCommit: baseline })).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(await git(checkout, 'stash', 'list', '-p')).toBe(original);
    expect(original).toContain('unfinished stashed work'); expect(original).toContain('second stashed work');
  });

  it.each(['MERGE_HEAD', 'rebase-merge', 'sharedindex.0123456789'])('refuses unsupported Git operation metadata %s and keeps the original checkout', async name => {
    await unfinishedWork();
    await writeFile(join(source, '.git', name), baseline);
    await expect(captureWorkspaceCheckpoint({ cwd: source, tool, baselineCommit: baseline })).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(await readFile(join(source, 'kept.txt'), 'utf8')).toBe('unstaged work\n');
    expect(await readFile(join(source, '.git', name), 'utf8')).toBe(baseline);
  });

  it.skipIf(process.platform === 'win32')('preserves an internal symbolic link without following its target', async () => {
    await symlink('kept.txt', join(source, 'linked.txt'));
    const checkpoint = await captureWorkspaceCheckpoint({ cwd: source, tool, baselineCommit: baseline });
    const restored = await restoreWorkspaceCheckpoint({ destination: join(root, 'restored'), tool, checkpoint });
    const destination = restored.cwd;
    expect(await readlink(join(destination, 'linked.txt'))).toBe('kept.txt');
  });
  it('refuses corruption and never overwrites an existing workspace', async () => {
    const checkpoint = await captureWorkspaceCheckpoint({ cwd: source, tool, baselineCommit: baseline });
    await expect(restoreWorkspaceCheckpoint({ destination: source, tool, checkpoint })).rejects.toThrow();
    await expect(restoreWorkspaceCheckpoint({ destination: join(root, 'tampered'), tool,
      checkpoint: { ...checkpoint, headCommit: 'f'.repeat(40) } })).rejects.toThrow();
    expect(await readFile(join(source, 'kept.txt'), 'utf8')).toBe('base\n');
  });
  it.skipIf(process.platform === 'win32')('refuses a link outside the workspace and keeps the original work untouched', async () => {
    await symlink('../outside', join(source, 'unsafe'));
    await expect(captureWorkspaceCheckpoint({ cwd: source, tool, baselineCommit: baseline })).rejects.toThrow();
    expect(await readlink(join(source, 'unsafe'))).toBe('../outside');
  });
});
