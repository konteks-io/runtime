import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteSignedBundleManifestSchema } from "@konteks/remote-common";
import { buildReleaseFixture } from "../fixtures.js";
import { signNativeReleaseManifest, verifyNativeRelease } from "../native.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const targets = [
  ["macos", "amd64"], ["macos", "arm64"], ["windows", "amd64"],
  ["debian", "amd64"], ["debian", "arm64"],
] as const;

describe("native release pipeline", () => {
  it("assembles only signed-manifest native connector and complete offline agent artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-release-pipeline-")); roots.push(root);
    const artifacts = targets.flatMap(([os, architecture], targetIndex) => [
      { id: `connector-${os}-${architecture}`, kind: "connector", format: "executable", os, architecture, url: `https://releases.example/v1.2.3/${os}/${architecture}/connector`, digest: digest(String(targetIndex + 1)), sizeBytes: 1024 },
      ...["claude-code", "codex", "opencode"].map((agentId, agentIndex) => ({
        id: `${agentId}-${os}-${architecture}`, kind: "agent_bridge", format: "offline_agent_tgz",
        agentId, os, architecture, url: `https://releases.example/v1.2.3/${os}/${architecture}/${agentId}.tgz`,
        digest: digest(String(targetIndex + agentIndex + 2)), profileDigest: digest(String(targetIndex + agentIndex + 5)), sizeBytes: 2048,
      })),
    ]);
    const index = join(root, "native-artifacts.json"), out = join(root, "manifest.json");
    await writeFile(index, JSON.stringify({ schemaVersion: 1, artifacts }));
    execFileSync(process.execPath, [resolve("scripts/assemble-release-manifest.mjs"), "--tag", "v1.2.3", "--artifacts", index, "--policy", resolve("release/release-policy.json"), "--out", out], { cwd: resolve(".") });
    const manifest = JSON.parse(await readFile(out, "utf8"));
    const fixture = buildReleaseFixture();
    const signed = signNativeReleaseManifest(manifest, { keyId: fixture.keyId, privateKey: fixture.privateKey });
    expect(RemoteSignedBundleManifestSchema.safeParse(signed).success).toBe(true);
    expect(manifest).toMatchObject({ bundleVersion: "1.2.3", deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [] });
    expect(manifest.nativeArtifacts).toHaveLength(20);
    expect(JSON.stringify(manifest)).not.toMatch(/harness|validation.runtime|gateway|compose|docker|postgres|valkey/i);
    expect(verifyNativeRelease(signed, [fixture.root], Date.now()).manifest.nativeArtifacts).toHaveLength(20);
  });

  it("rejects an incomplete platform or agent matrix before producing a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-release-pipeline-")); roots.push(root);
    const index = join(root, "native-artifacts.json"), out = join(root, "manifest.json");
    await writeFile(index, JSON.stringify({ schemaVersion: 1, artifacts: [] }));
    expect(() => execFileSync(process.execPath, [resolve("scripts/assemble-release-manifest.mjs"), "--tag", "v1.2.3", "--artifacts", index, "--policy", resolve("release/release-policy.json"), "--out", out], { cwd: resolve("."), stdio: "pipe" })).toThrow();
  });

  it("keeps the active release workflow free of appliance image and Compose jobs", async () => {
    const workflow = await readFile(resolve(".github/workflows/release.yaml"), "utf8");
    expect(workflow).toContain("release-assets.mjs stage");
    expect(workflow).toContain("native-manifest.json");
    expect(workflow).toContain("sign-native");
    expect(workflow).toContain("gh release create");
    expect(workflow).not.toMatch(/docker\/|docker-|buildx|compose|domain-images|runner-images|gateway/i);
  });
});
