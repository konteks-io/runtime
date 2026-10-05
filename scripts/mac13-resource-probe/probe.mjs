import { spawn } from 'node:child_process';
import { constants, closeSync, openSync, writeSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect, sha256 } from './inspect-candidate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX = Object.freeze({ url: 'https://github.com/openai/codex.git', tag: 'rust-v0.159.0',
  tagObject: '377f7f557a6bdea0f3a2d26d4d899c66db4789d0',
  commit: '687a119f0fcaace47e1f1abcc77cec6c813fd6da', tree: 'bee1375c8502e4c4d71db017f7e087dfbb3e775c' });
const ZSH = Object.freeze({ url: 'https://git.code.sf.net/p/zsh/code', commit: '77045ef899e53b9598bebc5a41db93a548a40ca6' });
const ARCH = Object.freeze({ arm64: { target: 'aarch64-apple-darwin', prefix: 'macos_aarch64', macho: 'arm64' },
  x64: { target: 'x86_64-apple-darwin', prefix: 'macos_x86_64', macho: 'x86_64' } });
const MAX_LOG_BYTES = 16 * 1024 ** 2;
const MAX_COMMAND_BYTES = 4 * 1024 ** 2;
const MAX_FRAME_BYTES = 128 * 1024;
const WALL_MILLISECONDS = 105 * 60 * 1000;
const GST = Object.freeze({ GST_PLUGIN_PATH: '', GST_PLUGIN_PATH_1_0: '', GST_PLUGIN_SYSTEM_PATH: '',
  GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_REGISTRY: '/dev/null', GST_REGISTRY_UPDATE: 'no', GST_REGISTRY_FORK: 'no' });

function assert(value, message) {
  if (!value) throw new Error(message);
}

function childPath(root, file) {
  const local = relative(root, file);
  assert(local !== '' && !isAbsolute(local) && !local.startsWith('..'), 'output escaped runner temporary directory');
  return file;
}

function argumentsFor(argv) {
  assert(argv.length === 4 && argv[0] === '--arch' && argv[2] === '--output', 'use --arch arm64|x64 --output NEW_RUNNER_TEMP_DIRECTORY');
  const coordinate = ARCH[argv[1]];
  assert(coordinate, 'unsupported probe architecture');
  assert(isAbsolute(argv[3]), 'output must be absolute');
  return { architecture: argv[1], coordinate, output: resolve(argv[3]) };
}

async function absent(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('output already exists');
}

async function boundedText(file, maximum) {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'invalid bounded text input');
  const value = await readFile(file, 'utf8');
  assert(Buffer.byteLength(value) === info.size, 'text input changed size');
  return value;
}

function remainingSeconds(context, maximum) {
  const remaining = Math.floor((context.deadline - Date.now()) / 1000);
  assert(remaining > 0, 'overall probe deadline exceeded');
  return Math.min(remaining, maximum);
}

async function environment(work) {
  const home = join(work, 'home');
  const temporary = join(work, 'tmp');
  await mkdir(home);
  await mkdir(temporary);
  const selected = { HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', TERM: 'dumb', CI: '1', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', GIT_SSH_COMMAND: '/usr/bin/false',
    CARGO_HOME: join(home, '.cargo'), CARGO_NET_GIT_FETCH_WITH_CLI: 'true', RUSTUP_TOOLCHAIN: '1.95.0',
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME ?? '', '.rustup'),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1',
    BAZELISK_HOME: join(home, '.bazelisk'), STABLE_GIT_COMMIT: CODEX.commit,
    MACOSX_DEPLOYMENT_TARGET: '13.0' };
  for (const key of ['DEVELOPER_DIR']) {
    if (process.env[key]) selected[key] = process.env[key];
  }
  assert(typeof selected.PATH === 'string' && selected.PATH.length <= 16_384, 'missing or excessive CI tool PATH');
  assert(isAbsolute(selected.RUSTUP_HOME), 'missing CI Rust toolchain location');
  return selected;
}

function terminateOwned(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function logSink(context, label) {
  const name = `${String(context.commands.length + 1).padStart(3, '0')}-${label}.log`;
  const fd = openSync(join(context.logs, name), 'wx', 0o600);
  let bytes = 0;
  return { name, close: () => closeSync(fd), append(chunk) {
    bytes += chunk.length;
    context.logBytes += chunk.length;
    assert(bytes <= MAX_COMMAND_BYTES, 'command output exceeds cap');
    assert(context.logBytes <= MAX_LOG_BYTES, 'aggregate log cap exceeded');
    writeSync(fd, chunk);
  } };
}

function commandData(child, sink, stdout, failure) {
  child.stdout.on('data', (chunk) => {
    try { sink.append(chunk); stdout.push(chunk); }
    catch (error) { failure(error); }
  });
  child.stderr.on('data', (chunk) => {
    try { sink.append(chunk); }
    catch (error) { failure(error); }
  });
}

function commandExit(child) {
  return new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ code: null, error }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
}

