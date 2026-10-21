import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
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


test('owner direct sessions load only user-scope MCP definitions without personal settings', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { ownerClaudeMcpServers, ownerClaudeMcpToolServer } = await import('./claude-instruction-scope.mjs');
  const root = mkdtempSync(join(tmpdir(), 'claude-personal-mcp-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  const meta = { konteksIntegration: { version: 1, accountConnectors: true }, konteksPersonalMcp: { version: 1 } };
  try {
    const user = join(root, '.claude');
    mkdirSync(user);
    await writeFile(join(root, '.claude.json'), JSON.stringify({
      mcpServers: { 'asana-recrebox': { type: 'http', url: 'https://mcp.asana.com/v2/mcp', oauth: { clientId: 'test-client', callbackPort: 45432 } } },
      projects: { '/repo': { mcpServers: { untrusted: { command: 'never-run' } } } },
      hooks: { SessionStart: ['never-run'] }, permissions: { defaultMode: 'bypassPermissions' },
    }));
    const expected = { 'asana-recrebox': { type: 'http', url: 'https://mcp.asana.com/v2/mcp', oauth: { clientId: 'test-client', callbackPort: 45432 } } };
    assert.deepEqual(await ownerClaudeMcpServers(meta, user, []), expected);
    assert.equal(await ownerClaudeMcpToolServer(meta, user, 'mcp__asana-recrebox__get_tasks'), 'asana-recrebox');
    assert.equal(await ownerClaudeMcpToolServer(meta, user, 'mcp__repository__get_tasks'), undefined);
    assert.equal(await ownerClaudeMcpToolServer({ konteksIntegration: meta.konteksIntegration }, user, 'mcp__asana-recrebox__get_tasks'), undefined);
    assert.equal(await ownerClaudeMcpToolServer(meta, user, 'Bash'), undefined);
    assert.deepEqual(await ownerClaudeMcpServers({ konteksIntegration: meta.konteksIntegration }, user, []), {});
    assert.deepEqual(await ownerClaudeMcpServers({ konteksPersonalMcp: { version: 1 } }, user, []), {});
    await assert.rejects(ownerClaudeMcpServers(meta, user, ['asana-recrebox']), /conflicts with a Konteks session server/);
    await writeFile(join(user, '.claude.json'), JSON.stringify({ mcpServers: { privateProfile: { command: 'personal-mcp' } } }));
    process.env.CLAUDE_CONFIG_DIR = user;
    assert.deepEqual(await ownerClaudeMcpServers(meta, user, []), { privateProfile: { command: 'personal-mcp' } });
    await writeFile(join(user, '.claude.json'), '{invalid');
    await assert.rejects(ownerClaudeMcpServers(meta, user, []), /personal MCP configuration/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
