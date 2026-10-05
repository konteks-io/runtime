/** Synthetic diagnostic fixtures only. No native tools, binary execution or compatibility acceptance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { inspect, inventory, sha256 } from './inspect-candidate.mjs';

const FIXTURE_PREFIX = 'konteks-mac13-inspector-fixture-';
const THIN = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('synthetic, never executed\n')]);
const SYSTEM = '/usr/lib/libSystem.B.dylib';
const COMMANDS = {
  lipo: { executable: '/usr/bin/lipo', flags: ['-archs'], result: 'architecture' },
  'otool-load': { executable: '/usr/bin/otool', flags: ['-l'], result: 'load' },
  'otool-imports': { executable: '/usr/bin/otool', flags: ['-L'], result: 'imports' },
  'nm-undefined': { executable: '/usr/bin/nm', flags: ['-m', '-u'], result: 'symbols' },
};

function loadCommands(...blocks) {
  return `synthetic candidate:\n${blocks.map((block, index) => `Load command ${index}\n${block}\n`).join('\n')}`;
}

function buildMinimum(version = '13.0', platform = '1') {
  return `      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform ${platform}\n    minos ${version}\n      sdk 26.0`;
}

function loader(kind, name) {
  return `      cmd ${kind}\n  cmdsize 64\n     name ${name} (offset 24)`;
}

function metadata(overrides = {}) {
  return { architecture: 'arm64\n', load: loadCommands(buildMinimum(), loader('LC_LOAD_DYLIB', SYSTEM)),
    imports: 'synthetic candidate:\n\t/usr/lib/libSystem.B.dylib\n', symbols: '', ...overrides };
}

/** The only "native" boundary is this mock; it never starts a process. */
function commandFixture(rows = new Map(), calls = []) {
  return async (label, executable, args) => {
    const descriptor = COMMANDS[label];
    assert.ok(descriptor, `unexpected diagnostic command ${label}`);
    assert.equal(executable, descriptor.executable);
    assert.deepEqual(args.slice(0, -1), descriptor.flags);
    const file = args.at(-1);
    assert.ok(isAbsolute(file));
    calls.push({ label, file });
    return metadata(rows.get(file))[descriptor.result];
  };
}

async function file(root, name = 'bin/helper', bytes = THIN) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return path;
}

async function removeFixture(root, parent) {
  assert.ok(isAbsolute(root));
  const absolute = resolve(root);
  assert.equal(dirname(absolute), parent);
  assert.ok(basename(absolute).startsWith(FIXTURE_PREFIX));
  assert.equal(await realpath(absolute), absolute);
  assert.equal((await lstat(absolute)).isSymbolicLink(), false);
  await rm(absolute, { recursive: true });
}

async function fixture(run) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, FIXTURE_PREFIX));
  try { return await run(root); }
  finally { await removeFixture(root, parent); }
}

test('mocked thin native metadata reports exact file bytes and preserves the unclassified availability limit', () => fixture(async root => {
  const executable = await file(root);
  await file(root, 'README.txt', Buffer.from('regular non-native fixture\n'));
  const calls = [];
  const result = await inspect(root, executable, 'arm64', commandFixture(new Map(), calls));
  assert.equal(result.fileCount, 2);
  assert.equal(result.binaries.length, 1);
  const [binary] = result.binaries;
  assert.equal(binary.path, relative(root, executable));
  assert.equal(binary.size, THIN.length);
  assert.equal(binary.sha256, createHash('sha256').update(THIN).digest('hex'));
  assert.equal(binary.minimumOS, '13.0');
  assert.equal(result.allMinimumsAtMost13, true);
  assert.equal(result.privateImportsResolved, true);
  assert.equal(result.selectedNewerAPIImportsAllWeak, true);
  assert.equal(result.symbolAvailabilityFullyClassified, false);
  assert.deepEqual(calls.map(value => value.label), Object.keys(COMMANDS));
}));

for (const [version, expected] of [['10.15', true], ['12.7.1', true], ['13.0', true], ['13.0.0', true], ['13.0.1', false], ['13.1', false], ['15.0', false]]) {
  test(`mocked minimum ${version} is measured against the full 13.0 tuple`, () => fixture(async root => {
    const executable = await file(root);
    const rows = new Map([[executable, { load: loadCommands(buildMinimum(version)) }]]);
    const result = await inspect(root, executable, 'arm64', commandFixture(rows));
    assert.equal(result.allMinimumsAtMost13, expected);
    assert.equal(result.binaries[0].minimumOS, version);
    assert.equal(result.symbolAvailabilityFullyClassified, false);
  }));
}

