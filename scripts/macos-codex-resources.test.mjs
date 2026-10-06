/** Source-bound packaging characterization. All npm/native commands are replaced; files are synthetic. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('./build-offline-agent.mjs', import.meta.url), 'utf8');
const body = source.replace(/^#![^\n]*\n/, '').replace(/^import [^\n]+;\r?\n/gm, '')
  .replaceAll('import.meta.url', '"file:///synthetic/packager.mjs"');

function put(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes, { flag: 'wx' });
}

function packageFixture(root, name, bin, entry) {
  const directory = join(root, 'node_modules', ...name.split('/'));
  put(join(directory, 'package.json'), JSON.stringify({ bin: { [bin]: entry } }));
  put(join(directory, entry), 'synthetic wrapper must never be executed\n');
}

function packager(t, os = 'macos', agent = 'codex', failPrepare = false) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'konteks-resource-packager-fixture-')));
  const root = join(work, 'root');
  mkdirSync(root);
  t.after(() => { assert.equal(realpathSync(work), resolve(work)); rmSync(work, { recursive: true }); });
  const selected = { bridge: { package: '@agentclientprotocol/codex-acp', version: '1.10.0', bin: 'codex-acp' },
    tooling: { package: '@openai/codex', version: '0.159.0', bin: 'codex' } };
  packageFixture(root, selected.bridge.package, 'codex-acp', 'dist/index.js');
  packageFixture(root, selected.tooling.package, 'codex', 'bin/codex.js');
  const config = JSON.stringify({ nodeVersion: '22.23.2', agents: { codex: selected, 'claude-code': selected } });
  const calls = [];
  const boundary = Error('synthetic package boundary');
  const failure = Error('synthetic preparation refusal');
  const closures = [{ synthetic: true }];
  const globals = { ...fs, Buffer, URL, process: { platform: 'darwin', version: 'v22.23.2', execPath: 'synthetic-node', pid: 1,
    argv: ['node', 'build-offline-agent.mjs', '--agent', agent, '--os', os, '--architecture', 'amd64',
      '--approval', 'synthetic-reference', '--out', join(work, 'unused.tgz'), '--profile', join(work, 'unused.json')] },
    tmpdir: () => work, mkdtempSync: () => work, join, dirname, relative: () => '', sep: '/',
    readFileSync: (file, encoding) => file === 'release/native-agent-builds.json' ? config : fs.readFileSync(file, encoding),
    cpSync: (_from, to) => { calls.push({ kind: 'copy', to }); put(to, 'synthetic copied bytes'); },
    rmSync: value => { assert.equal(value, work); calls.push({ kind: 'cleanup' }); },
    execFileSync: (_command, args) => calls.push({ kind: 'npm', args: Array.from(args) }),
    offlineAgentPatches: () => ({ codexBridge: agent === 'codex', codexLocalProxy: false, claudeFiles: [] }),
    patchCodexAcpLiveUsers: bytes => { calls.push({ kind: 'bridge-patch' }); return { source: bytes, provenance: { synthetic: true } }; },
    prepareMacCodexResourceTree: async input => { calls.push({ kind: 'prepare', input }); if (failPrepare) throw failure; return { applies: true, resourceClosures: closures }; },
    macOsArtifactOptions: architecture => ({ architecture, minimumOS: '13' }),
    assertMacOsArtifactTree: (directory, options) => { calls.push({ kind: 'guard', directory, options }); throw boundary; },
    inventoryOfflineFiles: async () => { calls.push({ kind: 'inventory' }); throw boundary; } };
  // Keep the actual pipeline and local helper functions; import bindings alone are replaced.
  globals.relative = (from, to) => fs.realpathSync(to).slice(`${from}/`.length).replace(/\\/g, '/');
  const execute = () => runInNewContext(`(async () => {${body}})()`, globals);
  return { execute, calls, boundary, failure, root, closures };
}

test('actual Mac Codex packager prepares resources after bridge patch and before native guard', async t => {
  const f = packager(t);
  await assert.rejects(f.execute(), error => error === f.boundary);
  assert.equal(f.calls.filter(row => row.kind === 'prepare').length, 1);
  const prepare = f.calls.findIndex(row => row.kind === 'prepare');
  assert.ok(f.calls.findIndex(row => row.kind === 'bridge-patch') < prepare);
  assert.ok(prepare < f.calls.findIndex(row => row.kind === 'guard'));
});

test('actual packager hands only prepared closure metadata to the existing Mac guard', async t => {
  const f = packager(t);
  await assert.rejects(f.execute(), error => error === f.boundary);
  assert.equal(f.calls.find(row => row.kind === 'guard').options.resourceClosures, f.closures);
});

test('preparation refusal prevents native inspection and inventory on the actual packaging path', async t => {
  const f = packager(t, 'macos', 'codex', true);
  await assert.rejects(f.execute(), error => error === f.failure);
  assert.equal(f.calls.some(row => row.kind === 'guard' || row.kind === 'inventory'), false);
});

for (const [os, agent] of [['macos', 'claude-code'], ['windows', 'codex'], ['debian', 'codex']]) {
  test(`existing ${os}/${agent} packaging does not enter Mac Codex preparation`, async t => {
    const f = packager(t, os, agent);
    await assert.rejects(f.execute(), error => error === f.boundary);
    assert.equal(f.calls.some(row => row.kind === 'prepare'), false);
    assert.equal(f.calls.filter(row => row.kind === 'npm').length, 1);
  });
}
