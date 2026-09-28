import { describe, expect, it } from "vitest";
import { buildReleaseFixture } from "../fixtures.js";
import { assertSameBundle } from "../manifest.js";
import { signNativeReleaseManifest } from "../native.js";

const unsigned = (bundleVersion: string) => ({
  bundleVersion, protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [],
  nativeArtifacts: [{ id: "connector-macos-arm64", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: `https://releases.example/v${bundleVersion}/connector`, digest: `sha256:${"a".repeat(64)}`, sizeBytes: 1 }],
  expiresAt: "2027-01-01T00:00:00Z",
}) as never;

describe("release manifest refresh", () => {
  it("a refreshed manifest may only renew the signature envelope", () => {
    const fixture = buildReleaseFixture();
    const key = { keyId: fixture.keyId, privateKey: fixture.privateKey };
    const first = signNativeReleaseManifest(unsigned("1.0.0"), key);
    const renewed = signNativeReleaseManifest(unsigned("1.0.0"), key);
    expect(() => assertSameBundle(first, renewed)).not.toThrow();
    const changed = signNativeReleaseManifest(unsigned("1.0.1"), key);
    expect(() => assertSameBundle(first, changed)).toThrow(/changed the bundle/);
  });
});
