import { createHash, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, computeBundleManifestDigest, writeSecretFile } from "@konteks/remote-common";
import { buildReleaseFixture } from "@konteks/remote-release";
import { loadNativeInstallation, SupervisorStore, verifyInstalledNativeConnector } from "@konteks/remote-supervisor";
import { addNativeAgent, installNative, readNativeRecord, restoreNativeRecord } from "../native/install.js";
import { createOutput } from "../output.js";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { resolveBridgeSpawnSpec, resolveToolingCommand, resolveBridgeFamily } from "@konteks/remote-agent-runner";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-cli-install-")); roots.push(root);
  const profile = join(root, "operator-codex");
  await mkdir(profile, { mode: 0o700 });
  vi.stubEnv("CODEX_HOME", profile);
  const keys = buildReleaseFixture();
  const agent = offlineFixture();
  const claude = offlineFixture("macos", "arm64", "claude-code");
  const bytes = Buffer.from("test-native-executable-not-run");
  const artifact = { id: "connector", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: "https://releases.example/connector", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, sizeBytes: bytes.length };
  const signed = (body: Record<string, unknown>) => {
    const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
    return { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
  };
  const base = { protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], expiresAt: "2027-01-01T00:00:00Z" };
  const oldManifest = signed({ ...base, bundleVersion: "1.0.0", nativeArtifacts: [artifact, claude.artifact] });
  const manifest = signed({ ...base, bundleVersion: "1.1.0", nativeArtifacts: [artifact, claude.artifact, agent.artifact] });
  const trust = [{ ...keys.root, coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }] }];
  const platform = { os: "macos", architecture: "arm64", deploymentKind: "native_connector", containerBackend: "none" } as const;
  const activate = vi.fn(async ({ release }: { release: { manifest: typeof manifest } }) => {
    const activatedManifest = release.manifest;
    await writeSecretFile(join(root, "supervisor", "identity.json"), JSON.stringify({ instanceId: "instance", workspaceId: "tenant", activationId: "activation-123", activatedAt: new Date().toISOString(), administrativeStatus: "provisioning", exchangeNonce: "nonce" }));
    await writeSecretFile(join(root, "supervisor", "manifest.json"), JSON.stringify({ manifest: activatedManifest, manifestDigest: activatedManifest.digest }));
    return { instanceId: "instance", manifest: activatedManifest, manifestDigest: activatedManifest.digest, provisioningWindowExpiresAt: "2026-10-01T00:00:00Z" };
  });
  const fetchFn = vi.fn(async (url: string) => new Response(url === agent.artifact.url ? agent.archive : url === claude.artifact.url ? claude.archive : bytes));
  const options = { root, activationId: "activation-123", coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", agents: ["codex"], output: createOutput({ json: true }), deps: { roots: trust, platform, manifest, activate, fetchFn, git: null } };
  return { root, options, activate, trust, platform, manifest, oldManifest, fetchFn };
}

/** The person's own DeepSeek Harness and Node, as npm installs them (the Node only answers --version). */
async function personDsh(root: string, version = "0.1.7-rc.2") {
  const prefix = join(root, "person-npm");
  const pkg = join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
  await mkdir(join(pkg, "lib"), { recursive: true });
  await writeFile(join(pkg, "lib", "bin.js"), "#!/usr/bin/env node\n");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version, bin: { dsh: "lib/bin.js" } }));
  await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(join(prefix, "bin", "node"), "#!/bin/sh\necho v22.23.2\n");
  await chmod(join(prefix, "bin", "node"), 0o755);
  vi.stubEnv("DSH_EXECUTABLE", await realpath(pkg));
  vi.stubEnv("DSH_NODE", await realpath(join(prefix, "bin", "node")));
  return { pkg: await realpath(pkg), node: await realpath(join(prefix, "bin", "node")) };
}

