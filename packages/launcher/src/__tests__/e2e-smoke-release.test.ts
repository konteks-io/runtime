import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { installOfflineAgentPackage, NativeAgentPackageProfileSchema, verifyNativeRelease } from "@konteks/remote-release";
import { RunnerConfigSchema, resolveBridgeSpawnSpec, spawnBridge } from "@konteks/remote-agent-runner";
import { prepareE2ERealRelease, prepareE2ESmokeRelease } from "../e2e/smoke-release.js";

describe("signed E2E ACP releases", () => {
  it("installs and executes one Codex-shaped ACP bridge through the normal verified package boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-e2e-smoke-release-"));
    try {
      const prepared = await prepareE2ESmokeRelease({ gate: "1", directory: join(root, ".runtime", "native-cloud"), origin: "https://127.0.0.1:7443", platform: { os: "macos", architecture: "arm64" } });
      const release = verifyNativeRelease(prepared.manifest, [prepared.root]);
      expect(Date.parse(release.manifest.expiresAt) - Date.now()).toBeGreaterThan(365 * 24 * 60 * 60 * 1_000);
      const artifact = release.manifest.nativeArtifacts?.find(item => item.agentId === "codex");
      expect(artifact?.format).toBe("offline_agent_tgz");
      expect(release.manifest.modelCapabilityMappings).toEqual([
        expect.objectContaining({
          bridgeProfileRef: artifact?.id,
          bridgeArtifactDigest: artifact?.digest,
          configId: "model",
          optionType: "select",
          modelIdentities: [{ value: "e2e-model", canonicalProviderId: "e2e", canonicalModelId: "e2e-model" }],
        }),
      ]);
      const prefix = join(root, "installed-agent");
      const profile = await installOfflineAgentPackage(prepared.artifactFiles.agent, prefix, artifact!);
      const credentials = join(root, "credentials"), workspace = join(root, "workspace");
      await mkdir(credentials, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
      const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_AUTH_MODE: "agent_local_subscription", RUNNER_CREDENTIAL_DIR: credentials, RUNNER_WORKSPACE_DIR: workspace, RUNNER_BRIDGE_PREFIX: prefix, RUNNER_BRIDGE_VERSION: profile.bridge.version, RUNNER_NATIVE_PACKAGE_PROFILE: profile, RUNNER_NATIVE_PACKAGE_ARTIFACT: artifact });
      const updates: unknown[] = [];
      const bridge = await spawnBridge({ spec: resolveBridgeSpawnSpec(config), initializeTimeoutMs: 2_000, clientVersion: "e2e", handlers: { onSessionUpdate: update => updates.push(update), onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }), onCreateElicitation: async () => ({ action: "cancel" }), onExit: () => undefined } });
      try {
        const session = await bridge.connection.newSession({ cwd: workspace, mcpServers: [] });
        expect(session.sessionId).toMatch(/^e2e-session-/);
        expect(session.configOptions).toEqual([
          expect.objectContaining({
            id: "model",
            type: "select",
            currentValue: "e2e-model",
            options: [{ value: "e2e-model", name: "E2E deterministic model" }],
          }),
        ]);
        await expect(bridge.connection.setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "model",
          value: "e2e-model",
        })).resolves.toEqual({ configOptions: session.configOptions });
        const repositoryUrl = "https://git.example/konteks/native-smoke.git";
        const planningInput = { goal: "Prove native planning", repositories: [{ url: repositoryUrl }] };
        const prompt = `Planning input:\n${JSON.stringify(planningInput)}\n\nFrozen assignment inputs:\n{}`;
        await expect(bridge.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] })).resolves.toMatchObject({ stopReason: "end_turn" });
        expect(updates).toHaveLength(1);
        const update = updates[0] as { sessionId: string; update: { sessionUpdate: string; content: { type: string; text: string } } };
        expect(update).toMatchObject({
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text" } },
        });
        expect(JSON.parse(update.update.content.text)).toEqual({
          tasks: [{
            name: "native-smoke",
            repositoryUrl,
            goal: "test: prove native ACP planning transport",
            validation: "The native planning smoke reaches terminal settlement.",
            dependsOn: [],
            acceptanceCriteria: [{
              id: "AC-1",
              description: "The native planning assignment settles successfully.",
              evidenceExpectation: "The terminal settlement records an accepted candidate.",
            }],
          }],
        });
      } finally { await bridge.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("cannot prepare a fixture without the explicit gate or on a production origin", async () => {
    const directory = join(tmpdir(), "konteks-e2e-smoke-forbidden", ".runtime", "native-cloud");
    await expect(prepareE2ESmokeRelease({ gate: "0", directory, origin: "https://127.0.0.1:7443", platform: { os: "macos", architecture: "arm64" } })).rejects.toThrow(/E2E smoke release/i);
    await expect(prepareE2ESmokeRelease({ gate: "1", directory, origin: "https://releases.konteks.example", platform: { os: "macos", architecture: "arm64" } })).rejects.toThrow(/E2E smoke release/i);
  });

  it("signs an externally built complete real-Codex package without substituting the fake bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-e2e-real-release-"));
    try {
      const platform = { os: "macos" as const, architecture: "arm64" as const };
      const external = await writeExternalCodexPackage(root, platform);
      const directory = join(root, ".runtime", "native-cloud");
      const prepared = await prepareE2ERealRelease({ realAgentGate: "1", directory, origin: "https://localhost:7443", platform, packagePath: external.archive, profilePath: external.profile });
      const release = verifyNativeRelease(prepared.manifest, [prepared.root]);
      expect(Date.parse(release.manifest.expiresAt) - Date.now()).toBeGreaterThan(365 * 24 * 60 * 60 * 1_000);
      const artifact = release.manifest.nativeArtifacts?.find(item => item.agentId === "codex");
      expect(artifact).toMatchObject({ id: "e2e-real-codex-acp", url: "https://localhost:7443/__e2e/native/codex.tgz", profileDigest: hash(await readFile(external.profile)) });
      expect(await readFile(prepared.artifactFiles.agent)).toEqual(await readFile(external.archive));
      const installed = await installOfflineAgentPackage(prepared.artifactFiles.agent, join(root, "installed-real-agent"), artifact!);
      expect(installed.bridge.entrypoint).toBe("bridge/codex-acp");
      await expect(prepareE2ERealRelease({ realAgentGate: "0", directory, origin: "https://localhost:7443", platform, packagePath: external.archive, profilePath: external.profile })).rejects.toThrow(/E2E smoke release/i);
      await expect(prepareE2ERealRelease({ realAgentGate: "1", directory, origin: "https://localhost:7443", platform, packagePath: "codex.tgz", profilePath: external.profile })).rejects.toThrow(/E2E smoke release/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("signs Claude selector aliases with reviewed canonical model identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-e2e-claude-release-"));
    try {
      const platform = { os: "macos" as const, architecture: "arm64" as const };
      const external = await writeExternalAgentPackage(root, platform, "claude-code");
      const prepared = await prepareE2ERealRelease({ realAgentGate: "1", directory: join(root, ".runtime", "native-cloud"), origin: "https://localhost:7443", platform, packagePath: external.archive, profilePath: external.profile });
      const identities = verifyNativeRelease(prepared.manifest, [prepared.root]).manifest.modelCapabilityMappings?.[0]?.modelIdentities;
      expect(identities).toEqual(expect.arrayContaining([
        { value: "opus[1m]", canonicalProviderId: "anthropic", canonicalModelId: "claude-opus-5[1m]" },
        { value: "sonnet", canonicalProviderId: "anthropic", canonicalModelId: "claude-sonnet-5" },
      ]));
      expect(new Set(identities?.map(identity => identity.value)).size).toBe(identities?.length);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("signs one immutable release containing distinct Claude and Codex packages and model mappings", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-e2e-multi-agent-release-"));
    try {
      const platform = { os: "macos" as const, architecture: "arm64" as const };
      const claude = await writeExternalAgentPackage(root, platform, "claude-code");
      const codex = await writeExternalAgentPackage(root, platform, "codex");
      const directory = join(root, ".runtime", "native-cloud");
      const old = await prepareE2ERealRelease({ realAgentGate: "1", directory, origin: "https://localhost:7443", bundleVersion: "0.1.0-e2e", platform, packagePath: claude.archive, profilePath: claude.profile });
      const prepared = await prepareE2ERealRelease({
        realAgentGate: "1",
        directory,
        origin: "https://localhost:7443",
        bundleVersion: "0.2.0-e2e",
        platform,
        packagePath: [claude.archive, codex.archive],
        profilePath: [claude.profile, codex.profile],
      });
      const release = verifyNativeRelease(prepared.manifest, [prepared.root]).manifest;
      expect(old.root.publicKeyJwk.x).toBe(prepared.root.publicKeyJwk.x);
      expect(verifyNativeRelease(old.manifest, [prepared.root]).manifest.nativeArtifacts?.filter(artifact => artifact.kind === "agent_bridge").map(artifact => artifact.agentId)).toEqual(["claude-code"]);
      expect(release.bundleVersion).toBe("0.2.0-e2e");
      expect(release.nativeArtifacts?.filter(artifact => artifact.kind === "agent_bridge").map(artifact => artifact.agentId)).toEqual(["claude-code", "codex"]);
      expect(release.modelCapabilityMappings?.map(mapping => mapping.bridgeProfileRef)).toEqual([
        "e2e-real-claude-code-acp",
        "e2e-real-codex-acp",
      ]);
      expect(release.modelCapabilityMappings?.[1]?.modelIdentities).toContainEqual({
        value: "gpt-5.6-sol",
        canonicalProviderId: "openai",
        canonicalModelId: "gpt-5.6-sol",
      });
      await expect(readFile(prepared.artifactFiles.agents["claude-code"]!)).resolves.toEqual(await readFile(claude.archive));
      await expect(readFile(prepared.artifactFiles.agents.codex!)).resolves.toEqual(await readFile(codex.archive));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function writeExternalCodexPackage(root: string, platform: { os: "macos"; architecture: "arm64" }) {
  return writeExternalAgentPackage(root, platform, "codex");
}

async function writeExternalAgentPackage(root: string, platform: { os: "macos"; architecture: "arm64" }, agentId: "codex" | "claude-code") {
  const family = agentId === "claude-code" ? {
    bridgePackage: "@agentclientprotocol/claude-agent-acp", bridgeVersion: "0.75.1",
    bridgeEntrypoint: "bridge/claude-agent-acp", toolingPackage: "@anthropic-ai/claude-code", toolingEntrypoint: "bin/claude",
  } : {
    bridgePackage: "@agentclientprotocol/codex-acp", bridgeVersion: "1.10.0",
    bridgeEntrypoint: "bridge/codex-acp", toolingPackage: "@openai/codex", toolingEntrypoint: "bin/codex",
  };
  const files = [
    { path: family.toolingEntrypoint, bytes: Buffer.from("#!/bin/sh\nexit 0\n"), executable: true },
    { path: family.bridgeEntrypoint, bytes: Buffer.from("#!/bin/sh\nexit 0\n"), executable: true },
  ];
  const profile = NativeAgentPackageProfileSchema.parse({
    schemaVersion: 1, agentId, ...platform,
    bridge: { package: family.bridgePackage, version: family.bridgeVersion, entrypoint: family.bridgeEntrypoint, runtime: "native" },
    tooling: { package: family.toolingPackage, version: "0.153.3", entrypoint: family.toolingEntrypoint, runtime: "native" },
    files: files.map(file => ({ path: file.path, digest: hash(file.bytes), sizeBytes: file.bytes.length, executable: file.executable })),
  });
  const profileBytes = Buffer.from(JSON.stringify(profile));
  const profilePath = join(root, `external-${agentId}-konteks-agent.json`), archivePath = join(root, `external-${agentId}.tgz`);
  await writeFile(profilePath, profileBytes);
  await writeFile(archivePath, gzipSync(testTar([{ path: "konteks-agent.json", bytes: profileBytes }, ...files])));
  return { profile: profilePath, archive: archivePath };
}

function hash(bytes: Buffer): `sha256:${string}` { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function testTar(entries: { path: string; bytes: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512); header.write(entry.path, 0, 100); header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116); header.write(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263); header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
