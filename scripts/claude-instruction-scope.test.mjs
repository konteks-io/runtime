import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateClaudeInstructions } from './claude-instruction-scope.mjs';

test('excludes ancestor and personal memory while retaining project instructions and auth', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-scope-'));
  try {
    const cwd = join(root, 'home', 'parent', 'repo');
    mkdirSync(cwd, { recursive: true });
    const user = join(root, 'home', '.claude');
    const result = await isolateClaudeInstructions({ env: { AUTH_MODE: 'preserve' }, claudeMdExcludes: ['**/excluded.md'] }, cwd, user);
    assert.ok(result.claudeMdExcludes.includes(join(root, 'home', 'parent', 'CLAUDE.md')));
    assert.ok(result.claudeMdExcludes.includes(join(user, 'CLAUDE.md')));
    assert.ok(result.claudeMdExcludes.includes(join(root, 'home', 'parent', '.claude', 'rules', '**')));
    assert.ok(result.claudeMdExcludes.includes('**/excluded.md'));
    assert.equal(result.claudeMdExcludes.includes(join(cwd, 'CLAUDE.md')), false);
    assert.ok(result.claudeMdExcludes.includes(`${cwd}/**/CLAUDE.local.md`));
    assert.equal(result.autoMemoryEnabled, false);
    assert.deepEqual(result.env, { AUTH_MODE: 'preserve' });
    const alias = join(root, 'alias'); symlinkSync(cwd, alias, 'dir');
    const resumed = await isolateClaudeInstructions({}, alias, user);
    assert.ok(resumed.claudeMdExcludes.includes(join(realpathSync(root), 'home', 'parent', 'CLAUDE.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('under a personal profile whose HOME is the operator home, personal instructions and memory stay excluded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-personal-scope-'));
  try {
    // The personal Claude profile sets HOME to the operator's home
    // (packages/agent-runner/src/bridge/spec.ts). The bridge patch must still
    // leave that home's user instructions, rules, ancestors and auto memory out.
    const home = join(root, 'operator');
    const cwd = join(home, 'code', 'shop', 'repo');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'the operator private rules\n');
    writeFileSync(join(home, 'CLAUDE.md'), 'the home folder rules\n');
    writeFileSync(join(home, 'code', 'CLAUDE.md'), 'the parent folder rules\n');
    const settings = {
      env: {
        HOME: home,
        RUNNER_CREDENTIAL_DIR: join(home, '.claude'),
        RUNNER_WORKSPACE_DIR: home,
        RUNNER_NATIVE_CLAUDE_EXECUTABLE: join(home, '.local', 'bin', 'claude'),
        RUNNER_INSTRUCTIONS_DIR: join(home, '.claude'),
        RUNNER_MEMORY_DIR: join(home, '.claude', 'memory'),
      },
      cwd: home,
      memoryDir: join(home, '.claude', 'memory'),
    };
    const result = await isolateClaudeInstructions(settings, cwd, join(home, '.claude'));
    // The user CLAUDE.md, its rules folder, every parent CLAUDE.md and auto memory.
    assert.ok(result.claudeMdExcludes.includes(join(home, '.claude', 'CLAUDE.md')));
    assert.ok(result.claudeMdExcludes.includes(`${join(home, '.claude', 'rules')}/**`));
    assert.ok(result.claudeMdExcludes.includes(join(home, 'code', 'shop', 'CLAUDE.md')));
    assert.ok(result.claudeMdExcludes.includes(join(home, 'code', 'CLAUDE.md')));
    assert.ok(result.claudeMdExcludes.includes(join(home, 'CLAUDE.md')));
    assert.equal(result.autoMemoryEnabled, false);
    // The working copy's own instructions stay, and settings are carried unchanged.
    assert.equal(result.claudeMdExcludes.includes(join(cwd, 'CLAUDE.md')), false);
    assert.deepEqual(result.env, settings.env);
    // No RUNNER_* value is read as an instruction or memory location: the same
    // exclusions come back when those settings are absent.
    const without = await isolateClaudeInstructions({}, cwd, join(home, '.claude'));
    assert.deepEqual(result.claudeMdExcludes, without.claudeMdExcludes);
    assert.equal(without.autoMemoryEnabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a Konteks session runs no repository hooks, whatever the settings it was given ask for', async () => {
  const { hardenClaudeSession } = await import('./claude-instruction-scope.mjs');
  // Flag settings outrank project settings, so the repository cannot turn its
  // own hooks back on; the SDK's callback hooks (the bridge's) are not settings
  // hooks and keep running (proof/cp2-runtime/stage-0).
  const hardened = hardenClaudeSession({ disableAllHooks: false, claudeMdExcludes: ['a'], env: { KEEP: '1' } });
  assert.equal(hardened.disableAllHooks, true);
  assert.deepEqual(hardened.claudeMdExcludes, ['a']);
  assert.deepEqual(hardened.env, { KEEP: '1' });
  assert.equal(hardenClaudeSession(undefined).disableAllHooks, true);
});

test('a Konteks session leaves the account\'s claude.ai connectors out', async () => {
  const { hardenClaudeSession } = await import('./claude-instruction-scope.mjs');
  assert.equal(hardenClaudeSession({ disableClaudeAiConnectors: false }).disableClaudeAiConnectors, true);
});

test('only an integration session admits the account connectors, and still runs no hooks', async () => {
  const { hardenClaudeSession, konteksAccountConnectors } = await import('./claude-instruction-scope.mjs');
  const admitted = hardenClaudeSession({ disableClaudeAiConnectors: true }, true);
  assert.equal(admitted.disableClaudeAiConnectors, undefined);
  assert.equal(admitted.disableAllHooks, true);
  assert.equal(hardenClaudeSession({}, false).disableClaudeAiConnectors, true);
  assert.equal(konteksAccountConnectors({ konteksIntegration: { version: 1, admittedMcpServerNames: [], accountConnectors: true } }), true);
  for (const meta of [undefined, null, {}, { konteksIntegration: { version: 2, accountConnectors: true } }, { konteksIntegration: { version: 1, accountConnectors: 'yes' } },
    { konteksIntegration: { version: 1, accountConnectors: false } }, { claudeCode: { options: { strictMcpConfig: false } } }]) {
    assert.equal(konteksAccountConnectors(meta), false);
  }
});
