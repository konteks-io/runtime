import { describe, expect, it } from "vitest";
import { RemoteInstanceError, generateEd25519 } from "@konteks/remote-common";
import { buildReleaseFixture, fakeDigest } from "../fixtures.js";
import { assertSameBundle, verifyExchangeManifest, verifyReleaseManifest } from "../manifest.js";
import { deriveExchangeManifest } from "../signing.js";

const now = Date.parse("2026-09-06T00:00:00Z");

describe("release manifest verification against the embedded root", () => {
  it("accepts a manifest signed by an embedded root with a matching digest", () => {
    const fixture = buildReleaseFixture();
    const verified = verifyReleaseManifest(fixture.manifest, [fixture.root], now);
    expect(verified.bundleVersion).toBe("1.0.0");
  });

  it("fails closed with bundle_untrusted when no root is embedded", () => {
    const fixture = buildReleaseFixture();
    expect(() => verifyReleaseManifest(fixture.manifest, [], now)).toThrowError(
      expect.objectContaining({ code: "bundle_untrusted" }),
    );
  });

  it.each([
    ["tampered image digest", (m: Record<string, unknown>) => ({ ...m, images: [{ ...(m.images as Array<Record<string, unknown>>)[0], digest: fakeDigest("evil") }, ...(m.images as unknown[]).slice(1)] })],
    ["tampered bundle version", (m: Record<string, unknown>) => ({ ...m, bundleVersion: "9.9.9" })],
    ["forged signature", (m: Record<string, unknown>) => ({ ...m, signature: { ...(m.signature as Record<string, unknown>), value: "AAAA" } })],
    ["expired", (m: Record<string, unknown>) => ({ ...m, expiresAt: "2020-01-01T00:00:00Z" })],
    ["unknown field", (m: Record<string, unknown>) => ({ ...m, shell: "rm -rf /" })],
  ])("rejects a %s manifest", (_name, mutate) => {
    const fixture = buildReleaseFixture();
    const tampered = mutate(fixture.manifest as unknown as Record<string, unknown>);
    expect(() => verifyReleaseManifest(tampered, [fixture.root], now)).toThrow(RemoteInstanceError);
  });

  it("rejects a manifest signed by a key that is not the embedded root even with a valid digest", () => {
    const fixture = buildReleaseFixture();
    const other = generateEd25519();
    expect(() => verifyReleaseManifest(fixture.manifest, [{ keyId: fixture.keyId, publicKeyJwk: other.publicJwk }], now)).toThrow(
      /signature does not verify/,
    );
  });
});

describe("exchange manifest agreement (invariant 32)", () => {
  it("accepts an exchange manifest that agrees with the release manifest", () => {
    const fixture = buildReleaseFixture();
    const exchange = deriveExchangeManifest(fixture.manifest, { keyId: fixture.keyId, privateKey: fixture.privateKey }, "2027-01-01T00:00:00Z");
    expect(verifyExchangeManifest({ exchange, release: fixture.manifest, roots: [fixture.root], nowMs: now })).toEqual({
      manifestDigest: exchange.digest,
    });
  });

  it("rejects an exchange manifest whose bridge digest differs from the release", () => {
    const fixture = buildReleaseFixture();
    const exchange = deriveExchangeManifest(fixture.manifest, { keyId: fixture.keyId, privateKey: fixture.privateKey }, "2027-01-01T00:00:00Z");
    const bridges = exchange.agentBridges.map((bridge, index) => (index === 0 ? { ...bridge, digest: fakeDigest("other") } : bridge));
    const resigned = deriveExchangeManifest({ ...fixture.manifest, agentBridges: fixture.manifest.agentBridges.map((b, i) => (i === 0 ? { ...b, digest: fakeDigest("other") } : b)) }, { keyId: fixture.keyId, privateKey: fixture.privateKey }, "2027-01-01T00:00:00Z");
    expect(resigned.agentBridges[0]?.digest).toBe(bridges[0]?.digest);
    expect(() => verifyExchangeManifest({ exchange: resigned, release: fixture.manifest, roots: [fixture.root], nowMs: now })).toThrow(/agent bridge digest mismatch/);
  });

  it("rejects an exchange manifest for a different bundle version", () => {
    const fixture = buildReleaseFixture();
    const other = buildReleaseFixture({ bundleVersion: "1.1.0" });
    const exchange = deriveExchangeManifest(other.manifest, { keyId: fixture.keyId, privateKey: fixture.privateKey }, "2027-01-01T00:00:00Z");
    expect(() => verifyExchangeManifest({ exchange, release: fixture.manifest, roots: [fixture.root], nowMs: now })).toThrow(/different bundle versions/);
  });

  it("TLS alone is not trust: a Core-delivered manifest with an unknown signer fails", () => {
    const fixture = buildReleaseFixture();
    const rogue = generateEd25519();
    const exchange = deriveExchangeManifest(fixture.manifest, { keyId: "core-tls", privateKey: rogue.privateKey }, "2027-01-01T00:00:00Z");
    expect(() => verifyExchangeManifest({ exchange, release: fixture.manifest, roots: [fixture.root], nowMs: now })).toThrow(/not an embedded release root/);
  });

  it("a refreshed manifest may only renew the signature envelope", () => {
    const fixture = buildReleaseFixture();
    const key = { keyId: fixture.keyId, privateKey: fixture.privateKey };
    const first = deriveExchangeManifest(fixture.manifest, key, "2027-01-01T00:00:00Z");
    const renewed = deriveExchangeManifest(fixture.manifest, key, "2027-01-01T00:00:00Z");
    expect(() => assertSameBundle(first, renewed)).not.toThrow();
    const changed = deriveExchangeManifest(buildReleaseFixture({ bundleVersion: "1.0.1" }).manifest, key, "2027-01-01T00:00:00Z");
    expect(() => assertSameBundle(first, changed)).toThrow(/changed the bundle/);
  });
});
