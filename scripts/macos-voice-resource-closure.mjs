/** Validate the verified top-level Codex voice closure without host loader fallbacks. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

const sourceCommit = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const targets = new Map([['arm64', 'aarch64-apple-darwin'], ['amd64', 'x86_64-apple-darwin']]);
const thinMagic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe']);
const plugins = ['app', 'audioconvert', 'audioresample', 'coreelements', 'opus', 'rtp', 'rtpmanager'].map(name => `plugins/libgst${name}.dylib`);
const importCommands = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_DYLINKER']);
const helperPath = 'bin/codex-voice-host';

export function createMacVoiceResourceClosures(root, descriptors = [], architecture) {
  if (!Array.isArray(descriptors) || descriptors.length > 1) throw new Error('Invalid voice closure descriptor list');
  return descriptors.map(descriptor => prepareClosure(realpathSync(root), descriptor, architecture));
}

function prepareClosure(root, descriptor, architecture) {
  exactFields(descriptor, ['kind', 'root', 'target', 'sourceCommit', 'sourceManifest', 'inventory', 'manifest', 'nativeMembers'], 'descriptor');
  assertOrigin(descriptor, architecture);
  const voicePath = relativePath(descriptor.root);
  if (!voicePath.endsWith('/codex-resources/voice')) throw new Error('Invalid voice closure root');
  const directory = physicalPath(root, voicePath, 'directory');
  assertProvenanceRecord(root, descriptor.sourceManifest, 'sources.json');
  const original = assertProvenanceRecord(root, descriptor.inventory, 'binaries.json', true);
  const inventory = checkedInventory(JSON.parse(original.bytes.toString('utf8')), descriptor.target);
  checkedRecord(descriptor.manifest, 2 * 1024 ** 2);
  if (descriptor.manifest.path !== 'runtime.json') throw new Error('Invalid voice runtime manifest path');
  const bytes = readBoundMember(directory, descriptor.manifest, 2 * 1024 ** 2, true).bytes;
  const manifest = JSON.parse(bytes.toString('utf8'));
  const libraries = checkedManifest(manifest, descriptor, inventory);
  const members = checkedMembers(directory, descriptor.nativeMembers, libraries);
  return { root, directory, descriptor, members, inspected: new Set(), helper: join(directory, helperPath) };
}

function assertOrigin(descriptor, architecture) {
  if (descriptor.kind !== 'codex-voice-0.159.0') throw new Error('Unreviewed voice closure kind');
  if (descriptor.sourceCommit !== sourceCommit) throw new Error('Unreviewed voice source commit');
  if (!targets.has(architecture) || descriptor.target !== targets.get(architecture)) throw new Error('Voice closure target architecture mismatch');
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid voice ${label}`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) throw new Error(`Unknown or missing voice ${label} field`);
}

function checkedText(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > 4_096) throw new Error('Invalid voice path/text bound');
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Voice path/text contains control characters');
  return value;
}

function relativePath(value) {
  checkedText(value);
  if (value.includes('\\') || posix.isAbsolute(value) || posix.normalize(value) !== value || value === '.' || value.split('/').includes('..')) throw new Error('Invalid voice relative path');
  return value;
}

function contained(root, value) {
  const scoped = relative(root, value);
  return scoped !== '..' && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped);
}

function physicalPath(root, name, kind) {
  const path = resolve(root, relativePath(name));
  if (!contained(root, path)) throw new Error('Voice closure path escapes physical root');
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Voice closure path has a linked ancestor/member');
  }
  const stat = lstatSync(path);
  const valid = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!valid || realpathSync(path) !== path) throw new Error('Voice closure path is not physically regular');
  return path;
}

function checkedRecord(record, maximum) {
  exactFields(record, ['path', 'size', 'sha256'], 'member record');
  relativePath(record.path);
  if (!Number.isSafeInteger(record.size) || record.size < 1 || record.size > maximum) throw new Error('Voice member size bound differs');
  checkedDigest(record.sha256);
}

function checkedDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid voice member/source digest');
}

function assertRegular(stat, record) {
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Voice member must be regular and not a hardlink');
  if (stat.size !== record.size) throw new Error('Voice member size differs');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && right.nlink === 1;
}

function readBoundMember(root, record, maximum, capture = false) {
  checkedRecord(record, maximum);
  const path = physicalPath(root, record.path, 'file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(fd);
    assertRegular(initial, record);
    const result = hashDescriptor(fd, record.size, capture);
    if (result.sha256 !== record.sha256) throw new Error('Voice member digest differs');
    const final = fstatSync(fd);
    assertRegular(final, record);
    if (!sameFile(initial, final) || !sameFile(final, lstatSync(physicalPath(root, record.path, 'file')))) throw new Error('Voice member changed during verification');
    return result;
  } finally { closeSync(fd); }
}

function hashDescriptor(fd, expected, capture) {
  const buffer = Buffer.alloc(32 * 1024), hash = createHash('sha256'), chunks = [];
  let offset = 0, magic = '';
  while (offset < expected) {
    const length = readSync(fd, buffer, 0, Math.min(buffer.length, expected - offset), offset);
    if (!length) throw new Error('Voice member ended before its size bound');
    const chunk = buffer.subarray(0, length);
    if (offset === 0) magic = chunk.subarray(0, 4).toString('hex');
    hash.update(chunk);
    if (capture) chunks.push(Buffer.from(chunk));
    offset += length;
  }
  return { sha256: hash.digest('hex'), magic, bytes: capture ? Buffer.concat(chunks) : null };
}

function assertProvenanceRecord(root, record, name, capture = false) {
  checkedRecord(record, 16 * 1024 ** 2);
  if (record.path !== `konteks/macos-codex-resource-inputs/${name}`) throw new Error('Unreviewed voice provenance input path');
  return readBoundMember(root, record, 16 * 1024 ** 2, capture);
}

function checkedInventory(values, target) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) throw new Error('Voice original inventory row count differs');
  const inventory = new Map();
  for (const row of values) {
    checkedInventoryRow(row, target);
    if (inventory.has(row.path)) throw new Error('Duplicate voice original inventory source path');
    inventory.set(row.path, row.sha256);
  }
  return inventory;
}

function checkedInventoryRow(row, target) {
  exactFields(row, ['path', 'target', 'sha256'], 'original inventory row');
  relativePath(row.path);
  checkedDigest(row.sha256);
  if (row.target !== target) throw new Error('Voice original inventory target differs');
}

function checkedManifest(manifest, descriptor, inventory) {
  exactFields(manifest, ['schemaVersion', 'developmentOnly', 'distribution', 'target', 'sourceCommit', 'sourceManifestSha256', 'inventorySha256', 'libraries', 'plugins'], 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.developmentOnly !== false || manifest.distribution !== 'publicRelease') throw new Error('Voice manifest is not a sealed public release');
  if (manifest.target !== descriptor.target || manifest.sourceCommit !== descriptor.sourceCommit) throw new Error('Voice manifest target/source commit differs');
  if (manifest.sourceManifestSha256 !== descriptor.sourceManifest.sha256) throw new Error('Voice source manifest digest differs from measured input');
  if (manifest.inventorySha256 !== descriptor.inventory.sha256) throw new Error('Voice inventory digest differs from measured input');
  assertPlugins(manifest.plugins);
  return checkedLibraries(manifest.libraries, inventory);
}

function assertPlugins(values) {
  if (!Array.isArray(values) || JSON.stringify([...values].sort()) !== JSON.stringify([...plugins].sort())) throw new Error('Voice manifest plugin set differs');
}

function checkedLibraries(values, inventory) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) throw new Error('Voice library inventory exceeds bound');
  const libraries = new Map();
  const sources = new Set();
  for (const library of values) addCheckedLibrary(library, libraries, sources, inventory);
  if (!libraries.has('lib/libgio-2.0.0.dylib') || plugins.some(name => !libraries.has(name))) throw new Error('Missing required voice library/plugin');
  return libraries;
}

function addCheckedLibrary(library, libraries, sources, inventory) {
  checkedLibrary(library);
  if (libraries.has(library.path) || sources.has(library.sourcePath)) throw new Error('Duplicate voice library member/source path');
  if (inventory.get(library.sourcePath) !== library.sourceSha256) throw new Error('Voice library source path/digest differs from original inventory');
  libraries.set(library.path, library.sha256);
  sources.add(library.sourcePath);
}

function checkedLibrary(library) {
  exactFields(library, ['path', 'sourcePath', 'sourceSha256', 'sha256', 'imports'], 'library');
  if (!/^(?:lib|plugins)\/[a-zA-Z0-9._+-]+\.dylib$/.test(relativePath(library.path))) throw new Error('Unreviewed voice library path');
  relativePath(library.sourcePath);
  checkedDigest(library.sha256);
  checkedDigest(library.sourceSha256);
  if (!Array.isArray(library.imports) || library.imports.length > 128) throw new Error('Voice declared import inventory exceeds bound');
  for (const name of library.imports) checkedText(name);
}

function checkedMembers(directory, values, libraries) {
  if (!Array.isArray(values) || values.length !== libraries.size + 1) throw new Error('Voice native member inventory differs from manifest libraries');
  const members = new Map();
  let total = 0;
  for (const member of values) {
    checkedNativeMember(member, libraries);
    if (members.has(member.path)) throw new Error('Duplicate voice native member');
    if ((total += member.size) > 1024 ** 3) throw new Error('Voice native members exceed total byte bound');
    const result = readBoundMember(directory, member, 256 * 1024 ** 2);
    if (!thinMagic.has(result.magic)) throw new Error('Voice native member is not a thin Mach-O');
    members.set(member.path, member);
  }
  if (!members.has(helperPath)) throw new Error('Missing voice helper member');
  return members;
}

function checkedNativeMember(member, libraries) {
  checkedRecord(member, 256 * 1024 ** 2);
  if (member.path === helperPath) return;
  if (!libraries.has(member.path) || libraries.get(member.path) !== member.sha256) throw new Error('Voice native member digest differs from manifest library');
}

export function macVoiceResourceContext(closures, path) {
  const closure = closures.find(value => contained(value.directory, path));
  if (!closure) return null;
  const name = relative(closure.directory, path).split(sep).join('/');
  const member = closure.members.get(name);
  if (!member) throw new Error('Undeclared native member in voice closure');
  return { closure, path, name };
}

export function assertMacVoiceResourceDependencies(context, commands) {
  if (commands.length > 4_096) throw new Error('Voice load command count exceeds bound');
  const entries = commands.flatMap(loaderEntry);
  const paths = entries.filter(entry => entry.kind === 'LC_RPATH').map(entry => searchDirectory(context, entry.path));
  if (paths.length > 16) throw new Error('Voice rpath count exceeds bound');
  for (const entry of entries.filter(value => value.kind !== 'LC_RPATH')) assertImport(context, entry, paths);
  context.closure.inspected.add(context.name);
}

function loaderEntry({ name, block }) {
  if (name === 'LC_DYLD_ENVIRONMENT') throw new Error('Voice Mach-O embeds a loader environment');
  if (name === 'LC_PREBOUND_DYLIB') throw new Error('Voice prebound dependency is unreviewed');
  if (name === 'LC_ID_DYLIB') return [];
  if (name === 'LC_RPATH') return [{ kind: name, path: dependencyPath(block, 'path') }];
  if (importCommands.has(name)) return [{ kind: name, path: dependencyPath(block, 'name') }];
  if (name.startsWith('LC_LOAD_') || name.endsWith('_DYLIB')) throw new Error('Unknown voice dependency load command');
  return [];
}

function dependencyPath(block, field) {
  const value = new RegExp(`^\\s+${field} (.+) \\(offset \\d+\\)\\s*$`, 'm').exec(block)?.[1];
  if (!value) throw new Error('Missing voice dependency path');
  return checkedText(value);
}

function systemPath(value) {
  return posix.normalize(value) === value && (value === '/usr/lib' || value === '/System/Library' || value.startsWith('/usr/lib/') || value.startsWith('/System/Library/'));
}

function privatePath(context, value) {
  checkedText(value);
  const [token, ...parts] = value.split('/');
  const suffix = parts.join('/');
  if (value.includes('\\') || posix.isAbsolute(suffix) || (suffix && posix.normalize(suffix) !== suffix)) throw new Error('Voice loader dependency path is not normalized');
  const bases = new Map([['@loader_path', dirname(context.path)], ['@executable_path', dirname(context.closure.helper)]]);
  const base = bases.get(token);
  if (!base) throw new Error('Unknown voice loader dependency token');
  const path = resolve(base, ...parts);
  if (!contained(context.closure.directory, path)) throw new Error('Voice loader dependency escapes closure');
  return path;
}

function searchDirectory(context, value) {
  if (systemPath(value)) return { system: true, path: value };
  const path = privatePath(context, value);
  const name = relative(context.closure.directory, path).split(sep).join('/');
  if (!name) return { system: false, path: context.closure.directory };
  physicalPath(context.closure.directory, name, 'directory');
  return { system: false, path };
}

function assertImport(context, entry, paths) {
  if (systemPath(entry.path)) return;
  if (entry.kind === 'LC_LOAD_DYLINKER') throw new Error('Voice loader interpreter is not a system dependency');
  if (entry.path.startsWith('@rpath/')) return assertRpathImport(context, entry.path, paths);
  assertDeclaredNative(context, privatePath(context, entry.path));
}

function assertRpathImport(context, value, paths) {
  checkedText(value);
  if (!/^@rpath\/[a-zA-Z0-9._+-]+\.dylib$/.test(value)) throw new Error('Voice rpath import is not a normalized library basename');
  if (paths.some(path => path.system)) throw new Error('Voice rpath import permits a host loader fallback');
  const candidates = new Set();
  for (const directory of paths) {
    const path = resolve(directory.path, value.slice('@rpath/'.length));
    if (!contained(context.closure.directory, path)) throw new Error('Voice rpath dependency escapes closure');
    const name = relative(context.closure.directory, path).split(sep).join('/');
    if (context.closure.members.has(name)) candidates.add(assertDeclaredNative(context, path));
    else assertMissingCandidate(path);
  }
  if (candidates.size !== 1) throw new Error('Unresolved or ambiguous voice rpath dependency');
}

function assertMissingCandidate(path) {
  try { lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Voice rpath dependency targets an undeclared/non-native member');
}

function assertDeclaredNative(context, path) {
  const name = relative(context.closure.directory, path).split(sep).join('/');
  const record = context.closure.members.get(name);
  if (!record) throw new Error('Voice dependency targets an unresolved/undeclared native member');
  readBoundMember(context.closure.directory, record, 256 * 1024 ** 2);
  return path;
}

export function assertMacVoiceResourceInspections(closures) {
  for (const closure of closures) {
    if (closure.inspected.size !== closure.members.size) throw new Error('Voice closure contains uninspected native members');
    for (const member of closure.members.values()) readBoundMember(closure.directory, member, 256 * 1024 ** 2);
    assertProvenanceRecord(closure.root, closure.descriptor.sourceManifest, 'sources.json');
    assertProvenanceRecord(closure.root, closure.descriptor.inventory, 'binaries.json');
    readBoundMember(closure.directory, closure.descriptor.manifest, 2 * 1024 ** 2);
  }
}
