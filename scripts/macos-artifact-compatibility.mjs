/** Inspect produced Mach-O metadata before native release artifacts are packaged. */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { assertMacVoiceResourceDependencies, assertMacVoiceResourceInspections, createMacVoiceResourceClosures, macVoiceResourceContext } from './macos-voice-resource-closure.mjs';

const architectures = new Map([['arm64', 'arm64'], ['amd64', 'x86_64']]);
const thinMagic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe']);
const fatMagic = new Set(['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const imports = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_PREBOUND_DYLIB', 'LC_LOAD_DYLINKER']);

export function macOsArtifactOptions(architecture) {
  expectedArchitecture(architecture);
  const policy = JSON.parse(readFileSync(new URL('../release/release-policy.json', import.meta.url), 'utf8'));
  const minimumOS = policy.minimums.os.macos;
  versionTuple(minimumOS);
  return { architecture, minimumOS };
}

export function assertMacOsMetadata(metadata, options) {
  assertMetadata(metadata, options, null);
}

function assertMetadata(metadata, options, voiceContext) {
  const expected = expectedArchitecture(options.architecture);
  if (metadata.architectures.trim() !== expected) throw new Error(`Mach-O expected thin ${expected}, found ${metadata.architectures.trim() || '(missing)'}`);
  const commands = loadCommands(metadata.loadCommands);
  const versions = commands.flatMap(minimumVersions);
  if (versions.length === 0) throw new Error('No macOS minimum OS load command');
  const maximum = versionNumber(options.minimumOS);
  for (const version of versions) {
    if (versionNumber(version) > maximum) throw new Error(`Mach-O minimum OS exceeds advertised ${options.minimumOS}: ${version}`);
  }
  if (voiceContext) return assertMacVoiceResourceDependencies(voiceContext, commands);
  for (const command of commands) assertDependencies(command);
}

function expectedArchitecture(architecture) {
  const expected = architectures.get(architecture);
  if (!expected) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  return expected;
}

function versionTuple(version) {
  if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(version)) throw new Error(`Invalid macOS version: ${version}`);
  const [major, minor = 0, patch = 0] = version.split('.').map(Number);
  if (major > 65535 || minor > 255 || patch > 255) throw new Error(`Invalid macOS version: ${version}`);
  return [major, minor, patch];
}

function versionNumber(version) {
  const [major, minor, patch] = versionTuple(version);
  return major * 65536 + minor * 256 + patch;
}

function loadCommands(output) {
  return output.split(/(?:^|\r?\n)Load command \d+\r?\n/).slice(1).map(block => {
    const name = /^\s+cmd (\S+)\s*$/m.exec(block)?.[1];
    if (!name) throw new Error('Malformed Mach-O load command');
    return { name, block };
  });
}

function minimumVersions({ name, block }) {
  if (name === 'LC_VERSION_MIN_MACOSX') return [requiredField(block, 'version')];
  if (name.startsWith('LC_VERSION_MIN_')) throw new Error(`Mach-O has non-macOS minimum command: ${name}`);
  if (name !== 'LC_BUILD_VERSION') return [];
  const platform = requiredField(block, 'platform');
  if (platform !== '1' && platform !== 'MACOS') throw new Error(`Mach-O has non-macOS platform: ${platform}`);
  return [requiredField(block, 'minos')];
}

function requiredField(block, field) {
  const value = new RegExp(`^\\s+${field} (\\S+)\\s*$`, 'm').exec(block)?.[1];
  if (!value) throw new Error(`Missing Mach-O ${field} field`);
  return value;
}

function assertDependencies({ name, block }) {
  if (name === 'LC_DYLD_ENVIRONMENT') throw new Error('Mach-O embeds a loader environment');
  if (name === 'LC_RPATH') return assertSystemPath(dependencyName(block, 'path'));
  if (imports.has(name)) assertSystemPath(dependencyName(block, 'name'));
  // LC_ID_DYLIB is the library's own identity, not an imported dependency.
}

function dependencyName(block, field) {
  const value = new RegExp(`^\\s+${field} (.+) \\(offset \\d+\\)\\s*$`, 'm').exec(block)?.[1];
  if (!value) throw new Error('Missing dependency path in Mach-O load command');
  return value;
}

function assertSystemPath(path) {
  const system = path === '/usr/lib' || path === '/System/Library' || path.startsWith('/usr/lib/') || path.startsWith('/System/Library/');
  if (!system || posix.normalize(path) !== path) throw new Error(`Mach-O has a non-system dependency or loader path: ${path}`);
}

export function assertMacOsArtifact(path, options) {
  inspectArtifact(path, options, null);
}

function inspectArtifact(path, options, voiceContext) {
  if (process.platform !== 'darwin') throw new Error('Produced Mach-O inspection requires a macOS build host');
  const magic = artifactMagic(path);
  if (fatMagic.has(magic)) throw new Error(`Mach-O expected thin ${expectedArchitecture(options.architecture)}: ${path}`);
  if (!thinMagic.has(magic)) throw new Error(`Not a Mach-O artifact: ${path}`);
  const invocation = { encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true };
  try {
    assertMetadata({
      architectures: execFileSync('/usr/bin/lipo', ['-archs', path], invocation),
      loadCommands: execFileSync('/usr/bin/otool', ['-l', path], invocation),
    }, options, voiceContext);
  } catch (cause) {
    throw new Error(`Mach-O compatibility refused ${JSON.stringify(path)}: ${cause.message}`, { cause });
  }
}

function artifactMagic(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Mach-O artifact must be a regular file: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('Mach-O artifact changed file type');
    const bytes = Buffer.alloc(4);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length).toString('hex');
  } finally { closeSync(descriptor); }
}

export function assertMacOsArtifactTree(directory, options) {
  if (process.platform !== 'darwin') throw new Error('Produced Mach-O inspection requires a macOS build host');
  const root = realpathSync(directory);
  if (!statSync(root).isDirectory()) throw new Error('Mach-O artifact tree must be a directory');
  const closures = createMacVoiceResourceClosures(root, options.resourceClosures, options.architecture);
  const state = { root, options, closures, visited: 0, inspected: 0 };
  inspectDirectory(root, state, 0);
  if (state.inspected === 0) throw new Error('No Mach-O artifacts in native package');
  assertMacVoiceResourceInspections(closures);
  return state.inspected;
}

function inspectDirectory(directory, state, depth) {
  if (depth > 64) throw new Error('Mach-O artifact tree exceeds depth bound');
  for (const entry of readdirSync(directory)) {
    if (++state.visited > 20_000) throw new Error('Mach-O artifact tree exceeds entry bound');
    inspectEntry(join(directory, entry), state, depth);
  }
}

function inspectEntry(path, state, depth) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return assertInternalFileLink(path, state.root);
  if (info.isDirectory()) return inspectDirectory(path, state, depth + 1);
  if (!info.isFile()) throw new Error(`Unsupported native package entry: ${path}`);
  const magic = artifactMagic(path);
  if (!thinMagic.has(magic) && !fatMagic.has(magic)) return;
  inspectArtifact(path, state.options, macVoiceResourceContext(state.closures, path));
  state.inspected++;
}

function assertInternalFileLink(path, root) {
  const target = realpathSync(path);
  const scoped = relative(root, target);
  if (scoped === '..' || scoped.startsWith('../') || isAbsolute(scoped) || !statSync(target).isFile()) throw new Error(`Native package link escapes regular bundled files: ${path}`);
  // npm's .bin links may point to regular files elsewhere in this same inspected tree.
}