async function run(context, label, executable, args, seconds = 30, options = {}) {
  seconds = remainingSeconds(context, seconds);
  const sink = logSink(context, label);
  const row = { label, executable, args, seconds, log: sink.name, startedAt: new Date().toISOString() };
  context.commands.push(row);
  const child = spawn(executable, args, { cwd: options.cwd ?? context.work, env: { ...context.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true });
  const stdout = [];
  let refused = null;
  const fail = (error) => { refused ??= error; terminateOwned(child); };
  commandData(child, sink, stdout, fail);
  const timer = setTimeout(() => fail(new Error('command deadline exceeded')), seconds * 1000);
  try {
    const exit = await commandExit(child);
    Object.assign(row, { finishedAt: new Date().toISOString(), code: exit.code, signal: exit.signal ?? null });
    if (refused) throw refused;
    if (exit.error) throw exit.error;
    assert(exit.code === 0, `command failed: ${label}`);
    return Buffer.concat(stdout).toString('utf8');
  } finally {
    clearTimeout(timer);
    sink.close();
  }
}

async function contextFor(input) {
  assert(process.versions.node === '22.23.2', 'pinned Node 22.23.2 is required');
  assert(process.platform === 'darwin' && process.arch === input.architecture, 'probe requires its native macOS architecture');
  assert(process.env.GITHUB_ACTIONS === 'true', 'probe is restricted to a CI runner');
  const runner = await realpath(process.env.RUNNER_TEMP ?? '');
  assert(isAbsolute(runner), 'missing runner temporary directory');
  const output = childPath(runner, input.output);
  assert(await realpath(dirname(output)) === dirname(output), 'output parent is redirected');
  await absent(output);
  await mkdir(output, { mode: 0o700 });
  const work = await mkdtemp(join(runner, 'codex-mac13-build-'));
  assert(await realpath(work) === work, 'fresh build directory is redirected');
  const logs = join(output, 'logs');
  await mkdir(logs);
  return { ...input, work, logs, env: await environment(work), logBytes: 0, commands: [], stage: 'toolchain',
    deadline: Date.now() + WALL_MILLISECONDS };
}

async function checkout(context, name, spec) {
  const directory = join(context.work, name);
  await run(context, `${name}-init`, '/usr/bin/git', ['init', directory]);
  await run(context, `${name}-remote`, '/usr/bin/git', ['-C', directory, 'remote', 'add', 'origin', spec.url]);
  const reference = spec.tag ? `refs/tags/${spec.tag}:refs/tags/${spec.tag}` : spec.commit;
  await run(context, `${name}-fetch`, '/usr/bin/git', ['-C', directory, '-c', 'credential.helper=',
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'fetch', '--depth=1', 'origin', reference], 600);
  await run(context, `${name}-checkout`, '/usr/bin/git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', spec.commit]);
  const head = (await run(context, `${name}-head`, '/usr/bin/git', ['-C', directory, 'rev-parse', 'HEAD'])).trim();
  const tree = (await run(context, `${name}-tree`, '/usr/bin/git', ['-C', directory, 'rev-parse', 'HEAD^{tree}'])).trim();
  assert(head === spec.commit, 'upstream commit mismatch');
  if (spec.tree) assert(tree === spec.tree, 'upstream tree mismatch');
  return { directory, head, tree };
}

async function codexSource(context) {
  const source = await checkout(context, 'codex', CODEX);
  const tag = (await run(context, 'codex-tag', '/usr/bin/git', ['-C', source.directory, 'rev-parse', `refs/tags/${CODEX.tag}`])).trim();
  assert(tag === CODEX.tagObject, 'upstream annotated tag object mismatch');
  assert((await boundedText(join(source.directory, '.bazelversion'), 128)).trim() === '9.0.0', 'upstream Bazel pin changed');
  const release = await boundedText(join(source.directory, '.github/workflows/rust-release-zsh.yml'), 1024 ** 2);
  assert(release.includes(`ZSH_COMMIT: ${ZSH.commit}`), 'upstream zsh pin mismatch');
  assert(release.includes('ZSH_PATCH: codex-rs/shell-escalation/patches/zsh-exec-wrapper.patch'), 'upstream zsh patch changed');
  return source;
}

