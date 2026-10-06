/** Synthetic thin-file/action/tool-boundary checks only; no native tools or candidate execution. */
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import { deriveVoiceHelperRpath, relocateVoiceHelper } from './voice-helper-relocation.mjs';
import { sha256 } from './inspect-candidate.mjs';

const fixtures = new URL('../fixtures/cpal-0.18.2-availability/', import.meta.url);
const COMMIT = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const TREE = 'bee1375c8502e4c4d71db017f7e087dfbb3e775c';
const PREFIX = 'konteks-voice-relocation-fixture-';

function graph(prefix = 'macos_aarch64', cpu = 'actual_arm_configuration') {
  const path = `bazel-out/synthetic-opt/bin/_solib_${cpu}/voice/native_link_${prefix}/libSynthetic.dylib`.split('/');
  return { actions: [{ mnemonic: 'SolibSymlink', targetId: '1', actionKey: 'a'.repeat(64), outputIds: ['1'] }],
    targets: [{ id: '1', label: `//third_party/voice:native_link_${prefix}` }],
    artifacts: [{ id: '1', pathFragmentId: String(path.length) }],
    pathFragments: path.map((label, index) => ({ id: String(index + 1), label, parentId: String(index) })) };
}

function metadata(paths, imported = '/usr/lib/libSystem.B.dylib') {
  const entries = [...paths.map(path => `      cmd LC_RPATH\n     path ${path} (offset 12)`),
    `      cmd LC_LOAD_DYLIB\n     name ${imported} (offset 24)`];
  return `synthetic helper:\n${entries.map((value, index) => `Load command ${index}\n${value}\n`).join('\n')}`;
}

async function fixture(run) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, PREFIX));
  try { return await run(root); }
  finally {
    assert.ok(isAbsolute(root)); assert.equal(dirname(resolve(root)), parent);
    assert.ok(basename(root).startsWith(PREFIX)); assert.equal(await realpath(root), root);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  }
}

async function inputs(root, prefix = 'macos_aarch64') {
  const directory = join(root, 'checkout');
  await mkdir(join(directory, 'third_party/voice'), { recursive: true });
  await copyFile(new URL('voice.BUILD.bazel', fixtures), join(directory, 'third_party/voice/BUILD.bazel'));
  await copyFile(new URL('voice.native_link.bzl', fixtures), join(directory, 'third_party/voice/native_link.bzl'));
  const helper = join(root, 'candidate/codex-resources/voice/bin/codex-voice-host');
  await mkdir(dirname(helper), { recursive: true });
  await writeFile(helper, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('synthetic helper never executed\n')]));
  const target = prefix === 'macos_aarch64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return { context: { work: root, coordinate: { prefix, target } }, codex: { directory, head: COMMIT, tree: TREE }, helper };
}

function toolBoundary(input, selectedGraph = graph(input.context.coordinate.prefix), options = {}) {
  const calls = [];
  const text = JSON.stringify(selectedGraph);
  const expected = deriveVoiceHelperRpath(text, input.context.coordinate.prefix).staleRpath;
  const run = async (_, label, executable, args, seconds) => {
    calls.push({ label, executable, args, seconds });
    if (label === 'voice-link-actions') {
      assert.equal(executable, 'bazel'); assert.equal(seconds, 300);
      assert.ok(args.includes('--macos_minimum_os=13.0'));
      assert.equal(args.at(-1), `mnemonic("SolibSymlink", //third_party/voice:native_link_${input.context.coordinate.prefix})`);
      return text;
    }
    assert.equal(args.at(-1), input.helper);
    if (label === 'voice-delete-build-rpath') {
      assert.equal(executable, '/usr/bin/install_name_tool');
      assert.deepEqual(args, ['-delete_rpath', expected, input.helper]);
      await writeFile(input.helper, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('synthetic relocated helper\n')]));
      return '';
    }
    assert.equal(executable, '/usr/bin/otool');
    assert.deepEqual(args, ['-l', input.helper]);
    return label === 'voice-rpaths-before'
      ? metadata(options.beforePaths ?? [expected, '@loader_path/../lib'])
      : metadata(options.afterPaths ?? ['@loader_path/../lib'], options.afterImport);
  };
  return { calls, run, expected };
}

