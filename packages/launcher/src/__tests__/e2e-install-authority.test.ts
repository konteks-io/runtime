import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signNativeReleaseManifest } from "@konteks/remote-release";
import { loadE2EInstallAuthority } from "../e2e/authority.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

async function fixture(root: string) {
  const directory = join(root, ".runtime", "native-cloud");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "e2e-local-native-release-1";
  const rootsFile = join(directory, "release-roots.json");
  const manifestFile = join(directory, "native-manifest.json");
  const caFile = join(directory, "ca.pem");
  const unsigned = {
    bundleVersion: "0.1.0-e2e", protocol: { min: "1.0", max: "1.0" },
    deploymentKind: "native_connector" as const, components: ["agent_runner" as const], images: [], agentBridges: [],
    nativeArtifacts: [
      { id: "connector", kind: "connector" as const, format: "executable" as const, os: "macos" as const, architecture: "arm64" as const, url: "https://127.0.0.1:7443/__e2e/native/connector", digest: digest("a"), sizeBytes: 1 },
      { id: "codex", kind: "agent_bridge" as const, format: "offline_agent_tgz" as const, agentId: "codex", os: "macos" as const, architecture: "arm64" as const, url: "https://127.0.0.1:7443/__e2e/native/codex.tgz", digest: digest("b"), profileDigest: digest("c"), sizeBytes: 1 },
    ],
    expiresAt: "2027-01-01T00:00:00.000Z",
  };
  const manifest = signNativeReleaseManifest(unsigned, { keyId, privateKey });
  await writeFile(rootsFile, JSON.stringify({ roots: [{ keyId, publicKeyJwk: publicKey.export({ format: "jwk" }) }] }), { mode: 0o600 });
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(caFile, "e2e-ca", { mode: 0o600 });
  return { directory, rootsFile, manifestFile, caFile };
}

describe("explicit E2E native install authority", () => {
  it("loads only an E2E-signed manifest on the loopback TLS edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-e2e-authority-"));
    try {
      const files = await fixture(root);
      const result = await loadE2EInstallAuthority({
        gate: "1", coreUrl: "https://127.0.0.1:7443", relayUrl: "wss://127.0.0.1:7443/relay/runtime",
        ...files, nodeExtraCaCerts: files.caFile,
      });
      expect(result.roots[0]?.keyId).toBe("e2e-local-native-release-1");
      expect(result.manifest.deploymentKind).toBe("native_connector");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { gate: "0" },
    { coreUrl: "https://core.konteks.example" },
    { relayUrl: "wss://relay.konteks.example/relay/runtime" },
    { nodeExtraCaCerts: "/tmp/other-ca.pem" },
  ])("fails closed when the E2E-only boundary is absent or widened", async patch => {
    const root = await mkdtemp(join(tmpdir(), "konteks-e2e-authority-"));
    try {
      const files = await fixture(root);
      await expect(loadE2EInstallAuthority({
        gate: "1", coreUrl: "https://localhost:7443", relayUrl: "wss://localhost:7443/relay/runtime",
        ...files, nodeExtraCaCerts: files.caFile, ...patch,
      })).rejects.toThrow(/E2E native install authority/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
