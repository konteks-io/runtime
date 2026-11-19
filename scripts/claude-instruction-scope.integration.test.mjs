import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { hardenClaudeSession, isolateClaudeInstructions, ownerClaudeMcpServers } from './claude-instruction-scope.mjs';

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

  async function observe(mode) {
    const isolated = mode !== 'default';
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
    const scoped = isolated ? await isolateClaudeInstructions({}, cwd, config) : {};
    // Stage 0: the hardened session (no repository hooks, only Konteks's MCP
    // servers) still reads the repository's own instructions.
    const settings = mode === 'hardened' ? hardenClaudeSession(scoped) : scoped;
    const child = spawn(process.env.CLAUDE_CLI_UNDER_TEST, [
      '--print', '--model', 'claude-sonnet-4-6', '--setting-sources', 'project',
      '--settings', JSON.stringify(settings), '--tools', '',
      ...(mode === 'hardened' ? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : []),
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
    assert.deepEqual(await observe('default'), { PARENT: true, USER: true, PROJECT: true, LOCAL: false });
    assert.deepEqual(await observe('isolated'), { PARENT: false, USER: false, PROJECT: true, LOCAL: false });
    assert.deepEqual(await observe('hardened'), { PARENT: false, USER: false, PROJECT: true, LOCAL: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('real CLI receives owner personal MCP tools with all setting sources excluded', {
  skip: !process.env.CLAUDE_CLI_UNDER_TEST, timeout: 45_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-personal-mcp-probe-'));
  const config = path.join(root, '.claude');
  await mkdir(config);
  let observed, called = false;
  const observation = new Promise(resolve => { observed = resolve; });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      const value = JSON.parse(body || '{}');
      if (req.url === '/mcp') {
        if (!('id' in value)) { res.writeHead(202); res.end(); return; }
        const results = {
          initialize: { protocolVersion: value.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'personal-probe', version: '1' } },
          'tools/list': { tools: [{ name: 'read_probe', description: 'Read-only test probe', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] },
        };
        if (value.method === 'tools/call') called = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: results[value.method] ?? {} }));
        return;
      }
      if (req.url.includes('/messages')) observed(body.includes('mcp__personal__read_probe'));
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"overloaded_error","message":"local canary"}}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const file = process.env.CLAUDE_CONFIG_DIR ? path.join(config, '.claude.json') : path.join(root, '.claude.json');
  await writeFile(file, JSON.stringify({ mcpServers: { personal: { type: 'http', url: `${endpoint}/mcp` } } }));
  const meta = { konteksIntegration: { version: 1, accountConnectors: true }, konteksPersonalMcp: { version: 1 } };
  const mcpServers = await ownerClaudeMcpServers(meta, config, []);
  const settings = hardenClaudeSession(await isolateClaudeInstructions({}, root, config));
  const child = spawn(process.env.CLAUDE_CLI_UNDER_TEST, [
    '--print', '--model', 'haiku', '--setting-sources', '', '--settings', JSON.stringify(settings),
    '--tools', '', '--mcp-config', JSON.stringify({ mcpServers }),
  ], { cwd: root, env: {
    PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: 'local-canary', ANTHROPIC_BASE_URL: endpoint,
    ENABLE_TOOL_SEARCH: 'false', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end('Reply OK without calling tools');
  let timer;
  try {
    const found = await Promise.race([observation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLI did not advertise the personal MCP tool')), 30_000);
      child.once('error', reject);
    })]);
    assert.equal(found, true);
    assert.equal(called, false);
  } finally {
    clearTimeout(timer); child.kill('SIGKILL'); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
