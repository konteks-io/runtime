import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { assertMacOsMetadata } from './macos-artifact-compatibility.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const domainPath = path.join(directory, 'macos-voice-resource-closure.mjs');
const domain = fs.existsSync(domainPath) ? await import(pathToFileURL(domainPath).href) : {};
const sourceCommit = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const plugins = ['app', 'audioconvert', 'audioresample', 'coreelements', 'opus', 'rtp', 'rtpmanager'].map(name => `plugins/libgst${name}.dylib`);
const members = ['bin/codex-voice-host', 'lib/libgio-2.0.0.dylib', 'lib/libglib-2.0.0.dylib', ...plugins];
const command = (name, fields) => `Load command 0\n      cmd ${name}\n  cmdsize 32\n${fields}\n`;
const build = version => command('LC_BUILD_VERSION', ` platform 1\n    minos ${version}\n      sdk 26.0`);
const dependency = value => command('LC_LOAD_DYLIB', `     name ${value} (offset 24)`);
const rpath = value => command('LC_RPATH', `     path ${value} (offset 12)`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function write(root, name, bytes) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: name, size: bytes.length, sha256: digest(bytes) };
}

function record(root, name) {
  const bytes = fs.readFileSync(path.join(root, name));
  return { path: name, size: bytes.length, sha256: digest(bytes) };
}

function seed(root, architecture) {
  const target = architecture === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const voice = `node_modules/@openai/codex/vendor/${target}/codex-resources/voice`;
  const sourceManifest = write(root, 'konteks/macos-codex-resource-inputs/sources.json', Buffer.from('{"syntheticSourceFixture":true}\n'));
  for (const name of members) write(root, `${voice}/${name}`, Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from(`synthetic native boundary ${name}\n`)]));
  const nativeMembers = members.map(name => ({ ...record(root, `${voice}/${name}`), path: name }));
  const libraries = nativeMembers.slice(1).map(member => ({ path: member.path, sourcePath: `synthetic-prefix/${member.path}`, sourceSha256: member.sha256, sha256: member.sha256, imports: ['/usr/lib/libSystem.B.dylib'] }));
  const original = libraries.map(library => ({ path: library.sourcePath, target, sha256: library.sourceSha256 }));
  const inventory = write(root, 'konteks/macos-codex-resource-inputs/binaries.json', Buffer.from(JSON.stringify(original) + '\n'));
  const manifest = { schemaVersion: 1, developmentOnly: false, distribution: 'publicRelease', target, sourceCommit, sourceManifestSha256: sourceManifest.sha256, inventorySha256: inventory.sha256, libraries, plugins };
  const manifestRecord = write(root, `${voice}/runtime.json`, Buffer.from(JSON.stringify(manifest) + '\n'));
  const closure = { kind: 'codex-voice-0.159.0', root: voice, target, sourceCommit, sourceManifest, inventory, manifest: { ...manifestRecord, path: 'runtime.json' }, nativeMembers };
  return { root, voice, closure, architecture, commands: new Map(), versions: new Map(), architectures: new Map(), calls: [] };
}

function fixture(run, architecture = 'arm64') {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'konteks-voice-closure-'));
  try { return run(seed(root, architecture)); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function inspect(state, closures = [state.closure]) {
  const helper = path.join(directory, 'macos-artifact-compatibility.mjs');
  const source = fs.readFileSync(helper, 'utf8').replace(/^import .+;\r?$/gm, '').replace(/^export function /gm, 'function ').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(helper).href));
  const context = { ...fs, ...path, ...domain, Buffer, URL, Error, SyntaxError, ReferenceError, process: { platform: 'darwin' },
    execFileSync: (executable, args) => toolMetadata(state, executable, args) };
  const api = runInNewContext(`${source}\n({ assertMacOsArtifactTree });`, context, { timeout: 1_000 });
  return api.assertMacOsArtifactTree(state.root, { architecture: state.architecture, minimumOS: '13', resourceClosures: closures });
}

