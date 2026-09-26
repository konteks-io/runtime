import { createHash, sign } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, computeBundleManifestDigest, controlCall, SupervisorStatusSchema, writeSecretFile } from "@konteks/remote-common";
import type { BridgeProcess } from "@konteks/remote-agent-runner";
import { buildReleaseFixture, installOfflineAgentPackage } from "@konteks/remote-release";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { loadNativeInstallation, NativeRuntimeRecordSchema, parseNativeRuntimeRecord } from "../native/installation.js";
import { createNativeService } from "../native/service.js";
import { SupervisorStore } from "../state/store.js";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { testGitTool } from "./native-git-fixture.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "native-installation-")));
  const profile = join(root, "operator-codex");
  await mkdir(profile, { mode: 0o700 });
  vi.stubEnv("CODEX_HOME", profile);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const keys = buildReleaseFixture();
  const agent = offlineFixture();
  const bytes = "verified-test-bridge-not-executed";
  const artifact = { id: "connector", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: "https://release.example/connector", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, sizeBytes: Buffer.byteLength(bytes) };
  const body = { bundleVersion: "1.0.0", protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], nativeArtifacts: [artifact, agent.artifact], expiresAt: "2027-01-01T00:00:00Z" };
  const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
  const manifest = { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
  const record = { schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance", workspaceId: "tenant", releaseId: "release-1", manifestDigest: manifest.digest, bundleVersion: "1.0.0", coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", controlPort: 41800, agents: ["codex"] };
  const releaseDir = join(root, "releases", record.releaseId);
  for (const directory of [join(root, "supervisor"), join(root, "credentials", "codex"), join(root, "workspaces", "codex"), join(releaseDir, "agents")]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await new SupervisorStore(join(root, "supervisor")).loadOrCreateInstanceKey();
  await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(record));
  await writeSecretFile(join(root, "supervisor", "identity.json"), JSON.stringify({ instanceId: "instance", workspaceId: "tenant", activationId: "activation", activatedAt: "2026-09-06T00:00:00Z", administrativeStatus: "provisioning", exchangeNonce: "nonce" }));
  await writeSecretFile(join(root, "supervisor", "manifest.json"), JSON.stringify({ manifest, manifestDigest: manifest.digest }));
  await writeSecretFile(join(releaseDir, "manifest.json"), JSON.stringify(manifest));
  const archive = join(releaseDir, "agent.tgz");
  await writeFile(archive, agent.archive, { mode: 0o600 });
  await installOfflineAgentPackage(archive, join(releaseDir, "agents", "codex"), agent.artifact as never);
  const executable = join(releaseDir, "agents", "codex", "bin", "node");
  const options = { roots: [{ ...keys.root, coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }] }], platform: { os: "macos" as const, architecture: "arm64" as const }, nowMs: Date.parse("2026-09-06T00:00:00Z") };
  return { record, manifest, releaseDir, executable, options };
}

