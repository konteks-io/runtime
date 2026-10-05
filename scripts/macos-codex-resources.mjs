/** Prepare the two reviewed Mac Codex resource owners before native inspection and inventory. */
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { discoverMacCodexResourceOwners } from './macos-codex-resource-owners.mjs';
import { buildMac13ResourceCandidate } from './mac13-resource-probe/probe.mjs';

const CODEX = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const CODEX_TREE = 'bee1375c8502e4c4d71db017f7e087dfbb3e775c';
const ZSH = '77045ef899e53b9598bebc5a41db93a548a40ca6';
const SEAL = '96aab48ce7156ecab5343b55836162956e84f5b43fdb34dde8f54766c154be40';
const CPAL = Object.freeze({ crate: '6f02e8d0327b42d3e2e4ab2119af397344eb9fc54a34bf0ddeaa1277af8681f1',
  patch: '97f209eb3af032c04f72522cb7f7282f15f6254cce5badffb2c98fffd7c3e4fe',
  candidate: '981f569aeca0a715f4f403fcbd315dd31f50cdd303f4aa789c56ff878e3041ba',
  preparer: 'ad23376b9cb96239ea74c8ab6e45a45b39bedf5c5445a5e2e37c02e47ed3c0fd' });
const LINK_SOURCE = Object.freeze({
  build: { member: 'third_party/voice/BUILD.bazel', sha256: '80e56372c8b9027e5afc4de644f4b923dbb3570ef445f25ec9860c80d4223c61',
    anchor: 'name = "native_link_" + os + "_" + cpu,' },
  nativeLink: { member: 'third_party/voice/native_link.bzl', sha256: '38736a14a8975ef5a15779b87f31093b706e0dcfe44213ba86a9e7d1935d369c',
    anchor: 'dynamic_library_symlink_path = "voice/" + ctx.label.name + "/" + filename,' } });
const IMPORTS = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_DYLINKER']);
const MAX_BYTES = 1024 ** 3;
const INPUTS = 'konteks/macos-codex-resource-inputs';
const MEMBER = /^(?:runtime\.json|bin\/codex-voice-host|(?:lib|plugins)\/[A-Za-z0-9_+.-]+\.dylib)$/;
const PLUGINS = ['app', 'audioconvert', 'audioresample', 'coreelements', 'opus', 'rtp', 'rtpmanager']
  .map(name => `plugins/libgst${name}.dylib`);

function check(value, message) { if (!value) throw new Error(message); }
function exact(value, keys) { check(value && Object.keys(value).sort().join(',') === keys.slice().sort().join(','), 'Resource record shape refused'); }
function digest(value) { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Resource digest refused'); return value; }
function scoped(root, file) {
  const path = relative(root, file);
  check(path !== '' && !isAbsolute(path) && !path.split(sep).includes('..'), 'Resource path escaped its root');
  return path.split(sep).join('/');
}

async function physical(root, file, kind) {
  let cursor = root;
  for (const part of scoped(root, file).split('/')) {
    cursor = join(cursor, part);
    check(!(await lstat(cursor)).isSymbolicLink(), 'Linked resource path refused');
  }
  check(await realpath(file) === resolve(file), 'Resource path redirected');
  const info = await lstat(file);
  check(kind === 'file' ? info.isFile() : info.isDirectory(), 'Resource entry type refused');
  if (kind === 'file') check(info.nlink === 1, 'Hard-linked resource file refused');
  return info;
}

function statIdentity(info) { return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.nlink]; }