function assertProductionRefusal(run, expected) {
  assert.throws(run, error => {
    assert.ok(!(error instanceof SyntaxError), 'parser failures are fixture defects, not production refusals');
    assert.ok(!(error instanceof ReferenceError), 'missing VM bindings are fixture defects, not production refusals');
    assert.match(error.message, expected);
    return true;
  });
}

function toolMetadata(state, executable, args) {
  const name = path.relative(path.join(state.root, state.voice), args[1]).split(path.sep).join('/');
  state.calls.push({ executable, name });
  if (executable === '/usr/bin/lipo') return state.architectures.get(name) ?? (state.architecture === 'arm64' ? 'arm64' : 'x86_64');
  assert.equal(executable, '/usr/bin/otool');
  return build(state.versions.get(name) ?? '13.0') + (state.commands.get(name) ?? dependency('/usr/lib/libSystem.B.dylib'));
}

function reviseManifest(state, revise) {
  const file = path.join(state.root, state.voice, 'runtime.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  revise(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest) + '\n');
  state.closure.manifest = { ...record(state.root, `${state.voice}/runtime.json`), path: 'runtime.json' };
}

function reviseInventory(state, revise) {
  const file = path.join(state.root, state.closure.inventory.path);
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(revise(inventory) ?? inventory) + '\n');
  state.closure.inventory = record(state.root, state.closure.inventory.path);
  reviseManifest(state, manifest => { manifest.inventorySha256 = state.closure.inventory.sha256; });
}

const privateImports = [
  ['same-directory loader dependency', 'lib/libgio-2.0.0.dylib', dependency('@loader_path/libglib-2.0.0.dylib')],
  ['fixed helper executable dependency', 'bin/codex-voice-host', dependency('@executable_path/../lib/libgio-2.0.0.dylib')],
  ['contained plugin parent dependency', plugins[0], dependency('@loader_path/../lib/libgio-2.0.0.dylib')],
  ['single declared rpath dependency', 'lib/libgio-2.0.0.dylib', rpath('@loader_path') + dependency('@rpath/libglib-2.0.0.dylib')],
];

for (const [name, member, commands] of privateImports) {
  test(`verified voice tree permits ${name} while inspecting every native member`, () => fixture(state => {
    state.commands.set(member, commands);
    assert.equal(inspect(state), members.length);
    assert.equal(state.calls.filter(call => call.executable === '/usr/bin/otool').length, members.length);
  }));
}

test('verified voice tree retains the Intel architecture and macOS13 checks', () => fixture(state => {
  state.commands.set('lib/libgio-2.0.0.dylib', dependency('@loader_path/libglib-2.0.0.dylib'));
  assert.equal(inspect(state), members.length);
}, 'amd64'));

test('a verified closure cannot waive an individual native macOS floor', () => fixture(state => {
  state.versions.set('lib/libglib-2.0.0.dylib', '14.0');
  assertProductionRefusal(() => inspect(state), /minimum OS exceeds/);
}));

test('a verified closure cannot waive an individual native architecture', () => fixture(state => {
  state.architectures.set('lib/libglib-2.0.0.dylib', 'x86_64');
  assertProductionRefusal(() => inspect(state), /expected thin/);
}));

test('all nonclosure native artifacts retain system-only imports', () => fixture(state => {
  state.commands.set('lib/libgio-2.0.0.dylib', dependency('@loader_path/libglib-2.0.0.dylib'));
  assertProductionRefusal(() => inspect(state, []), /non-system dependency/);
}));

test('public metadata validation cannot acquire a private closure waiver', () => fixture(state => {
  assertProductionRefusal(() => assertMacOsMetadata({ architectures: 'arm64', loadCommands: build('13.0') + dependency('@loader_path/libglib-2.0.0.dylib') },
    { architecture: 'arm64', minimumOS: '13', resourceClosures: [state.closure] }), /non-system dependency/);
}));

