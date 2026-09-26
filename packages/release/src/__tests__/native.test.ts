import { createHash, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReleaseFixture } from "../fixtures.js";
import { agentModelCapabilityMappingSigningBytes, bundleManifestSigningBytes, computeAgentModelCapabilityMappingDigest, computeBundleManifestDigest } from "@konteks/remote-common";
import { nativeConnectorFileNames, presentNativeConnectorExecutables, resolveNativeConnectorExecutable, verifyNativeRelease, selectNativeArtifacts, selectNativeModelCapabilityMappings, stageNativeRelease } from "../native.js";

const bytes = Buffer.from('test executable bytes');
const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fixture = buildReleaseFixture();
const roots = [fixture.root];
const artifact = { id: 'connector-macos-arm64', kind: 'connector', format: 'executable', os: 'macos', architecture: 'arm64', url: 'https://releases.konteks.test/connector', digest: hash, sizeBytes: bytes.length };
function signed(patch: Record<string, unknown> = {}) {
  const body = { bundleVersion: '1.0.0', protocol: { min: '1.0', max: '1.0' }, deploymentKind: 'native_connector', components: ['agent_runner'], images: [], agentBridges: [], nativeArtifacts: [artifact, { ...artifact, id: 'claude-bridge', kind: 'agent_bridge', agentId: 'claude-code' }], expiresAt: '2027-09-01T00:00:00Z', ...patch };
  const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
  return { ...unsigned, signature: { algorithm: 'Ed25519', keyId: fixture.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), fixture.privateKey).toString('base64url') } };
}
const target = { os: 'macos', architecture: 'arm64', agentIds: ['claude-code'] } as const;
const now = Date.parse('2026-09-06T00:00:00Z');
function signedMapping(patch: Record<string, unknown> = {}) {
  const body = { version: 1, mappingId: 'claude-model', mappingRevision: 1, bridgeProfileRef: 'claude-bridge', bridgeArtifactDigest: hash, configId: 'model', optionType: 'select', issuedAt: '2026-09-01T00:00:00Z', expiresAt: '2027-09-01T00:00:00Z', ...patch };
  const unsigned = { ...body, mappingDigest: computeAgentModelCapabilityMappingDigest(body) };
  const placeholder = { ...unsigned, signature: { algorithm: 'Ed25519', keyId: fixture.keyId, value: 'AA' } };
  return { ...unsigned, signature: { algorithm: 'Ed25519', keyId: fixture.keyId, value: sign(null, agentModelCapabilityMappingSigningBytes(placeholder), fixture.privateKey).toString('base64url') } };
}
const folders: string[] = [];
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('signed native executable staging', () => {
  it('verifies signatures, expiry, and an explicit native topology before selection', () => {
    expect(verifyNativeRelease(signed(), roots, now).manifest.deploymentKind).toBe('native_connector');
    expect(() => verifyNativeRelease(signed(), [], now)).toThrow();
    expect(() => verifyNativeRelease({ ...signed(), bundleVersion: '2.0.0' }, roots, now)).toThrow();
    expect(() => verifyNativeRelease(signed(), roots, Date.parse('2028-01-01'))).toThrow();
    expect(() => verifyNativeRelease(fixture.manifest, roots, now)).toThrow();
  });

  it('independently verifies every reviewed model mapping with the release root', () => {
    expect(verifyNativeRelease(signed({ modelCapabilityMappings: [signedMapping()] }), roots, now).manifest.modelCapabilityMappings).toHaveLength(1);
    const bad = signedMapping();
    expect(() => verifyNativeRelease(signed({ modelCapabilityMappings: [{ ...bad, signature: { ...bad.signature, value: 'AA' } }] }), roots, now)).toThrow(/model capability mapping/i);
    expect(() => verifyNativeRelease(signed({ modelCapabilityMappings: [signedMapping({ expiresAt: '2026-09-05T00:00:00Z' })] }), roots, now)).toThrow(/model capability mapping/i);
  });

  it('selects exactly the requested platform and bridges, never falls back to another architecture', () => {
    const release = verifyNativeRelease(signed(), roots, now);
    expect(selectNativeArtifacts(release, target).map(a => a.id)).toEqual(['connector-macos-arm64', 'claude-bridge']);
    expect(() => selectNativeArtifacts(release, { ...target, architecture: 'amd64' })).toThrow();
    expect(() => selectNativeArtifacts(release, { ...target, agentIds: ['codex'] })).toThrow();
    const duplicate = verifyNativeRelease(signed({ nativeArtifacts: [artifact, { ...artifact, id: 'same-platform' }] }), roots, now);
    expect(() => selectNativeArtifacts(duplicate, { ...target, agentIds: [] })).toThrow();
  });

  it('requires a new reviewed mapping signature when canonical model identity changes', () => {
    const modelIdentities = [
      { value: 'sonnet', canonicalProviderId: 'anthropic', canonicalModelId: 'claude-sonnet-4-5' },
      { value: 'opus', canonicalProviderId: 'anthropic', canonicalModelId: 'claude-opus-4-1' },
    ];
    const original = signedMapping({ modelIdentities });
    expect(verifyNativeRelease(signed({ modelCapabilityMappings: [original] }), roots, now)
      .manifest.modelCapabilityMappings?.[0]?.modelIdentities).toEqual(modelIdentities);
    const { signature, mappingDigest: _digest, ...body } = original;
    const changed = { ...body, modelIdentities: [
      modelIdentities[0], { ...modelIdentities[1], canonicalModelId: 'claude-sonnet-4-5' },
    ] };
    // Even recomputing the mapping hash and signing the surrounding bundle
    // cannot replace the independently reviewed model mapping's signature.
    const forged = { ...changed, mappingDigest: computeAgentModelCapabilityMappingDigest(changed), signature };
    expect(() => verifyNativeRelease(signed({ modelCapabilityMappings: [forged] }), roots, now))
      .toThrow(/model capability mapping/i);
  });

  it('selects a reviewed host-agent mapping for DeepSeek Harness only when it names the versions this runtime supports', () => {
    const host = (versions: { min: string; belowCore: string }, agentId = 'dsh') => {
      const body = { version: 1, mappingId: `host-${agentId}-${versions.min}`, mappingRevision: 1, hostAgent: { agentId, versions }, configId: 'model', optionType: 'select',
        modelIdentities: [{ value: '["deepseek-official","deepseek-flash"]', canonicalProviderId: 'deepseek', canonicalModelId: 'deepseek-flash' }],
        issuedAt: '2026-09-01T00:00:00Z', expiresAt: '2027-09-01T00:00:00Z' };
      const unsigned = { ...body, mappingDigest: computeAgentModelCapabilityMappingDigest(body) };
      const placeholder = { ...unsigned, signature: { algorithm: 'Ed25519', keyId: fixture.keyId, value: 'AA' } };
      return { ...unsigned, signature: { algorithm: 'Ed25519', keyId: fixture.keyId, value: sign(null, agentModelCapabilityMappingSigningBytes(placeholder), fixture.privateKey).toString('base64url') } };
    };
    const release = verifyNativeRelease(signed({ modelCapabilityMappings: [signedMapping(), host({ min: '0.1.7-rc.2', belowCore: '0.1.8' }), host({ min: '0.1.5-rc.3', belowCore: '0.1.8' }), host({ min: '0.1.9', belowCore: '0.2.0' }), host({ min: '1.0.0', belowCore: '2.0.0' }, 'codex')] }), roots, now);
    expect(selectNativeModelCapabilityMappings(release).map(({ agentId, mapping }) => [agentId, mapping.mappingId])).toEqual([
      ['claude-code', 'claude-model'],
      ['dsh', 'host-dsh-0.1.5-rc.3'],
    ]);
  });

  it('selects model authority only for bridge artifacts installed on this platform', () => {
    const macBridge = { ...artifact, id: 'claude-macos-arm64', kind: 'agent_bridge', agentId: 'claude-code' };
    const windowsBridge = { ...artifact, id: 'claude-windows-amd64', kind: 'agent_bridge', agentId: 'claude-code', os: 'windows', architecture: 'amd64' };
    const release = verifyNativeRelease(signed({
      nativeArtifacts: [artifact, macBridge, windowsBridge],
      modelCapabilityMappings: [
        signedMapping({ mappingId: 'claude-macos-model', bridgeProfileRef: macBridge.id }),
        signedMapping({ mappingId: 'claude-windows-model', bridgeProfileRef: windowsBridge.id }),
      ],
    }), roots, now);

    expect(selectNativeModelCapabilityMappings(release, { os: 'macos', architecture: 'arm64' })
      .map(value => value.mapping.mappingId)).toEqual(['claude-macos-model']);
  });

  it('cannot change signed artifacts after verification', () => {
    const release = verifyNativeRelease(signed(), roots, now);
    expect(() => { release.manifest.nativeArtifacts![0]!.url = 'https://evil.test/unsigned'; }).toThrow();
    expect(() => { release.manifest.nativeArtifacts!.push(release.manifest.nativeArtifacts![0]!); }).toThrow();
  });

  it('writes executable bytes only after checking their signed length and digest', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'native-artifact-test-')); folders.push(parent);
    const fetchFn = vi.fn(async () => new Response(bytes));
    const staged = await stageNativeRelease({ release: verifyNativeRelease(signed(), roots, now), target, releasesDir: parent, fetchFn: fetchFn as typeof fetch });
    expect(await readFile(staged.connector)).toEqual(bytes);
    expect(await readFile(staged.bridges['claude-code']!)).toEqual(bytes);
    expect((await stat(staged.connector)).mode & 0o777).toBe(0o700);
    expect(fetchFn).toHaveBeenCalledWith(artifact.url, expect.objectContaining({ redirect: 'follow', credentials: 'omit' }));
    expect((await readdir(parent)).length).toBe(1);
  });

  it('names the connector konteks-connector, with an independent pre-rename copy older launchers still run', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'native-artifact-test-')); folders.push(parent);
    const staged = await stageNativeRelease({ release: verifyNativeRelease(signed(), roots, now), target, releasesDir: parent, fetchFn: (async () => new Response(bytes)) as typeof fetch });
    expect(staged.connector).toBe(join(staged.directory, 'konteks-connector'));
    const legacy = join(staged.directory, 'connector');
    expect(await readFile(legacy)).toEqual(bytes);
    const [renamed, old] = [await stat(staged.connector), await stat(legacy)];
    // Two files, not a link: installed-executable verification refuses links.
    expect(renamed.ino).not.toBe(old.ino);
    expect([renamed.nlink, old.nlink]).toEqual([1, 1]);
    expect(old.mode & 0o777).toBe(0o700);
    expect(nativeConnectorFileNames('windows')).toEqual(['konteks-connector.exe', 'connector.exe']);
  });

  it('finds a release folder\'s connector by the Konteks name first, else the pre-rename name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-connector-name-')); folders.push(directory);
    expect(await presentNativeConnectorExecutables(directory, 'macos')).toEqual([]);
    expect(await resolveNativeConnectorExecutable(directory, 'macos')).toBe(join(directory, 'konteks-connector'));
    await writeFile(join(directory, 'connector'), bytes);
    expect(await resolveNativeConnectorExecutable(directory, 'macos')).toBe(join(directory, 'connector'));
    await writeFile(join(directory, 'konteks-connector'), bytes);
    expect(await presentNativeConnectorExecutables(directory, 'macos')).toEqual([join(directory, 'konteks-connector'), join(directory, 'connector')]);
    expect(await resolveNativeConnectorExecutable(directory, 'macos')).toBe(join(directory, 'konteks-connector'));
    expect(await resolveNativeConnectorExecutable(directory, 'windows')).toBe(join(directory, 'konteks-connector.exe'));
  });

  it('stages bb-style host-only npm packages without executing them or enabling archive executable bits', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'native-artifact-test-')); folders.push(parent);
    const release = verifyNativeRelease(signed({ nativeArtifacts: [{ ...artifact, format: 'npm_tgz' }] }), roots, now);
    const staged = await stageNativeRelease({ release, target: { ...target, agentIds: [] }, releasesDir: parent, fetchFn: (async () => new Response(bytes)) as typeof fetch });
    expect(staged.connector).toMatch(/\.tgz$/);
    expect((await stat(staged.connector)).mode & 0o111).toBe(0);
    expect(await readdir(staged.directory)).toEqual(['konteks-connector.tgz']);
  });

  it.each(['corrupt', 'oversized', 'truncated', 'redirect'])('rejects %s downloads and leaves no executable candidate', async failure => {
    const parent = await mkdtemp(join(tmpdir(), 'native-artifact-test-')); folders.push(parent);
    const response = failure === 'redirect' ? new Response(null, { status: 302, headers: { location: 'http://evil.test' } }) : new Response(failure === 'corrupt' ? Buffer.alloc(bytes.length) : failure === 'oversized' ? Buffer.concat([bytes, bytes]) : bytes.subarray(0, 2));
    const fetchFn = vi.fn(async () => response);
    await expect(stageNativeRelease({ release: verifyNativeRelease(signed(), roots, now), target, releasesDir: parent, fetchFn: fetchFn as typeof fetch })).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });
});