async function fileProof(root, file, maximum = MAX_BYTES) {
  const info = await physical(root, file, 'file');
  check(info.size > 0 && info.size <= maximum, 'Resource file byte bound refused');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    check(JSON.stringify(statIdentity(await handle.stat())) === JSON.stringify(statIdentity(info)), 'Resource changed before hashing');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      size += chunk.length;
      check(size <= info.size, 'Resource grew while hashing');
      hash.update(chunk);
    }
    check(size === info.size, 'Resource shrank while hashing');
    check(JSON.stringify(statIdentity(await handle.stat())) === JSON.stringify(statIdentity(info)), 'Resource changed while hashing');
    return { path: scoped(root, file), size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function treeProof(root, directory) {
  await physical(root, directory, 'directory');
  const pending = [directory];
  const records = [];
  let bytes = 0;
  for (const parent of pending) {
    for (const name of (await readdir(parent)).sort()) {
      const file = join(parent, name);
      const info = await lstat(file);
      if (info.isDirectory()) { await physical(root, file, 'directory'); pending.push(file); }
      else { const row = await fileProof(root, file); records.push(row); bytes += row.size; }
      check(records.length + pending.length <= 256, 'Resource tree file bound refused');
      check(bytes <= MAX_BYTES, 'Resource tree byte bound refused');
    }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

async function inputProof(root, discovered) {
  const files = [discovered.bridge.entry.path, 'node_modules/@agentclientprotocol/codex-acp/package.json'];
  for (const owner of discovered.owners) {
    files.push(owner.wrapper.path, `${dirname(owner.wrapper.path)}/../package.json`,
      `${owner.platform.root}/package.json`, owner.codex.path, owner.zsh.path);
    if (owner.voice.present) files.push(...(await treeProof(root, join(root, dirname(dirname(owner.voice.helper.path))))).map(row => row.path));
  }
  const result = [];
  for (const file of [...new Set(files.map(value => scoped(root, resolve(root, value))))].sort()) result.push(await fileProof(root, join(root, file)));
  return result;
}

function buildIdentity(receipt, architecture, target) {
  check(receipt.schema === 1 && receipt.candidateOnly === true, 'Resource build receipt identity refused');
  check(receipt.buildAndProbeCompleted === true, 'Verified resource build did not complete');
  check(receipt.architecture === architecture && receipt.target === target, 'Resource build coordinate mismatch');
}

function buildSources(receipt) {
  const { codex, zsh } = receipt.sourcePins;
  check(codex.commit === CODEX && codex.tree === CODEX_TREE, 'Resource source changed');
  check(zsh.commit === ZSH, 'Patched zsh source changed');
  for (const key of ['acceptancePassed', 'macOS13ExecutionProved', 'shippingReplacementApproved',
    'publisherTrustProved', 'developerIdUsed', 'notarizationUsed']) check(receipt[key] === false, 'Resource receipt claims unproved authority');
}

function compilerFacts(receipt, target) {
  const value = receipt.voiceBuild.cpalCandidate;
  const prepared = value.preparation;
  check(prepared.upstreamCommit === CODEX && prepared.upstreamTree === CODEX_TREE, 'CPAL source owner changed');
  check(prepared.crateVersion === '0.18.2' && prepared.crateSha256 === CPAL.crate, 'CPAL crate changed');
  check(prepared.patchSha256 === CPAL.patch && prepared.candidateLoopbackSha256 === CPAL.candidate, 'CPAL candidate changed');
  check(prepared.originalRuntimePreparerSha256 === CPAL.preparer, 'Voice inventory preparation source changed');
  check(prepared.inventoryPreservation.rawBytesOnly === true && prepared.inventoryPreservation.noInspectionAlgorithmChange === true, 'Voice inventory was reconstructed');
  check(value.compilerInputStable === true && JSON.stringify(value.compilerInputBefore) === JSON.stringify(value.compilerInputAfter), 'Effective CPAL compiler input was not stable');
  compilerIdentity(value.compilerInputAfter, target);
}

function compilerIdentity(value, target) {
  check(value.crateVersion === '0.18.2' && value.loopbackSha256 === CPAL.candidate && value.target === target, 'Effective CPAL compiler identity changed');
  check(value.candidateOnly === true && value.shippingReplacementApproved === false, 'CPAL compiler receipt authority refused');
  digest(value.argumentsSha256);
  check(/^[a-f0-9]{16,128}$/.test(value.actionKey), 'CPAL action identity refused');
  check(/^external\/[A-Za-z0-9_+~.-]+\/src\/host\/coreaudio\/macos\/loopback[.]rs$/.test(value.materializedRelativePath), 'CPAL materialized owner refused');
}

function buildMeasurements(receipt) {
  check(receipt.candidateMeetsMeasuredFloor === true && receipt.candidateLoaderClosureResolved === true && receipt.selectedNewerAPIImportsAllWeak === true, 'Resource native measurements refused');
  check(receipt.voiceSeal.normalPinnedSealCompleted === true && receipt.voiceSeal.sourceSha256 === SEAL, 'Normal pinned voice seal was not proved');
  check(receipt.protocol.exitedZero === true, 'Voice caller smoke was not proved');
  check(receipt.zshSmoke.execWrapperObserved === true && receipt.zshSmoke.outputMatched === true, 'Patched zsh caller smoke was not proved');
}

async function buildReceipt(runner, output, built, architecture, target) {
  const proof = await fileProof(runner, join(output, 'receipt.json'), 8 * 1024 ** 2);
  const actual = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'));
  check(JSON.stringify(actual) === JSON.stringify(built), 'Resource builder return differs from its retained receipt');
  buildIdentity(actual, architecture, target);
  buildSources(actual);
  compilerFacts(actual, target);
  buildMeasurements(actual);
  relocationFacts(actual);
  return proof;
}

function relocationSources(source) {
  exact(source, ['commit', 'tree', 'build', 'nativeLink']);
  check(source.commit === CODEX && source.tree === CODEX_TREE, 'Voice relocation source owner changed');
  for (const key of ['build', 'nativeLink']) {
    const row = source[key], expected = LINK_SOURCE[key];
    exact(row, ['member', 'size', 'sha256', 'anchorSha256']);
    check(row.member === expected.member && row.sha256 === expected.sha256, 'Voice relocation source bytes changed');
    check(Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 64 * 1024, 'Voice relocation source size refused');
    check(row.anchorSha256 === createHash('sha256').update(expected.anchor).digest('hex'), 'Voice relocation source anchor changed');
  }
}

function relocationActionOutput(row, label, prefix) {
  exact(row, ['actionKey', 'targetLabel', 'outputPath', 'directory']);
  check(row.targetLabel === label && typeof row.actionKey === 'string' && /^[a-f0-9]{16,128}$/.test(row.actionKey), 'Voice relocation action owner changed');
  const match = new RegExp(`^bazel-out/[A-Za-z0-9_+.-]+/bin/(_solib_[A-Za-z0-9_]+/voice/native_link_${prefix})/[A-Za-z0-9_+.-]+[.]dylib$`).exec(row.outputPath);
  check(match && row.directory === match[1], 'Voice relocation action output layout changed');
  return row.directory;
}

function relocationAction(action, target) {
  exact(action, ['graphSha256', 'targetLabel', 'outputs', 'staleRpath']);
  digest(action.graphSha256);
  const prefix = new Map([['aarch64-apple-darwin', 'macos_aarch64'], ['x86_64-apple-darwin', 'macos_x86_64']]).get(target);
  check(prefix, 'Voice relocation target refused');
  const label = `//third_party/voice:native_link_${prefix}`;
  check(action.targetLabel === label, 'Voice relocation action label changed');
  check(Array.isArray(action.outputs) && action.outputs.length > 0 && action.outputs.length <= 128, 'Voice relocation action count refused');
  const directories = action.outputs.map(row => relocationActionOutput(row, label, prefix));
  check(new Set(directories).size === 1 && new Set(action.outputs.map(row => row.outputPath)).size === action.outputs.length, 'Voice relocation action outputs are ambiguous');
  check(action.staleRpath === `@loader_path/../../${directories[0]}`, 'Voice relocation search path was not derived from the action');
}

function relocationImports(values) {
  check(Array.isArray(values) && values.length <= 128, 'Voice relocation import count refused');
  for (const row of values) {
    exact(row, ['kind', 'name']);
    check(IMPORTS.has(row.kind), 'Voice relocation import kind refused');
    check(typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 4096, 'Voice relocation import bound refused');
  }
}

function relocationMetadata(value) {
  exact(value.before, ['imports', 'rpaths']);
  exact(value.after, ['imports', 'rpaths']);
  relocationImports(value.before.imports); relocationImports(value.after.imports);
  check(JSON.stringify(value.before.imports) === JSON.stringify(value.after.imports), 'Voice relocation changed its imports');
  check(Array.isArray(value.before.rpaths) && JSON.stringify(value.before.rpaths.slice().sort()) === JSON.stringify([value.action.staleRpath, '@loader_path/../lib'].sort()), 'Voice relocation original search paths changed');
  check(JSON.stringify(value.after.rpaths) === '["@loader_path/../lib"]', 'Voice relocation retained an unreviewed search path');
  check(value.deletedRpath === value.action.staleRpath, 'Voice relocation deleted a different search path');
}

function relocationByteIdentity(row) {
  check(Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 256 * 1024 ** 2, 'Voice relocation byte count refused');
  digest(row.sha256);
}

function relocationSignature(signature) {
  exact(signature, ['existingSignatureUsable', 'adHocAddedByProbe', 'publisherTrustProved']);
  check(typeof signature.existingSignatureUsable === 'boolean' && typeof signature.adHocAddedByProbe === 'boolean', 'Voice relocation signature result refused');
  check(signature.existingSignatureUsable !== signature.adHocAddedByProbe && signature.publisherTrustProved === false, 'Voice relocation signature authority refused');
}

function relocationSignedHelper(receipt, value) {
  exact(value.input, ['size', 'sha256']); exact(value.output, ['size', 'sha256']);
  relocationByteIdentity(value.input); relocationByteIdentity(value.output);
  exact(value.signedHelper, ['size', 'sha256', 'signature']);
  relocationByteIdentity(value.signedHelper); relocationSignature(value.signedHelper.signature);
  const helper = receipt.outputs.voice.members.find(row => row.path === 'bin/codex-voice-host');
  check(helper && helper.size === value.signedHelper.size && helper.sha256 === value.signedHelper.sha256, 'Voice relocation signed bytes differ from final output');
  const inspected = receipt.inspection.binaries.find(row => row.path === 'codex-resources/voice/bin/codex-voice-host');
  check(inspected && inspected.size === helper.size && inspected.sha256 === helper.sha256, 'Voice relocation signed bytes differ from final inspection');
  check(JSON.stringify(inspected.rpaths) === JSON.stringify(value.after.rpaths), 'Voice relocation final inspected search paths differ');
  check(JSON.stringify(inspected.imports.map(row => ({ kind: row.kind, name: row.name }))) === JSON.stringify(value.after.imports), 'Voice relocation final inspected imports differ');
}

function relocationFacts(receipt) {
  const value = receipt.voiceRelocation;
  exact(value, ['source', 'action', 'before', 'after', 'input', 'output', 'deletedRpath', 'fixedTool', 'importsUnchanged', 'publisherTrustProved', 'signedHelper']);
  check(value.fixedTool === '/usr/bin/install_name_tool' && value.importsUnchanged === true && value.publisherTrustProved === false, 'Voice relocation fixed operation refused');
  relocationSources(value.source); relocationAction(value.action, receipt.target);
  relocationMetadata(value); relocationSignedHelper(receipt, value);
}

function memberRecord(row) {
  exact(row, ['path', 'size', 'sha256']);
  check(typeof row.path === 'string' && MEMBER.test(row.path), 'Voice resource member path refused');
  check(Number.isSafeInteger(row.size) && row.size > 0 && row.size <= MAX_BYTES, 'Voice resource member size refused');
  digest(row.sha256);
}

async function measuredFile(root, row, maximum = MAX_BYTES) {
  exact(row, ['path', 'size', 'sha256']);
  digest(row.sha256);
  const actual = await fileProof(root, row.path, maximum);
  check(actual.size === row.size && actual.sha256 === row.sha256, 'Built resource bytes differ from measured output');
  return actual;
}

async function candidateProof(receipt, runner) {
  const work = receipt.workDirectory;
  check(isAbsolute(work) && dirname(work) === runner && work.startsWith(join(runner, 'codex-mac13-build-')), 'Build work directory escaped the runner');
  check(await realpath(work) === work && !(await lstat(work)).isSymbolicLink(), 'Build work directory redirected');
  const outputs = receipt.outputs;
  check(outputs.zsh.path === join(work, 'candidate/zsh/zsh') && outputs.voice.directory === join(work, 'candidate/codex-resources/voice'), 'Resource build output slot changed');
  await measuredFile(work, outputs.zsh, 32 * 1024 ** 2);
  await physical(work, outputs.voice.directory, 'directory');
  check(Array.isArray(outputs.voice.members) && outputs.voice.members.length <= 130, 'Voice member count refused');
  for (const row of outputs.voice.members) {
    memberRecord(row);
    const file = join(outputs.voice.directory, row.path);
    await measuredFile(work, { ...row, path: file });
  }
  const actual = await treeProof(work, outputs.voice.directory);
  const expected = outputs.voice.members.map(row => ({ ...row, path: scoped(work, join(outputs.voice.directory, row.path)) })).sort((a, b) => a.path.localeCompare(b.path));
  check(JSON.stringify(actual) === JSON.stringify(expected), 'Voice closure contains missing, duplicate or undeclared files');
  return work;
}

function nativeFacts(receipt) {
  const native = [{ ...receipt.outputs.zsh, path: 'zsh/zsh' }, ...receipt.outputs.voice.members
    .filter(row => row.path !== 'runtime.json').map(row => ({ ...row, path: `codex-resources/voice/${row.path}` }))];
  const binaries = receipt.inspection.binaries;
  check(Array.isArray(binaries) && binaries.length === native.length, 'Native inspection set changed');
  check(Array.isArray(receipt.nativeSignatures) && receipt.nativeSignatures.length === native.length, 'Native signature set changed');
  for (const row of native) inspectedMember(receipt, row);
}

function inspectedMember(receipt, row) {
  const measured = receipt.inspection.binaries.filter(value => value.path === row.path);
  check(measured.length === 1, 'Native resource inspection missing or repeated');
  check(measured[0].size === row.size && measured[0].sha256 === row.sha256 && measured[0].minimumAtMost13 === true, 'Native resource differs from measured bytes');
  const signed = receipt.nativeSignatures.filter(value => value.path === row.path);
  check(signed.length === 1, 'Native resource signature missing or repeated');
  check(signed[0].result.existingSignatureUsable === true || signed[0].result.adHocAddedByProbe === true, 'Native resource signature was not usable');
  check(signed[0].result.publisherTrustProved === false, 'Development signature confused with publisher trust');
}

async function sealedManifest(receipt, work, target) {
  const file = join(receipt.outputs.voice.directory, 'runtime.json');
  await fileProof(work, file, 1024 ** 2);
  const value = JSON.parse(await readFile(file, 'utf8'));
  check(value.schemaVersion === 1 && value.target === target && value.sourceCommit === CODEX, 'Voice manifest caller mismatch');
  check(value.developmentOnly === false && value.distribution === 'publicRelease', 'Voice manifest is not normally sealed');
  check(Array.isArray(value.libraries) && value.libraries.length > 0 && value.libraries.length <= 128, 'Voice library count refused');
  const libraries = value.libraries.map(row => ({ path: row.path, sha256: digest(row.sha256) }));
  check(JSON.stringify([...value.plugins].sort()) === JSON.stringify(PLUGINS.slice().sort()), 'Voice plugin contract changed');
  check(libraries.some(row => row.path === 'lib/libgio-2.0.0.dylib'), 'Required voice library missing');
  const expected = ['runtime.json', 'bin/codex-voice-host', ...libraries.map(row => row.path)].sort();
  check(JSON.stringify(expected) === JSON.stringify(receipt.outputs.voice.members.map(row => row.path).sort()), 'Sealed voice closure does not match native output');
  for (const row of libraries) check(receipt.outputs.voice.members.find(member => member.path === row.path).sha256 === row.sha256, 'Sealed voice library digest differs from output');
  return value;
}

async function sourceInputs(receipt, work, manifest) {
  const sources = receipt.outputs.provenance;
  check(sources.sourceManifest.path === join(work, 'voice-source-provenance/sources.json') && sources.inventory.path === join(work, 'voice-source-provenance/binaries.json'), 'Voice provenance output slot changed');
  const sourceManifest = await measuredFile(work, sources.sourceManifest, 1024 ** 2);
  const inventory = await measuredFile(work, sources.inventory, 4 * 1024 ** 2);
  check(sourceManifest.sha256 === manifest.sourceManifestSha256 && inventory.sha256 === manifest.inventorySha256, 'Voice source inventory provenance mismatch');
  return sources;
}

async function copyMeasured(sourceRoot, row, destinationRoot, destination, maximum = MAX_BYTES) {
  const before = await measuredFile(sourceRoot, row, maximum);
  await copyFile(row.path, destination, constants.COPYFILE_EXCL);
  await chmod(destination, (await lstat(row.path)).mode & 0o777);
  const after = await fileProof(destinationRoot, destination, maximum);
  check(before.size === after.size && before.sha256 === after.sha256, 'Resource changed while copying');
  await measuredFile(sourceRoot, row, maximum);
  return after;
}

async function replaceZsh(root, owner, receipt, work) {
  const destination = join(root, owner.zsh.path);
  const temporary = join(dirname(destination), `.konteks-zsh-${randomUUID()}`);
  await copyMeasured(work, receipt.outputs.zsh, root, temporary, 32 * 1024 ** 2);
  await physical(root, destination, 'file');
  await rename(temporary, destination);
  return fileProof(root, destination, 32 * 1024 ** 2);
}

async function replaceVoice(root, owner, receipt, work) {
  const destination = join(root, dirname(dirname(owner.voice.helper.path)));
  const temporary = join(dirname(destination), `voice-konteks-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  for (const row of receipt.outputs.voice.members) {
    const file = join(temporary, row.path);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await copyMeasured(work, { ...row, path: join(receipt.outputs.voice.directory, row.path) }, root, file);
  }
  await physical(root, destination, 'directory');
  // The exact captured top-level voice directory is inside this unpublished package root.
  scoped(root, destination);
  await rm(destination, { recursive: true });
  await rename(temporary, destination);
  return destination;
}

async function copyInputs(root, work, sources) {
  const parent = join(root, 'konteks');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await physical(root, parent, 'directory');
  const directory = join(root, INPUTS);
  await mkdir(directory, { mode: 0o700 });
  return { sourceManifest: await copyMeasured(work, sources.sourceManifest, root, join(directory, 'sources.json'), 1024 ** 2),
    inventory: await copyMeasured(work, sources.inventory, root, join(directory, 'binaries.json'), 4 * 1024 ** 2) };
}

async function unchangedInputs(root, records) {
  const current = [];
  for (const row of records) current.push(await fileProof(root, join(root, row.path)));
  check(JSON.stringify(current) === JSON.stringify(records), 'Caller package changed during resource build');
}

async function closure(root, voice, receipt, provenance, target) {
  const members = [];
  for (const row of receipt.outputs.voice.members) members.push(await fileProof(root, join(voice, row.path)));
  const manifest = members.find(row => row.path === `${scoped(root, voice)}/runtime.json`);
  return { kind: 'codex-voice-0.159.0', root: scoped(root, voice), target, sourceCommit: CODEX,
    manifest: { ...manifest, path: 'runtime.json' }, ...provenance,
    nativeMembers: members.filter(row => row !== manifest).map(row => ({ ...row, path: relative(voice, join(root, row.path)).split(sep).join('/') })) };
}

async function canonicalRoot(input) {
  check(typeof input.root === 'string' && isAbsolute(input.root), 'Explicit package root required');
  const info = await lstat(input.root);
  check(info.isDirectory() && !info.isSymbolicLink(), 'Package root must be a physical directory');
  return realpath(input.root);
}

async function freshEvidenceOutput(runner) {
  const output = join(runner, 'mac13-resource-probe-evidence');
  try { await lstat(output); }
  catch (error) { if (error.code === 'ENOENT') return output; throw error; }
  throw new Error('Resource build output already exists');
}

export async function prepareMacCodexResourceTree(input) {
  check(input && typeof input === 'object', 'Explicit resource preparation input required');
  if (input.os !== 'macos' || input.agent !== 'codex') return { applies: false, resourceClosures: [] };
  exact(input, ['root', 'os', 'agent', 'architecture']);
  const architectures = { arm64: ['arm64', 'arm64'], amd64: ['x86_64', 'x64'] };
  check(Object.hasOwn(architectures, input.architecture), 'Mac resource architecture refused');
  const [ownerArchitecture, builderArchitecture] = architectures[input.architecture];
  const root = await canonicalRoot(input);
  const discovered = discoverMacCodexResourceOwners({ ...input, root, architecture: ownerArchitecture });
  const before = await inputProof(root, discovered);
  const runner = await realpath(process.env.RUNNER_TEMP);
  const output = await freshEvidenceOutput(runner);
  const built = await buildMac13ResourceCandidate({ architecture: builderArchitecture, output });
  const target = discovered.owners[0].targetTriple;
  const retainedReceipt = await buildReceipt(runner, output, built, builderArchitecture, target);
  const work = await candidateProof(built, runner);
  nativeFacts(built);
  const manifest = await sealedManifest(built, work, target);
  const sources = await sourceInputs(built, work, manifest);
  check(JSON.stringify(discoverMacCodexResourceOwners({ ...input, root, architecture: ownerArchitecture })) === JSON.stringify(discovered), 'Resource owner identities changed during build');
  await unchangedInputs(root, before);
  const zsh = [];
  for (const owner of discovered.owners) zsh.push(await replaceZsh(root, owner, built, work));
  const voice = await replaceVoice(root, discovered.owners[0], built, work);
  const provenance = await copyInputs(root, work, sources);
  const resourceClosure = await closure(root, voice, built, provenance, target);
  const replaced = new Set(discovered.owners.map(owner => owner.zsh.path));
  const voicePrefix = `${scoped(root, voice)}/`;
  await unchangedInputs(root, before.filter(row => !replaced.has(row.path) && !row.path.startsWith(voicePrefix)));
  await writeFile(join(root, 'konteks/macos-codex-resource-provenance.json'), `${JSON.stringify({ schemaVersion: 1,
    architecture: input.architecture, sourceCommit: CODEX, sourceTree: CODEX_TREE, zshSourceCommit: ZSH,
    inputFiles: before, outputZsh: zsh, voice: resourceClosure, normalPinnedSealCompleted: true,
    builderReceipt: retainedReceipt, voiceRelocation: built.voiceRelocation, cpal: { patchSha256: CPAL.patch, loopbackSha256: CPAL.candidate,
      compilerInput: built.voiceBuild.cpalCandidate.compilerInputAfter,
      inventoryPreservation: built.voiceBuild.cpalCandidate.preparation.inventoryPreservation },
    compilerInputStable: true, macOS13ExecutionProved: false, publisherTrustProved: false })}\n`, { flag: 'wx', mode: 0o600 });
  return { applies: true, resourceClosures: [resourceClosure] };
}
