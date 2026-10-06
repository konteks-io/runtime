/** Check the real workflows' prerequisites and single-build boundary. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ci = readFileSync(new URL('../../.github/workflows/ci.yaml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const release = readFileSync(new URL('../../.github/workflows/release.yaml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const setup = 'uses: ./.github/actions/setup-macos-resources';
const tools = readFileSync(new URL('../../.github/actions/setup-macos-resources/action.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

function nativeSteps(source, start, end) {
  const begin = source.indexOf(start);
  const finish = end ? source.indexOf(end, begin + start.length) : source.length;
  assert.ok(begin >= 0, 'actual native job boundary changed');
  return source.slice(begin, finish < 0 ? undefined : finish);
}

const ciNative = nativeSteps(ci, '  windows-native:\n');
const releaseNative = nativeSteps(release, '  build:\n', '\n  release:\n');
const releaseDownload = nativeSteps(release, '      - uses: actions/download-artifact@v4\n', '      - name: Assemble, sign and verify');
const nativeArtifacts = ['native-macos-arm64', 'native-macos-amd64', 'native-windows-amd64', 'native-debian-amd64', 'native-debian-arm64'];
const diagnosticArtifacts = ['mac13-resource-measurement-macos-26', 'mac13-resource-measurement-macos-15-intel'];

function fixture(t) {
  const parent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(parent, 'konteks-release-collection-')));
  t.after(() => {
    assert.ok(isAbsolute(root) && dirname(root) === parent && basename(root).startsWith('konteks-release-collection-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function selectedArtifacts(names) {
  const pattern = releaseDownload.match(/^\s+pattern: (\S+)$/m)?.[1];
  assert.ok(pattern === undefined || pattern === 'native-*', 'release artifact selection must use the closed native prefix');
  assert.doesNotMatch(releaseDownload, /merge-multiple: true/);
  assert.match(releaseDownload, /path: dist\/artifacts/);
  return names.filter(name => pattern === undefined || name.startsWith('native-'));
}

function artifactFile(root, artifact, name, bytes) {
  const directory = join(root, 'artifacts', artifact);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), bytes);
}

function collect(root) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../release-assets.mjs', import.meta.url)),
    'collect', '--artifacts', join(root, 'artifacts'), '--out', join(root, 'release'), '--descriptors', join(root, 'descriptors')],
  { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 });
  assert.equal(result.error, undefined);
  return result;
}

test('publisher selects native platform artifacts while excluding sibling measurement logs', t => {
  const root = fixture(t);
  const selected = selectedArtifacts([...nativeArtifacts, ...diagnosticArtifacts]);
  for (const name of selected) {
    if (name.startsWith('native-')) {
      artifactFile(root, name, `${name}.tgz`, `synthetic platform bytes: ${name}`);
      artifactFile(root, name, `${name}.artifact.json`, '{}');
    } else artifactFile(root, name, '001-tool-os.log', 'synthetic diagnostic bytes');
  }
  const result = collect(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(selected, nativeArtifacts);
  assert.deepEqual(readdirSync(join(root, 'release')).sort(), nativeArtifacts.map(name => `${name}.tgz`).sort());
  assert.deepEqual(readdirSync(join(root, 'descriptors')).sort(), nativeArtifacts.map(name => `${name}.artifact.json`).sort());
  assert.match(releaseDownload, /pattern: native-\*/);
});

test('the real collector still refuses duplicate assets in two selected native platforms', t => {
  const root = fixture(t);
  for (const name of selectedArtifacts(nativeArtifacts.slice(0, 2))) artifactFile(root, name, 'collision.tgz', 'synthetic colliding asset');
  const result = collect(root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /duplicate release asset collision\.tgz/);
});

test('actual Mac packaging preflight has its build prerequisites before it starts', () => {
  const preflight = ciNative.indexOf('      - name: Preflight the actual offline Mac agent and Graft packages before release\n');
  assert.ok(preflight >= 0);
  const prerequisites = ciNative.slice(0, preflight);
  assert.ok(prerequisites.includes(setup), 'Mac packaging currently reaches its guard before the source-build tools are provisioned');
  assert.match(prerequisites, /if: runner\.os == 'macOS'\n\s+uses: \.\/\.github\/actions\/setup-macos-resources/);
  assert.match(prerequisites, /timeout-minutes: 35\n\s+if: runner\.os == 'macOS'/);
  assert.ok(tools.includes('using: composite'));
  for (const pin of ['actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405',
    'dtolnay/rust-toolchain@e081816240890017053eacbb1bdf337761dc5582',
    'bazel-contrib/setup-bazel@c5acdfb288317d0b5c0bbd7a396a3dc868bb0f86']) assert.ok(tools.includes(pin));
  assert.equal(tools.includes('continue-on-error'), false);
});

test('the real release packager uses the same Mac prerequisites as preflight', () => {
  const packaging = releaseNative.indexOf('      - name: Build complete offline agent packages and describe every artifact\n');
  assert.ok(packaging >= 0);
  assert.ok(releaseNative.slice(0, packaging).includes(setup), 'release-assets reaches the same source packager without its required toolchain');
  assert.match(releaseNative.slice(0, packaging), /if: runner\.os == 'macOS'\n\s+uses: \.\/\.github\/actions\/setup-macos-resources/);
});

test('a failed package preflight retains its evidence without starting another resource build', () => {
  const preflight = ciNative.indexOf('      - name: Preflight the actual offline Mac agent and Graft packages before release\n');
  const after = ciNative.indexOf('      - name: ', preflight + 20);
  assert.ok(preflight >= 0 && after > preflight);
  const following = ciNative.slice(after);
  assert.equal(/node[^\n]*scripts\/mac13-resource-probe\/probe\.mjs/.test(following), false, 'post-preflight diagnostic command would compile the same voice target again');
  assert.ok(following.includes('mac13-resource-probe-evidence/logs/*.log'));
  assert.ok(following.includes('mac13-resource-probe-evidence/receipt.json'));
  assert.ok(following.includes("steps.macos-offline-preflight.outcome == 'failure'"));
  assert.ok(following.includes("steps.mac13-resource-diagnostic-bounds.outputs.ready == 'true'"));
});

test('the existing seven CI executions and failed shipping gate stay intact', () => {
  assert.match(ciNative, /os: \[macos-26, macos-15-intel, ubuntu-24\.04, ubuntu-24\.04-arm, windows-2022\]/);
  const jobs = ci.slice(ci.indexOf('jobs:\n'));
  assert.deepEqual(Array.from(jobs.matchAll(/^  ([a-z-]+):$/gm), value => value[1]), ['check', 'windows-bootstrap', 'windows-native']);
  assert.ok(ciNative.includes('exit "$failed"'));
  assert.equal(ciNative.includes('continue-on-error'), false);
  assert.match(releaseNative, /needs: check\n/);
  assert.match(releaseNative, /timeout-minutes: 180\n/);
});
