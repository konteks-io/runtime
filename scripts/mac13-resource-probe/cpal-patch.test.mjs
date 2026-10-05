/** Source-bound candidate preparation tests. All process/filesystem boundaries are synthetic. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { assertStableCpalCompilerInput, prepareCpalAvailabilityCandidate, verifyCpalCompilerInput } from './cpal-patch.mjs';
import { sha256 } from './inspect-candidate.mjs';

const probe = readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8');
const commit = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const tree = 'bee1375c8502e4c4d71db017f7e087dfbb3e775c';
const fixtures = new URL('../fixtures/cpal-0.18.2-availability/', import.meta.url);

function productionFunction(start, end) {
  const begin = probe.indexOf(start);
  const finish = probe.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, 'actual candidate function boundary changed');
  return probe.slice(begin, finish);
}

function fixtureContext() {
  return { work: resolve('synthetic-candidate-work'), output: resolve('synthetic-candidate-output'),
    stage: 'build', coordinate: { target: 'aarch64-apple-darwin', prefix: 'macos_aarch64' } };
}

function buildVoiceFixture() {
  const calls = [];
  const context = fixtureContext();
  const codex = { directory: resolve('synthetic-codex-source'), head: commit };
  const input = { actionKey: 'synthetic-cpal-action', loopbackSha256: 'synthetic-candidate-hash' };
  const sandbox = {
    join, constants: { COPYFILE_EXCL: 1 }, LOCK_CHECK: 'synthetic-lock-comparison',
    copyFile: async () => undefined, sha256: async () => 'synthetic-lock-hash',
    run: async (_, label) => { calls.push(label); return label === 'tool-bazel' ? 'Build label: 9.0.0' : ''; },
    assert: (value, message) => assert.ok(value, message),
    prepareCpalAvailabilityCandidate: async () => { calls.push('cpal-prepare'); return { candidateOnly: true }; },
    voiceBuildOptions: () => [],
    cpalCompilerInput: async () => { calls.push('cpal-compiler-input'); return input; },
    assertStableCpalCompilerInput: () => calls.push('cpal-input-stable'),
  };
  const source = productionFunction('async function buildVoice(context, codex)', '\nasync function stageVoice(');
  const build = runInNewContext(`${source}; buildVoice`, sandbox, { timeout: 1_000 });
  return { calls, context, codex, build };
}

test('candidate CPAL preparation precedes the actual cargo and Bazel build path', async () => {
  const f = buildVoiceFixture();
  await f.build(f.context, f.codex);
  const prepare = f.calls.indexOf('cpal-prepare');
  assert.ok(prepare >= 0, 'actual candidate probe currently compiles unpatched CPAL');
  assert.ok(prepare < f.calls.indexOf('cargo-workspace-refresh'));
  assert.ok(prepare < f.calls.indexOf('voice-build'));
});

test('candidate build completion retains CPAL compiler-input proof before and after compilation', async () => {
  const f = buildVoiceFixture();
  const result = await f.build(f.context, f.codex);
  const indices = f.calls.flatMap((label, index) => label === 'cpal-compiler-input' ? [index] : []);
  assert.equal(indices.length, 2, 'materialized source and effective compiler action are not currently attested');
  const build = f.calls.indexOf('voice-build');
  assert.ok(indices[0] < build && build < indices[1]);
  assert.ok(f.calls.includes('cpal-input-stable'));
  assert.equal(result.cpalCandidate.compilerInputStable, true);
});

function candidateFixture() {
  const context = fixtureContext();
  const stages = [];
  const calls = [];
  const codex = { directory: resolve('synthetic-codex-source') };
  const sandbox = {
    join, CODEX: { commit }, ZSH: { commit: 'synthetic-zsh-pin' }, HERE: resolve('synthetic-probe-source'), GST: {},
    mkdir: async () => undefined, checkout: async () => ({ directory: resolve('synthetic-zsh-source'), tree: 'synthetic-zsh-tree' }),
    run: async (_, label) => { calls.push(label); return label === 'helper-build-commit' ? commit : ''; },
    developmentSignature: async () => ({ developmentOnly: true }), zshSmoke: async () => ({ synthetic: true }),
    buildVoice: async () => ({ synthetic: true }), stageVoice: async () => ({ executable: resolve('synthetic-helper-not-executed'), relocation: { synthetic: true } }),
    lstat: async () => ({ size: 1 }), sha256: async () => 'synthetic-helper-hash',
    assert: (value, message) => assert.ok(value, message),
    reportCandidateStage: (owner, stage) => { owner.stage = stage; stages.push(stage); },
  };
  const source = productionFunction('async function candidates(context, codex)', '\nasync function body(');
  const build = runInNewContext(`${source}; candidates`, sandbox, { timeout: 1_000 });
  return { context, stages, calls, codex, build };
}

test('actual candidate staging never executes the helper before the complete native inspection', async () => {
  const f = candidateFixture();
  await f.build(f.context, f.codex);
  assert.equal(f.calls.includes('helper-build-commit'), false, 'current staging executes the helper before loader closure measurement');
});

for (const field of ['privateImportsResolved', 'allMinimumsAtMost13', 'selectedNewerAPIImportsAllWeak']) {
  test(`actual body refuses ${field}=false before every helper execution and retains measurements`, async () => {
    const calls = [];
    const context = fixtureContext();
    const inspection = { privateImportsResolved: true, allMinimumsAtMost13: true, selectedNewerAPIImportsAllWeak: true, [field]: false };
    const source = productionFunction('async function body(context)', '\nexport async function buildMac13ResourceCandidate(');
    const body = runInNewContext(`${source}; body`, {
      toolchain: async () => ({}), codexSource: async () => ({}), CODEX: { commit }, ZSH: {},
      candidates: async () => ({ helper: 'synthetic-never-executed', zsh: {} }),
      inspect: async () => inspection, candidateNativeSignatures: async () => [],
      reportCandidateStage: () => undefined,
      run: async () => { calls.push('execute'); return commit; },
      handshake: async () => { calls.push('handshake'); return {}; },
      sealCandidateVoice: async () => { calls.push('seal'); return { outputs: {}, seal: {} }; },
      assert: (value, message) => assert.ok(value, message),
    });
    await assert.rejects(body(context), /candidate (?:loader|native|selected)/);
    assert.deepEqual(calls, []);
    assert.equal(context.measurements.inspection[field], false);
  });
}

test('actual development stage relocates the copied helper before exposing it for signature or execution', async () => {
  const calls = [];
  const context = fixtureContext();
  const source = productionFunction('async function stageVoice(', '\nasync function developmentSignature(');
  const stage = runInNewContext(`${source}; stageVoice`, {
    join, dirname: value => join(value, '..'), constants, CODEX: { commit },
    mkdir: async () => undefined,
    run: async (_, label) => { calls.push(label); return ''; },
    boundedText: async () => JSON.stringify({ schemaVersion: 1, developmentOnly: true,
      target: context.coordinate.target, sourceCommit: commit, sourceManifestSha256: 'synthetic-source-manifest' }),
    sha256: async () => 'synthetic-source-manifest',
    assert: (value, message) => assert.ok(value, message),
    copyFile: async () => calls.push('helper-copy'), chmod: async () => calls.push('helper-mode'),
    relocateVoiceHelper: async () => { calls.push('helper-relocation'); return { synthetic: true }; },
    voiceBuildOptions: () => [],
  });
  await stage(context, { directory: resolve('synthetic-reviewed-checkout') }, join(context.work, 'candidate'));
  assert.deepEqual(calls, ['voice-stage-development', 'helper-copy', 'helper-mode', 'helper-relocation'],
    'actual stage currently exposes the Bazel helper with its escaped build-host rpath');
});

test('candidate emits fixed zsh and voice stage progress before those real build seams', async () => {
  const f = candidateFixture();
  await f.build(f.context, f.codex);
  assert.deepEqual(f.stages, ['zsh-build', 'voice-build']);
});

test('candidate emits fixed inspection and handshake progress without paths or commands', async () => {
  const context = fixtureContext();
  const stages = [];
  const sandbox = {
    toolchain: async () => ({ os: 'synthetic-macos' }), codexSource: async () => ({ synthetic: true }),
    candidates: async () => ({ candidate: 'synthetic-candidate', helper: 'synthetic-helper', zsh: { tree: 'synthetic-zsh' } }),
    candidateOutputs: async () => ({ synthetic: true }),
    candidateNativeSignatures: async () => [], sealCandidateVoice: async () => ({ outputs: { synthetic: true }, seal: { synthetic: true } }),
    inspect: async () => ({ allMinimumsAtMost13: true, privateImportsResolved: true, selectedNewerAPIImportsAllWeak: true }),
    handshake: async () => ({ synthetic: true }), run: async () => commit, GST: {},
    CODEX: { commit }, ZSH: { commit: 'synthetic-zsh-pin' },
    assert: (value, message) => assert.ok(value, message),
    reportCandidateStage: (owner, stage) => { owner.stage = stage; stages.push(stage); },
  };
  const source = productionFunction('async function body(context)', '\nexport async function buildMac13ResourceCandidate(');
  const body = runInNewContext(`${source}; body`, sandbox, { timeout: 1_000 });
  await body(context);
  assert.deepEqual(stages, ['inspect', 'handshake']);
});

async function ownedFixture(body) {
  const temporary = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporary, 'konteks-cpal-source-test-')));
  try { return await body(root); } finally {
    const local = relative(temporary, root);
    assert.ok(isAbsolute(root) && !isAbsolute(local) && local.startsWith('konteks-cpal-source-test-') && !local.includes('..'));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  }
}

async function upstreamFixture(root) {
  await mkdir(join(root, 'patches'));
  await mkdir(join(root, 'codex-rs'));
  await mkdir(join(root, 'third_party/voice'), { recursive: true });
  for (const [from, to] of [['MODULE.bazel', 'MODULE.bazel'], ['Cargo.lock', 'codex-rs/Cargo.lock'], ['patches.BUILD.bazel', 'patches/BUILD.bazel'], ['prepare_built_runtime.py', 'third_party/voice/prepare_built_runtime.py']]) {
    await copyFile(new URL(from, fixtures), join(root, to));
  }
  return { directory: root, head: commit, tree };
}

test('exact primary source inputs add only the version-filtered Bazel annotation and patch export', () => ownedFixture(async root => {
  const codex = await upstreamFixture(root);
  const originalLock = await readFile(join(root, 'codex-rs/Cargo.lock'));
  const prepared = await prepareCpalAvailabilityCandidate(codex);
  const module = await readFile(join(root, 'MODULE.bazel'), 'utf8');
  assert.match(module, /crate = "cpal",\n    version = "0[.]18[.]2",\n    repositories = \["crates"\]/);
  assert.equal(module.split('crate = "cpal"').length, 2);
  assert.match(await readFile(join(root, 'patches/BUILD.bazel'), 'utf8'), /^exports_files\(\[\n    "konteks_cpal_process_tap_availability[.]patch",/);
  assert.deepEqual(await readFile(join(root, 'codex-rs/Cargo.lock')), originalLock);
  assert.deepEqual(await readFile(join(root, 'patches/konteks_cpal_process_tap_availability.patch')), await readFile(new URL('process-tap.patch', fixtures)));
  assert.equal(prepared.upstreamCommit, commit);
  assert.equal(prepared.cargoDependencyChanges, false);
  assert.equal(prepared.shippingReplacementApproved, false);
  assert.equal(prepared.inventoryPreservation.rawBytesOnly, true);
  const modifiedPreparer = await readFile(join(root, 'third_party/voice/prepare_built_runtime.py'), 'utf8');
  assert.match(modifiedPreparer, /platform[.]project\(prefix, receipts, target, output\)\n        with \(output \/ "konteks-source-inventory[.]json"\)[.]open\("xb"\) as preserved:\n            preserved[.]write\(\(receipts \/ "inspection\/binaries[.]json"\)[.]read_bytes\(\)\)/);
}));

for (const file of ['MODULE.bazel', 'patches/BUILD.bazel', 'codex-rs/Cargo.lock', 'third_party/voice/prepare_built_runtime.py']) {
  test(`altered exact source ${file} refuses before any patch or source mutation`, () => ownedFixture(async root => {
    const codex = await upstreamFixture(root);
    await writeFile(join(root, file), 'synthetic unreviewed source\n');
    const before = await readFile(join(root, 'MODULE.bazel'));
    await assert.rejects(prepareCpalAvailabilityCandidate(codex), /requires review/);
    assert.deepEqual(await readFile(join(root, 'MODULE.bazel')), before);
    await assert.rejects(readFile(join(root, 'patches/konteks_cpal_process_tap_availability.patch')), { code: 'ENOENT' });
  }));
}

test('wrong Codex commit and preexisting patch refuse without changing the pinned source', () => ownedFixture(async root => {
  const codex = await upstreamFixture(root);
  const before = await readFile(join(root, 'MODULE.bazel'));
  await assert.rejects(prepareCpalAvailabilityCandidate({ ...codex, head: 'f'.repeat(40) }), /exact reviewed Codex/);
  await writeFile(join(root, 'patches/konteks_cpal_process_tap_availability.patch'), 'synthetic existing patch');
  await assert.rejects(prepareCpalAvailabilityCandidate(codex), /already exists/);
  assert.deepEqual(await readFile(join(root, 'MODULE.bazel')), before);
}));

function syntheticGraph(target = 'aarch64-apple-darwin') {
  const segments = 'external/crates+cpal-0.18.2/src/host/coreaudio/macos/loopback.rs'.split('/');
  return { actions: [{ actionKey: 'a'.repeat(64), mnemonic: 'Rustc', targetId: '1', inputDepSetIds: ['1'],
    arguments: ['rustc', '--crate-name', 'cpal', '--target', target] }],
  targets: [{ id: '1', label: '@@crates+cpal-0.18.2//:cpal' }],
  artifacts: [{ id: '1', pathFragmentId: String(segments.length) }],
  pathFragments: segments.map((label, index) => ({ id: String(index + 1), label, parentId: String(index) })),
  depSetOfFiles: [{ id: '1', transitiveDepSetIds: ['2'] }, { id: '2', directArtifactIds: ['1'] }] };
}

async function compilerFixture(root, graph = syntheticGraph()) {
  const outputBase = join(root, 'bazel/output-base');
  const member = join(outputBase, 'external/crates+cpal-0.18.2/src/host/coreaudio/macos/loopback.rs');
  await mkdir(join(member, '..'), { recursive: true });
  await copyFile(new URL('loopback.candidate.rs', fixtures), member);
  await copyFile(new URL('Cargo.toml', fixtures), join(outputBase, 'external/crates+cpal-0.18.2/Cargo.toml'));
  return { text: JSON.stringify(graph), work: root, outputBase, target: 'aarch64-apple-darwin', member };
}

for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
  test(`synthetic ${target} effective Rustc transitive closure is bound to exact candidate bytes`, () => ownedFixture(async root => {
    const input = await compilerFixture(root, syntheticGraph(target));
    const result = await verifyCpalCompilerInput({ ...input, target });
    assert.equal(result.loopbackSha256, '981f569aeca0a715f4f403fcbd315dd31f50cdd303f4aa789c56ff878e3041ba');
    assert.equal(result.target, target);
    assert.equal(result.candidateOnly, true);
    assert.equal(result.shippingReplacementApproved, false);
    assertStableCpalCompilerInput(result, { ...result });
    assert.throws(() => assertStableCpalCompilerInput(result, { ...result, actionKey: 'b'.repeat(64) }), /changed across the build/);
  }));
}

const graphRefusals = [
  ['source present only outside the effective closure', graph => { graph.depSetOfFiles[1].directArtifactIds = []; }, /one exact compiler input/],
  ['wrong Rustc crate', graph => { graph.actions[0].arguments[2] = 'another_crate'; }, /crate or target/],
  ['wrong Rustc target', graph => { graph.actions[0].arguments[4] = 'x86_64-apple-darwin'; }, /crate or target/],
  ['another repository owns the action', graph => { graph.targets[0].label = '@@another//:cpal'; }, /another repository/],
  ['ambiguous effective action', graph => { graph.actions.push({ ...graph.actions[0] }); }, /ambiguous/],
  ['traversal fragment', graph => { graph.pathFragments[1].label = '..'; }, /path segment/],
  ['duplicate graph identity', graph => { graph.artifacts.push({ ...graph.artifacts[0] }); }, /duplicate ids/],
  ['missing input set', graph => { graph.actions[0].inputDepSetIds = ['3']; }, /reference is missing/],
];
for (const [name, mutate, error] of graphRefusals) {
  test(`synthetic CPAL compiler proof refuses ${name}`, () => ownedFixture(async root => {
    const graph = syntheticGraph();
    mutate(graph);
    await assert.rejects(verifyCpalCompilerInput(await compilerFixture(root, graph)), error);
  }));
}

test('effective source hash mismatch refuses even when a different cache file has the reviewed bytes', () => ownedFixture(async root => {
  const input = await compilerFixture(root);
  await copyFile(input.member, join(root, 'unrelated-matching-cache.rs'));
  await writeFile(input.member, 'synthetic unpatched compiler source');
  await assert.rejects(verifyCpalCompilerInput(input), /effective compiler source differs/);
}));

test('synthetic effective Rustc options can come only from its exact declared parameter file', () => ownedFixture(async root => {
  const graph = syntheticGraph();
  graph.actions[0].paramFiles = [{ execPath: 'synthetic/cpal.params', arguments: graph.actions[0].arguments.slice(1) }];
  graph.actions[0].arguments = ['rustc', '@synthetic/cpal.params'];
  const input = await compilerFixture(root, graph);
  assert.equal((await verifyCpalCompilerInput(input)).target, input.target);
  graph.actions[0].paramFiles[0].execPath = 'synthetic/unreferenced.params';
  await assert.rejects(verifyCpalCompilerInput({ ...input, text: JSON.stringify(graph) }), /parameter file is unbound/);
}));

test('materialized linked repository refuses before compiler-input hash authority', () => ownedFixture(async root => {
  const input = await compilerFixture(root);
  const actual = join(input.outputBase, 'external/crates+cpal-0.18.2');
  const moved = join(input.outputBase, 'external/source-copy');
  await mkdir(moved);
  await symlink(moved, join(input.outputBase, 'external/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const graph = syntheticGraph();
  graph.pathFragments[1].label = 'linked';
  graph.targets[0].label = '@@linked//:cpal';
  await mkdir(join(moved, 'src/host/coreaudio/macos'), { recursive: true });
  await copyFile(join(actual, 'src/host/coreaudio/macos/loopback.rs'), join(moved, 'src/host/coreaudio/macos/loopback.rs'));
  await copyFile(new URL('Cargo.toml', fixtures), join(moved, 'Cargo.toml'));
  await assert.rejects(verifyCpalCompilerInput({ ...input, text: JSON.stringify(graph) }), /source path is linked/);
}));

test('actual compiler-query seam has finite bounds and shares the build configuration', async () => {
  const calls = [];
  const context = fixtureContext();
  const source = productionFunction('async function cpalCompilerInput(', '\nasync function buildVoice(');
  const query = runInNewContext(`${source}; cpalCompilerInput`, { join,
    run: async (_, label, executable, args, seconds) => { calls.push({ label, executable, args: Array.from(args), seconds }); return label === 'cpal-output-base' ? join(context.work, 'bazel/output') : '{}'; },
    voiceBuildOptions: () => ['-c', 'opt', '--macos_minimum_os=13.0', '--remote_cache='],
    verifyCpalCompilerInput: async input => ({ synthetic: true, ...input }),
  });
  const result = await query(context, { directory: 'synthetic-checkout' }, ['--batch']);
  assert.equal(calls[0].seconds, 120);
  assert.equal(calls[1].seconds, 300);
  assert.ok(calls[1].args.includes('--include_param_files'));
  assert.ok(calls[1].args.includes('--macos_minimum_os=13.0'));
  assert.match(calls[1].args.at(-1), /deps\(\/\/codex-rs\/voice-host:codex-voice-host\)/);
  assert.equal(result.target, context.coordinate.target);
});

test('materialized CPAL manifest must remain the exact authenticated version and dependency metadata', () => ownedFixture(async root => {
  const input = await compilerFixture(root);
  await writeFile(join(input.outputBase, 'external/crates+cpal-0.18.2/Cargo.toml'), '[package]\nname="cpal"\nversion="unreviewed"\n');
  await assert.rejects(verifyCpalCompilerInput(input), /requires review/);
}));

test('actual fixed seal uses exact source and target after development layout, then inventories sealed output', async () => {
  const context = fixtureContext();
  const calls = [];
  let read = 0;
  const source = productionFunction('async function sealCandidateVoice(', '\nasync function candidateNativeSignatures(');
  const seal = runInNewContext(`${source}; sealCandidateVoice`, { join,
    voiceManifest: async () => { calls.push('manifest'); return { developmentOnly: read++ === 0, distribution: read === 1 ? null : 'publicRelease' }; },
    candidateOutputs: async () => { calls.push('inventory'); return { voice: { directory: 'synthetic-owned-voice', members: [] } }; },
    preserveVoiceProvenance: async () => { calls.push('provenance'); return { synthetic: true }; },
    sha256: async () => '96aab48ce7156ecab5343b55836162956e84f5b43fdb34dde8f54766c154be40',
    assert: (value, message) => assert.ok(value, message),
    run: async (_, label, executable, args, seconds, options) => { calls.push('seal');
      assert.equal(label, 'voice-seal'); assert.equal(executable, 'python3'); assert.equal(seconds, 120);
      assert.deepEqual(Array.from(args), ['third_party/voice/release_runtime.py', 'seal', '--target', context.coordinate.target, '--output', 'synthetic-owned-voice']);
      assert.equal(options.cwd, 'synthetic-reviewed-checkout');
      assert.deepEqual(Object.keys(options.env), ['PYTHONPATH']);
    },
  });
  const result = await seal(context, { directory: 'synthetic-reviewed-checkout' }, {});
  assert.deepEqual(calls, ['manifest', 'inventory', 'seal', 'manifest', 'inventory', 'provenance']);
  assert.equal(result.seal.normalPinnedSealCompleted, true);
  assert.equal(result.seal.publisherTrustProved, false);
  assert.equal(result.seal.shippingReplacementApproved, false);
});

function provenanceFixture() {
  const source = productionFunction('async function provenanceMember(', '\nasync function sealCandidateVoice(');
  return runInNewContext(`${source}; ({provenanceMember, preserveVoiceProvenance})`, {
    join, realpath, lstat, copyFile, constants, sha256, mkdir,
    assert: (value, message) => assert.ok(value, message),
    childPath: (root, file) => { const local = relative(root, file); assert.ok(local !== '' && !isAbsolute(local) && !local.startsWith('..')); return file; },
  });
}

test('actual provenance seam retains original raw bytes and binds both files to the sealed manifest hashes', () => ownedFixture(async root => {
  const directory = join(root, 'codex');
  const source = join(directory, 'third_party/voice/sources.json');
  const original = join(directory, 'bazel-bin/third_party/voice/native_runtime_macos_aarch64/konteks-source-inventory.json');
  await mkdir(join(source, '..'), { recursive: true });
  await mkdir(join(original, '..'), { recursive: true });
  const inputs = [Buffer.from('{ "syntheticSource": true }\n'), Buffer.from('[\n {"syntheticOriginalInventory": true}\n]\n')];
  await writeFile(source, inputs[0]); await writeFile(original, inputs[1]);
  const manifest = { sourceManifestSha256: createHash('sha256').update(inputs[0]).digest('hex'), inventorySha256: createHash('sha256').update(inputs[1]).digest('hex') };
  const result = await provenanceFixture().preserveVoiceProvenance({ work: root, coordinate: { prefix: 'macos_aarch64' } }, { directory }, manifest);
  assert.deepEqual(await readFile(result.sourceManifest.path), inputs[0]);
  assert.deepEqual(await readFile(result.inventory.path), inputs[1]);
  assert.equal(result.sourceManifest.sha256, manifest.sourceManifestSha256);
  assert.equal(result.inventory.sha256, manifest.inventorySha256);
  assert.equal(result.inventory.size, inputs[1].length);
}));

test('actual provenance seam refuses an incorrect runtime digest rather than synthesizing matching JSON', () => ownedFixture(async root => {
  const source = join(root, 'original.json');
  await writeFile(source, '[ { "syntheticOriginalBytes": true } ]\n');
  await assert.rejects(provenanceFixture().provenanceMember({ work: root }, source, join(root, 'copied.json'), '0'.repeat(64)), /differs from its actual runtime manifest/);
}));

test('actual provenance publication is exclusive and never overwrites an existing file', () => ownedFixture(async root => {
  const source = join(root, 'original.json');
  const destination = join(root, 'existing.json');
  await writeFile(source, 'synthetic raw source'); await writeFile(destination, 'existing retained bytes');
  await assert.rejects(provenanceFixture().provenanceMember({ work: root }, source, destination, await sha256(source)), { code: 'EEXIST' });
  assert.equal(await readFile(destination, 'utf8'), 'existing retained bytes');
}));

test('actual body signs every measured native member, reinspects, handshakes, then seals', async () => {
  const calls = [];
  const source = productionFunction('async function body(context)', '\nexport async function buildMac13ResourceCandidate(');
  const body = runInNewContext(`${source}; body`, {
    toolchain: async () => ({ os: 'synthetic-macos' }), codexSource: async () => ({}),
    candidates: async () => ({ zsh: { tree: 'synthetic-tree' } }), CODEX: { commit }, ZSH: {}, GST: {}, run: async () => commit,
    reportCandidateStage: () => undefined,
    inspect: async () => { calls.push('inspect'); return { allMinimumsAtMost13: true, privateImportsResolved: true, selectedNewerAPIImportsAllWeak: true }; },
    candidateNativeSignatures: async () => { calls.push('signatures'); return []; },
    handshake: async () => { calls.push('handshake'); return {}; },
    sealCandidateVoice: async () => { calls.push('seal'); return { outputs: {}, seal: {} }; },
    assert: (value, message) => assert.ok(value, message),
  });
  const result = await body(fixtureContext());
  assert.deepEqual(calls, ['inspect', 'signatures', 'inspect', 'handshake', 'seal']);
  assert.equal(result.candidateMeetsMeasuredFloor, true);
});

test('actual shared candidate builder rejects caller command or source overlays before context admission', async () => {
  let admitted = false;
  const source = productionFunction('export async function buildMac13ResourceCandidate(', '\nexport async function main(').replace(/^export /, '');
  const build = runInNewContext(`${source}; buildMac13ResourceCandidate`, {
    assert: (value, message) => assert.ok(value, message),
    contextFor: async () => { admitted = true; throw Error('synthetic boundary should not be reached'); },
  });
  await assert.rejects(build({ architecture: 'arm64', output: 'synthetic', command: 'unapproved' }), /requires only architecture/);
  await assert.rejects(build({ architecture: 'arm64', output: 'synthetic', sourceDirectory: 'unapproved' }), /requires only architecture/);
  assert.equal(admitted, false);
});

test('actual fixed progress reporter emits no source paths and rejects unknown stage copy', () => {
  const source = productionFunction('function reportCandidateStage(', '\nasync function candidateOutputs(');
  const lines = [];
  const report = runInNewContext(`${source}; reportCandidateStage`, { assert: (value, message) => assert.ok(value, message), console: { log: value => lines.push(value) } });
  const context = {};
  for (const stage of ['zsh-build', 'voice-build', 'inspect', 'handshake']) report(context, stage);
  assert.equal(lines.length, 4);
  assert.ok(lines.every(value => value.startsWith('Mac13 candidate: ') && !value.includes('/') && !value.includes('\\')));
  assert.equal(context.stage, 'handshake');
  assert.throws(() => report(context, '/synthetic/private/path'), /unknown candidate/);
  assert.equal(lines.length, 4);
});

function patchHunks(source) {
  const input = source.trimEnd().split('\n');
  assert.equal(input.shift(), '--- a/src/host/coreaudio/macos/loopback.rs');
  assert.equal(input.shift(), '+++ b/src/host/coreaudio/macos/loopback.rs');
  const hunks = [];
  for (const row of input) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(row);
    if (header) hunks.push({ start: Number(header[1]), old: Number(header[2]), new: Number(header[4]), rows: [] });
    else { assert.ok(hunks.length > 0 && /^[ +-]/.test(row)); hunks.at(-1).rows.push(row); }
  }
  return hunks;
}

function patchRows(hunk, old, state, result) {
  let removed = 0;
  let added = 0;
  for (const row of hunk.rows) {
    if (row[0] !== '+') { assert.equal(old[state.offset++], row.slice(1)); removed++; }
    if (row[0] !== '-') { result.push(row.slice(1)); added++; }
  }
  assert.equal(removed, hunk.old);
  assert.equal(added, hunk.new);
}

test('all seven exact patch hunks reproduce the fully reviewed CPAL candidate from primary source bytes', async () => {
  const hunks = patchHunks(await readFile(new URL('process-tap.patch', fixtures), 'utf8'));
  const old = (await readFile(new URL('loopback.upstream.rs', fixtures), 'utf8')).trimEnd().split('\n');
  const result = [];
  const state = { offset: 0 };
  assert.equal(hunks.length, 7);
  for (const hunk of hunks) {
    assert.ok(hunk.start > state.offset);
    result.push(...old.slice(state.offset, hunk.start - 1));
    state.offset = hunk.start - 1;
    patchRows(hunk, old, state, result);
  }
  result.push(...old.slice(state.offset));
  assert.equal(`${result.join('\n')}\n`, await readFile(new URL('loopback.candidate.rs', fixtures), 'utf8'));
});
