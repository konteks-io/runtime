import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { discoverMacCodexResourceOwners as discover } from './macos-codex-resource-owners.mjs';

function put(file, content) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content, { flag: 'wx' }); }
function json(file, value) { put(file, JSON.stringify(value)); }
function change(file, mutate) { const value = JSON.parse(readFileSync(file, 'utf8')); mutate(value); writeFileSync(file, JSON.stringify(value)); }

function cli(root, directory, version, cpu, triple, top) {
  const alias = `codex-darwin-${cpu}`;
  const platform = join(dirname(directory), alias);
  json(join(directory, 'package.json'), { name: '@openai/codex', version, bin: { codex: 'bin/codex.js' }, optionalDependencies: { [`@openai/${alias}`]: `npm:@openai/codex@${version}-darwin-${cpu}` } });
  put(join(directory, 'bin/codex.js'), 'throw new Error("SYNTHETIC WRAPPER MUST NEVER EXECUTE");\n');
  json(join(platform, 'package.json'), { name: '@openai/codex', version: `${version}-darwin-${cpu}`, os: ['darwin'], cpu: [cpu], files: ['vendor'] });
  const vendor = join(platform, 'vendor', triple);
  put(join(vendor, 'bin/codex'), 'synthetic non-native codex bytes\n');
  put(join(vendor, 'codex-resources/zsh/bin/zsh'), 'synthetic non-native zsh bytes\n');
  put(join(vendor, 'codex-resources/voice/bin/codex-voice-host'), `synthetic non-native voice ${version}\n`);
  if (top) json(join(vendor, 'codex-resources/voice/runtime.json'), { synthetic: true });
  return { directory, platform, vendor, wrapper: join(directory, 'bin/codex.js'), manifest: join(directory, 'package.json'), platformManifest: join(platform, 'package.json') };
}

function fixture(t, architecture = 'arm64') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'konteks-resource-owner-fixture-')));
  const cpu = architecture === 'arm64' ? 'arm64' : 'x64';
  const triple = architecture === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const bridge = join(root, 'node_modules/@agentclientprotocol/codex-acp');
  json(join(bridge, 'package.json'), { name: '@agentclientprotocol/codex-acp', version: '1.10.0', bin: { 'codex-acp': './dist/index.js' }, dependencies: { '@openai/codex': '^0.153.3' } });
  put(join(bridge, 'dist/index.js'), 'throw new Error("SYNTHETIC ACP MUST NEVER EXECUTE");\n');
  const top = cli(root, join(root, 'node_modules/@openai/codex'), '0.159.0', cpu, triple, true);
  const nested = cli(root, join(bridge, 'node_modules/@openai/codex'), '0.153.4', cpu, triple, false);
  t.after(() => { assert.equal(realpathSync(root), resolve(root)); rmSync(root, { recursive: true }); });
  return { root, bridge, top, nested, input: { root, os: 'macos', agent: 'codex', architecture } };
}

for (const architecture of ['arm64', 'x86_64']) {
  test(`discovers both ${architecture} aliases without evaluating wrapper/ACP bytes`, t => {
    const f = fixture(t, architecture);
    const result = discover(f.input);
    assert.equal(result.applies, true);
    assert.deepEqual(result.owners.map(value => value.version), ['0.159.0', '0.153.4']);
    assert.deepEqual(result.owners.map(value => value.platform.alias), Array(2).fill(`@openai/codex-darwin-${architecture === 'arm64' ? 'arm64' : 'x64'}`));
    assert.notEqual(result.owners[0].platform.root, result.owners[1].platform.root);
    assert.notEqual(result.owners[0].voice.contract, result.owners[1].voice.contract);
    assert.equal(result.owners[0].voice.runtimeManifest.path.endsWith('runtime.json'), true);
    assert.equal(result.owners[1].voice.runtimeManifest, null);
    assert.equal(result.provenanceVerified, false);
    assert.equal(result.resourcesReplaced, false);
    assert.equal(result.nativeCodeExecuted, false);
    assert.equal(result.mac13CompatibilityProved, false);
  });
}

