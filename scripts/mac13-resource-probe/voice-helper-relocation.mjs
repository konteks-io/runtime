/** Remove only the pinned voice helper's measured Bazel search path before native signing. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { actionIds, actionIndex, actionPath, actionRequired, actionRows } from './bazel-actions.mjs';
import { sha256 } from './inspect-candidate.mjs';

const COMMIT = '687a119f0fcaace47e1f1abcc77cec6c813fd6da';
const TREE = 'bee1375c8502e4c4d71db017f7e087dfbb3e775c';
const PREFIXES = new Map([['macos_aarch64', 'aarch64-apple-darwin'], ['macos_x86_64', 'x86_64-apple-darwin']]);
const SOURCE = Object.freeze({
  build: { member: 'third_party/voice/BUILD.bazel', sha256: '80e56372c8b9027e5afc4de644f4b923dbb3570ef445f25ec9860c80d4223c61',
    anchor: 'name = "native_link_" + os + "_" + cpu,' },
  link: { member: 'third_party/voice/native_link.bzl', sha256: '38736a14a8975ef5a15779b87f31093b706e0dcfe44213ba86a9e7d1935d369c',
    anchor: 'dynamic_library_symlink_path = "voice/" + ctx.label.name + "/" + filename,' },
});
const imports = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_DYLINKER']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };

async function physicalFile(root, file, maximum) {
  const local = relative(root, file);
  check(local !== '' && !isAbsolute(local) && !local.split(sep).includes('..'), 'Voice relocation file escaped its owned root');
  check(await realpath(root) === root, 'Voice relocation root is redirected');
  let cursor = file;
  while (cursor !== root) {
    check(!(await lstat(cursor)).isSymbolicLink(), 'Voice relocation path is linked');
    cursor = dirname(cursor);
  }
  const info = await lstat(file);
  check(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= maximum, 'Voice relocation file type/size refused');
  check(await realpath(file) === file, 'Voice relocation file is redirected');
  return info;
}

async function pinnedSource(codex, selected) {
  const file = join(codex.directory, selected.member);
  const info = await physicalFile(codex.directory, file, 64 * 1024);
  const bytes = await readFile(file);
  check(bytes.length === info.size && hash(bytes) === selected.sha256, 'Voice relocation requires review of pinned source');
  check(bytes.toString('utf8').split(selected.anchor).length === 2, 'Voice relocation source anchor changed');
  return { member: selected.member, size: bytes.length, sha256: selected.sha256, anchorSha256: hash(selected.anchor) };
}

async function sourceBinding(context, codex) {
  check(codex.head === COMMIT && codex.tree === TREE, 'Voice relocation requires the pinned Codex checkout');
  check(PREFIXES.get(context.coordinate.prefix) === context.coordinate.target, 'Voice relocation coordinate refused');
  return { commit: COMMIT, tree: TREE, build: await pinnedSource(codex, SOURCE.build),
    nativeLink: await pinnedSource(codex, SOURCE.link) };
}

function linkOutput(graph, action, label, prefix) {
  check(action.mnemonic === 'SolibSymlink', 'Voice relocation action mnemonic refused');
  check(actionRequired(actionIndex(graph.targets), action.targetId).label === label, 'Voice relocation action target differs');
  check(typeof action.actionKey === 'string' && /^[a-f0-9]{16,128}$/.test(action.actionKey), 'Voice relocation action key refused');
  const outputs = actionIds(action.outputIds);
  check(outputs.length === 1, 'Voice relocation action output is ambiguous');
  const artifact = actionRequired(actionIndex(graph.artifacts), outputs[0]);
  const path = actionPath(actionIndex(graph.pathFragments), artifact.pathFragmentId);
  const pattern = new RegExp(`^bazel-out/[A-Za-z0-9_+.-]+/bin/(_solib_[A-Za-z0-9_]+/voice/native_link_${prefix})/([A-Za-z0-9_+.-]+[.]dylib)$`);
  const match = pattern.exec(path);
  check(match, 'Voice relocation action output is outside the pinned link layout');
  return { actionKey: action.actionKey, targetLabel: label, outputPath: path, directory: match[1] };
}

export function deriveVoiceHelperRpath(text, prefix) {
  check(PREFIXES.has(prefix), 'Voice relocation prefix refused');
  check(typeof text === 'string' && Buffer.byteLength(text) <= 4 * 1024 ** 2, 'Voice relocation action graph exceeds cap');
  const graph = JSON.parse(text);
  const actions = actionRows(graph.actions);
  check(actions.length > 0 && actions.length <= 128, 'Voice relocation action count refused');
  const label = `//third_party/voice:native_link_${prefix}`;
  const outputs = actions.map(action => linkOutput(graph, action, label, prefix));
  check(new Set(outputs.map(value => value.outputPath)).size === outputs.length, 'Voice relocation action outputs repeat');
  const directories = new Set(outputs.map(value => value.directory));
  check(directories.size === 1, 'Voice relocation search directory is ambiguous');
  return { graphSha256: hash(text), targetLabel: label, outputs,
    staleRpath: `@loader_path/../../${outputs[0].directory}` };
}

function loadEntry(block) {
  const kind = /^\s+cmd (LC_[A-Z0-9_]+)\s*$/m.exec(block)?.[1];
  check(kind, 'Voice relocation load command is missing');
  check(!['LC_DYLD_ENVIRONMENT', 'LC_PREBOUND_DYLIB'].includes(kind), 'Voice relocation has an unsafe loader command');
  if (kind === 'LC_ID_DYLIB') return [];
  if (kind !== 'LC_RPATH' && !imports.has(kind)) {
    check(!/^LC_LOAD_|_DYLIB$/.test(kind), 'Voice relocation has an unknown dependency command');
    return [];
  }
  const field = kind === 'LC_RPATH' ? 'path' : 'name';
  const value = new RegExp(`^\\s+${field} ([^\\r\\n]+) \\(offset \\d+\\)\\s*$`, 'm').exec(block)?.[1];
  check(typeof value === 'string' && value.length <= 4096, 'Voice relocation load path refused');
  return [{ kind, name: value }];
}

function helperMetadata(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= 2 * 1024 ** 2, 'Voice relocation load commands exceed cap');
  const blocks = text.split(/\nLoad command [0-9]+\n/).slice(1);
  check(blocks.length > 0 && blocks.length <= 512, 'Voice relocation load command count refused');
  const entries = blocks.flatMap(loadEntry);
  return { imports: entries.filter(value => value.kind !== 'LC_RPATH'),
    rpaths: entries.filter(value => value.kind === 'LC_RPATH').map(value => value.name) };
}

async function linkActions(context, codex, run, buildOptions) {
  const startup = ['--batch', '--nosystem_rc', '--nohome_rc', `--output_user_root=${join(context.work, 'bazel')}`];
  const query = `mnemonic("SolibSymlink", //third_party/voice:native_link_${context.coordinate.prefix})`;
  const text = await run(context, 'voice-link-actions', 'bazel', [...startup, 'aquery', ...buildOptions,
    '--output=jsonproto', '--include_artifacts', query], 300, { cwd: codex.directory });
  return deriveVoiceHelperRpath(text, context.coordinate.prefix);
}

export async function relocateVoiceHelper(context, codex, helper, run, buildOptions) {
  context.stage = 'voice-helper-relocation';
  const source = await sourceBinding(context, codex);
  const action = await linkActions(context, codex, run, buildOptions);
  const info = await physicalFile(context.work, helper, 256 * 1024 ** 2);
  const inputSha256 = await sha256(helper);
  const before = helperMetadata(await run(context, 'voice-rpaths-before', '/usr/bin/otool', ['-l', helper]));
  check(await sha256(helper) === inputSha256, 'Voice helper changed during metadata measurement');
  check(JSON.stringify(before.rpaths.slice().sort()) === JSON.stringify([action.staleRpath, '@loader_path/../lib'].sort()), 'Voice helper has unexpected build search paths');
  await run(context, 'voice-delete-build-rpath', '/usr/bin/install_name_tool', ['-delete_rpath', action.staleRpath, helper]);
  const outputSha256 = await sha256(helper);
  const after = helperMetadata(await run(context, 'voice-rpaths-after', '/usr/bin/otool', ['-l', helper]));
  check(await sha256(helper) === outputSha256, 'Voice helper changed during metadata measurement');
  check(JSON.stringify(after.rpaths) === JSON.stringify(['@loader_path/../lib']), 'Voice helper still has an unexpected search path');
  check(JSON.stringify(before.imports) === JSON.stringify(after.imports), 'Voice helper relocation changed its imports');
  const final = await physicalFile(context.work, helper, 256 * 1024 ** 2);
  return { source, action, before, after, input: { size: info.size, sha256: inputSha256 },
    output: { size: final.size, sha256: outputSha256 }, deletedRpath: action.staleRpath,
    fixedTool: '/usr/bin/install_name_tool', importsUnchanged: true, publisherTrustProved: false };
}