async function toolchain(context) {
  const tools = { node: process.versions.node };
  for (const [name, executable, args] of [
    ['os', '/usr/bin/sw_vers', ['-productVersion']], ['machine', '/usr/bin/uname', ['-m']],
    ['clang', '/usr/bin/clang', ['--version']], ['python', 'python3', ['--version']],
    ['cargo', 'cargo', ['--version']], ['autoconf', 'autoconf', ['--version']],
  ]) tools[name] = (await run(context, `tool-${name}`, executable, args)).trim();
  assert(/^Python 3\.12\./.test(tools.python), 'Python 3.12 is required');
  assert(/^cargo 1\.95\.0\b/.test(tools.cargo), 'pinned Cargo 1.95.0 is required');
  assert(tools.machine === context.coordinate.macho, 'native runner architecture mismatch');
  return tools;
}

const LOCK_CHECK = `import json,sys,tomllib
from pathlib import Path
a,b=(tomllib.loads(Path(p).read_text()) for p in sys.argv[1:])
def external(v):
    return sorted((p for p in v['package'] if 'source' in p),key=lambda p:(p['name'],p['version'],p['source']))
assert external(a)==external(b),'external Cargo graph changed'
assert {k:v for k,v in a.items() if k!='package'}=={k:v for k,v in b.items() if k!='package'},'Cargo metadata changed'
old={p['name']:p for p in a['package'] if 'source' not in p}
new={p['name']:p for p in b['package'] if 'source' not in p}
assert len(old)==sum('source' not in p for p in a['package']),'ambiguous source workspace packages'
assert len(new)==sum('source' not in p for p in b['package']),'ambiguous refreshed workspace packages'
assert old.keys()==new.keys(),'workspace package set changed'
for name,p in new.items():
    q=old[name]
    assert {k:v for k,v in p.items() if k!='version'}=={k:v for k,v in q.items() if k!='version'},'workspace dependency fields changed'
    assert p['version']==q['version'] or p['version']=='0.159.0','unexpected workspace version'
print(json.dumps({'externalGraphUnchanged':True,'workspacePackages':len(new)}))
`;

async function buildVoice(context, codex) {
  const lock = join(codex.directory, 'codex-rs/Cargo.lock');
  const before = join(context.output, 'Cargo.lock.source');
  await copyFile(lock, before, constants.COPYFILE_EXCL);
  await run(context, 'cargo-workspace-refresh', 'cargo', ['update', '--workspace'], 600, { cwd: join(codex.directory, 'codex-rs') });
  await run(context, 'cargo-lock-graph', 'python3', ['-c', LOCK_CHECK, before, lock]);
  await copyFile(lock, join(context.output, 'Cargo.lock.refreshed'), constants.COPYFILE_EXCL);
  await run(context, 'cargo-lock-diff', '/usr/bin/git', ['-C', codex.directory, 'diff', '--', 'codex-rs/Cargo.lock']);
  const startup = ['--batch', '--nosystem_rc', '--nohome_rc', `--output_user_root=${join(context.work, 'bazel')}`];
  const bazel = (await run(context, 'tool-bazel', 'bazel', [...startup, 'version'], 300, { cwd: codex.directory })).trim();
  assert(/Build label: 9\.0\.0\b/.test(bazel), 'pinned Bazel 9.0.0 is required');
  await run(context, 'voice-build', 'bazel', [...startup, 'build', '-c', 'opt', '--jobs=2', '--macos_minimum_os=13.0',
    '--remote_executor=', '--remote_cache=', '--bes_backend=', '--experimental_remote_downloader=',
    '--disk_cache=', `--repository_cache=${join(context.work, 'repository-cache')}`,
    '//codex-rs/voice-host:codex-voice-host', '//third_party/voice:native_runtime'], 5400, { cwd: codex.directory });
  return { bazel, sourceLockSha256: await sha256(before), refreshedLockSha256: await sha256(lock) };
}