const invalid = [
  ['top wrapper version', f => change(f.top.manifest, value => { value.version = '0.160.0'; })],
  ['unreviewed nested version', f => change(f.nested.manifest, value => { value.version = '0.153.3'; })],
  ['wrapper package name', f => change(f.top.manifest, value => { value.name = '@other/codex'; })],
  ['wrapper entrypoint escape', f => change(f.nested.manifest, value => { value.bin.codex = '../../outside.js'; })],
  ['wrong optional alias version', f => change(f.top.manifest, value => { value.optionalDependencies['@openai/codex-darwin-arm64'] = 'npm:@openai/codex@0.153.4-darwin-arm64'; })],
  ['alias manifest name confusion', f => change(f.top.platformManifest, value => { value.name = '@openai/codex-darwin-arm64'; })],
  ['platform version', f => change(f.nested.platformManifest, value => { value.version = '0.159.0-darwin-arm64'; })],
  ['platform architecture', f => change(f.top.platformManifest, value => { value.cpu = ['x64']; })],
  ['platform OS', f => change(f.nested.platformManifest, value => { value.os = ['linux']; })],
  ['incomplete payload identity', f => change(f.top.platformManifest, value => { delete value.files; })],
  ['wrong ACP version', f => change(join(f.bridge, 'package.json'), value => { value.version = '1.11.0'; })],
  ['changed ACP dependency range', f => change(join(f.bridge, 'package.json'), value => { value.dependencies['@openai/codex'] = '^0.159.0'; })],
  ['ACP entrypoint fallback', f => change(join(f.bridge, 'package.json'), value => { value.bin['codex-acp'] = 'dist/other.js'; })],
  ['top local-vendor fallback', f => { renameSync(f.top.platform, `${f.top.platform}-unused`); mkdirSync(join(f.top.directory, 'vendor'), { recursive: true }); }],
  ['nested wrapper hoisted fallback', f => renameSync(f.nested.directory, `${f.nested.directory}-unused`)],
  ['nested platform hoisted wrong-owner fallback', f => renameSync(f.nested.platform, `${f.nested.platform}-unused`)],
  ['missing native CLI slot', f => rmSync(join(f.top.vendor, 'bin/codex'))],
  ['missing nested zsh slot', f => rmSync(join(f.nested.vendor, 'codex-resources/zsh/bin/zsh'))],
  ['missing top voice slot', f => rmSync(join(f.top.vendor, 'codex-resources/voice'), { recursive: true })],
  ['incomplete top voice runtime slot', f => rmSync(join(f.top.vendor, 'codex-resources/voice/runtime.json'))],
  ['incomplete nested voice slot', f => rmSync(join(f.nested.vendor, 'codex-resources/voice/bin/codex-voice-host'))],
  ['resource directory instead of file', f => { const slot = join(f.top.vendor, 'bin/codex'); rmSync(slot); mkdirSync(slot); }],
  ['empty resource slot', f => writeFileSync(join(f.top.vendor, 'codex-resources/zsh/bin/zsh'), '')],
];
for (const [name, mutate] of invalid) test(`refuses ${name}`, t => { const f = fixture(t); mutate(f); assert.throws(() => discover(f.input)); });

test('permits absent nested voice only as an explicit nonreplacement observation', t => {
  const f = fixture(t);
  rmSync(join(f.nested.vendor, 'codex-resources/voice'), { recursive: true });
  const result = discover(f.input);
  assert.equal(result.owners[1].voice.present, false);
  assert.equal(result.owners[0].voice.present, true);
  assert.notEqual(result.owners[0].voice.sourceContract, result.owners[1].voice.sourceContract);
});

test('refuses unknown architecture before filesystem reads', () => assert.throws(() => discover({ root: 'does-not-exist', os: 'macos', agent: 'codex', architecture: 'universal' }), /Architecture/));
test('refuses missing explicit Mac build root', () => assert.throws(() => discover({ os: 'macos', agent: 'codex', architecture: 'arm64' }), /absolute build root/));
test('nonMac and nonCodex require no package reads and remain unchanged', () => {
  for (const [os, agent] of [['linux', 'codex'], ['windows', 'codex'], ['macos', 'claude-code']]) assert.deepEqual(discover({ root: 'missing', architecture: 'unknown', os, agent }), { applies: false, owners: [] });
});

test('refuses a linked platform owner escaping the physical root', t => {
  const f = fixture(t);
  const escaped = realpathSync(mkdtempSync(join(tmpdir(), 'konteks-resource-owner-external-')));
  t.after(() => { assert.equal(realpathSync(escaped), resolve(escaped)); rmSync(escaped, { recursive: true }); });
  renameSync(f.top.platform, join(escaped, 'platform'));
  symlinkSync(join(escaped, 'platform'), f.top.platform, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discover(f.input));
});

test('refuses an internally linked voice owner without claiming compatibility', t => {
  const f = fixture(t);
  const nestedVoice = join(f.nested.vendor, 'codex-resources/voice');
  rmSync(nestedVoice, { recursive: true });
  symlinkSync(join(f.top.vendor, 'codex-resources/voice'), nestedVoice, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discover(f.input), /Linked/);
});

test('refuses a dangling nested voice link rather than reporting resource absence', t => {
  const f = fixture(t);
  const nestedVoice = join(f.nested.vendor, 'codex-resources/voice');
  rmSync(nestedVoice, { recursive: true });
  symlinkSync(join(f.root, 'missing-voice'), nestedVoice, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discover(f.input), /Linked/);
});

test('refuses a hardlinked voice slot shared across callers', t => {
  const f = fixture(t);
  const nestedHelper = join(f.nested.vendor, 'codex-resources/voice/bin/codex-voice-host');
  rmSync(nestedHelper);
  linkSync(join(f.top.vendor, 'codex-resources/voice/bin/codex-voice-host'), nestedHelper);
  assert.throws(() => discover(f.input), /Hard-linked/);
});
