/** Source-bound synthetic diagnostics. No process, native tool, network or candidate build. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../../.github/workflows/ci.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const setup = readFileSync(new URL('../../.github/actions/setup-macos-resources/action.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const gate = "runner.os == 'macOS' && !cancelled() && (steps.macos-offline-preflight.outcome == 'success' || steps.macos-offline-preflight.outcome == 'failure')";

function functionSource(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, 'production function boundary changed');
  return source.slice(begin, finish).replace(/^export /, '');
}

function productionToolchain(run) {
  const text = functionSource('async function toolchain(context)', 'const LOCK_CHECK =');
  return runInNewContext(`${text}; toolchain`, { process: { versions: { node: '22.23.2' } }, run, assert: (value, message) => assert.ok(value, message) });
}

function mainFixture(body) {
  const context = { output: resolve('synthetic-owned-evidence'), work: resolve('synthetic-work'), architecture: 'arm64', coordinate: { target: 'aarch64-apple-darwin' }, stage: 'toolchain', commands: [] };
  const writes = [];
  const output = [];
  const process = { argv: [], exitCode: 0 };
  const text = functionSource('export async function buildMac13ResourceCandidate(', 'if (process.argv[1] && import.meta.url').replace(/^export /gm, '');
  const main = runInNewContext(`${text}; main`, { contextFor: async () => context,
    argumentsFor: () => ({ architecture: context.architecture, output: context.output }), body,
    assert: (value, message) => assert.ok(value, message),
    Date, String, JSON, CODEX: { commit: 'synthetic-source-pin' }, ZSH: { commit: 'synthetic-zsh-pin' },
    MAX_COMMAND_BYTES: 4 * 1024 ** 2, MAX_LOG_BYTES: 16 * 1024 ** 2, WALL_MILLISECONDS: 105 * 60 * 1000,
    writeFile: async (file, bytes, options) => writes.push({ file, value: JSON.parse(bytes), options }),
    join, process, console: { log: value => output.push(JSON.parse(value)) } });
  return { main, context, writes, output, process };
}

function toolOutput(label) {
  const values = { 'tool-os': '26.0', 'tool-machine': 'arm64', 'tool-clang': 'synthetic clang', 'tool-python': 'Python 3.12.10', 'tool-cargo': 'cargo 1.95.0', 'tool-autoconf': 'autoconf 2.73' };
  assert.ok(Object.hasOwn(values, label));
  return values[label];
}

test('controlled missing autoconf retains a failed bounded receipt and a fixed stage-only summary', async () => {
  const calls = [];
  const tools = productionToolchain(async (_, label, executable, args) => {
    calls.push({ label, executable, args: Array.from(args) });
    if (label === 'tool-autoconf') throw Error('spawn autoconf ENOENT /synthetic/private-path');
    return toolOutput(label);
  });
  const f = mainFixture(context => tools(context));
  await f.main([]);
  assert.equal(calls.at(-1).executable, 'autoconf');
  assert.deepEqual(calls.at(-1).args, ['--version']);
  assert.equal(f.process.exitCode, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].file, join(f.context.output, 'receipt.json'));
  assert.equal(f.writes[0].options.flag, 'wx');
  assert.equal(f.writes[0].options.mode, 0o600);
  assert.equal(f.writes[0].value.failedStage, 'toolchain');
  assert.equal(f.writes[0].value.buildAndProbeCompleted, false);
  assert.equal(f.writes[0].value.acceptancePassed, false);
  assert.equal(f.writes[0].value.macOS13ExecutionProved, false);
  assert.equal(f.writes[0].value.shippingReplacementApproved, false);
  assert.equal(f.output[0].failedStage, 'toolchain');
  assert.equal(Object.hasOwn(f.output[0], 'output'), false);
  assert.equal(JSON.stringify(f.output).includes(f.context.output), false);
});

test('existing owned build failure remains failed even when diagnostic evidence is retained', async () => {
  const f = mainFixture(async context => { context.stage = 'build'; throw Error('synthetic controlled failure'); });
  await f.main([]);
  assert.equal(f.process.exitCode, 1);
  assert.equal(f.writes[0].value.failedStage, 'build');
  assert.equal(f.writes[0].value.publisherTrustProved, false);
  assert.equal(f.writes[0].value.developerIdUsed, false);
  assert.equal(f.writes[0].value.notarizationUsed, false);
});

test('actual shared builder preserves measured native refusal facts without claiming completion', async () => {
  const f = mainFixture(async context => {
    context.stage = 'candidate-loader-verification';
    context.measurements = { inspection: { privateImportsResolved: false }, candidateLoaderClosureResolved: false };
    throw Error('candidate loader closure unresolved');
  });
  await f.main([]);
  assert.equal(f.process.exitCode, 1);
  assert.deepEqual(f.writes[0].value.inspection, { privateImportsResolved: false });
  assert.equal(f.writes[0].value.candidateLoaderClosureResolved, false);
  assert.equal(f.writes[0].value.buildAndProbeCompleted, false);
  assert.equal(f.writes[0].value.acceptancePassed, false);
});

test('pre-output admission refusal prints a fixed reason without raw exception/path data', async () => {
  const beginning = source.indexOf('if (process.argv[1] && import.meta.url');
  assert.ok(beginning > 0);
  const entry = source.slice(beginning).replace('import.meta.url', '"fixture:probe"');
  const output = [];
  const process = { argv: ['node', 'synthetic-probe'], exitCode: 0 };
  let called;
  runInNewContext(entry, { process, resolve: value => value, pathToFileURL: () => ({ href: 'fixture:probe' }),
    main: () => { called = Promise.reject(Error('synthetic-admission-private-value /private/not-output')); return called; },
    console: { error: value => output.push(value) } });
  await called.catch(() => undefined);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(output, ['Mac13 candidate probe refused before evidence admission.']);
});

function step(name) {
  const marker = `      - name: ${name}\n`;
  const begin = workflow.indexOf(marker);
  assert.ok(begin >= 0, `required step missing: ${name}`);
  const end = workflow.indexOf('      - name: ', begin + marker.length);
  return workflow.slice(begin, end < 0 ? undefined : end);
}

test('finite shared Mac prerequisites keep official conditional autoconf provisioning', () => {
  const value = step('Set up pinned Mac resource build tools before packaging');
  assert.ok(value.includes("if: runner.os == 'macOS'"));
  assert.match(value, /timeout-minutes: 35\n/);
  assert.ok(value.includes('uses: ./.github/actions/setup-macos-resources'));
  assert.match(setup, /HOMEBREW_NO_AUTO_UPDATE: '1'/);
  assert.match(setup, /HOMEBREW_NO_INSTALL_CLEANUP: '1'/);
  assert.match(setup, /if ! command -v autoconf >\/dev\/null 2>&1; then\s+brew install autoconf\s+fi/);
  assert.equal((setup.match(/brew install/g) ?? []).length, 1);
  assert.equal(setup.includes('continue-on-error'), false);
});

test('packaging enters the real builder once with no post-preflight resource compilation', () => {
  const value = step('Preflight the actual offline Mac agent and Graft packages before release');
  assert.ok(value.includes("if: runner.os == 'macOS'"));
  assert.match(value, /timeout-minutes: 120/);
  assert.equal(value.includes('command -v autoconf'), false);
  assert.ok(value.includes('node scripts/build-offline-agent.mjs'));
  const following = workflow.slice(workflow.indexOf(value) + value.length);
  assert.equal(/node[^\n]*scripts\/mac13-resource-probe\/probe\.mjs/.test(following), false);
});

test('one native runner retains both inspector and diagnostics failures on every coordinate', () => {
  const value = step('Verify Mac resource inspection refusals on every native coordinate');
  assert.match(value, /run: node --test --test-concurrency=1 scripts\/mac13-resource-probe\/inspect-candidate\.test\.mjs scripts\/mac13-resource-probe\/probe\.test\.mjs scripts\/mac13-resource-probe\/cpal-patch\.test\.mjs scripts\/mac13-resource-probe\/voice-helper-relocation\.test\.mjs scripts\/mac13-resource-probe\/pipeline\.test\.mjs\n/);
  assert.equal(value.includes('npm run'), false);
});

function diagnosticFixture(kind = 'present', mutation = {}) {
  const value = step('Bound the selected resource measurement diagnostics before upload');
  const script = value.match(/<<'NODE'\n([\s\S]+?)\n          NODE/)?.[1];
  assert.ok(script, 'production diagnostic script boundary changed');
  const body = script.split('\n').filter(line => !line.trimStart().startsWith('import ')).map(line => line.replace(/^          /, '')).join('\n');
  const writes = [];
  const messages = [];
  const runner = resolve('synthetic-virtual-runner');
  const root = join(runner, 'mac13-resource-probe-evidence');
  const outputFile = join(runner, 'job-output');
  const plain = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 16 };
  const directory = { ...plain, isDirectory: () => true, isFile: () => false };
  const rows = new Map([[root, mutation.root ?? directory], [join(root, 'logs'), mutation.logs ?? directory], [join(root, 'receipt.json'), mutation.receipt ?? plain]]);
  const lstat = async file => {
    if (file === root && ['missing', 'denied'].includes(kind)) throw Object.assign(Error('synthetic controlled filesystem refusal'), { code: { missing: 'ENOENT', denied: 'EACCES' }[kind] });
    return rows.get(file) ?? mutation.member ?? plain;
  };
  const execution = runInNewContext(`(async () => {${body}})()`, { lstat, readdir: async () => mutation.names ?? ['001-tool-os.log'],
    realpath: async value => value, appendFile: async (file, bytes) => writes.push({ file, bytes }), join, resolve,
    process: { env: { RUNNER_TEMP: runner, GITHUB_OUTPUT: outputFile } },
    console: { log: value => messages.push(value) } });
  return { execution, writes, messages, outputFile };
}

test('missing probe output explicitly withholds upload without a secondary ENOENT', async () => {
  const f = diagnosticFixture('missing');
  await f.execution;
  assert.deepEqual(f.writes, [{ file: f.outputFile, bytes: 'ready=false\n' }]);
  assert.deepEqual(f.messages, ['No owned Mac resource measurement evidence was created.']);
});

test('valid bounded evidence alone enables upload without compatibility acceptance', async () => {
  const f = diagnosticFixture();
  await f.execution;
  assert.deepEqual(f.writes, [{ file: f.outputFile, bytes: 'ready=true\n' }]);
  assert.deepEqual(f.messages, []);
});

test('filesystem denial is not converted into evidence absence', async () => {
  const f = diagnosticFixture('denied');
  await assert.rejects(f.execution, error => error.code === 'EACCES');
  assert.deepEqual(f.writes, []);
});

for (const [label, mutation] of [
  ['linked root', { root: { isDirectory: () => true, isSymbolicLink: () => true } }],
  ['linked member', { member: { isFile: () => true, isSymbolicLink: () => true, size: 1 } }],
  ['oversize member', { member: { isFile: () => true, isSymbolicLink: () => false, size: 4 * 1024 ** 2 + 1 } }],
  ['unexpected payload filename', { names: ['private-source-tree.tar'] }],
  ['oversize receipt', { receipt: { isFile: () => true, isSymbolicLink: () => false, size: 8 * 1024 ** 2 + 1 } }],
]) test(`diagnostic upload still refuses ${label}`, async () => {
  const f = diagnosticFixture('present', mutation);
  await assert.rejects(f.execution);
  assert.deepEqual(f.writes, []);
});

test('seven jobs, five coordinates and shipping preflight stay present without acceptance waivers', () => {
  const jobs = workflow.slice(workflow.indexOf('jobs:\n'));
  assert.deepEqual(Array.from(jobs.matchAll(/^  ([a-z-]+):$/gm), value => value[1]), ['check', 'windows-bootstrap', 'windows-native']);
  assert.match(workflow, /os: \[macos-26, macos-15-intel, ubuntu-24\.04, ubuntu-24\.04-arm, windows-2022\]/);
  const preflight = step('Preflight the actual offline Mac agent and Graft packages before release');
  assert.ok(preflight.includes('exit "$failed"'));
  assert.equal(preflight.includes('continue-on-error'), false);
  const upload = step('Retain bounded Mac resource measurements only');
  assert.ok(upload.includes(`if: ${gate}`));
  assert.ok(upload.includes("steps.mac13-resource-diagnostic-bounds.outputs.ready == 'true'"));
  assert.ok(upload.includes('logs/*.log'));
  assert.ok(upload.includes('/receipt.json'));
  assert.equal(upload.includes('continue-on-error'), false);
});
