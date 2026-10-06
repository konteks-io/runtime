/** Pinned CPAL source preparation for the shared Mac resource builder; never mutates an installation. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionRows as rows, actionIds as ids, actionIndex as indexed,
  actionRequired as required, actionPath as fragmentPath } from './bazel-actions.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/cpal-0.18.2-availability/', import.meta.url));
const COMMIT = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const TREE = 'bee1375c8502e4c4d71db017f7e087dfbb3e775c';
const PATCH = 'konteks_cpal_process_tap_availability.patch';
const MEMBER = 'src/host/coreaudio/macos/loopback.rs';
const HASH = Object.freeze({
  module: 'a00f5bf29f9a5978fedf1446d5ab1dde219ecd6dec3e247bba0207148b571bb2',
  build: 'd7896530b94656192baca7e4a0953549a30392b39c34581abaabc4cc3b70a01c',
  lock: '16b915e94730a7e598182620923fc6eae19e32366d3b5ef91128002575ae24af',
  crate: '6f02e8d0327b42d3e2e4ab2119af397344eb9fc54a34bf0ddeaa1277af8681f1',
  patch: '97f209eb3af032c04f72522cb7f7282f15f6254cce5badffb2c98fffd7c3e4fe',
  candidate: '981f569aeca0a715f4f403fcbd315dd31f50cdd303f4aa789c56ff878e3041ba',
  crateManifest: '3d12cc7e5a8744461a2173c5cd8ac5b61e6067ace219cb3fd45a31894830198b',
  preparer: 'ad23376b9cb96239ea74c8ab6e45a45b39bedf5c5445a5e2e37c02e47ed3c0fd',
});
const ANNOTATION = `crate.annotation(
    crate = "cpal",
    version = "0.18.2",
    repositories = ["crates"],
    patch_args = ["-p1"],
    patches = ["//patches:${PATCH}"],
)

`;
const MODULE_ANCHOR = 'crate.annotation(\n    # Daemon tests repeatedly hash large CLI binaries';
const PRESERVE_ANCHOR = '        platform.project(prefix, receipts, target, output)\n';
const PRESERVE_BYTES = `${PRESERVE_ANCHOR}        with (output / "konteks-source-inventory.json").open("xb") as preserved:
            preserved.write((receipts / "inspection/binaries.json").read_bytes())
`;
const TARGETS = new Set(['aarch64-apple-darwin', 'x86_64-apple-darwin']);
const PLATFORMS = Object.freeze({ 'aarch64-apple-darwin': 'darwin_arm64', 'x86_64-apple-darwin': 'darwin_x86_64' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };

function contained(root, file) {
  const local = relative(root, file);
  check(local !== '' && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`), 'CPAL source escaped its owned root');
  return file;
}

async function physical(root, file) {
  root = resolve(root);
  file = contained(root, resolve(file));
  check(await realpath(root) === root, 'CPAL owned root is redirected');
  let cursor = file;
  while (cursor !== root) {
    const info = await lstat(cursor);
    check(!info.isSymbolicLink(), 'CPAL source path is linked');
    cursor = dirname(cursor);
  }
  check(await realpath(file) === file, 'CPAL source path is redirected');
  return file;
}

async function boundedBytes(root, file, maximum) {
  await physical(root, file);
  const info = await lstat(file);
  check(info.isFile() && info.nlink === 1 && info.size <= maximum, 'CPAL source type or size refused');
  const bytes = await readFile(file);
  check(bytes.length === info.size, 'CPAL source changed during read');
  return bytes;
}

async function pinned(root, file, hash, maximum = 1024 ** 2) {
  const bytes = await boundedBytes(root, file, maximum);
  check(digest(bytes) === hash, 'CPAL candidate requires review of this upstream source');
  return bytes.toString('utf8');
}

function replaceOnce(source, anchor, replacement) {
  check(source.split(anchor).length === 2, 'CPAL source anchor changed');
  return source.replace(anchor, replacement);
}

function lockedCpal(lock) {
  const packages = lock.split('\n[[package]]\n').filter(value => /^name = "cpal"$/m.test(value));
  check(packages.length === 1, 'CPAL locked package is ambiguous');
  const expected = `name = "cpal"\nversion = "0.18.2"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${HASH.crate}"`;
  check(packages[0].startsWith(expected), 'CPAL locked version or checksum changed');
}

async function newPatchPath(root) {
  const directory = await physical(root, join(root, 'patches'));
  const file = join(directory, PATCH);
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') return file; throw error; }
  throw new Error('CPAL candidate patch already exists');
}

export async function prepareCpalAvailabilityCandidate(codex) {
  check(codex.head === COMMIT && codex.tree === TREE, 'CPAL candidate requires the exact reviewed Codex source');
  const root = resolve(codex.directory);
  const moduleFile = join(root, 'MODULE.bazel');
  const buildFile = join(root, 'patches/BUILD.bazel');
  const prepareFile = join(root, 'third_party/voice/prepare_built_runtime.py');
  const module = await pinned(root, moduleFile, HASH.module);
  const build = await pinned(root, buildFile, HASH.build);
  const lock = await pinned(root, join(root, 'codex-rs/Cargo.lock'), HASH.lock);
  const preparer = await pinned(root, prepareFile, HASH.preparer);
  lockedCpal(lock);
  const patch = await pinned(FIXTURES, join(FIXTURES, 'process-tap.patch'), HASH.patch);
  const patchFile = await newPatchPath(root);
  const modifiedModule = replaceOnce(module, MODULE_ANCHOR, ANNOTATION + MODULE_ANCHOR);
  const modifiedBuild = replaceOnce(build, 'exports_files([\n', `exports_files([\n    "${PATCH}",\n`);
  const modifiedPreparer = replaceOnce(preparer, PRESERVE_ANCHOR, PRESERVE_BYTES);
  await writeFile(patchFile, patch, { flag: 'wx', mode: 0o600 });
  await writeFile(moduleFile, modifiedModule);
  await writeFile(buildFile, modifiedBuild);
  await writeFile(prepareFile, modifiedPreparer);
  return { candidateOnly: true, upstreamCommit: COMMIT, upstreamTree: TREE, crateVersion: '0.18.2',
    crateSha256: HASH.crate, patchSha256: HASH.patch, candidateLoopbackSha256: HASH.candidate,
    sourceLockSha256: HASH.lock, sourceModuleSha256: HASH.module, sourcePatchBuildSha256: HASH.build,
    modifiedModuleSha256: digest(modifiedModule), modifiedPatchBuildSha256: digest(modifiedBuild),
    originalRuntimePreparerSha256: HASH.preparer, modifiedRuntimePreparerSha256: digest(modifiedPreparer),
    inventoryPreservation: { member: 'konteks-source-inventory.json', rawBytesOnly: true,
      sourceMember: 'third_party/voice/prepare_built_runtime.py', sourceAnchorSha256: digest(PRESERVE_ANCHOR),
      exactSourceReplacementSha256: digest(PRESERVE_BYTES), noInspectionAlgorithmChange: true },
    cargoDependencyChanges: false, shippingReplacementApproved: false };
}

function inputClosure(graph, action) {
  const sets = indexed(graph.depSetOfFiles);
  const pending = ids(action.inputDepSetIds);
  const seen = new Set();
  const artifacts = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    check(seen.size <= 50_000, 'CPAL input closure exceeds bound');
    const row = required(sets, id);
    for (const file of ids(row.directArtifactIds)) artifacts.add(file);
    pending.push(...ids(row.transitiveDepSetIds));
  }
  return artifacts;
}

function actionArguments(action) {
  const parameters = rows(action.paramFiles ?? []);
  const values = [];
  const used = new Set();
  for (const argument of rows(action.arguments)) {
    if (typeof argument === 'string' && argument.startsWith('@')) {
      const matches = parameters.filter(file => file.execPath === argument.slice(1));
      check(matches.length === 1 && !used.has(matches[0]), 'CPAL Rustc parameter file is unbound or repeated');
      used.add(matches[0]);
      values.push(...rows(matches[0].arguments));
    } else values.push(argument);
  }
  check(used.size === parameters.length, 'CPAL Rustc has unconsumed parameter files');
  check(values.every(value => typeof value === 'string' && value.length <= 16_384), 'CPAL Rustc arguments refused');
  check(Buffer.byteLength(JSON.stringify(values)) <= 1024 ** 2, 'CPAL Rustc arguments exceed bound');
  return values;
}

function option(values, key, expected) {
  const direct = values.filter(value => value.startsWith(`${key}=`)).map(value => value.slice(key.length + 1));
  const separate = values.flatMap((value, i) => value === key ? [values[i + 1]] : []);
  const found = [...direct, ...separate];
  check(found.length === 1 && found[0] === expected, 'CPAL Rustc crate or target binding changed');
}

function productionConfiguration(configuration, target) {
  check([undefined, false, true].includes(configuration.isTool), 'CPAL compiler configuration tool flag refused');
  if (configuration.isTool === true) return false;
  const platform = PLATFORMS[target];
  check(configuration.platformName === platform && configuration.mnemonic === `${platform}-opt`, 'CPAL production compiler configuration changed');
  check(typeof configuration.checksum === 'string' && /^[a-f0-9]{64}$/.test(configuration.checksum), 'CPAL compiler configuration checksum refused');
  return true;
}

function compilerAction(graph, target) {
  const configurations = indexed(graph.configuration);
  const actions = rows(graph.actions).filter(action => {
    check(action.mnemonic === 'Rustc', 'CPAL effective compiler action type changed');
    return productionConfiguration(required(configurations, action.configurationId), target);
  });
  check(actions.length === 1 && actions[0].mnemonic === 'Rustc', 'CPAL effective Rustc action is ambiguous');
  const action = actions[0];
  check(typeof action.actionKey === 'string' && /^[a-f0-9]{16,128}$/.test(action.actionKey), 'CPAL action key refused');
  const args = actionArguments(action);
  option(args, '--crate-name', 'cpal');
  option(args, '--crate-type', 'rlib');
  option(args, '--target', target);
  const configuration = required(configurations, action.configurationId);
  return { action, argumentsSha256: digest(JSON.stringify(args)), configuration: {
    mnemonic: configuration.mnemonic, platformName: configuration.platformName, checksum: configuration.checksum, isTool: false } };
}

function compilerMember(graph, action) {
  const artifacts = indexed(graph.artifacts);
  const fragments = indexed(graph.pathFragments);
  const matches = [];
  for (const id of inputClosure(graph, action)) {
    const row = required(artifacts, id);
    const path = fragmentPath(fragments, row.pathFragmentId);
    if (path.endsWith(`/${MEMBER}`)) matches.push(path);
  }
  check(matches.length === 1, 'CPAL loopback is not one exact compiler input');
  const match = new RegExp(`^external/([A-Za-z0-9_+~.-]+)/${MEMBER.replaceAll('.', '[.]')}$`).exec(matches[0]);
  check(match, 'CPAL compiler source is outside a materialized repository');
  const label = required(indexed(graph.targets), action.targetId).label;
  check(label === `@@${match[1]}//:cpal` || label === `@${match[1]}//:cpal`, 'CPAL compiler action belongs to another repository');
  return matches[0];
}

function compilerOutput(graph, selected, member) {
  const artifacts = indexed(graph.artifacts), fragments = indexed(graph.pathFragments);
  const outputs = ids(selected.action.outputIds).map(id => fragmentPath(fragments, required(artifacts, id).pathFragmentId));
  check(outputs.length === 1, 'CPAL production library output is missing or ambiguous');
  const directory = `bazel-out/${selected.configuration.mnemonic}/bin/${member.slice(0, -MEMBER.length)}`;
  check(outputs[0].startsWith(directory), 'CPAL production library output owner changed');
  check(/^libcpal-[A-Za-z0-9_-]+[.]rlib$/.test(outputs[0].slice(directory.length)), 'CPAL production library output type changed');
  return outputs[0];
}

export async function verifyCpalCompilerInput({ text, outputBase, work, target }) {
  check(TARGETS.has(target), 'CPAL candidate target refused');
  check(typeof text === 'string' && Buffer.byteLength(text) <= 4 * 1024 ** 2, 'CPAL action graph text exceeds bound');
  check(isAbsolute(outputBase) && outputBase === outputBase.trim(), 'CPAL Bazel output base refused');
  await physical(work, outputBase);
  const graph = JSON.parse(text);
  const selected = compilerAction(graph, target);
  const member = compilerMember(graph, selected.action);
  const libraryOutputPath = compilerOutput(graph, selected, member);
  const repository = member.slice(0, -MEMBER.length);
  await pinned(outputBase, join(outputBase, repository, 'Cargo.toml'), HASH.crateManifest, 16 * 1024);
  const bytes = await boundedBytes(outputBase, join(outputBase, ...member.split('/')), 64 * 1024);
  check(digest(bytes) === HASH.candidate, 'CPAL effective compiler source differs from the reviewed candidate');
  return { actionKey: selected.action.actionKey, argumentsSha256: selected.argumentsSha256, configuration: selected.configuration, libraryOutputPath,
    loopbackSha256: digest(bytes), materializedRelativePath: member, crateVersion: '0.18.2', crateManifestSha256: HASH.crateManifest,
    target, candidateOnly: true, shippingReplacementApproved: false };
}

export function assertStableCpalCompilerInput(before, after) {
  check(JSON.stringify(before) === JSON.stringify(after), 'CPAL compiler input changed across the build');
}
