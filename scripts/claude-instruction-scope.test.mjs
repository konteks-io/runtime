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