test('mocked Intel metadata and the legacy macOS minimum command are accepted explicitly', () => fixture(async root => {
  const executable = await file(root);
  const rows = new Map([[executable, { architecture: 'x86_64\n', load: loadCommands('      cmd LC_VERSION_MIN_MACOSX\n  version 11.0\n      sdk 15.0') }]]);
  const result = await inspect(root, executable, 'x86_64', commandFixture(rows));
  assert.equal(result.binaries[0].architecture, 'x86_64');
  assert.equal(result.allMinimumsAtMost13, true);
}));

for (const architecture of ['x86_64', 'arm64 x86_64']) {
  test(`mocked lipo architecture ${architecture} refuses the requested arm64 coordinate`, () => fixture(async root => {
    const executable = await file(root);
    const calls = [];
    await assert.rejects(inspect(root, executable, 'arm64', commandFixture(new Map([[executable, { architecture }]]), calls)), /architecture mismatch/);
    assert.deepEqual(calls.map(value => value.label), ['lipo']);
  }));
}

for (const [name, load, expected] of [
  ['foreign platform', loadCommands(buildMinimum('13.0', '2')), /non-macOS/],
  ['missing minimum', loadCommands(loader('LC_LOAD_DYLIB', SYSTEM)), /missing or ambiguous/],
  ['ambiguous minimum', loadCommands(buildMinimum(), buildMinimum('12.0')), /missing or ambiguous/],
  ['dyld environment', loadCommands(buildMinimum(), '      cmd LC_DYLD_ENVIRONMENT\n     name DYLD_INSERT_LIBRARIES=untrusted (offset 12)'), /unsupported candidate loader/],
  ['prebound library', loadCommands(buildMinimum(), loader('LC_PREBOUND_DYLIB', SYSTEM)), /unsupported candidate loader/],
]) {
  test(`mocked ${name} metadata refuses rather than producing compatibility facts`, () => fixture(async root => {
    const executable = await file(root);
    await assert.rejects(inspect(root, executable, 'arm64', commandFixture(new Map([[executable, { load }]]))), expected);
  }));
}

for (const symbol of ['_AudioHardwareCreateProcessTap', '_AudioHardwareDestroyProcessTap', '_OBJC_CLASS_$_CATapDescription', '_kAudioTapPropertyFormat']) {
  test(`mocked newer API ${symbol} distinguishes strong from weak undefined imports`, () => fixture(async root => {
    const executable = await file(root);
    const strong = new Map([[executable, { symbols: `                 (undefined) external ${symbol} (from CoreAudio)\n` }]]);
    const weak = new Map([[executable, { symbols: `                 (undefined) weak external ${symbol} (from CoreAudio)\n` }]]);
    assert.equal((await inspect(root, executable, 'arm64', commandFixture(strong))).selectedNewerAPIImportsAllWeak, false);
    const result = await inspect(root, executable, 'arm64', commandFixture(weak));
    assert.equal(result.selectedNewerAPIImportsAllWeak, true);
    assert.equal(result.binaries[0].selectedNewerAPIImports[0].weakExternal, true);
    assert.equal(result.symbolAvailabilityFullyClassified, false);
  }));
}

for (const [path, expected] of [
  [SYSTEM, 'system'], ['/usr/lib/dyld', 'system'],
  ['/System/Library/Frameworks/CoreAudio.framework/Versions/A/CoreAudio', 'system'],
  ['/usr/lib/../local/libForeign.dylib', 'unresolved_private'], ['/usr/lib/./libSystem.B.dylib', 'unresolved_private'],
  ['//usr/lib/libSystem.B.dylib', 'unresolved_private'], ['/usr/liberal/libForeign.dylib', 'unresolved_private'],
  ['/System/Library/Frameworks/../../Private/libForeign.dylib', 'unresolved_private'], ['usr/lib/libSystem.B.dylib', 'unresolved_private'],
]) {
  test(`mocked loader path ${path} has only the normalized system classification`, () => fixture(async root => {
    const executable = await file(root);
    const kind = path === '/usr/lib/dyld' ? 'LC_LOAD_DYLINKER' : 'LC_LOAD_DYLIB';
    const rows = new Map([[executable, { load: loadCommands(buildMinimum(), loader(kind, path)) }]]);
    const result = await inspect(root, executable, 'arm64', commandFixture(rows));
    assert.equal(result.binaries[0].imports[0].resolution, expected);
    assert.equal(result.privateImportsResolved, expected === 'system');
  }));
}

test('mocked private loader closure resolves only regular members of the candidate and ignores its own dylib ID', () => fixture(async root => {
  const executable = await file(root);
  const library = await file(root, 'lib/helper.dylib');
  const nested = await file(root, 'lib/nested.dylib');
  const rows = new Map([
    [executable, { load: loadCommands(buildMinimum(), loader('LC_LOAD_DYLIB', '@loader_path/../lib/helper.dylib')) }],
    [library, { load: loadCommands(buildMinimum(), loader('LC_ID_DYLIB', '/not-an-import/helper.dylib'), loader('LC_LOAD_WEAK_DYLIB', '@executable_path/../lib/nested.dylib')) }],
    [nested, metadata()],
  ]);
  const result = await inspect(root, executable, 'arm64', commandFixture(rows));
  assert.equal(result.binaries.length, 3);
  assert.equal(result.privateImportsResolved, true);
  const main = result.binaries.find(value => value.path === relative(root, executable));
  assert.equal(main.imports[0].path, relative(root, library));
  const privateLibrary = result.binaries.find(value => value.path === relative(root, library));
  assert.equal(privateLibrary.imports.length, 1);
  assert.equal(privateLibrary.imports[0].path, relative(root, nested));
}));