describe("native install composition", () => {
  it.runIf(process.platform !== "win32")("installs the person's own DeepSeek Harness beside bundled agents, with no package of it", async () => {
    const f = await fixture();
    const dsh = await personDsh(f.root);
    await installNative({ ...f.options, agents: ["codex", "dsh"] } as never);
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(loaded.record).toMatchObject({ agents: ["codex", "dsh"], dshRoot: dsh.pkg, dshNode: dsh.node });
    expect(loaded.runners.find(runner => runner.RUNNER_AGENT_ID === "dsh")).toMatchObject({ RUNNER_NATIVE_DSH_ROOT: dsh.pkg, RUNNER_NATIVE_DSH_NODE: dsh.node });
    const release = join(f.root, "releases", loaded.record.releaseId, "agents");
    expect(await readdir(release)).toEqual(["codex"]);
    expect(await readdir(join(f.root, "credentials"))).toEqual(expect.arrayContaining(["codex", "dsh"]));
  });
  it.runIf(process.platform !== "win32")("refuses an unsupported DeepSeek Harness before any activation is used", async () => {
    const f = await fixture();
    await personDsh(f.root, "0.1.5-rc.2");
    await expect(installNative({ ...f.options, agents: ["codex", "dsh"] } as never)).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_unsupported_version" });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it.runIf(process.platform !== "win32")("adds DeepSeek Harness to an installed runtime without a new release or reactivation", async () => {
    const f = await fixture();
    const first = await installNative(f.options as never);
    const dsh = await personDsh(f.root);
    const fetches = f.fetchFn.mock.calls.length;
    const added = await addNativeAgent({ root: f.root, agentId: "dsh", output: createOutput({ json: true }), deps: { roots: f.trust, platform: f.platform, fetchFn: f.fetchFn } } as never);
    expect(added).toMatchObject({ agents: ["codex", "dsh"], releaseId: first.releaseId, dshRoot: dsh.pkg, dshNode: dsh.node });
    expect(f.fetchFn.mock.calls.length).toBe(fetches);
    expect(f.activate).toHaveBeenCalledTimes(1);
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(loaded.runners.map(runner => runner.RUNNER_AGENT_ID)).toEqual(["codex", "dsh"]);
    await expect(addNativeAgent({ root: f.root, agentId: "dsh", output: createOutput({ json: true }), deps: { roots: f.trust, platform: f.platform } } as never)).resolves.toMatchObject({ agents: ["codex", "dsh"] });
  });
  it("creates the production native installation record and no domain-service volumes", async () => {
    const f = await fixture();
    await installNative(f.options as never);
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(loaded.record).toMatchObject({ deploymentKind: "native_connector", instanceId: "instance", workspaceId: "tenant", agents: ["codex"] });
    expect(loaded.runners[0]?.RUNNER_AUTH_MODE).toBe("agent_local_subscription");
    expect(loaded.record.codexHome).toBe(await realpath(join(f.root, "operator-codex")));
    vi.stubEnv("CODEX_HOME", join(f.root, "not-the-installed-profile"));
    const restarted = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(restarted.runners[0]?.RUNNER_NATIVE_CODEX_HOME).toBe(loaded.record.codexHome);
    const runner = loaded.runners[0]!, family = resolveBridgeFamily("codex");
    const bridge = resolveBridgeSpawnSpec(runner), login = resolveToolingCommand(runner, family, family.tooling.login);
    expect(bridge.command).toBe(join(runner.RUNNER_BRIDGE_PREFIX, "bin/node"));
    expect(bridge.args).toEqual([join(runner.RUNNER_BRIDGE_PREFIX, "bridge/index.js")]);
    expect(login.command).toBe(join(runner.RUNNER_BRIDGE_PREFIX, "bin/codex"));
    expect(login.args).toEqual(["login", "--device-auth"]);
    expect(await readdir(f.root)).not.toEqual(expect.arrayContaining(["compose", "stores", "harness", "validation-runtime", "gateway"]));
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).not.toMatch(/activationCode|gateway_keyed/);
    expect(f.activate).toHaveBeenCalledWith(expect.objectContaining({ platform: f.platform }));
  });
  it("resumes an installed identity without exchanging or overwriting its runtime record", async () => {
    const f = await fixture();
    const first = await installNative(f.options as never);
    const second = await installNative(f.options as never);
    expect(second).toEqual(first);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });
  it("adds Codex through a new immutable release without reactivation or touching existing agent data", async () => {
    const f = await fixture();
    const claude = join(f.root, "operator-claude");
    await writeFile(claude, "claude-not-executed", { mode: 0o700 });
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", claude);
    f.options.agents = ["claude-code"];
    f.options.deps.manifest = f.oldManifest;
    const before = await installNative(f.options as never);
    await writeFile(join(f.root, "credentials", "claude-code", "keep"), "credential-owned-by-agent");
    await writeFile(join(f.root, "workspaces", "claude-code", "keep"), "workspace-owned-by-agent");
    const identity = await readFile(join(f.root, "supervisor", "identity.json"), "utf8");

    const added = await addNativeAgent({ root: f.root, agentId: "codex", output: f.options.output, deps: { roots: f.trust, platform: f.platform, manifest: f.manifest, fetchFn: f.fetchFn } });

    expect(added).toMatchObject({ instanceId: before.instanceId, workspaceId: before.workspaceId, agents: ["claude-code", "codex"], codexHome: await realpath(join(f.root, "operator-codex")) });
    expect(added.releaseId).not.toBe(before.releaseId);
    expect(added.manifestDigest).toBe(f.manifest.digest);
    expect(added.manifestDigest).not.toBe(before.manifestDigest);
    expect(added.bundleVersion).toBe("1.1.0");
    expect(await new SupervisorStore(join(f.root, "supervisor")).manifest()).toEqual({ manifest: f.manifest, manifestDigest: f.manifest.digest });
    expect(await readFile(join(f.root, "supervisor", "identity.json"), "utf8")).toBe(identity);
    expect(await readFile(join(f.root, "credentials", "claude-code", "keep"), "utf8")).toBe("credential-owned-by-agent");
    expect(await readFile(join(f.root, "workspaces", "claude-code", "keep"), "utf8")).toBe("workspace-owned-by-agent");
    expect(f.activate).toHaveBeenCalledTimes(1);
    await expect(loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform })).resolves.toMatchObject({ record: { agents: ["claude-code", "codex"] }, runners: [{ RUNNER_AGENT_ID: "claude-code" }, { RUNNER_AGENT_ID: "codex" }] });
    await restoreNativeRecord(f.root, added.releaseId, before, { roots: f.trust, platform: f.platform });
    expect(await new SupervisorStore(join(f.root, "supervisor")).manifest()).toEqual({ manifest: f.oldManifest, manifestDigest: f.oldManifest.digest });
    await expect(loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform })).resolves.toMatchObject({ record: { agents: ["claude-code"], releaseId: before.releaseId }, runners: [{ RUNNER_AGENT_ID: "claude-code" }] });
    expect(await readFile(join(f.root, "credentials", "claude-code", "keep"), "utf8")).toBe("credential-owned-by-agent");
  });
  it("refuses stale or untrusted release evolution without changing the installed record", async () => {
    const f = await fixture();
    const claude = join(f.root, "operator-claude");
    await writeFile(claude, "claude-not-executed", { mode: 0o700 });
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", claude);
    f.options.agents = ["claude-code"];
    f.options.deps.manifest = f.oldManifest;
    const before = await installNative(f.options as never);
    await expect(addNativeAgent({ root: f.root, agentId: "codex", output: f.options.output, deps: { roots: f.trust, platform: f.platform, manifest: f.oldManifest, fetchFn: f.fetchFn } })).rejects.toMatchObject({ code: "update_required" });
    await expect(addNativeAgent({ root: f.root, agentId: "codex", output: f.options.output, deps: { roots: [], platform: f.platform, manifest: f.manifest, fetchFn: f.fetchFn } })).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(await readNativeRecord(f.root)).toEqual(before);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });
  it("refuses a missing local Codex profile before activation", async () => {
    const f = await fixture();
    vi.stubEnv("CODEX_HOME", join(f.root, "missing-profile"));
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "prerequisite_missing" });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it("binds a legacy profile without reactivating or replacing other local state", async () => {
    const f = await fixture();
    const installed = await installNative(f.options as never);
    const { codexHome: _codexHome, ...legacy } = installed;
    await writeSecretFile(join(f.root, "native-runtime.json"), JSON.stringify(legacy));
    const before = await readFile(join(f.root, "supervisor", "identity.json"), "utf8");
    const updated = await installNative(f.options as never);
    expect(updated).toEqual(installed);
    expect(await readFile(join(f.root, "supervisor", "identity.json"), "utf8")).toBe(before);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });
  it("refuses untrusted native releases before activation", async () => {
    const f = await fixture();
    f.options.deps.roots = [];
    await expect(installNative(f.options as never)).rejects.toThrow();
    expect(f.activate).not.toHaveBeenCalled();
  });
  it("refuses unsupported Pi compatibility before activation or downloads", async () => {
    const f = await fixture();
    f.options.agents = ["pi"];
    await expect(installNative(f.options as never)).rejects.toThrow("Pi native authentication and MCP compatibility are not yet supported");
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.options.deps.fetchFn).not.toHaveBeenCalled();
  });
  it("rechecks the connector executable before OS service execution", async () => {
    const f = await fixture();
    const record = await installNative(f.options as never);
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    const directory = join(f.root, "releases", record.releaseId);
    await expect(verifyInstalledNativeConnector(loaded.release, directory, f.platform)).resolves.toBeUndefined();
    // Either name tampered is refused: the service runs one, older launchers the other.
    for (const name of ["konteks-connector", "connector"]) {
      const original = await readFile(join(directory, name));
      await writeFile(join(directory, name), "tampered");
      await chmod(join(directory, name), 0o700);
      await expect(verifyInstalledNativeConnector(loaded.release, directory, f.platform)).rejects.toThrow();
      await writeFile(join(directory, name), original);
    }
    await expect(verifyInstalledNativeConnector(loaded.release, directory, f.platform)).resolves.toBeUndefined();
    // A folder with no connector under either name is refused.
    for (const name of ["konteks-connector", "connector"]) await rm(join(directory, name));
    await expect(verifyInstalledNativeConnector(loaded.release, directory, f.platform)).rejects.toThrow();
  });
});
