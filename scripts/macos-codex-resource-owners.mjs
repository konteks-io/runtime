/** Build-tree owner discovery only. No wrapper evaluation, resource writes or provenance approval. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const fail = message => { throw new Error(message); };
const check = (value, message) => { if (!value) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contracts = Object.freeze({
  top: { version: '0.159.0', source: '687a119f0fcaace47e1f1abcc77cec6c813fd6da', voice: '0.159-audio-runtime' },
  nested: { version: '0.153.4', source: '3d2ee51ca2d5db578f328aa75e20aa22c0197c9a', voice: '0.153-initialization-contract' },
});

function target(architecture) {
  const targets = { arm64: { cpu: 'arm64', triple: 'aarch64-apple-darwin' }, x86_64: { cpu: 'x64', triple: 'x86_64-apple-darwin' } };
  check(Object.hasOwn(targets, architecture), 'Architecture is outside the reviewed Mac mapping');
  return targets[architecture];
}

function rootPath(input) {
  check(typeof input === 'string' && isAbsolute(input), 'An explicit absolute build root is required');
  check(resolve(input) === input && realpathSync(input) === input, 'Build root is redirected or noncanonical');
  const info = lstatSync(input);
  check(info.isDirectory() && !info.isSymbolicLink(), 'Build root must be a physical directory');
  return input;
}

function relativePath(root, file) {
  const value = relative(root, file);
  check(!isAbsolute(value) && !value.split(sep).includes('..'), 'Resolved file escapes the build root');
  return value;
}

function physical(root, file, kind, maximum = 512 * 1024 ** 2) {
  const parts = relativePath(root, file).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    check(!lstatSync(cursor).isSymbolicLink(), 'Linked package/resource path refused');
  }
  check(realpathSync(file) === resolve(file), 'Package/resource path redirected');
  const info = lstatSync(file);
  check(kind === 'directory' ? info.isDirectory() : info.isFile(), 'Unexpected package/resource file type');
  if (kind === 'file') {
    check(info.nlink === 1, 'Hard-linked package/resource file refused');
    check(info.size > 0 && info.size <= maximum, 'Package/resource file size refused');
  }
  return { path: relativePath(root, file).split(sep).join('/'), size: info.size };
}

function readJson(root, file) {
  physical(root, file, 'file', 64 * 1024);
  const bytes = readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  check(object(value), 'Package identity must be an object');
  return { value, sha256: hash(bytes) };
}

function entryIdentity(root, file, maximum) {
  const selected = physical(root, file, 'file', maximum);
  return { ...selected, sha256: hash(readFileSync(file)) };
}

function present(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function fixedEntry(root, context, specifier, expected) {
  physical(root, expected, 'file', 4 * 1024 ** 2);
  const file = createRequire(context).resolve(specifier);
  check(file === expected, 'Unexpected wrapper owner/fallback layout');
  physical(root, file, 'file', 4 * 1024 ** 2);
  return file;
}

function binaryEntry(bin, key, expected) {
  const value = typeof bin === 'string' ? bin : bin?.[key];
  check(value === expected || value === `./${expected}`, 'Unexpected package entrypoint');
}

function bridgeIdentity(root) {
  const directory = join(root, 'node_modules', '@agentclientprotocol', 'codex-acp');
  const manifest = readJson(root, join(directory, 'package.json'));
  check(manifest.value.name === '@agentclientprotocol/codex-acp' && manifest.value.version === '1.10.0', 'ACP identity is outside the reviewed mapping');
  check(manifest.value.dependencies?.['@openai/codex'] === '^0.153.3', 'ACP Codex dependency contract changed');
  binaryEntry(manifest.value.bin, 'codex-acp', 'dist/index.js');
  const entry = join(directory, 'dist', 'index.js');
  return { directory, entry, identity: { version: '1.10.0', manifestSha256: manifest.sha256, entry: entryIdentity(root, entry, 4 * 1024 ** 2) } };
}

function wrapperIdentity(root, context, directory, role, selected) {
  const entry = fixedEntry(root, context, '@openai/codex/bin/codex.js', join(directory, 'bin', 'codex.js'));
  const manifest = readJson(root, join(directory, 'package.json'));
  const expected = contracts[role];
  check(manifest.value.name === '@openai/codex' && manifest.value.version === expected.version, 'Codex wrapper version/name is outside the reviewed mapping');
  binaryEntry(manifest.value.bin, 'codex', 'bin/codex.js');
  const alias = `@openai/codex-darwin-${selected.cpu}`;
  check(manifest.value.optionalDependencies?.[alias] === `npm:@openai/codex@${expected.version}-darwin-${selected.cpu}`, 'Codex platform alias declaration changed');
  return { entry, alias, version: expected.version, manifestSha256: manifest.sha256, wrapper: entryIdentity(root, entry, 256 * 1024) };
}

function platformIdentity(root, wrapper, selected) {
  const expected = join(dirname(dirname(dirname(wrapper.entry))), wrapper.alias.split('/')[1], 'package.json');
  physical(root, expected, 'file', 64 * 1024);
  const manifestFile = createRequire(wrapper.entry).resolve(`${wrapper.alias}/package.json`);
  check(manifestFile === expected, 'Unexpected platform owner/fallback layout');
  const directory = dirname(manifestFile);
  check(basename(directory) === wrapper.alias.split('/')[1] && basename(dirname(directory)) === '@openai' && basename(dirname(dirname(directory))) === 'node_modules', 'Platform alias layout refused');
  const manifest = readJson(root, manifestFile);
  const value = manifest.value;
  check(value.name === '@openai/codex' && value.version === `${wrapper.version}-darwin-${selected.cpu}`, 'Platform manifest name/version mismatch');
  check(JSON.stringify(value.os) === '["darwin"]' && JSON.stringify(value.cpu) === JSON.stringify([selected.cpu]), 'Platform os/cpu mismatch');
  check(JSON.stringify(value.files) === '["vendor"]', 'Platform payload identity incomplete');
  return { directory, manifestSha256: manifest.sha256, version: value.version, alias: wrapper.alias };
}

function voiceSlot(root, vendor, role) {
  const directory = join(vendor, 'codex-resources', 'voice');
  const helper = join(directory, 'bin', 'codex-voice-host');
  const manifest = join(directory, 'runtime.json');
  if (!present(directory)) {
    check(role === 'nested', 'Top-level voice resource slot missing');
    return { present: false, contract: contracts[role].voice, sourceContract: contracts[role].source };
  }
  physical(root, directory, 'directory');
  const entry = physical(root, helper, 'file', 128 * 1024 ** 2);
  if (role === 'top') physical(root, manifest, 'file', 1024 ** 2);
  return { present: true, contract: contracts[role].voice, sourceContract: contracts[role].source, helper: entry, runtimeManifest: present(manifest) ? physical(root, manifest, 'file', 1024 ** 2) : null };
}

function owner(root, context, directory, role, selected) {
  const wrapper = wrapperIdentity(root, context, directory, role, selected);
  const platform = platformIdentity(root, wrapper, selected);
  const vendor = join(platform.directory, 'vendor', selected.triple);
  physical(root, vendor, 'directory');
  return { role, version: wrapper.version, sourceContract: contracts[role].source, wrapper: wrapper.wrapper, wrapperManifestSha256: wrapper.manifestSha256,
    platform: { root: relativePath(root, platform.directory).split(sep).join('/'), alias: platform.alias, version: platform.version, manifestSha256: platform.manifestSha256 },
    targetTriple: selected.triple, codex: physical(root, join(vendor, 'bin', 'codex'), 'file'),
    zsh: physical(root, join(vendor, 'codex-resources', 'zsh', 'bin', 'zsh'), 'file', 32 * 1024 ** 2), voice: voiceSlot(root, vendor, role) };
}

export function discoverMacCodexResourceOwners(input) {
  check(object(input), 'Explicit discovery input required');
  if (input.os !== 'macos' || input.agent !== 'codex') return { applies: false, owners: [] };
  const selected = target(input.architecture);
  const root = rootPath(input.root);
  const bridge = bridgeIdentity(root);
  const top = owner(root, join(root, '__konteks_owner_discovery__.cjs'), join(root, 'node_modules', '@openai', 'codex'), 'top', selected);
  const nested = owner(root, bridge.entry, join(bridge.directory, 'node_modules', '@openai', 'codex'), 'nested', selected);
  check(top.platform.root !== nested.platform.root && top.voice.sourceContract !== nested.voice.sourceContract, 'Resource owners must remain distinct');
  return { applies: true, architecture: input.architecture, bridge: bridge.identity, owners: [top, nested], provenanceVerified: false, resourcesReplaced: false, nativeCodeExecuted: false, mac13CompatibilityProved: false };
}