for (const path of ['@rpath/libUnknown.dylib', '@loader_path/../../outside.dylib', '/opt/homebrew/lib/libUnknown.dylib']) {
  test(`mocked private import ${path} never becomes a resolved candidate member`, () => fixture(async root => {
    const executable = await file(root);
    const result = await inspect(root, executable, 'arm64', commandFixture(new Map([[executable, { load: loadCommands(buildMinimum(), loader('LC_LOAD_DYLIB', path)) }]])));
    assert.equal(result.privateImportsResolved, false);
    assert.equal(result.binaries[0].imports[0].resolution, 'unresolved_private');
    assert.equal(Object.hasOwn(result.binaries[0].imports[0], 'path'), false);
  }));
}

test('an explicitly relative rpath remains reported rather than counted as a resolved imported file', () => fixture(async root => {
  const executable = await file(root);
  const result = await inspect(root, executable, 'arm64', commandFixture(new Map([[executable, { load: loadCommands(buildMinimum(), loader('LC_RPATH', '@loader_path/../lib')) }]])));
  assert.deepEqual(result.binaries[0].rpaths, ['@loader_path/../lib']);
  assert.deepEqual(result.binaries[0].imports, []);
  assert.equal(result.symbolAvailabilityFullyClassified, false);
}));

test('a candidate directory cannot satisfy a private dylib import', () => fixture(async root => {
  const executable = await file(root);
  await mkdir(join(root, 'lib', 'not-a-dylib'), { recursive: true });
  const rows = new Map([[executable, { load: loadCommands(buildMinimum(), loader('LC_LOAD_DYLIB', '@loader_path/../lib/not-a-dylib')) }]]);
  await assert.rejects(inspect(root, executable, 'arm64', commandFixture(rows)), /private import is not a regular candidate file/);
}));

test('fat magic and a non-native-only tree refuse without any mocked tool request', () => fixture(async root => {
  const executable = await file(root, 'bin/helper', Buffer.from('cafebabe', 'hex'));
  const calls = [];
  await assert.rejects(inspect(root, executable, 'arm64', commandFixture(new Map(), calls)), /fat Mach-O/);
  await writeFile(executable, 'ordinary synthetic text\n');
  await assert.rejects(inspect(root, executable, 'arm64', commandFixture(new Map(), calls)), /no Mach-O/);
  assert.deepEqual(calls, []);
}));

/** Execute unchanged frozen function bodies with synthetic filesystem metadata for Windows portability. */
function metadataInspector(selected, info) {
  const source = readFileSync(new URL('./inspect-candidate.mjs', import.meta.url), 'utf8');
  const imports = /^import[^\n]+;\r?$/gm;
  assert.equal([...source.matchAll(imports)].length, 4);
  assert.equal([...source.matchAll(/^export async function /gm)].length, 3);
  const body = source.replace(imports, '').replace(/^export (?=async function )/gm, '');
  const bindings = { Buffer, createReadStream, createHash, open, readdir, realpath, dirname, isAbsolute, join, posix, relative, resolve,
    lstat: async path => { assert.equal(path, selected); return info; } };
  return runInNewContext(`${body}\n({ inventory, sha256 })`, bindings, { timeout: 1_000 });
}

for (const [name, linked, expected] of [['link', true, /contains a link/], ['special file', false, /contains a special file/]]) {
  test(`synthetic ${name} metadata refuses before reading or hashing the candidate entry`, () => fixture(async root => {
    const selected = await file(root, 'entry');
    const info = { size: THIN.length, isSymbolicLink: () => linked, isDirectory: () => false, isFile: () => false };
    const api = metadataInspector(selected, info);
    await assert.rejects(api.inventory(root), expected);
    await assert.rejects(api.sha256(selected), /not a regular file/);
    assert.deepEqual(await inventory(root), { files: [{ file: selected, path: 'entry', size: THIN.length }], bytes: THIN.length });
  }));
}

test('the bounded real fixture hash refuses an excessive input before opening a stream', () => fixture(async root => {
  const selected = await file(root, 'entry');
  assert.equal(await sha256(selected), createHash('sha256').update(THIN).digest('hex'));
  await assert.rejects(sha256(selected, THIN.length - 1), /exceeds byte cap/);
}));