async function stageVoice(context, codex, candidate) {
  const voice = join(candidate, 'codex-resources/voice');
  await mkdir(dirname(voice), { recursive: true });
  const source = join(codex.directory, `bazel-bin/third_party/voice/native_runtime_${context.coordinate.prefix}`);
  await run(context, 'voice-stage-development', 'python3', ['third_party/voice/release_runtime.py', 'stage',
    '--target', context.coordinate.target, '--source', source, '--output', voice], 120,
    { cwd: codex.directory, env: { PYTHONPATH: join(codex.directory, 'third_party/voice') } });
  const manifest = JSON.parse(await boundedText(join(voice, 'runtime.json'), 1024 ** 2));
  assert(manifest.schemaVersion === 1, 'voice development manifest schema mismatch');
  assert(manifest.developmentOnly === true && manifest.target === context.coordinate.target, 'voice stage is not an exact development runtime');
  assert(manifest.sourceCommit === CODEX.commit, 'voice runtime source commit mismatch');
  assert(manifest.sourceManifestSha256 === await sha256(join(codex.directory, 'third_party/voice/sources.json')), 'voice dependency source manifest mismatch');
  await mkdir(join(voice, 'bin'));
  const executable = join(voice, 'bin/codex-voice-host');
  await copyFile(join(codex.directory, 'bazel-bin/codex-rs/voice-host/codex-voice-host'), executable, constants.COPYFILE_EXCL);
  await chmod(executable, 0o755);
  return executable;
}

async function developmentSignature(context, file) {
  try {
    await run(context, 'signature-existing', '/usr/bin/codesign', ['--verify', '--strict', file]);
    return { existingSignatureUsable: true, adHocAddedByProbe: false, publisherTrustProved: false };
  } catch (error) {
    if (context.commands.at(-1).code !== 1) throw error;
  }
  await run(context, 'signature-development-only', '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
  await run(context, 'signature-development-check', '/usr/bin/codesign', ['--verify', '--strict', file]);
  return { existingSignatureUsable: false, adHocAddedByProbe: true, publisherTrustProved: false };
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  assert(payload.length <= MAX_FRAME_BYTES, 'outgoing frame exceeds bound');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function protocolData(state, child, chunk) {
  state.total += chunk.length;
  assert(state.total <= 3 * MAX_FRAME_BYTES + 12, 'helper stdout cap exceeded');
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 4) {
    const length = state.buffer.readUInt32BE(0);
    assert(length > 0 && length <= MAX_FRAME_BYTES, 'invalid helper frame size');
    if (state.buffer.length < length + 4) return;
    const value = JSON.parse(state.buffer.subarray(4, length + 4).toString('utf8'));
    state.buffer = state.buffer.subarray(length + 4);
    protocolReply(state, child, value);
  }
}

function protocolReply(state, child, value) {
  const expected = ['ready', 'runtimeReady', 'closed'][state.received.length];
  assert(expected && value?.type === expected && Object.keys(value).length === 1, 'unexpected helper protocol message');
  state.received.push(value.type);
  const next = { ready: 'initializeRuntime', runtimeReady: 'close' }[value.type];
  if (next) child.stdin.write(frame({ type: next }));
  else child.stdin.end();
}

async function handshake(context, executable) {
  const sink = logSink(context, 'voice-protocol-stderr');
  const seconds = remainingSeconds(context, 60);
  const row = { label: 'voice-protocol', executable, args: [], seconds, log: sink.name,
    inputTypes: ['hello', 'initializeRuntime', 'close'], startedAt: new Date().toISOString() };
  context.commands.push(row);
  const state = { buffer: Buffer.alloc(0), total: 0, received: [] };
  const child = spawn(executable, [], { cwd: context.work, env: { ...context.env, ...GST },
    stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true });
  let failure = null;
  const fail = (error) => { failure ??= error; terminateOwned(child); };
  child.stdout.on('data', (chunk) => {
    try { protocolData(state, child, chunk); } catch (error) { fail(error); }
  });
  child.stderr.on('data', (chunk) => {
    try { sink.append(chunk); } catch (error) { fail(error); }
  });
  child.stdin.on('error', fail);
  const timer = setTimeout(() => fail(new Error('helper handshake deadline exceeded')), seconds * 1000);
  const exitPromise = commandExit(child);
  child.stdin.write(frame({ type: 'hello', protocol: 1, buildCommit: CODEX.commit }));
  try {
    const exit = await exitPromise;
    Object.assign(row, { finishedAt: new Date().toISOString(), code: exit.code, signal: exit.signal ?? null });
    if (failure) throw failure;
    if (exit.error) throw exit.error;
    assert(exit.code === 0 && state.buffer.length === 0, 'helper did not exit cleanly');
    assert(state.received.join(',') === 'ready,runtimeReady,closed', 'helper handshake incomplete');
    return { protocol: 1, buildCommit: CODEX.commit, received: state.received, exitedZero: true,
      noTransportOpeningRequestSent: true, noDeviceOpeningRequestSent: true,
      macOS13ExecutionProved: false, stderrLog: sink.name };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) terminateOwned(child);
    sink.close();
  }
}