describe("closed native runtime installation", () => {
  it("loads only the digest-matching installer-selected Git executable", async () => {
    const f = await fixture(), git = await testGitTool();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, git }));
    expect((await loadNativeInstallation(root, f.options)).record.git).toEqual(git);
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, git: { ...git, digest: "sha256:" + "f".repeat(64) } }));
    await expect(loadNativeInstallation(root, f.options)).rejects.toThrow();
  });
  it("uses the production input preparer without an embedding adapter", async () => {
    const f = await fixture();
    expect(() => createNativeService({ root, ...f.options })).not.toThrow();
  });
  it("serves authenticated native status, rejects BYOK, and releases its runner and ownership on shutdown", async () => {
    const f = await fixture();
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, controlPort: port }));
    const stop = vi.fn(async () => undefined);
    const spawn = vi.fn(async () => ({ initializeResult: { protocolVersion: 1 }, connection: {}, exited: false, stderrTail: () => [], stop }) as BridgeProcess);
    const signals = new EventEmitter();
    const service = createNativeService({ root, ...f.options, prepareInputs: async () => { throw new Error("no assignment in service test"); }, runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" as const }) }, signalSource: signals });
    try {
      await service.start();
      const token = await new SupervisorStore(join(root, "supervisor")).controlToken();
      const result = await controlCall({ port, token }, { request: { op: "status" }, schema: SupervisorStatusSchema });
      expect(result.instanceId).toBe("instance");
      expect(result.administrativeStatus).toBe("provisioning");
      expect(result.lease.mode).toBe("none");
      expect(result.components.map(component => component.kind)).toEqual(["agent_runner"]);
      await expect(controlCall({ port, token: "wrong", timeoutMs: 500 }, { request: { op: "status" }, schema: z.unknown() })).rejects.toThrow();
      // The retired appliance's BYOK operation is no longer part of the closed protocol.
      await expect(controlCall({ port, token, timeoutMs: 500 }, { request: { op: "gateway.key.set", agentId: "codex", key: "not-a-provider-key" } as never, schema: z.unknown() })).rejects.toThrow();
      expect(spawn).toHaveBeenCalledOnce();
      signals.emit("SIGTERM");
      await service.waitUntilStopped();
      expect(stop).toHaveBeenCalledOnce();
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      const nextOwner = acquireNativeRootLock(join(root, "supervisor"));
      nextOwner.release();
      await expect(controlCall({ port, token, timeoutMs: 500 }, { request: { op: "status" }, schema: z.unknown() })).rejects.toThrow();
    } finally { await service.shutdown("test-cleanup", 0); }
  });
  it("cleans up the started runner and releases ownership when the local control port is occupied", async () => {
    const f = await fixture();
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, controlPort: port }));
    const stop = vi.fn(async () => undefined);
    const spawn = vi.fn(async () => ({ initializeResult: { protocolVersion: 1 }, connection: {}, exited: false, stderrTail: () => [], stop }) as BridgeProcess);
    const service = createNativeService({ root, ...f.options, prepareInputs: async () => { throw new Error("no assignment in service test"); }, runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" as const }) }, signalSource: new EventEmitter() });
    try {
      await expect(service.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      await service.waitUntilStopped();
      expect(stop).toHaveBeenCalledOnce();
      const nextOwner = acquireNativeRootLock(join(root, "supervisor"));
      nextOwner.release();
    } finally {
      await service.shutdown("test-cleanup", 0);
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each(["linked", "hard-linked", "public", "oversized"])("rejects %s runtime records without executing anything", async kind => {
    const f = await fixture();
    const path = join(root, "native-runtime.json");
    if (kind === "linked") {
      await writeSecretFile(join(root, "another.json"), JSON.stringify(f.record));
      await rm(path);
      await symlink(join(root, "another.json"), path);
    }
    if (kind === "hard-linked") await link(path, join(root, "alias.json"));
    if (kind === "public") await chmod(path, 0o644);
    if (kind === "oversized") await writeSecretFile(path, " ".repeat(1024 * 1024 + 1));
    await expect(loadNativeInstallation(root, f.options)).rejects.toMatchObject({ code: "install_state_corrupt" });
  });
  it("derives native configuration and isolated agent paths without inheriting appliance environment", async () => {
    const f = await fixture();
    vi.stubEnv("SUPERVISOR_DEPLOYMENT_KIND", "appliance");
    vi.stubEnv("SUPERVISOR_CORE_URL", "https://wrong.example");
    const loaded = await loadNativeInstallation(root, f.options);
    expect(loaded.runners[0]?.RUNNER_NATIVE_CODEX_HOME).toBe(join(root, "operator-codex"));
    expect(loaded.config).toMatchObject({ SUPERVISOR_DEPLOYMENT_KIND: "native_connector", SUPERVISOR_DATA_DIR: join(root, "supervisor"), SUPERVISOR_ONBOARD_GIT_KEY_DIR: join(root, "supervisor", "git-keys"), SUPERVISOR_ONBOARD_SCRATCH_ROOT: join(root, "supervisor", "onboard"), SUPERVISOR_CORE_URL: "https://core.example", SUPERVISOR_BUNDLE_VERSION: "1.0.0" });
    expect(loaded.runners).toHaveLength(1);
    expect(loaded.runners[0]).toMatchObject({ RUNNER_AGENT_ID: "codex", RUNNER_AUTH_MODE: "agent_local_subscription", RUNNER_CREDENTIAL_DIR: join(root, "credentials", "codex"), RUNNER_WORKSPACE_DIR: join(root, "workspaces", "codex"), RUNNER_BRIDGE_PREFIX: join(f.releaseDir, "agents", "codex") });
    expect(loaded.runners[0]).not.toHaveProperty("RUNNER_GATEWAY_BASE_URL");
  });
  it.runIf(process.platform !== "win32")("runs DeepSeek Harness from the person's own installation, with no bundled artifact", async () => {
    const f = await fixture();
    const dsh = async (version: string) => {
      const pkg = join(root, `dsh-${version}`);
      await mkdir(join(pkg, "lib"), { recursive: true });
      await writeFile(join(pkg, "lib", "bin.js"), "#!/usr/bin/env node\n");
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version, bin: { dsh: "lib/bin.js" } }));
      return pkg;
    };
    for (const directory of [join(root, "credentials", "dsh"), join(root, "workspaces", "dsh")]) await mkdir(directory, { recursive: true, mode: 0o700 });
    const supported = await dsh("0.1.7-rc.2");
    // The person's Node, as installed (a stand-in that only answers --version).
    const node = join(root, "person-node", "bin", "node");
    await mkdir(join(node, ".."), { recursive: true });
    await writeFile(node, "#!/bin/sh\necho v22.23.2\n");
    await chmod(node, 0o755);
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, agents: ["codex", "dsh"], dshRoot: supported, dshNode: node }));
    const loaded = await loadNativeInstallation(root, f.options);
    expect(loaded.runners.map(runner => runner.RUNNER_AGENT_ID)).toEqual(["codex", "dsh"]);
    const runner = loaded.runners[1]!;
    expect(runner).toMatchObject({ RUNNER_AGENT_ID: "dsh", RUNNER_NATIVE_DSH_ROOT: supported, RUNNER_NATIVE_DSH_ENTRY: join(supported, "lib", "bin.js"), RUNNER_NATIVE_DSH_NODE: node, RUNNER_BRIDGE_VERSION: "0.1.7-rc.2", RUNNER_CREDENTIAL_DIR: join(root, "credentials", "dsh"), RUNNER_WORKSPACE_DIR: join(root, "workspaces", "dsh") });
    expect(runner).not.toHaveProperty("RUNNER_NATIVE_PACKAGE_PROFILE");
    expect(runner).not.toHaveProperty("RUNNER_NATIVE_PACKAGE_ARTIFACT");
    // An upgrade out of the tested range stops the load with the install hint, never a silent run.
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, agents: ["codex", "dsh"], dshRoot: await dsh("0.1.8"), dshNode: node }));
    await expect(loadNativeInstallation(root, f.options)).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_unsupported_version" });
    expect(NativeRuntimeRecordSchema.safeParse({ ...f.record, agents: ["claude-code", "codex", "dsh"] }).success).toBe(true);
  });
  it("still loads a record written before 7.0.0 that lists Pi or OpenCode, without them", async () => {
    const f = await fixture();
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, agents: ["codex", "opencode", "pi"] }));
    const loaded = await loadNativeInstallation(root, f.options);
    expect(loaded.record.agents).toEqual(["codex"]);
    expect(loaded.retiredAgents).toEqual(["opencode", "pi"]);
    expect(loaded.runners.map(runner => runner.RUNNER_AGENT_ID)).toEqual(["codex"]);
    // Tolerant reading only: a new record naming a retired agent is refused.
    expect(NativeRuntimeRecordSchema.safeParse({ ...f.record, agents: ["codex", "opencode"] }).success).toBe(false);
    expect(parseNativeRuntimeRecord({ ...f.record, agents: ["pi", "codex"] }).record.agents).toEqual(["codex"]);
  });
  it.each([{ releaseId: "../outside" }, { agents: ["codex", "codex"] }, { coreUrl: "http://core.example" }, { coreUrl: "https://user:password@core.example" }, { relayUrl: "ws://relay.example" }, { gatewayKey: "forbidden" }, { environment: { NODE_OPTIONS: "--require untrusted" } }, { deploymentKind: "appliance" }, { command: "/bin/sh" }])("rejects unsafe or unimplemented install fields", async patch => {
    const f = await fixture();
    expect(NativeRuntimeRecordSchema.safeParse({ ...f.record, ...patch }).success).toBe(false);
  });
  it("rejects metadata identity/tenant/digest drift before returning runnable configuration", async () => {
    const f = await fixture();
    for (const patch of [{ instanceId: "other" }, { workspaceId: "other" }, { manifestDigest: "A".repeat(43) }, { bundleVersion: "9.0.0" }]) {
      await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, ...patch }));
      await expect(loadNativeInstallation(root, f.options)).rejects.toThrow();
    }
  });
  it("rejects tampered bridge bytes and linked release directories", async () => {
    const f = await fixture();
    await writeSecretFile(f.executable, "tampered");
    await chmod(f.executable, 0o700);
    await expect(loadNativeInstallation(root, f.options)).rejects.toMatchObject({ code: "bundle_untrusted" });
    await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({ ...f.record, releaseId: "alias" }));
    await symlink(f.releaseDir, join(root, "releases", "alias"));
    await expect(loadNativeInstallation(root, f.options)).rejects.toThrow();
  });
  it("cannot bootstrap trust from an editable roots file or run the wrong platform", async () => {
    const f = await fixture();
    await writeSecretFile(join(f.releaseDir, "roots.json"), JSON.stringify({ roots: f.options.roots }));
    await expect(loadNativeInstallation(root, { ...f.options, roots: [] })).rejects.toMatchObject({ code: "bundle_untrusted" });
    await expect(loadNativeInstallation(root, { ...f.options, platform: { os: "debian", architecture: "amd64" } })).rejects.toThrow();
  });
});