for (const [prefix, cpu] of [['macos_aarch64', 'independent_arm_value'], ['macos_x86_64', 'darwin_x86_64']]) {
  test(`real relocation code derives ${prefix} search directory from its own synthetic action output`, () => fixture(async root => {
    const input = await inputs(root, prefix);
    const original = await sha256(input.helper);
    const boundary = toolBoundary(input, graph(prefix, cpu));
    const result = await relocateVoiceHelper(input.context, input.codex, input.helper, boundary.run, ['-c', 'opt', '--macos_minimum_os=13.0']);
    assert.equal(result.deletedRpath, `@loader_path/../../_solib_${cpu}/voice/native_link_${prefix}`);
    assert.equal(result.source.nativeLink.sha256, '38736a14a8975ef5a15779b87f31093b706e0dcfe44213ba86a9e7d1935d369c');
    assert.equal(result.source.build.sha256, '80e56372c8b9027e5afc4de644f4b923dbb3570ef445f25ec9860c80d4223c61');
    assert.equal(result.input.sha256, original); assert.equal(result.output.sha256, await sha256(input.helper));
    assert.notEqual(result.input.sha256, result.output.sha256);
    assert.deepEqual(result.before.imports, result.after.imports);
    assert.deepEqual(result.after.rpaths, ['@loader_path/../lib']);
    assert.equal(result.publisherTrustProved, false);
    assert.deepEqual(boundary.calls.map(row => row.label), ['voice-link-actions', 'voice-rpaths-before', 'voice-delete-build-rpath', 'voice-rpaths-after']);
  }));
}

for (const [name, change, error] of [
  ['another target', value => { value.targets[0].label = '//third_party/voice:native_link_macos_x86_64'; }, /target differs/],
  ['another mnemonic', value => { value.actions[0].mnemonic = 'CppLink'; }, /mnemonic refused/],
  ['missing action key', value => { delete value.actions[0].actionKey; }, /action key refused/],
  ['multiple outputs', value => { value.actions[0].outputIds.push('1'); }, /output is ambiguous/],
  ['traversal', value => { value.pathFragments[1].label = '..'; }, /path segment refused/],
  ['unrelated build path', value => { value.pathFragments[3].label = '_arbitrary'; }, /pinned link layout/],
  ['wrong coordinate layout', value => { value.pathFragments[5].label = 'native_link_macos_x86_64'; }, /pinned link layout/],
  ['repeated output', value => { value.actions.push({ ...value.actions[0] }); }, /outputs repeat/],
]) {
  test(`voice action proof refuses ${name}`, () => {
    const value = graph(); change(value);
    assert.throws(() => deriveVoiceHelperRpath(JSON.stringify(value), 'macos_aarch64'), error);
  });
}

for (const member of ['BUILD.bazel', 'native_link.bzl']) {
  test(`altered pinned ${member} refuses before any tool query or helper modification`, () => fixture(async root => {
    const input = await inputs(root);
    const original = await readFile(input.helper);
    await writeFile(join(input.codex.directory, 'third_party/voice', member), 'synthetic unreviewed source\n');
    let called = false;
    await assert.rejects(relocateVoiceHelper(input.context, input.codex, input.helper, async () => { called = true; }, []), /review of pinned source/);
    assert.equal(called, false); assert.deepEqual(await readFile(input.helper), original);
  }));
}

for (const beforePaths of [[], ['@loader_path/../lib'], ['@loader_path/../lib', '/opt/homebrew/lib']]) {
  test(`unexpected before search paths ${JSON.stringify(beforePaths)} refuse without relocation effects`, () => fixture(async root => {
    const input = await inputs(root);
    const boundary = toolBoundary(input, graph(), { beforePaths });
    const original = await readFile(input.helper);
    await assert.rejects(relocateVoiceHelper(input.context, input.codex, input.helper, boundary.run, ['--macos_minimum_os=13.0']), /unexpected build search paths/);
    assert.deepEqual(await readFile(input.helper), original);
    assert.equal(boundary.calls.some(row => row.label === 'voice-delete-build-rpath'), false);
  }));
}

for (const [options, error] of [[{ afterPaths: ['/opt/homebrew/lib'] }, /unexpected search path/],
  [{ afterImport: '@rpath/libChanged.dylib' }, /changed its imports/]]) {
  test('post-relocation loader changes refuse before signing or executing the helper', () => fixture(async root => {
    const input = await inputs(root);
    const boundary = toolBoundary(input, graph(), options);
    await assert.rejects(relocateVoiceHelper(input.context, input.codex, input.helper, boundary.run, ['--macos_minimum_os=13.0']), error);
    assert.equal(input.context.stage, 'voice-helper-relocation');
  }));
}

for (const label of ['voice-rpaths-before', 'voice-rpaths-after']) {
  test(`helper same-size replacement during ${label} is not attributed to measured metadata`, () => fixture(async root => {
    const input = await inputs(root);
    const boundary = toolBoundary(input);
    const run = async (...args) => {
      const result = await boundary.run(...args);
      if (args[1] === label) {
        const bytes = await readFile(input.helper);
        bytes[bytes.length - 1] ^= 1;
        await writeFile(input.helper, bytes);
      }
      return result;
    };
    await assert.rejects(relocateVoiceHelper(input.context, input.codex, input.helper, run, ['--macos_minimum_os=13.0']), /changed during metadata/);
    if (label === 'voice-rpaths-before') assert.equal(boundary.calls.some(row => row.label === 'voice-delete-build-rpath'), false);
  }));
}
