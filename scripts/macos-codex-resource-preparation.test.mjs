/** Synthetic source-bound preparation tests. No native build, shell, wrapper or candidate execution. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { discoverMacCodexResourceOwners } from './macos-codex-resource-owners.mjs';
import { createMacVoiceResourceClosures } from './macos-voice-resource-closure.mjs';

const { dirname, join, resolve } = paths;
const CODEX = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const TREE = 'bee1375c8502e4c4d71db017f7e087dfbb3e775c';
const ZSH = '77045ef899e53b9598bebc5a41db93a548a40ca6';
const SEAL = '96aab48ce7156ecab5343b55836162956e84f5b43fdb34dde8f54766c154be40';
const CPAL = { crate: '6f02e8d0327b42d3e2e4ab2119af397344eb9fc54a34bf0ddeaa1277af8681f1',
  patch: '97f209eb3af032c04f72522cb7f7282f15f6254cce5badffb2c98fffd7c3e4fe',
  candidate: '981f569aeca0a715f4f403fcbd315dd31f50cdd303f4aa789c56ff878e3041ba',
  preparer: 'ad23376b9cb96239ea74c8ab6e45a45b39bedf5c5445a5e2e37c02e47ed3c0fd' };
const PLUGINS = ['app', 'audioconvert', 'audioresample', 'coreelements', 'opus', 'rtp', 'rtpmanager'].map(name => `plugins/libgst${name}.dylib`);
const source = readFileSync(new URL('./macos-codex-resources.mjs', import.meta.url), 'utf8');
const body = source.replace(/^import [^\n]+;\r?\n/gm, '').replace('export async function prepareMacCodexResourceTree', 'async function prepareMacCodexResourceTree');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function put(file, bytes) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: 'wx' }); }
function json(file, value) { put(file, JSON.stringify(value)); }
function row(file, path = file) { return { path, size: statSync(file).size, sha256: sha(readFileSync(file)) }; }
function productRefusal(error) {
  assert.notEqual(error.name, 'ReferenceError', 'Missing VM bindings are fixture defects');
  assert.notEqual(error.name, 'SyntaxError', 'Source transform/parser errors are fixture defects');
  return true;
}
function voice(directory, version) {
  put(join(directory, 'bin/codex-voice-host'), `synthetic old helper ${version}`);
  json(join(directory, 'runtime.json'), { old: version });
}

function owner(directory, version, cpu, triple) {
  const platform = join(dirname(directory), `codex-darwin-${cpu}`);
  json(join(directory, 'package.json'), { name: '@openai/codex', version, bin: { codex: 'bin/codex.js' },
    optionalDependencies: { [`@openai/codex-darwin-${cpu}`]: `npm:@openai/codex@${version}-darwin-${cpu}` } });
  put(join(directory, 'bin/codex.js'), 'throw new Error("SYNTHETIC WRAPPER MUST NEVER EXECUTE");');
  json(join(platform, 'package.json'), { name: '@openai/codex', version: `${version}-darwin-${cpu}`, os: ['darwin'], cpu: [cpu], files: ['vendor'] });
  const vendor = join(platform, 'vendor', triple);
  put(join(vendor, 'bin/codex'), `synthetic unchanged codex ${version}`);
  put(join(vendor, 'codex-resources/zsh/bin/zsh'), `synthetic old zsh ${version}`);
  voice(join(vendor, 'codex-resources/voice'), version);
  return { directory, platform, vendor, zsh: join(vendor, 'codex-resources/zsh/bin/zsh'),
    helper: join(vendor, 'codex-resources/voice/bin/codex-voice-host') };
}

function fixture(t, architecture = 'arm64') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'konteks-resource-preparation-fixture-')));
  const root = join(directory, 'package'), runner = join(directory, 'runner');
  mkdirSync(root); mkdirSync(runner);
  const cpu = architecture === 'arm64' ? 'arm64' : 'x64';
  const triple = architecture === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const bridge = join(root, 'node_modules/@agentclientprotocol/codex-acp');
  json(join(bridge, 'package.json'), { name: '@agentclientprotocol/codex-acp', version: '1.10.0', bin: { 'codex-acp': 'dist/index.js' }, dependencies: { '@openai/codex': '^0.153.3' } });
  put(join(bridge, 'dist/index.js'), 'throw new Error("SYNTHETIC ACP MUST NEVER EXECUTE");');
  const top = owner(join(root, 'node_modules/@openai/codex'), '0.159.0', cpu, triple);
  const nested = owner(join(bridge, 'node_modules/@openai/codex'), '0.153.4', cpu, triple);
  t.after(() => { assert.equal(realpathSync(directory), resolve(directory)); rmSync(directory, { recursive: true }); });
  return { directory, root, runner, top, nested, architecture, triple, input: { root, os: 'macos', agent: 'codex', architecture }, calls: [] };
}

function compilerInput(f) {
  return { actionKey: 'a'.repeat(64), argumentsSha256: 'b'.repeat(64), loopbackSha256: CPAL.candidate,
    materializedRelativePath: 'external/synthetic_cpal/src/host/coreaudio/macos/loopback.rs', crateVersion: '0.18.2',
    target: f.triple, candidateOnly: true, shippingReplacementApproved: false };
}

function candidateFiles(f, work) {
  const zsh = join(work, 'candidate/zsh/zsh'), directory = join(work, 'candidate/codex-resources/voice');
  put(zsh, 'synthetic rebuilt patched zsh');
  put(join(directory, 'bin/codex-voice-host'), Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('synthetic rebuilt helper')]));
  const libraries = ['lib/libgio-2.0.0.dylib', ...PLUGINS].map(path => {
    const file = join(directory, path); put(file, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(`synthetic dylib ${path}`)]));
    const sha256 = row(file).sha256;
    return { path, sourcePath: `synthetic-source/${path}`, sourceSha256: sha256, sha256, imports: ['/usr/lib/libSystem.B.dylib'] };
  });
  const sourceManifest = join(work, 'voice-source-provenance/sources.json'), inventory = join(work, 'voice-source-provenance/binaries.json');
  json(sourceManifest, { synthetic: true, commit: CODEX });
  json(inventory, libraries.map(value => ({ path: value.sourcePath, target: f.triple, sha256: value.sourceSha256 })));
  const manifest = { schemaVersion: 1, target: f.triple, sourceCommit: CODEX, developmentOnly: false,
    distribution: 'publicRelease', sourceManifestSha256: row(sourceManifest).sha256, inventorySha256: row(inventory).sha256,
    libraries, plugins: PLUGINS };
  json(join(directory, 'runtime.json'), manifest);
  const members = ['runtime.json', 'bin/codex-voice-host', ...libraries.map(value => value.path)].map(path => row(join(directory, path), path));
  return { zsh: row(zsh), voice: { directory, members }, provenance: { sourceManifest: row(sourceManifest), inventory: row(inventory) } };
}

function candidateReceipt(f, work, outputs) {
  const native = [{ ...outputs.zsh, path: 'zsh/zsh' }, ...outputs.voice.members.filter(value => value.path !== 'runtime.json')
    .map(value => ({ ...value, path: `codex-resources/voice/${value.path}` }))];
  const input = compilerInput(f);
  return { schema: 1, architecture: f.architecture === 'amd64' ? 'x64' : 'arm64', target: f.triple, candidateOnly: true,
    buildAndProbeCompleted: true, acceptancePassed: false, macOS13ExecutionProved: false, shippingReplacementApproved: false,
    publisherTrustProved: false, developerIdUsed: false, notarizationUsed: false,
    sourcePins: { codex: { commit: CODEX, tree: TREE }, zsh: { commit: ZSH } }, workDirectory: work,
    candidateMeetsMeasuredFloor: true, candidateLoaderClosureResolved: true, selectedNewerAPIImportsAllWeak: true,
    voiceBuild: { cpalCandidate: { compilerInputStable: true, compilerInputBefore: input, compilerInputAfter: { ...input },
      preparation: { upstreamCommit: CODEX, upstreamTree: TREE, crateVersion: '0.18.2', crateSha256: CPAL.crate,
        patchSha256: CPAL.patch, candidateLoopbackSha256: CPAL.candidate, originalRuntimePreparerSha256: CPAL.preparer,
        inventoryPreservation: { rawBytesOnly: true, noInspectionAlgorithmChange: true } } } },
    voiceSeal: { normalPinnedSealCompleted: true, sourceSha256: SEAL }, voiceRelocation: relocationReceipt(f, outputs), protocol: { exitedZero: true },
    zshSmoke: { execWrapperObserved: true, outputMatched: true }, outputs,
    inspection: { binaries: native.map(value => ({ ...value, minimumAtMost13: true,
      imports: value.path.endsWith('/bin/codex-voice-host') ? helperImports() : [],
      rpaths: value.path.endsWith('/bin/codex-voice-host') ? ['@loader_path/../lib'] : [] })) },
    nativeSignatures: native.map(value => ({ path: value.path, result: { existingSignatureUsable: true,
      adHocAddedByProbe: false, publisherTrustProved: false } })) };
}

function helperImports() { return [{ kind: 'LC_LOAD_DYLIB', name: '/usr/lib/libSystem.B.dylib' },
  { kind: 'LC_LOAD_DYLIB', name: '@rpath/libgio-2.0.0.dylib' }]; }

function relocationReceipt(f, outputs) {
  const prefix = f.architecture === 'amd64' ? 'macos_x86_64' : 'macos_aarch64';
  const directory = `_solib_synthetic/voice/native_link_${prefix}`;
  const label = `//third_party/voice:native_link_${prefix}`;
  const staleRpath = `@loader_path/../../${directory}`;
  const helper = outputs.voice.members.find(value => value.path === 'bin/codex-voice-host');
  return { source: { commit: CODEX, tree: TREE,
    build: { member: 'third_party/voice/BUILD.bazel', size: 100, sha256: '80e56372c8b9027e5afc4de644f4b923dbb3570ef445f25ec9860c80d4223c61',
      anchorSha256: sha('name = "native_link_" + os + "_" + cpu,') },
    nativeLink: { member: 'third_party/voice/native_link.bzl', size: 100, sha256: '38736a14a8975ef5a15779b87f31093b706e0dcfe44213ba86a9e7d1935d369c',
      anchorSha256: sha('dynamic_library_symlink_path = "voice/" + ctx.label.name + "/" + filename,') } },
    action: { graphSha256: sha('synthetic SolibSymlink graph'), targetLabel: label,
      outputs: [{ actionKey: 'c'.repeat(64), targetLabel: label,
        outputPath: `bazel-out/synthetic/bin/${directory}/libgio-2.0.0.dylib`, directory }], staleRpath },
    before: { imports: helperImports(), rpaths: [staleRpath, '@loader_path/../lib'] },
    after: { imports: helperImports(), rpaths: ['@loader_path/../lib'] },
    input: { size: 100, sha256: sha('synthetic before relocation') }, output: { size: 100, sha256: sha('synthetic after relocation before signing') },
    deletedRpath: staleRpath, fixedTool: '/usr/bin/install_name_tool', importsUnchanged: true, publisherTrustProved: false,
    signedHelper: { size: helper.size, sha256: helper.sha256, signature: { existingSignatureUsable: false, adHocAddedByProbe: true, publisherTrustProved: false } } };
}

function prepare(f, change = () => {}) {
  const build = async input => {
    f.calls.push(input);
    const work = join(f.runner, `codex-mac13-build-${randomUUID()}`); mkdirSync(work);
    const outputs = candidateFiles(f, work), receipt = candidateReceipt(f, work, outputs);
    const context = { f, input, work, outputs, receipt, retained: receipt };
    await change(context);
    json(join(input.output, 'receipt.json'), context.retained);
    return receipt;
  };
  return runInNewContext(`${body}\nprepareMacCodexResourceTree`, { ...fs, ...paths, constants, createHash, randomUUID,
    process: { env: { RUNNER_TEMP: f.runner } }, discoverMacCodexResourceOwners, buildMac13ResourceCandidate: build });
}

for (const architecture of ['arm64', 'amd64']) {
  test(`prepares ${architecture} two independent zsh files and only the top voice closure`, async t => {
    const f = fixture(t, architecture);
    const originalCodex = readFileSync(join(f.top.vendor, 'bin/codex'));
    const nestedHelper = readFileSync(f.nested.helper);
    const result = await prepare(f)(f.input);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].architecture, architecture === 'amd64' ? 'x64' : 'arm64');
    assert.equal(readFileSync(f.top.zsh, 'utf8'), 'synthetic rebuilt patched zsh');
    assert.deepEqual(readFileSync(f.nested.zsh), readFileSync(f.top.zsh));
    assert.equal(statSync(f.top.zsh).nlink, 1); assert.equal(statSync(f.nested.zsh).nlink, 1);
    assert.notEqual(statSync(f.top.zsh).ino, statSync(f.nested.zsh).ino);
    assert.equal(readFileSync(f.top.helper).subarray(4).toString('utf8'), 'synthetic rebuilt helper');
    assert.deepEqual(readFileSync(f.nested.helper), nestedHelper);
    assert.deepEqual(readFileSync(join(f.top.vendor, 'bin/codex')), originalCodex);
    const closure = result.resourceClosures[0];
    assert.equal(closure.sourceCommit, CODEX); assert.equal(closure.nativeMembers.length, 9);
    for (const entry of [closure.sourceManifest, closure.inventory]) assert.equal(sha(readFileSync(join(f.root, entry.path))), entry.sha256);
    const proof = JSON.parse(readFileSync(join(f.root, 'konteks/macos-codex-resource-provenance.json'), 'utf8'));
    assert.equal(proof.publisherTrustProved, false); assert.equal(proof.macOS13ExecutionProved, false);
    assert.equal(sha(readFileSync(join(f.runner, proof.builderReceipt.path))), proof.builderReceipt.sha256);
    assert.equal(proof.inputFiles.some(value => value.path.endsWith('/bin/codex')), true);
  });
}

const refused = [
  ['failed build', c => { c.receipt.buildAndProbeCompleted = false; }],
  ['wrong coordinate', c => { c.receipt.target = 'x86_64-apple-darwin'; }],
  ['wrong source', c => { c.receipt.sourcePins.codex.commit = '0'.repeat(40); }],
  ['wrong zsh source', c => { c.receipt.sourcePins.zsh.commit = '0'.repeat(40); }],
  ['unproved authority', c => { c.receipt.publisherTrustProved = true; }],
  ['missing actual compiler input', c => { c.receipt.voiceBuild.cpalCandidate.compilerInputStable = false; }],
  ['wrong CPAL patch', c => { c.receipt.voiceBuild.cpalCandidate.preparation.patchSha256 = '0'.repeat(64); }],
  ['changed compiler action', c => { c.receipt.voiceBuild.cpalCandidate.compilerInputAfter.actionKey = 'c'.repeat(64); }],
  ['reconstructed inventory', c => { c.receipt.voiceBuild.cpalCandidate.preparation.inventoryPreservation.rawBytesOnly = false; }],
  ['missing normal seal', c => { c.receipt.voiceSeal.normalPinnedSealCompleted = false; }],
  ['unresolved imports', c => { c.receipt.candidateLoaderClosureResolved = false; }],
  ['missing EXEC_WRAPPER smoke', c => { c.receipt.zshSmoke.execWrapperObserved = false; }],
  ['missing signature', c => { c.receipt.nativeSignatures.pop(); }],
  ['changed inspection digest', c => { c.receipt.inspection.binaries[0].sha256 = '0'.repeat(64); }],
  ['output byte drift', c => { writeFileSync(c.outputs.zsh.path, 'changed after measurement'); }],
  ['output path escape', c => { c.outputs.zsh.path = c.f.top.zsh; }],
  ['undeclared voice member', c => { put(join(c.outputs.voice.directory, 'extra.txt'), 'undeclared'); }],
  ['duplicate voice member', c => { c.outputs.voice.members.push({ ...c.outputs.voice.members[0] }); }],
  ['inventory byte drift', c => { writeFileSync(c.outputs.provenance.inventory.path, 'changed'); }],
  ['source inventory hash mismatch', c => { changeManifest(c, value => { value.inventorySha256 = '0'.repeat(64); }); }],
  ['sealed library hash mismatch', c => { changeManifest(c, value => { value.libraries[0].sha256 = '0'.repeat(64); }); }],
  ['changed caller during build', c => { writeFileSync(join(c.f.top.vendor, 'bin/codex'), 'changed caller'); }],
  ['owner version drift', c => { writeFileSync(join(c.f.nested.directory, 'package.json'), '{}'); }],
  ['returned/retained receipt mismatch', c => { c.retained = { ...c.receipt, buildAndProbeCompleted: false }; }],
  ['hardlinked rebuilt zsh', c => { linkSync(c.outputs.zsh.path, join(c.work, 'same-inode')); }],
  ['relocation evidence missing', c => { delete c.receipt.voiceRelocation; }],
  ['relocation source drift', c => { c.receipt.voiceRelocation.source.nativeLink.sha256 = '0'.repeat(64); }],
  ['relocation signed helper drift', c => { c.receipt.voiceRelocation.signedHelper.sha256 = '0'.repeat(64); }],
  ['relocation action owner drift', c => { c.receipt.voiceRelocation.action.outputs[0].targetLabel = '//third_party/voice:unreviewed'; }],
  ['relocation changed imports', c => { c.receipt.voiceRelocation.after.imports.pop(); }],
  ['relocation stale rpath retained', c => { c.receipt.voiceRelocation.after.rpaths.push(c.receipt.voiceRelocation.deletedRpath); }],
  ['relocation final inspection rpath drift', c => { c.receipt.inspection.binaries.find(value => value.path.endsWith('/bin/codex-voice-host')).rpaths = []; }],
];

function changeManifest(c, change) {
  const file = join(c.outputs.voice.directory, 'runtime.json');
  const value = JSON.parse(readFileSync(file, 'utf8')); change(value); writeFileSync(file, JSON.stringify(value));
  c.outputs.voice.members[c.outputs.voice.members.findIndex(value => value.path === 'runtime.json')] = row(file, 'runtime.json');
}

for (const [name, change] of refused) test(`refuses ${name} without publishing package provenance`, async t => {
  const f = fixture(t);
  await assert.rejects(prepare(f, change)(f.input), productRefusal);
  assert.equal(existsSync(join(f.root, 'konteks/macos-codex-resource-provenance.json')), false);
});

test('refuses linked candidate output before copying resources', async t => {
  const f = fixture(t);
  await assert.rejects(prepare(f, async c => {
    const original = c.outputs.voice.directory, other = join(c.work, 'other');
    await fs.rename(original, other);
    symlinkSync(other, original, process.platform === 'win32' ? 'junction' : 'dir');
  })(f.input), productRefusal);
  assert.equal(readFileSync(f.top.zsh, 'utf8'), 'synthetic old zsh 0.159.0');
});

test('nonMac and nonCodex return before filesystem reads or build', async () => {
  const f = { runner: 'does-not-exist', calls: [] };
  const run = prepare(f);
  for (const [os, agent] of [['debian', 'codex'], ['windows', 'codex'], ['macos', 'claude-code']]) {
    const result = await run({ os, agent, root: 'missing', architecture: 'unknown' });
    assert.equal(result.applies, false); assert.equal(result.resourceClosures.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('rejects unreviewed architecture and extra inputs before building', async t => {
  const f = fixture(t), run = prepare(f);
  await assert.rejects(run({ ...f.input, architecture: 'universal' }));
  await assert.rejects(run({ ...f.input, arbitraryMode: true }));
  assert.equal(f.calls.length, 0);
});

test('the one builder attempt uses the fixed retained workflow evidence output', async t => {
  const f = fixture(t);
  await prepare(f)(f.input);
  assert.equal(f.calls[0].output, join(f.runner, 'mac13-resource-probe-evidence'));
});

test('existing workflow evidence refuses before a second builder attempt', async t => {
  const f = fixture(t);
  mkdirSync(join(f.runner, 'mac13-resource-probe-evidence'));
  await assert.rejects(prepare(f)(f.input), /output already exists/);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(f.root, 'konteks/macos-codex-resource-provenance.json')), false);
});

test('prepared descriptor and raw inventory are accepted by the actual closed voice guard', async t => {
  const f = fixture(t);
  const result = await prepare(f)(f.input);
  const closures = createMacVoiceResourceClosures(f.root, result.resourceClosures, f.architecture);
  assert.equal(closures.length, 1);
  assert.equal(closures[0].members.size, 9);
  assert.equal(closures[0].descriptor.inventory.path, 'konteks/macos-codex-resource-inputs/binaries.json');
  // This calls the actual structural/digest guard only; synthetic magic is not a native compatibility proof.
  assert.equal(closures[0].inspected.size, 0);
});
