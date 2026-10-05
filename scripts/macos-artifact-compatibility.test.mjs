import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertMacOsMetadata, assertMacOsArtifact, assertMacOsArtifactTree } from './macos-artifact-compatibility.mjs';

// Synthetic command-output fixtures exercise policy decisions, not release acceptance.
const options = { architecture: 'arm64', minimumOS: '13' };
const command = (name, fields) => `Load command 0\n      cmd ${name}\n  cmdsize 32\n${fields}\n`;
const build = version => command('LC_BUILD_VERSION', ` platform 1\n    minos ${version}\n      sdk 26.0`);
const dependency = name => command('LC_LOAD_DYLIB', `     name ${name} (offset 24)`);
const metadata = (loadCommands = build('11.0'), architectures = 'arm64') => ({ architectures, loadCommands });

test('accepts pinned Node target and exact advertised macOS floor', () => {
  assert.doesNotThrow(() => assertMacOsMetadata(metadata(build('11.0') + dependency('/usr/lib/libSystem.B.dylib')), options));
  assert.doesNotThrow(() => assertMacOsMetadata(metadata(build('13.0.0')), options));
  assert.doesNotThrow(() => assertMacOsMetadata(metadata(build('13'), 'x86_64'), { ...options, architecture: 'amd64' }));
});

test('accepts legacy macOS version metadata and system frameworks', () => {
  const legacy = command('LC_VERSION_MIN_MACOSX', '  version 12.0\n      sdk 15.0');
  assert.doesNotThrow(() => assertMacOsMetadata(metadata(legacy + dependency('/System/Library/Frameworks/Security.framework/Versions/A/Security')), options));
});

for (const version of ['13.0.1', '13.1', '14.0', '26.0']) {
  test(`refuses minimum OS ${version} above advertised 13.0`, () => {
    assert.throws(() => assertMacOsMetadata(metadata(build(version)), options), /minimum OS exceeds/);
  });
}

for (const architectures of ['x86_64', 'arm64 x86_64', 'arm64e', '', 'arm64 arm64']) {
  test(`refuses a wrong, universal or ambiguous architecture: ${architectures || '(missing)'}`, () => {
    assert.throws(() => assertMacOsMetadata(metadata(build('11.0'), architectures), options), /expected thin/);
  });
}

test('refuses unknown target architecture', () => {
  assert.throws(() => assertMacOsMetadata(metadata(), { ...options, architecture: 'aarch64' }), /Unsupported/);
});

test('refuses missing, malformed or other-platform minimum metadata', () => {
  assert.throws(() => assertMacOsMetadata(metadata(dependency('/usr/lib/libSystem.B.dylib')), options), /No macOS minimum/);
  assert.throws(() => assertMacOsMetadata(metadata(build('garbage')), options), /Invalid macOS version/);
  assert.throws(() => assertMacOsMetadata(metadata(command('LC_BUILD_VERSION', ' platform 2\n    minos 11.0')), options), /non-macOS/);
  assert.throws(() => assertMacOsMetadata(metadata(build('11.0') + build('26.0')), options), /minimum OS exceeds/);
  for (const name of ['LC_VERSION_MIN_IPHONEOS', 'LC_VERSION_MIN_TVOS', 'LC_VERSION_MIN_WATCHOS']) {
    assert.throws(() => assertMacOsMetadata(metadata(build('11.0') + command(name, '  version 11.0')), options), /non-macOS/);
  }
});

for (const name of ['/opt/homebrew/lib/libtool.dylib', '/usr/local/lib/libtool.dylib', '@rpath/libtool.dylib', '@loader_path/libtool.dylib', '@executable_path/libtool.dylib', '/usr/lib/../../opt/homebrew/lib/libtool.dylib', '/System/LibraryExtra/libtool.dylib']) {
  test(`refuses non-system or traversing dependency ${name}`, () => {
    assert.throws(() => assertMacOsMetadata(metadata(build('11.0') + dependency(name)), options), /non-system dependency/);
  });
}

test('inspects weak/reexport/upward/dynamic-loader imports but not the dylib own identity', () => {
  for (const name of ['LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LOAD_DYLINKER']) {
    assert.throws(() => assertMacOsMetadata(metadata(build('11.0') + command(name, '     name /opt/homebrew/lib/injected.dylib (offset 24)')), options), /non-system dependency/);
  }
  assert.doesNotThrow(() => assertMacOsMetadata(metadata(build('11.0') + command('LC_ID_DYLIB', '     name /fixture/own-identity.dylib (offset 24)')), options));
  assert.throws(() => assertMacOsMetadata(metadata(build('11.0') + command('LC_DYLD_ENVIRONMENT', '     name DYLD_INSERT_LIBRARIES=/fixture/injected.dylib (offset 24)')), options), /loader environment/);
});

