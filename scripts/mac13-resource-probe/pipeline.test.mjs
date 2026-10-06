/** Check the real workflows' prerequisites and single-build boundary. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