async function zshSmoke(context, directory) {
  const output = await run(context, 'zsh-wrapper-smoke', join(directory, 'zsh'), ['-fc', '/bin/echo smoke-zsh'], 10,
    { env: { CODEX_WRAPPER_LOG: join(directory, 'wrapper.log'), EXEC_WRAPPER: join(directory, 'exec-wrapper') } });
  const wrapper = await boundedText(join(directory, 'wrapper.log'), 64 * 1024);
  assert(output.split('\n').includes('smoke-zsh'), 'patched zsh output smoke failed');
  assert(wrapper.split('\n').includes('/bin/echo'), 'patched zsh did not invoke EXEC_WRAPPER');
  await writeFile(join(context.output, 'zsh-smoke.stdout'), output, { flag: 'wx', mode: 0o600 });
  await copyFile(join(directory, 'applied.patch'), join(context.output, 'zsh-applied.patch'), constants.COPYFILE_EXCL);
  return { outputMatched: true, execWrapperObserved: true, macOS13ExecutionProved: false };
}

async function candidates(context, codex) {
  const candidate = join(context.work, 'candidate');
  await mkdir(candidate);
  const zsh = await checkout(context, 'zsh', ZSH);
  const zshOutput = join(candidate, 'zsh');
  await run(context, 'zsh-build', '/bin/bash', ['--noprofile', '--norc',
    join(HERE, 'build-patched-zsh.sh'), zsh.directory, codex.directory, zshOutput], 1200);
  const zshSignature = await developmentSignature(context, join(zshOutput, 'zsh'));
  const smoke = await zshSmoke(context, zshOutput);
  const voiceBuild = await buildVoice(context, codex);
  const helper = await stageVoice(context, codex, candidate);
  const signatures = { zsh: zshSignature,
    helper: await developmentSignature(context, helper) };
  const buildCommit = (await run(context, 'helper-build-commit', helper, ['--build-commit'], 10, { env: GST })).trim();
  assert(buildCommit === CODEX.commit, 'voice helper build commit mismatch');
  return { candidate, helper, zsh, voiceBuild, signatures, smoke };
}

async function body(context) {
  const tools = await toolchain(context);
  context.stage = 'source';
  const codex = await codexSource(context);
  context.stage = 'build';
  const built = await candidates(context, codex);
  context.stage = 'inspect';
  const inspection = await inspect(built.candidate, built.helper, context.coordinate.macho,
    (label, executable, args) => run(context, label, executable, args));
  context.stage = 'handshake';
  const protocol = await handshake(context, built.helper);
  return { tools, codex: { ...CODEX }, zsh: { ...ZSH, tree: built.zsh.tree }, voiceBuild: built.voiceBuild,
    signatures: built.signatures, zshSmoke: built.smoke, inspection, protocol, inspectedOnMacOS: tools.os,
    buildAndProbeCompleted: true, candidateMeetsMeasuredFloor: inspection.allMinimumsAtMost13,
    candidateLoaderClosureResolved: inspection.privateImportsResolved,
    selectedNewerAPIImportsAllWeak: inspection.selectedNewerAPIImportsAllWeak };
}

export async function main(argv = process.argv.slice(2)) {
  const context = await contextFor(argumentsFor(argv));
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await body(context);
  } catch (error) {
    result = { buildAndProbeCompleted: false, failedStage: context.stage, error: String(error.message).slice(0, 4096) };
  }
  const receipt = { schema: 1, startedAt, finishedAt: new Date().toISOString(), architecture: context.architecture,
    target: context.coordinate.target, minimumRequested: '13.0', candidateOnly: true,
    acceptancePassed: false, macOS13ExecutionProved: false, shippingReplacementApproved: false,
    publisherTrustProved: false, developerIdUsed: false, notarizationUsed: false,
    upstreamVoiceInnerJobs: 8, bazelJobs: 2, sourcePins: { codex: CODEX, zsh: ZSH },
    commands: context.commands, workDirectory: context.work, limits: { commandBytes: MAX_COMMAND_BYTES,
      aggregateLogBytes: MAX_LOG_BYTES, candidateBytes: 1024 ** 3, candidateFiles: 20_000,
      overallWallMilliseconds: WALL_MILLISECONDS }, ...result };
  await writeFile(join(context.output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: context.output, buildAndProbeCompleted: result.buildAndProbeCompleted,
    acceptancePassed: false, macOS13ExecutionProved: false }));
  const measured = result.candidateMeetsMeasuredFloor && result.candidateLoaderClosureResolved && result.selectedNewerAPIImportsAllWeak;
  if (!result.buildAndProbeCompleted || !measured) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Mac13 candidate probe refused: ${String(error.message).slice(0, 512)}`); process.exitCode = 1; });
}
