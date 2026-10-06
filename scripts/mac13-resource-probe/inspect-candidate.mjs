import { createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

const MAX_FILES = 20_000;
const MAX_BYTES = 1024 ** 3;
const LOAD_COMMAND_BYTES = 2 * 1024 ** 2;
const NEWER_API = /AudioHardware(?:Create|Destroy)ProcessTap|CATapDescription|kAudioTap/;

function assert(value, message) {
  if (!value) throw new Error(message);
}

function contained(root, file) {
  const local = relative(root, file);
  return local !== '' && !isAbsolute(local) && !local.startsWith('..');
}

async function member(root, file) {
  const info = await lstat(file);
  assert(!info.isSymbolicLink(), 'candidate contains a link');
  assert(contained(root, file), 'candidate escaped its root');
  return info;
}

export async function inventory(root) {
  assert(await realpath(root) === resolve(root), 'candidate root is redirected');
  const directories = [root];
  const files = [];
  let bytes = 0;
  for (const directory of directories) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const file = join(directory, name);
      const info = await member(root, file);
      if (info.isDirectory()) directories.push(file);
      else {
        assert(info.isFile(), 'candidate contains a special file');
        files.push({ file, path: relative(root, file), size: info.size });
        bytes += info.size;
      }
      assert(files.length + directories.length <= MAX_FILES, 'candidate file cap exceeded');
      assert(bytes <= MAX_BYTES, 'candidate byte cap exceeded');
    }
  }
  return { files, bytes };
}

export async function sha256(file, maximum = MAX_BYTES) {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), 'hash input is not a regular file');
  assert(info.size <= maximum, 'hash input exceeds byte cap');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 32 * 1024 })) {
    bytes += chunk.length;
    assert(bytes <= maximum, 'hash stream exceeds byte cap');
    hash.update(chunk);
  }
  assert(bytes === info.size, 'hash input changed size');
  return hash.digest('hex');
}