const descriptorRefusals = [
  ['other Codex version', state => { state.closure.kind = 'codex-voice-0.153.4'; }, /voice.*kind|closure.*kind/i],
  ['wrong source commit', state => { state.closure.sourceCommit = '0'.repeat(40); }, /source.*commit/i],
  ['wrong architecture target', state => { state.closure.target = 'x86_64-apple-darwin'; }, /target|architecture/i],
  ['extra descriptor authority', state => { state.closure.skipSystemOnly = true; }, /descriptor|unknown|field/i],
  ['changed native bytes', state => { fs.appendFileSync(path.join(state.root, state.voice, members[0]), 'changed'); }, /digest|size|hash/i],
  ['changed source input bytes', state => { fs.appendFileSync(path.join(state.root, state.closure.sourceManifest.path), 'changed'); }, /digest|size|hash/i],
  ['changed inventory bytes', state => { fs.appendFileSync(path.join(state.root, state.closure.inventory.path), 'changed'); }, /digest|size|hash/i],
  ['manifest source input disagreement', state => reviseManifest(state, manifest => { manifest.sourceManifestSha256 = '0'.repeat(64); }), /source.*manifest|source.*digest/i],
  ['manifest inventory disagreement', state => reviseManifest(state, manifest => { manifest.inventorySha256 = '0'.repeat(64); }), /inventory/i],
  ['development-only manifest', state => reviseManifest(state, manifest => { manifest.developmentOnly = true; }), /public|development|manifest/i],
  ['missing mandatory plugin', state => reviseManifest(state, manifest => { manifest.plugins.pop(); }), /plugin/i],
  ['missing declared library', state => { state.closure.nativeMembers.pop(); }, /member|librar/i],
  ['linked native bytes', state => { fs.linkSync(path.join(state.root, state.voice, members[0]), path.join(state.root, 'owned-hardlink')); }, /hardlink|link|regular/i],
];

for (const [name, mutate, expected] of descriptorRefusals) {
  test(`verified voice tree refuses ${name} before native-tool inspection`, () => fixture(state => {
    mutate(state);
    assertProductionRefusal(() => inspect(state), expected);
    assert.equal(state.calls.length, 0, 'invalid closure cannot reach native-tool inspection');
  }));
}

test('verified voice tree refuses undeclared native members', () => fixture(state => {
  write(state.root, `${state.voice}/lib/undeclared.dylib`, Buffer.from('cffaedfe00000000', 'hex'));
  assertProductionRefusal(() => inspect(state), /undeclared.*native|native.*undeclared/i);
}));

function addLibrary(state, name, bytes) {
  const member = { ...write(state.root, `${state.voice}/${name}`, bytes), path: name };
  state.closure.nativeMembers.push(member);
  reviseManifest(state, manifest => {
    manifest.libraries.push({ path: name, sourcePath: `synthetic-prefix/${name}`, sourceSha256: member.sha256, sha256: member.sha256, imports: ['/usr/lib/libSystem.B.dylib'] });
  });
  reviseInventory(state, inventory => { inventory.push({ path: `synthetic-prefix/${name}`, target: state.closure.target, sha256: member.sha256 }); });
}

test('verified voice tree refuses a declared non-native library', () => fixture(state => {
  addLibrary(state, 'lib/plain.dylib', Buffer.from('not a Mach-O file\n'));
  assertProductionRefusal(() => inspect(state), /native|Mach-O/i);
}));

test('verified voice tree refuses ambiguous declared rpath candidates', () => fixture(state => {
  addLibrary(state, 'lib/libgstapp.dylib', Buffer.from('cffaedfe00000000', 'hex'));
  state.commands.set('lib/libgio-2.0.0.dylib', rpath('@loader_path') + rpath('@loader_path/../plugins') + dependency('@rpath/libgstapp.dylib'));
  assertProductionRefusal(() => inspect(state), /ambiguous/i);
}));

test('verified voice tree refuses a linked member ancestor before native tools', () => fixture(state => {
  const libraries = path.join(state.root, state.voice, 'lib');
  const target = path.join(state.root, 'owned-library-target');
  fs.renameSync(libraries, target);
  fs.symlinkSync(target, libraries, 'junction');
  assertProductionRefusal(() => inspect(state), /link/i);
  assert.equal(state.calls.length, 0);
}));

