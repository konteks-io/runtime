import { generateEd25519 } from "@konteks/remote-common";
import type { KeyObject } from "node:crypto";
import type { EmbeddedReleaseRoot, ReleaseManifest } from "./manifest.js";
import { SUPPORTED_AGENT_BRIDGES } from "./bridges.js";
import { signReleaseManifest } from "./signing.js";

/**
 * Test fixtures shared across packages: a throwaway release root and a
 * well-formed signed release manifest. Digests are synthetic but well-formed.
 */
export function fakeDigest(seed: string): string {
  let hex = "";
  for (let index = 0; hex.length < 64; index += 1) {
    hex += seed.charCodeAt(index % seed.length).toString(16).padStart(2, "0");
  }
  return `sha256:${hex.slice(0, 64)}`;
}

export interface ReleaseFixture {
  root: EmbeddedReleaseRoot;
  privateKey: KeyObject;
  keyId: string;
  manifest: ReleaseManifest;
}

export function buildUnsignedReleaseManifest(
  overrides: Partial<Omit<ReleaseManifest, "digest" | "signature">> = {},
): Omit<ReleaseManifest, "digest" | "signature"> {
  const images = [
    "supervisor",
    "gateway",
    "agent-runner",
    "browser-tool",
    "preview-forwarder",
    "sysmon",
    "harness",
    "validation-runtime",
    "postgres",
    "valkey",
  ].map((component) => ({
    component: component as ReleaseManifest["images"][number]["component"],
    ref: `registry.konteks.example/remote-instance/${component}`,
    digest: fakeDigest(component),
    architectures: ["amd64", "arm64"] as Array<"amd64" | "arm64">,
    signatureRef: `registry.konteks.example/remote-instance/${component}:sha256-sig`,
    sbomRef: `registry.konteks.example/remote-instance/${component}:sbom`,
    provenanceRef: `registry.konteks.example/remote-instance/${component}:provenance`,
    version: "1.0.0",
  }));
  return {
    schemaVersion: 1,
    bundleVersion: "1.0.0",
    channel: "stable",
    protocol: { min: "1.0", max: "1.0" },
    components: ["harness", "validation_runtime", "agent_runner", "gateway"],
    images,
    agentBridges: SUPPORTED_AGENT_BRIDGES.map((bridge) => ({
      agentId: bridge.agentId,
      displayName: bridge.displayName,
      package: bridge.package,
      version: bridge.version,
      ref: `registry.konteks.example/remote-instance/agent-runner-${bridge.agentId}`,
      digest: fakeDigest(`bridge-${bridge.agentId}`),
      signatureRef: `registry.konteks.example/remote-instance/agent-runner-${bridge.agentId}:sha256-sig`,
      acpProtocol: bridge.acpProtocol,
      command: [...bridge.command],
      tooling: {
        login: [...bridge.tooling.login],
        logout: [...bridge.tooling.logout],
        ...(bridge.tooling.identitySignal ? { identitySignal: [...bridge.tooling.identitySignal] } : {}),
        ...(bridge.tooling.hostCacheImport ? { hostCacheImport: bridge.tooling.hostCacheImport } : {}),
      },
      egress: {
        ...(bridge.egress.baseUrlEnv ? { baseUrlEnv: bridge.egress.baseUrlEnv } : {}),
        providers: [...bridge.egress.providers],
      },
    })),
    compose: { templateDigest: fakeDigest("compose"), configSchemaVersion: 1 },
    egressAllowlist: {
      revision: "allowlist-1",
      entries: [
        { provider: "anthropic", hosts: ["api.anthropic.com"], pathPrefixes: ["/v1/messages"] },
        { provider: "openai", hosts: ["api.openai.com"], pathPrefixes: ["/v1/responses", "/v1/chat/completions"] },
        { provider: "google", hosts: ["generativelanguage.googleapis.com"], pathPrefixes: ["/v1beta/models/"] },
        { provider: "deepseek", hosts: ["api.deepseek.com"], pathPrefixes: ["/chat/completions", "/v1/chat/completions"] },
      ],
    },
    minimums: {
      launcher: "0.1.0",
      dockerEngine: "24.0.0",
      dockerDesktop: "4.30.0",
      compose: "2.24.0",
      wsl: "2.0.0",
      memoryBytes: 8 * 1024 ** 3,
      diskBytes: 30 * 1024 ** 3,
      os: { macos: "13", windows: "10", debian: ["12", "13"] },
    },
    migrations: [
      { component: "harness", order: 0, backwardCompatible: true },
      { component: "validation-runtime", order: 1, backwardCompatible: true },
    ],
    healthGates: { startupTimeoutSeconds: 600, agentProbeTimeoutSeconds: 60 },
    rollback: { compatibleDataFrom: "1.0.0" },
    minimumSupportedBundle: "1.0.0",
    issuedAt: "2026-09-01T00:00:00Z",
    expiresAt: "2027-09-01T00:00:00Z",
    ...overrides,
  };
}

export function buildReleaseFixture(overrides: Partial<Omit<ReleaseManifest, "digest" | "signature">> = {}): ReleaseFixture {
  const { privateKey, publicJwk } = generateEd25519();
  const keyId = "release-root-test";
  const manifest = signReleaseManifest(buildUnsignedReleaseManifest(overrides), { keyId, privateKey });
  return { root: { keyId, publicKeyJwk: publicJwk }, privateKey, keyId, manifest };
}
