import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { isolateClaudeInstructions } from './claude-instruction-scope.mjs';

// Qualification against the actual personal-profile CLI. The model endpoint is
// a local stub, auth is synthetic, HOME is isolated, and no tool can execute.
test('real CLI excludes parent, personal and local memory but keeps project memory', {
  skip: !process.env.CLAUDE_CLI_UNDER_TEST,
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-memory-canary-'));
  const home = path.join(root, 'home');
  const parent = path.join(home, 'parent');
  const cwd = path.join(parent, 'repo');
  const config = path.join(home, '.claude');
  await mkdir(cwd, { recursive: true });
  await mkdir(config, { recursive: true });
  for (const [file, marker] of [
    [path.join(parent, 'CLAUDE.md'), 'PARENT_MEMORY_CANARY'],
    [path.join(config, 'CLAUDE.md'), 'USER_MEMORY_CANARY'],
    [path.join(cwd, 'CLAUDE.md'), 'PROJECT_MEMORY_CANARY'],
    [path.join(cwd, 'CLAUDE.local.md'), 'LOCAL_MEMORY_CANARY'],
  ]) await writeFile(file, `${marker}: reply with this marker.`);

  async function observe(isolated) {
    let received;
    const request = new Promise(resolve => { received = resolve; });
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url.includes('/messages')) {
          const message = JSON.stringify(JSON.parse(body));
          // Retain only sentinel presence, never credentials or request bodies.
          received(Object.fromEntries(['PARENT', 'USER', 'PROJECT', 'LOCAL']
            .map(kind => [kind, message.includes(`${kind}_MEMORY_CANARY`)])));
        }
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"type":"overloaded_error","message":"local canary"}}');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const settings = isolated ? await isolateClaudeInstructions({}, cwd, config) : {};
    const child = spawn(process.env.CLAUDE_CLI_UNDER_TEST, [
      '--print', '--model', 'claude-sonnet-4-6', '--setting-sources', 'project',
      '--settings', JSON.stringify(settings), '--tools', '',
    ], {
      cwd, env: {
        PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_API_KEY: 'local-canary',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end('Reply OK');
    let timer;
    try {
      return await Promise.race([request, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CLI did not reach the local canary endpoint')), 20_000);
        child.once('error', reject);
      })]);
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  try {
    assert.deepEqual(await observe(false), { PARENT: true, USER: true, PROJECT: true, LOCAL: false });
    assert.deepEqual(await observe(true), { PARENT: false, USER: false, PROJECT: true, LOCAL: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