test('a sibling voice-backup path never receives closure permission', () => fixture(state => {
  const backup = `${state.voice}-backup/backup.dylib`;
  write(state.root, backup, Buffer.from('cffaedfe00000000', 'hex'));
  state.commands.set('../voice-backup/backup.dylib', dependency('@loader_path/libglib-2.0.0.dylib'));
  assertProductionRefusal(() => inspect(state), /non-system dependency/);
}));

const dependencyRefusals = [
  ['escaping loader path', dependency('@loader_path/../../../../outside.dylib')],
  ['undeclared loader target', dependency('@loader_path/unknown.dylib')],
  ['unresolved rpath', dependency('@rpath/libglib-2.0.0.dylib')],
  ['host rpath search', rpath('/opt/homebrew/lib') + dependency('@rpath/libglib-2.0.0.dylib')],
  ['unnormalized loader path', dependency('@loader_path/extra/../libglib-2.0.0.dylib')],
  ['unknown loader token', dependency('@unreviewed/libglib-2.0.0.dylib')],
  ['embedded loader environment', command('LC_DYLD_ENVIRONMENT', '     name DYLD_LIBRARY_PATH=/fixture (offset 24)')],
  ['prebound dependency', command('LC_PREBOUND_DYLIB', '     name /usr/lib/libSystem.B.dylib (offset 24)')],
  ['unknown dependency command', command('LC_LOAD_FUTURE_DYLIB', '     name /usr/lib/libSystem.B.dylib (offset 24)')],
];

for (const [name, commands] of dependencyRefusals) {
  test(`verified voice tree refuses ${name}`, () => fixture(state => {
    state.commands.set('lib/libgio-2.0.0.dylib', commands);
    assertProductionRefusal(() => inspect(state), /dependency|loader|rpath|closure|import|prebound/i);
  }));
}

const inventoryRefusals = [
  ['object instead of original row array', state => reviseInventory(state, () => ({ syntheticInvalidInventory: true }))],
  ['empty original row array', state => reviseInventory(state, () => [])],
  ['too many original rows', state => reviseInventory(state, inventory => Array.from({ length: 129 }, () => inventory[0]))],
  ['duplicate original source path', state => reviseInventory(state, inventory => { inventory.push({ ...inventory[0] }); })],
  ['wrong original target', state => reviseInventory(state, inventory => { inventory[0].target = 'x86_64-apple-darwin'; })],
  ['unknown original row field', state => reviseInventory(state, inventory => { inventory[0].allowUnverified = true; })],
  ['null original row', state => reviseInventory(state, inventory => { inventory[0] = null; })],
  ['noncanonical original path', state => reviseInventory(state, inventory => { inventory[0].path = 'synthetic-prefix/../lib/changed.dylib'; })],
  ['invalid original digest', state => reviseInventory(state, inventory => { inventory[0].sha256 = 'not-a-digest'; })],
  ['unlisted library source path', state => reviseManifest(state, manifest => { manifest.libraries[0].sourcePath = 'synthetic-prefix/unlisted.dylib'; })],
  ['absolute library source path', state => reviseManifest(state, manifest => { manifest.libraries[0].sourcePath = '/synthetic-prefix/lib/libgio-2.0.0.dylib'; })],
  ['library source hash differs', state => reviseManifest(state, manifest => { manifest.libraries[0].sourceSha256 = '0'.repeat(64); })],
  ['two libraries share one original source', state => reviseManifest(state, manifest => {
    manifest.libraries[1].sourcePath = manifest.libraries[0].sourcePath;
    manifest.libraries[1].sourceSha256 = manifest.libraries[0].sourceSha256;
  })],
];

for (const [name, mutate] of inventoryRefusals) {
  test(`verified voice tree independently refuses ${name} before native tools`, () => fixture(state => {
    mutate(state);
    assertProductionRefusal(() => inspect(state), /inventory|source|relative|row|digest/i);
    assert.equal(state.calls.length, 0);
  }));
}