async function macho(file) {
  const handle = await open(file, 'r');
  try {
    const prefix = Buffer.alloc(4);
    const read = await handle.read(prefix, 0, 4, 0);
    if (read.bytesRead < 4) return false;
    const magic = prefix.toString('hex');
    assert(!['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic), 'fat Mach-O candidate');
    return ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface'].includes(magic);
  } finally {
    await handle.close();
  }
}

function commandBlocks(output) {
  assert(Buffer.byteLength(output) <= LOAD_COMMAND_BYTES, 'load commands exceed cap');
  const blocks = output.split(/\nLoad command [0-9]+\n/).slice(1);
  assert(blocks.length > 0 && blocks.length <= 512, 'invalid load command count');
  return blocks;
}

function minimum(blocks) {
  const versions = blocks.flatMap((block) => {
    if (/\bcmd LC_BUILD_VERSION\b/.test(block)) {
      assert(/\bplatform (?:1|MACOS)\b/.test(block), 'non-macOS Mach-O platform');
      return [block.match(/\bminos ([0-9]+(?:\.[0-9]+){1,2})\b/)?.[1]];
    }
    if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) {
      return [block.match(/\bversion ([0-9]+(?:\.[0-9]+){1,2})\b/)?.[1]];
    }
    return [];
  });
  assert(versions.length === 1 && typeof versions[0] === 'string', 'missing or ambiguous macOS minimum');
  return versions[0];
}

function loaderEntry(block) {
  assert(!/\bcmd (?:LC_PREBOUND_DYLIB|LC_DYLD_ENVIRONMENT)\b/.test(block), 'unsupported candidate loader command');
  const kind = block.match(/\bcmd (LC_(?:LOAD|LOAD_WEAK|REEXPORT|LOAD_UPWARD|LAZY_LOAD)_DYLIB|LC_LOAD_DYLINKER|LC_RPATH)\b/)?.[1];
  if (!kind) {
    const command = block.match(/\bcmd (LC_[A-Z0-9_]+)\b/)?.[1] ?? '';
    assert(!/^LC_LOAD_|_DYLIB$/.test(command) || command === 'LC_ID_DYLIB', 'unknown candidate dependency load command');
    return [];
  }
  const name = block.match(/\n\s+(?:name|path) ([^\r\n]+) \(offset [0-9]+\)/)?.[1];
  assert(typeof name === 'string' && name.length <= 4096, 'invalid loader path');
  return [{ kind, name }];
}

function knownAPIImports(output) {
  return output.split('\n').filter((line) => NEWER_API.test(line)).map((line) => {
    assert(line.length <= 4096, 'symbol line exceeds cap');
    return { symbol: line.trim(), weakExternal: /\bweak\b/.test(line) };
  });
}

function loaderPath(value, file, executable) {
  const token = value.split('/')[0];
  const bases = new Map([['@loader_path', dirname(file)], ['@executable_path', dirname(executable)]]);
  const base = bases.get(token);
  if (!base) return null;
  const suffix = value.slice(token.length + 1);
  assert(!value.includes('\\') && !posix.isAbsolute(suffix) && posix.normalize(suffix) === suffix, 'candidate private path is not normalized');
  return resolve(base, suffix);
}

async function nativeMember(root, path, files) {
  const info = await member(root, path);
  assert(info.isFile(), 'private import is not a regular candidate file');
  assert(files.some(row => row.file === path), 'private import is outside the complete candidate inventory');
  assert(info.nlink === 1 && await realpath(path) === path, 'candidate private member is not physically regular');
  assert(await macho(path), 'candidate private member is not thin Mach-O');
  return relative(root, path);
}

async function resolveImport(root, file, executable, entry, files) {
  if (systemImport(entry.name)) return { ...entry, resolution: 'system' };
  const path = loaderPath(entry.name, file, executable);
  if (!path || !contained(root, path)) return { ...entry, resolution: 'unresolved_private' };
  return { ...entry, resolution: 'candidate', path: await nativeMember(root, path, files) };
}

async function rpathDirectories(root, file, executable, entries) {
  const paths = entries.filter(entry => entry.kind === 'LC_RPATH');
  assert(paths.length <= 16, 'candidate rpath count exceeds cap');
  const result = [];
  for (const entry of paths) {
    const suffix = entry.name.slice(entry.name.indexOf('/') + 1);
    assert(!entry.name.includes('\\') && posix.normalize(suffix) === suffix, 'candidate rpath is not normalized');
    const path = loaderPath(entry.name, file, executable);
    assert(path && (path === root || contained(root, path)), 'candidate rpath escapes its closure');
    const info = await lstat(path);
    assert(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path, 'candidate rpath directory is not physical');
    assert(!result.includes(path), 'candidate rpath directory is repeated');
    result.push(path);
  }
  return result;
}

async function rpathImport(root, entry, directories, files) {
  assert(/^@rpath\/[A-Za-z0-9_+.-]+\.dylib$/.test(entry.name), 'candidate rpath import is not a normalized library basename');
  const matches = directories.flatMap(directory => files.filter(row => row.file === join(directory, entry.name.slice(7))));
  assert(matches.length === 1, 'candidate rpath import is unresolved or ambiguous');
  return { ...entry, resolution: 'candidate', path: await nativeMember(root, matches[0].file, files) };
}

async function binaryImports(root, row, executable, entries, files) {
  const directories = await rpathDirectories(root, row.file, executable, entries);
  const imports = [];
  for (const entry of entries.filter(value => value.kind !== 'LC_RPATH')) {
    imports.push(entry.name.startsWith('@rpath/')
      ? await rpathImport(root, entry, directories, files)
      : await resolveImport(root, row.file, executable, entry, files));
  }
  return imports;
}

function systemImport(name) {
  if (!posix.isAbsolute(name) || posix.normalize(name) !== name) return false;
  return name.startsWith('/usr/lib/') || name.startsWith('/System/Library/Frameworks/');
}

function atMost13(value) {
  const [major, minor = 0, patch = 0] = value.split('.').map(Number);
  return major < 13 || (major === 13 && minor === 0 && patch === 0);
}

async function nativeFingerprint(root, row) {
  const info = await member(root, row.file);
  assert(info.isFile() && info.nlink === 1 && info.size === row.size && await realpath(row.file) === row.file,
    'candidate changed during native metadata measurement');
  return JSON.stringify({ size: info.size, dev: info.dev, ino: info.ino,
    mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, sha256: await sha256(row.file) });
}

export async function inspect(root, executable, architecture, command) {
  const found = await inventory(root);
  const binaries = [];
  for (const row of found.files) {
    if (!await macho(row.file)) continue;
    const before = await nativeFingerprint(root, row);
    const arch = (await command('lipo', '/usr/bin/lipo', ['-archs', row.file])).trim();
    assert(arch === architecture, 'candidate architecture mismatch');
    const load = await command('otool-load', '/usr/bin/otool', ['-l', row.file]);
    await command('otool-imports', '/usr/bin/otool', ['-L', row.file]);
    const symbols = await command('nm-undefined', '/usr/bin/nm', ['-m', '-u', row.file]);
    const blocks = commandBlocks(load);
    const minimumOS = minimum(blocks);
    const entries = blocks.flatMap(loaderEntry);
    const imports = await binaryImports(root, row, executable, entries, found.files);
    assert(await nativeFingerprint(root, row) === before, 'candidate changed during native metadata measurement');
    binaries.push({ path: row.path, size: row.size, sha256: JSON.parse(before).sha256, architecture: arch,
      minimumOS, minimumAtMost13: atMost13(minimumOS), imports,
      rpaths: entries.filter((value) => value.kind === 'LC_RPATH').map((value) => value.name),
      selectedNewerAPIImports: knownAPIImports(symbols) });
  }
  assert(binaries.length > 0, 'candidate contains no Mach-O binaries');
  return { fileCount: found.files.length, totalBytes: found.bytes, binaries,
    allMinimumsAtMost13: binaries.every((value) => value.minimumAtMost13),
    privateImportsResolved: binaries.every((value) => value.imports.every((entry) => entry.resolution !== 'unresolved_private')),
    selectedNewerAPIImportsAllWeak: binaries.every((value) => value.selectedNewerAPIImports.every((entry) => entry.weakExternal)),
    symbolAvailabilityFullyClassified: false };
}
