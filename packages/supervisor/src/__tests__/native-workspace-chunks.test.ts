import { testGitTool, testGitCommand } from './native-git-fixture.js';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureWorkspaceCheckpoint, restoreWorkspaceCheckpoint, verifyRestoredWorkspaceCheckpoint } from '../native/workspace-checkpoint.js';

let root: string; let source: string; let baseline: string; let tool: Awaited<ReturnType<typeof testGitTool>>;
const git = (cwd: string, ...args: string[]) => testGitCommand(tool, cwd, args);
const digest = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const chunks = new Map<string, Buffer>();
beforeEach(async () => {
  chunks.clear(); root = await mkdtemp(join(tmpdir(), 'kr-workspace-chunks-')); source = join(root, 'source');
  await mkdir(source, { mode: 0o700 }); tool = await testGitTool(); await git(source, 'init', '-q');
  await writeFile(join(source, 'source.txt'), 'base'); await writeFile(join(source, '.gitignore'), 'large.ignored\n');
  await git(source, 'add', '.'); await git(source, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'base');
  baseline = (await git(source, 'rev-parse', 'HEAD')).trim();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const put = async (data: Buffer) => { expect(data.length).toBeLessThanOrEqual(1024 * 1024); chunks.set(digest(data), Buffer.from(data)); };
const get = async (key: string) => { const data = chunks.get(key); if (!data) throw new Error('missing chunk'); return Buffer.from(data); };

describe('large materialized workspace preservation', () => {
  it('restores more than 64MiB of ignored work plus exact staged and unstaged Git state after the original is gone', async () => {
    await writeFile(join(source, 'source.txt'), 'staged'); await git(source, 'add', 'source.txt');
    await writeFile(join(source, 'source.txt'), 'unstaged');
    const handle = await open(join(source, 'large.ignored'), 'wx', 0o600);
    await handle.truncate(65 * 1024 * 1024 + 7); await handle.write(Buffer.from('tail'), 0, 4, 65 * 1024 * 1024 + 3); await handle.close();
    const before = await git(source, 'status', '--porcelain=v1', '-z');
    const checkpoint = await captureWorkspaceCheckpoint({ cwd: source, tool, baselineCommit: baseline, chunks: { put } });
    expect(checkpoint.format).toBe('konteks-workspace-checkpoint-v2');
    expect(JSON.stringify(checkpoint).length).toBeLessThan(20_000);
    await rm(source, { recursive: true });
    const restored = await restoreWorkspaceCheckpoint({ destination: join(root, 'target'), tool, checkpoint, chunks: { get } });
    await verifyRestoredWorkspaceCheckpoint({ cwd: restored.cwd, tool, checkpoint });
    expect(await git(restored.cwd, 'status', '--porcelain=v1', '-z')).toBe(before);
    expect(await git(restored.cwd, 'show', ':source.txt')).toBe('staged');
    expect(await readFile(join(restored.cwd, 'source.txt'), 'utf8')).toBe('unstaged');
    const output = await open(join(restored.cwd, 'large.ignored'), 'r'); const tail = Buffer.alloc(4);
    await output.read(tail, 0, 4, 65 * 1024 * 1024 + 3); await output.close(); expect(tail.toString()).toBe('tail');
  });
  it('refuses a corrupt chunk without publishing a restored folder or touching existing work', async () => {
    const checkpoint = await captureWorkspaceCheckpoint({ cwd: source, tool, baselineCommit: baseline, chunks: { put } });
    await expect(restoreWorkspaceCheckpoint({ destination: join(root, 'corrupt-target'), tool, checkpoint,
      chunks: { get: async () => Buffer.from('corrupt') } })).rejects.toThrow();
    expect(await readFile(join(source, 'source.txt'), 'utf8')).toBe('base');
  });
});