test('refuses malformed imported names rather than silently skipping them', () => {
  assert.throws(() => assertMacOsMetadata(metadata(build('11.0') + command('LC_LOAD_DYLIB', '     name missing-offset')), options), /Missing dependency/);
});

test('refuses relative and non-system loader search paths', () => {
  for (const path of ['@loader_path', '/opt/homebrew/lib', '/usr/lib/../../opt/lib']) {
    assert.throws(() => assertMacOsMetadata(metadata(build('11.0') + command('LC_RPATH', `     path ${path} (offset 12)`)), options), /non-system dependency/);
  }
  assert.doesNotThrow(() => assertMacOsMetadata(metadata(build('11.0') + command('LC_RPATH', '     path /usr/lib/konteks (offset 12)')), options));
  assert.doesNotThrow(() => assertMacOsMetadata(metadata(build('11.0') + command('LC_RPATH', '     path /usr/lib (offset 12)')), options));
});

test('tree inspection refuses an empty/non-Mach-O artifact set', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'konteks-macos-empty-'));
  try {
    writeFileSync(join(directory, 'readme.txt'), 'fixture');
    assert.throws(() => assertMacOsArtifactTree(directory, nativeOptions()), /No Mach-O/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native macOS CI inspects produced harmless dylibs without executing them', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'konteks-macos-binary-'));
  try {
    const source = join(directory, 'fixture.c');
    writeFileSync(source, 'int konteks_fixture(void) { return 0; }\n');
    const native = nativeOptions();
    const allowed = compileDylib(source, join(directory, 'allowed.dylib'), '13.0');
    assert.doesNotThrow(() => assertMacOsArtifact(allowed, native));
    const tooNew = compileDylib(source, join(directory, 'too-new.dylib'), '14.0');
    assert.throws(() => assertMacOsArtifact(tooNew, native), /minimum OS exceeds/);
    const opposite = process.arch === 'arm64' ? 'x86_64' : 'arm64';
    const wrong = compileDylib(source, join(directory, 'wrong.dylib'), '13.0', opposite);
    assert.throws(() => assertMacOsArtifact(wrong, native), /expected thin/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native macOS CI scans nonexecutable .node files and refuses escaping or direct artifact links', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'konteks-macos-tree-'));
  try {
    const source = join(directory, 'fixture.c');
    writeFileSync(source, 'int konteks_fixture(void) { return 0; }\n');
    const native = compileDylib(source, join(directory, 'fixture.node'), '13.0');
    chmodSync(native, 0o600);
    const link = join(directory, 'inside-link');
    symlinkSync('fixture.node', link);
    assert.equal(assertMacOsArtifactTree(directory, nativeOptions()), 1);
    assert.throws(() => assertMacOsArtifact(link, nativeOptions()), /regular file/);
    symlinkSync('/usr/lib', join(directory, 'outside-link'));
    assert.throws(() => assertMacOsArtifactTree(directory, nativeOptions()), /escapes regular bundled files/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native macOS CI refuses an actual unbundled host dylib import', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'konteks-macos-import-'));
  try {
    const source = join(directory, 'library.c');
    writeFileSync(source, 'int konteks_fixture(void) { return 0; }\n');
    const library = compileDylib(source, join(directory, 'library.dylib'), '13.0', undefined, ['-Wl,-install_name,/opt/homebrew/lib/konteks-fixture.dylib']);
    const consumer = join(directory, 'consumer.c');
    writeFileSync(consumer, 'extern int konteks_fixture(void); int konteks_consumer(void) { return konteks_fixture(); }\n');
    const artifact = compileDylib(consumer, join(directory, 'consumer.dylib'), '13.0', undefined, [library]);
    assert.throws(() => assertMacOsArtifact(artifact, nativeOptions()), /non-system dependency/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function nativeOptions() {
  return { architecture: process.arch === 'arm64' ? 'arm64' : 'amd64', minimumOS: '13' };
}

function compileDylib(source, out, minimumOS, architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64', extra = []) {
  execFileSync('/usr/bin/clang', ['-dynamiclib', '-arch', architecture, `-mmacosx-version-min=${minimumOS}`, source, ...extra, '-o', out], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  return out;
}
