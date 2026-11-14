import { createHash, createPublicKey, sign } from "node:crypto";
import { createServer } from "node:net";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, computeBundleManifestDigest, RemoteInstanceError, verifyInstanceProof, writeSecretFile } from "@konteks/remote-common";
import { buildReleaseFixture } from "@konteks/remote-release";
import { acquireNativeRootLock, CORE_AUDIENCE, hostAgentInstallAdapter, loadNativeInstallation, OPENCODE_MIN_BINARY_BYTES, SupervisorStore, verifyInstalledNativeConnector } from "@konteks/remote-supervisor";
import { addNativeAgent, completeNativeEnrollment, installNative, prepareNativeReenrollment, readNativeEnrollment, readNativeRecord, reassignOccupiedNativeControlPort, recordNativeEnrollment, removeNativeAgent, restoreNativeRecord } from "../native/install.js";
import { startNativeConnector } from "../native/commands.js";
import { SupervisorControl } from "../control.js";
import { uninstallNative } from "../native/uninstall.js";
import { readNativeReinstall } from "../native/reinstall.js";
import { createOutput } from "../output.js";
import { terminalFetchConsent } from "../native/consent.js";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { resolveBridgeSpawnSpec, resolveToolingCommand, resolveBridgeFamily } from "@konteks/remote-agent-runner";

const renameFault = vi.hoisted(() => ({ match: null as null | ((source: string, destination: string) => "before" | "after" | null) }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: async (source: string, destination: string) => {
    const fault = renameFault.match?.(String(source).replaceAll("\\", "/"), String(destination).replaceAll("\\", "/"));
    if (fault === "before") throw new Error("interrupted-native-reinstall-rename");
    await original.rename(source, destination);
    if (fault === "after") throw new Error("interrupted-native-reinstall-rename");
  } };
});

const checkpointFault = vi.hoisted(() => ({ phase: "", timing: "" }));
vi.mock("@konteks/remote-common", async importOriginal => {
  const original = await importOriginal<typeof import("@konteks/remote-common")>();
  return { ...original, writeSecretFile: async (path: string, value: string | Uint8Array) => {
    const phase = path.endsWith("reinstall.json") ? JSON.parse(String(value)).phase : "";
    const match = phase && phase === checkpointFault.phase;
    if (match && checkpointFault.timing === "before") throw new Error("interrupted-native-reinstall-checkpoint");
    await original.writeSecretFile(path, value);
    if (match && checkpointFault.timing === "after") throw new Error("interrupted-native-reinstall-checkpoint");
  } };
});

const roots: string[] = [];
afterEach(async () => { checkpointFault.phase = ""; checkpointFault.timing = ""; renameFault.match = null; vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
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
  const olderManifest = signed({ ...base, bundleVersion: "0.9.0", nativeArtifacts: [artifact, claude.artifact, agent.artifact] });
  const trust = [{ ...keys.root, coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }] }];
  const platform = { os: "macos", architecture: "arm64", deploymentKind: "native_connector", containerBackend: "none" } as const;
  const activate = vi.fn(async ({ release, activationId, dataDir = join(root, "supervisor") }: { release: { manifest: typeof manifest }; activationId: string; dataDir?: string }) => {
    const activatedManifest = release.manifest;
    const instanceId = activationId === "activation-123" ? "instance" : "replacement-instance";
    await new SupervisorStore(dataDir).loadOrCreateInstanceKey();
    await writeSecretFile(join(dataDir, "identity.json"), JSON.stringify({ instanceId, workspaceId: "tenant", activationId, activatedAt: new Date().toISOString(), administrativeStatus: "provisioning", exchangeNonce: "nonce" }));
    await writeSecretFile(join(dataDir, "manifest.json"), JSON.stringify({ manifest: activatedManifest, manifestDigest: activatedManifest.digest }));
    return { instanceId, manifest: activatedManifest, manifestDigest: activatedManifest.digest, provisioningWindowExpiresAt: "2026-10-01T00:00:00Z" };
  });
  const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => new Response(url === agent.artifact.url ? agent.archive : url === claude.artifact.url ? claude.archive : bytes));
  const options = { root, activationId: "activation-123", coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", agents: ["codex"], output: createOutput({ json: true }), deps: { roots: trust, platform, manifest, activate, fetchFn, git: null } };
  return { root, options, activate, trust, platform, manifest, oldManifest, olderManifest, fetchFn };
}

async function replacementFixture() {
  const f = await fixture();
  const previous = await installNative(f.options as never);
  const originalFetch = f.fetchFn.getMockImplementation()!;
  const owner = { reply: () => new Response(JSON.stringify({ code: "instance_revoked", message: "Identity cannot be recovered" }), { status: 422 }) };
  f.fetchFn.mockImplementation(async (url: string) => String(url).endsWith("/runtime-owner/resolve") ? owner.reply() : originalFetch(url));
  const record = await readFile(join(f.root, "native-runtime.json"), "utf8");
  const identity = await readFile(join(f.root, "supervisor", "identity.json"), "utf8");
  const key = await readFile(join(f.root, "supervisor", "instance-key.jwk"), "utf8");
  f.activate.mockClear();
  f.fetchFn.mockClear();
  const options = { ...f.options, activationId: "replacement-activation" };
  return { ...f, options, previous, owner, record, identity, key };
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

/**
 * The person's own OpenCode as npm installs it: a native-looking executable
 * (Mach-O magic, never run) with the package's version beside it.
 */
async function personOpenCode(root: string, version = "2.0.18", name = "@opencode/cli") {
  const pkg = join(root, "person-opencode", "lib", "node_modules", ...name.split("/"));
  await mkdir(join(pkg, "bin"), { recursive: true });
  const body = Buffer.alloc(OPENCODE_MIN_BINARY_BYTES + 16);
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(body);
  await writeFile(join(pkg, "bin", "opencode.exe"), body, { mode: 0o755 });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name, version }));
  vi.stubEnv("OPENCODE_EXECUTABLE", join(pkg, "bin", "opencode.exe"));
  return { binary: await realpath(join(pkg, "bin", "opencode.exe")) };
}

describe("native install composition", () => {
  it("installs a replacement activation after Core verifies the previous runtime is revoked, without uninstall", async () => {
    const f = await fixture();
    const previous = await installNative(f.options as never);
    await new SupervisorStore(join(f.root, "supervisor")).loadOrCreateInstanceKey();
    const originalFetch = f.fetchFn.getMockImplementation()!;
    f.fetchFn.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/runtime-owner/resolve")) return new Response(JSON.stringify({ code: "instance_revoked", message: "Identity cannot be recovered" }), { status: 422 });
      return originalFetch(url);
    });
    const credential = join(f.root, "credentials", "codex", "preserved-profile-state");
    await writeSecretFile(credential, "synthetic-profile-state");
    const replacement = await installNative({ ...f.options, activationId: "replacement-activation" } as never);
    expect(replacement.workspaceId).toBe(previous.workspaceId);
    expect(replacement.instanceId).not.toBe(previous.instanceId);
    expect(await readFile(credential, "utf8")).toBe("synthetic-profile-state");
    expect(JSON.parse(await readFile(join(f.root, "supervisor", "identity.json"), "utf8"))).toMatchObject({ activationId: "replacement-activation" });
    expect(f.activate).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "revoked", "provisioning"])("preserves a retained %s identity when its original key is unavailable", async administrativeStatus => {
    const f = await fixture();
    await installNative(f.options as never);
    const identityPath = join(f.root, "supervisor", "identity.json");
    const identity = JSON.parse(await readFile(identityPath, "utf8"));
    await writeSecretFile(identityPath, JSON.stringify({ ...identity, administrativeStatus }));
    await rm(join(f.root, "supervisor", "instance-key.jwk"));
    const credential = join(f.root, "credentials", "codex", "retained-test-state");
    const work = join(f.root, "workspaces", "codex", "retained-work");
    await writeSecretFile(credential, "synthetic-agent-state");
    await writeSecretFile(work, "synthetic-unfinished-work");
    const paths = [join(f.root, "native-runtime.json"), identityPath, credential, work];
    const before = await Promise.all(paths.map(path => readFile(path)));
    f.activate.mockClear();
    f.fetchFn.mockClear();
    const readActivationCode = vi.fn(async () => "unused-test-input");
    await expect(installNative({ ...f.options, activationId: "replacement-activation", deps: { ...f.options.deps, readActivationCode } } as never)).rejects.toMatchObject({
      code: "registration_mismatch",
      message: "The existing runtime key is unavailable; private data was preserved. Run konteks-remote doctor.",
    });
    expect(readActivationCode).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.fetchFn).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before);
  });

  it("characterizes a fresh activation succeeding after fixture-only uninstall", async () => {
    const f = await fixture();
    const profile = await mkdtemp(join(tmpdir(), "native-reinstall-profile-"));
    roots.push(profile);
    vi.stubEnv("CODEX_HOME", profile);
    await installNative(f.options as never);
    const execute = vi.fn(async () => 0);
    const removed = await uninstallNative({ root: f.root, output: f.options.output }, {
      control: async () => null, serviceDefinition: async () => null, execute,
      sleep: async () => undefined, now: () => Date.now(),
    });
    expect(removed.state).toBe("uninstalled");
    expect(execute).not.toHaveBeenCalled();
    const fresh = await installNative({ ...f.options, activationId: "replacement-activation" } as never);
    expect(fresh.instanceId).toBe("replacement-instance");
    expect(f.activate).toHaveBeenCalledTimes(2);
    expect(f.activate.mock.calls[1]?.[0]).toMatchObject({ activationId: "replacement-activation" });
    expect(JSON.parse(await readFile(join(f.root, "supervisor", "identity.json"), "utf8"))).toMatchObject({ activationId: "replacement-activation" });
  });

  it.each([
    [401, "activation_invalid"], [403, "permission_denied"], [404, "not_found"],
    [409, "registration_mismatch"], [422, "instance_suspended"], [403, "instance_revoked"],
  ])("does not infer retirement from HTTP %s with code %s", async (status, code) => {
    const f = await replacementFixture();
    f.owner.reply = () => new Response(JSON.stringify({ code, message: "refused" }), { status: Number(status) });
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "recovery_required" });
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).toBe(f.record);
    expect(await readFile(join(f.root, "supervisor", "identity.json"), "utf8")).toBe(f.identity);
    expect(f.activate).not.toHaveBeenCalled();
    expect(await readNativeReinstall(f.root)).toBeNull();
  });

  it("does not trust a locally revoked status when Core still accepts its owner", async () => {
    const f = await replacementFixture();
    await writeSecretFile(join(f.root, "supervisor", "identity.json"), JSON.stringify({ ...JSON.parse(f.identity), administrativeStatus: "revoked" }));
    f.owner.reply = () => new Response(JSON.stringify({ instanceId: f.previous.instanceId, ownerRevision: 0, currentIncarnation: null, acceptedHeartbeatSequence: 0, heartbeatSequenceFloor: 0 }));
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.activate).not.toHaveBeenCalled();
    expect(await readNativeRecord(f.root)).toEqual(f.previous);
  });

  it.each(["core", "relay", "agents"])("refuses a changed %s before contacting either server", async field => {
    const f = await replacementFixture();
    const patch = { core: { coreUrl: "https://other.example" }, relay: { relayUrl: "wss://other.example/runtime" }, agents: { agents: [] } }[field];
    await expect(installNative({ ...f.options, ...patch } as never)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.fetchFn).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(await readNativeRecord(f.root)).toEqual(f.previous);
  });

  it("verifies retirement without a bearer and refuses redirects", async () => {
    const f = await replacementFixture();
    await installNative(f.options as never);
    const calls = f.fetchFn.mock.calls as unknown as Array<[string | URL, RequestInit]>;
    const request = calls.find(([url]) => String(url).endsWith("/runtime-owner/resolve"))!;
    expect(new Headers(request[1]?.headers).has("authorization")).toBe(false);
    expect(request[1]?.redirect).toBe("error");
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ instanceId: f.previous.instanceId, proof: { algorithm: "ES256" } });
  });

  it("privately retains old identity and key while the replacement uses a different key", async () => {
    const f = await replacementFixture();
    await installNative(f.options as never);
    const retired = await readdir(join(f.root, "retired"));
    expect(retired).toHaveLength(1);
    const archive = join(f.root, "retired", retired[0]!);
    expect(await readFile(join(archive, "native-runtime.json"), "utf8")).toBe(f.record);
    expect(await readFile(join(archive, "supervisor", "identity.json"), "utf8")).toBe(f.identity);
    expect(await readFile(join(archive, "supervisor", "instance-key.jwk"), "utf8")).toBe(f.key);
    expect(await readFile(join(f.root, "supervisor", "instance-key.jwk"), "utf8")).not.toBe(f.key);
    expect(await readNativeReinstall(f.root)).toBeNull();
  });

  it("retains the verified original profile instead of substituting another CODEX_HOME", async () => {
    const f = await replacementFixture();
    const other = join(f.root, "other-profile");
    await mkdir(other, { mode: 0o700 });
    vi.stubEnv("CODEX_HOME", other);
    const replacement = await installNative(f.options as never);
    expect(replacement.codexHome).toBe(f.previous.codexHome);
  });

  it("reuses the verified installed release without downloading it again", async () => {
    const f = await replacementFixture();
    const replacement = await installNative(f.options as never);
    expect(replacement.releaseId).toBe(f.previous.releaseId);
    expect(f.fetchFn.mock.calls.every(([url]) => String(url).endsWith("/runtime-owner/resolve"))).toBe(true);
  });

  it("does not replace an installation while its supervisor lock is held", async () => {
    const f = await replacementFixture();
    const owner = acquireNativeRootLock(join(f.root, "supervisor"));
    try {
      await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
      expect(f.fetchFn).not.toHaveBeenCalled();
      expect(f.activate).not.toHaveBeenCalled();
      expect(await readNativeRecord(f.root)).toEqual(f.previous);
    } finally { owner.release(); }
  });

  it("stops only the verified retired predecessor before reacquiring its supervisor ownership", async () => {
    const f = await replacementFixture();
    const owner = acquireNativeRootLock(join(f.root, "supervisor"));
    const stopRetired = vi.fn(async (record: { instanceId: string }) => {
      expect(record.instanceId).toBe(f.previous.instanceId);
      expect(f.fetchFn.mock.calls.some(([url]) => String(url).endsWith("/runtime-owner/resolve"))).toBe(true);
      owner.release();
    });
    try {
      const result = await installNative({ ...f.options, deps: { ...f.options.deps, stopRetired } } as never);
      expect(result.instanceId).toBe("replacement-instance");
      expect(stopRetired).toHaveBeenCalledTimes(1);
    } finally { owner.release(); }
  });

  it("never stops a running predecessor on an unverified retirement response", async () => {
    const f = await replacementFixture();
    const owner = acquireNativeRootLock(join(f.root, "supervisor"));
    const stopRetired = vi.fn(async () => owner.release());
    f.owner.reply = () => new Response(JSON.stringify({ code: "permission_denied", message: "refused" }), { status: 403 });
    try {
      await expect(installNative({ ...f.options, deps: { ...f.options.deps, stopRetired } } as never)).rejects.toMatchObject({ code: "recovery_required" });
      expect(stopRetired).not.toHaveBeenCalled();
      expect(await readNativeRecord(f.root)).toEqual(f.previous);
    } finally { owner.release(); }
  });

  it("rejects another installer without consuming the replacement code", async () => {
    const f = await replacementFixture();
    const owner = acquireNativeRootLock(join(f.root, "installer"));
    try {
      await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
      expect(f.fetchFn).not.toHaveBeenCalled();
      expect(f.activate).not.toHaveBeenCalled();
    } finally { owner.release(); }
  });

  it("rechecks retirement before retrying a verified-but-uncommitted successor", async () => {
    const f = await replacementFixture();
    const output = { ...f.options.output, line: (text: string) => {
      if (text.startsWith("Keeping the previous")) throw new Error("interrupted-before-archive");
    } };
    await expect(installNative({ ...f.options, output } as never)).rejects.toThrow("interrupted-before-archive");
    expect((await readNativeReinstall(f.root))?.phase).toBe("activated");
    f.owner.reply = () => new Response(JSON.stringify({ code: "permission_denied", message: "refused" }), { status: 403 });
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "recovery_required" });
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).toBe(f.record);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });

  it("resumes after activation without another exchange or deleting prior data", async () => {
    const f = await replacementFixture();
    const output = { ...f.options.output, line: (text: string) => {
      if (text.startsWith("Keeping the previous")) throw new Error("interrupted-before-archive");
    } };
    await expect(installNative({ ...f.options, output } as never)).rejects.toThrow("interrupted-before-archive");
    const resumed = await installNative(f.options as never);
    expect(resumed.instanceId).toBe("replacement-instance");
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(await readNativeReinstall(f.root)).toBeNull();
  });

  it.each(["activation_invalid", "activation_expired", "activation_consumed", "limit_exceeded"] as const)("permits a new activation after definitive %s before any successor was bound", async code => {
    const f = await replacementFixture();
    f.activate.mockRejectedValueOnce(new RemoteInstanceError(code, "Activation was not accepted"));
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code });
    expect(await readNativeReinstall(f.root)).toBeNull();
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).toBe(f.record);
    const result = await installNative({ ...f.options, activationId: "another-replacement" } as never);
    expect(result.instanceId).toBe("replacement-instance");
  });

  it("does not overwrite a pending installation with a different activation", async () => {
    const f = await replacementFixture();
    f.activate.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "connection interrupted"));
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    await expect(installNative({ ...f.options, activationId: "different-activation" } as never)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).toBe(f.record);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });

  it("does not archive prior state when activation resolves to another workspace", async () => {
    const f = await replacementFixture();
    const activate = f.activate.getMockImplementation()!;
    f.activate.mockImplementationOnce(async args => {
      const outcome = await activate(args);
      const path = join(args.dataDir!, "identity.json");
      await writeSecretFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), workspaceId: "other-tenant" }));
      return outcome;
    });
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).toBe(f.record);
    expect(await readFile(join(f.root, "supervisor", "identity.json"), "utf8")).toBe(f.identity);
  });

  it("finishes an interrupted final record write without a second activation", async () => {
    const f = await replacementFixture();
    const output = { ...f.options.output, line: (text: string) => {
      if (text.startsWith("Installed.")) throw new Error("interrupted-after-record");
    } };
    await expect(installNative({ ...f.options, output } as never)).rejects.toThrow("interrupted-after-record");
    expect((await readNativeReinstall(f.root))?.phase).toBe("promoted");
    const resumed = await installNative(f.options as never);
    expect(resumed.instanceId).toBe("replacement-instance");
    expect(f.activate).toHaveBeenCalledTimes(1);
    expect(await readNativeReinstall(f.root)).toBeNull();
  });

  it("finalizes a completed replacement even when the new supervisor is already running", async () => {
    const f = await replacementFixture();
    const output = { ...f.options.output, line: (text: string) => {
      if (text.startsWith("Installed.")) throw new Error("interrupted-after-record");
    } };
    await expect(installNative({ ...f.options, output } as never)).rejects.toThrow("interrupted-after-record");
    const owner = acquireNativeRootLock(join(f.root, "supervisor"));
    try {
      const result = await installNative(f.options as never);
      expect(result.instanceId).toBe("replacement-instance");
      expect(await readNativeReinstall(f.root)).toBeNull();
      expect(f.activate).toHaveBeenCalledTimes(1);
    } finally { owner.release(); }
  });

  it("refuses a successor already known locally to be revoked before moving previous data", async () => {
    const f = await replacementFixture();
    const activate = f.activate.getMockImplementation()!;
    f.activate.mockImplementationOnce(async args => {
      const outcome = await activate(args);
      const path = join(args.dataDir!, "identity.json");
      await writeSecretFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), administrativeStatus: "revoked" }));
      return outcome;
    });
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).toBe(f.record);
  });

  it.runIf(process.platform !== "win32").each(["symlink", "hardlink", "public-mode"])("refuses an unsafe %s predecessor key before contacting Core", async kind => {
    const f = await replacementFixture();
    const path = join(f.root, "supervisor", "instance-key.jwk");
    const outside = await mkdtemp(join(tmpdir(), "native-key-outside-"));
    roots.push(outside);
    const target = join(outside, "key.jwk");
    await writeSecretFile(target, f.key);
    if (kind === "public-mode") await chmod(path, 0o644);
    else {
      await rm(path);
      if (kind === "symlink") await symlink(target, path);
      else await link(target, path);
    }
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.fetchFn).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe(f.key);
  });

  it.each(["malformed", "traversal", "duplicate", "lock-file", "oversized"])("refuses a %s checkpoint without modifying previous state", async kind => {
    const f = await replacementFixture();
    f.activate.mockRejectedValueOnce(new RemoteInstanceError("temporarily_unavailable", "interrupted"));
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    const path = join(f.root, "installer", "reinstall.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    const mutations: Record<string, string> = {
      malformed: "{", traversal: JSON.stringify({ ...state, previousEntries: ["../outside"] }),
      duplicate: JSON.stringify({ ...state, previousEntries: ["identity.json", "identity.json"] }),
      "lock-file": JSON.stringify({ ...state, previousEntries: ["connector-owner.sqlite"] }),
      oversized: "x".repeat(1024 * 1024 + 1),
    };
    await writeFile(path, mutations[kind]!);
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).toBe(f.record);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });

  describe.each(["before", "after"] as const)("interruption %s a durable state move", timing => {
    it.each([
      ["native-runtime.json", "archive"], ["identity.json", "archive"],
      ["instance-key.jwk", "archive"], ["manifest.json", "archive"],
      ["identity.json", "promote"], ["instance-key.jwk", "promote"], ["manifest.json", "promote"],
    ])("resumes %s %s without another activation", async (name, phase) => {
      const f = await replacementFixture();
      let interrupted = false;
      renameFault.match = (source, destination) => {
        const move = phase === "archive" ? destination.includes("/retired/reinstall-") : source.includes("/installer/reinstall-");
        if (interrupted || !move || !source.endsWith(`/${name}`)) return null;
        interrupted = true;
        return timing;
      };
      await expect(installNative(f.options as never)).rejects.toThrow("interrupted-native-reinstall-rename");
      expect(interrupted).toBe(true);
      expect(await readNativeReinstall(f.root)).not.toBeNull();
      renameFault.match = null;
      const resumed = await installNative(f.options as never);
      expect(resumed.instanceId).toBe("replacement-instance");
      expect(f.activate).toHaveBeenCalledTimes(1);
      const [retired] = await readdir(join(f.root, "retired"));
      expect(await readFile(join(f.root, "retired", retired!, "supervisor", "instance-key.jwk"), "utf8")).toBe(f.key);
      expect(await readNativeReinstall(f.root)).toBeNull();
    });
  });

  describe.each(["before", "after"])("interruption %s checkpoint commit", timing => {
    it.each(["prepared", "activated", "archiving", "promoting", "promoted"])("recovers the %s phase without losing either identity", async phase => {
      const f = await replacementFixture();
      checkpointFault.phase = phase;
      checkpointFault.timing = timing;
      await expect(installNative(f.options as never)).rejects.toThrow("interrupted-native-reinstall-checkpoint");
      checkpointFault.phase = "";
      checkpointFault.timing = "";
      const resumed = await installNative(f.options as never);
      expect(resumed.instanceId).toBe("replacement-instance");
      expect(await readNativeReinstall(f.root)).toBeNull();
      const [retired] = await readdir(join(f.root, "retired"));
      expect(await readFile(join(f.root, "retired", retired!, "native-runtime.json"), "utf8")).toBe(f.record);
      expect(await readFile(join(f.root, "retired", retired!, "supervisor", "instance-key.jwk"), "utf8")).toBe(f.key);
    });
  });

  it.each([false, true])("runs the real activation exchange with one successor, including lost response: %s", async loseResponse => {
    const f = await replacementFixture();
    const artifactFetch = f.fetchFn.getMockImplementation()!;
    const requests: unknown[] = [];
    const instances = new Set<string>();
    let disconnected = loseResponse;
    f.fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith("/activation-exchange")) return artifactFetch(url);
      const request = JSON.parse(String(init?.body));
      const publicKey = createPublicKey({ key: request.publicKeyJwk, format: "jwk" });
      expect(verifyInstanceProof(publicKey, { method: "activation_exchange", audience: CORE_AUDIENCE, subject: request.activationId, body: request }, request.proof)).toBe(true);
      requests.push(request);
      instances.add(JSON.stringify([request.activationId, request.publicKeyJwk, request.proof.nonce]));
      if (disconnected) throw new Error("synthetic-lost-response-after-server-commit");
      return new Response(JSON.stringify({ instanceId: "replacement-instance", workspaceId: "tenant", administrativeStatus: "provisioning",
        provisioningCredential: "synthetic-provisioning-only", provisioningCredentialExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        provisioningWindowExpiresAt: new Date(Date.now() + 86400000).toISOString(), bundleManifest: f.manifest,
      }), { headers: { "content-type": "application/json" } });
    });
    const code = "synthetic-local-reinstall-code";
    const readActivationCode = vi.fn(async () => code);
    const options = { ...f.options, deps: { ...f.options.deps, activate: undefined, readActivationCode } };
    if (loseResponse) {
      await expect(installNative(options as never)).rejects.toMatchObject({ code: "temporarily_unavailable" });
      expect(await readNativeRecord(f.root)).toEqual(f.previous);
      expect((await readNativeReinstall(f.root))?.phase).toBe("prepared");
      disconnected = false;
    }
    const installed = await installNative(options as never);
    expect(installed.instanceId).toBe("replacement-instance");
    expect(instances.size).toBe(1);
    expect(readActivationCode).toHaveBeenCalledTimes(loseResponse ? 2 : 1);
    expect(requests.length).toBe(loseResponse ? 5 : 1);
    const files = [join(f.root, "supervisor", "identity.json"), join(f.root, "supervisor", "activation-attempt.json"), join(f.root, "supervisor", "provisioning.json")];
    for (const file of files) expect(await readFile(file, "utf8")).not.toContain(code);
    expect(await readNativeReinstall(f.root)).toBeNull();
  });

  it.each([false, true])("keeps the original Codex profile during re-enrollment, without substituting a default (missing: %s)", async missing => {
    const f = await fixture();
    const installed = await installNative(f.options as never);
    await prepareNativeReenrollment(f.root, installed.instanceId, f.options.deps);
    await rm(join(f.root, "native-runtime.json"));
    await writeSecretFile(join(f.root, "supervisor", "identity.json"), JSON.stringify({ instanceId: "replacement", workspaceId: "new-workspace", activationId: "new-activation", activatedAt: new Date().toISOString(), administrativeStatus: "provisioning", exchangeNonce: "new-nonce" }));
    const other = join(f.root, "another-codex-profile");
    await mkdir(other, { mode: 0o700 });
    vi.stubEnv("CODEX_HOME", other);
    if (missing) await rm(installed.codexHome!, { recursive: true });
    const complete = completeNativeEnrollment(f.root, { instanceId: "replacement", workspaceId: "new-workspace" }, f.options.deps);
    if (missing) {
      await expect(complete).rejects.toMatchObject({ code: "prerequisite_missing" });
      await expect(readNativeRecord(f.root)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(complete).resolves.toMatchObject({ instanceId: "replacement", workspaceId: "new-workspace", codexHome: installed.codexHome });
    }
  });
  it("records the verified installed release for later recovery of an App-activated runtime", async () => {
    const f = await fixture();
    const record = await installNative(f.options as never);
    expect(await readNativeEnrollment(f.root)).toEqual({
      schemaVersion: 1, coreUrl: record.coreUrl, relayUrl: record.relayUrl,
      agents: record.agents, releaseId: record.releaseId, bundleVersion: record.bundleVersion,
      manifestDigest: record.manifestDigest, controlPort: record.controlPort,
      codexHome: record.codexHome,
    });
    expect(JSON.parse(await readFile(join(f.root, "installer", "enrollment-manifest.json"), "utf8"))).toEqual(f.manifest);
  });
  it("backfills a legacy installation only while stopped, retaining identity, credentials and release", async () => {
    const f = await fixture();
    const record = await installNative(f.options as never);
    await rm(join(f.root, "native-enrollment.json"));
    const identity = await readFile(join(f.root, "supervisor", "identity.json"), "utf8");
    const credential = join(f.root, "credentials", "codex", "retained");
    await writeSecretFile(credential, "retained-agent-state");
    const owner = acquireNativeRootLock(join(f.root, "supervisor"));
    try { await expect(prepareNativeReenrollment(f.root, record.instanceId, f.options.deps)).rejects.toThrow(); }
    finally { owner.release(); }
    await expect(readNativeEnrollment(f.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepareNativeReenrollment(f.root, "another-instance", f.options.deps)).rejects.toMatchObject({ code: "install_state_corrupt" });
    await prepareNativeReenrollment(f.root, record.instanceId, f.options.deps);
    expect(await readNativeEnrollment(f.root)).toMatchObject({ releaseId: record.releaseId, agents: record.agents, manifestDigest: record.manifestDigest });
    expect(await readNativeRecord(f.root)).toEqual(record);
    expect(await readFile(join(f.root, "supervisor", "identity.json"), "utf8")).toBe(identity);
    expect(await readFile(credential, "utf8")).toBe("retained-agent-state");
  });
  it("refreshes an already listed Claude pin without changing release, identity or credentials", async () => {
    const f = await fixture();
    const executable = join(f.root, "claude-current");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", executable);
    const installed = await installNative({ ...f.options, agents: ["claude-code"] } as never);
    const stale = { ...installed, claudeExecutable: join(f.root, "claude-removed") };
    await writeSecretFile(join(f.root, "native-runtime.json"), JSON.stringify(stale));
    const identity = await readFile(join(f.root, "supervisor", "identity.json"), "utf8");
    const credential = join(f.root, "credentials", "claude-code", "keep");
    await writeSecretFile(credential, "retained-private-state");
    const repaired = await addNativeAgent({ root: f.root, agentId: "claude-code", output: f.options.output, deps: { roots: f.trust, platform: f.platform } });
    expect(repaired).toEqual(installed);
    expect(await readNativeRecord(f.root)).toEqual(installed);
    expect(await readFile(join(f.root, "supervisor", "identity.json"), "utf8")).toBe(identity);
    expect(await readFile(credential, "utf8")).toBe("retained-private-state");
  });

  it("presents an Indonesian signed install while keeping its native record language-independent", async () => {
    const f = await fixture();
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const lines: string[] = [];
    const output = createOutput({ json: false, stdout: { write: (text: string) => { lines.push(text.trimEnd()); return true; } } as never });
    const record = await installNative({ ...f.options, output } as never);
    expect(lines[0]).toBe("Menghubungkan komputer ini ke Konteks. Ketik kode sekali pakai dari situs.");
    expect(lines).toContain("Kode diterima. Mengekstrak agen di komputer ini; proses ini memerlukan sekitar satu menit.");
    expect(lines.at(-1)).toBe("Terpasang. Selanjutnya, Konteks akan dimulai di komputer ini.");
    expect(record.bundleVersion).toBe("1.1.0");
    expect(JSON.stringify(record)).not.toMatch(/KONTEKS_SETUP_LOCALE|setupLocale|locale/);
    expect(await readFile(join(f.root, "native-runtime.json"), "utf8")).not.toContain("KONTEKS_SETUP_LOCALE");
  });

  it("moves a stopped installation off a port owned by another process without changing durable identity or work", async () => {
    const f = await fixture();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as { port: number }).port;
    try {
      const installed = await installNative({ ...f.options, controlPort: taken } as never);
      await writeSecretFile(join(f.root, "credentials", "codex", "keep"), "credential");
      await writeSecretFile(join(f.root, "supervisor", "assignment-journal.keep"), "journal");
      const identity = await readFile(join(f.root, "supervisor", "identity.json"), "utf8");
      const manifest = await readFile(join(f.root, "supervisor", "manifest.json"), "utf8");

      const moved = await reassignOccupiedNativeControlPort({
        root: f.root,
        roots: f.trust,
        platform: f.platform,
        serviceStopped: async () => true,
      });

      expect(moved).toMatchObject({ previousPort: taken, controlPort: expect.any(Number) });
      expect(moved?.controlPort).not.toBe(taken);
      expect(await readNativeRecord(f.root)).toEqual({
        ...installed,
        controlPort: moved?.controlPort,
      });
      expect(await readFile(join(f.root, "supervisor", "identity.json"), "utf8")).toBe(identity);
      expect(await readFile(join(f.root, "supervisor", "manifest.json"), "utf8")).toBe(manifest);
      expect(await readFile(join(f.root, "credentials", "codex", "keep"), "utf8")).toBe(
        "credential",
      );
      expect(await readFile(join(f.root, "supervisor", "assignment-journal.keep"), "utf8")).toBe(
        "journal",
      );
      expect(f.activate).toHaveBeenCalledTimes(1);
      await expect(
        loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform }),
      ).resolves.toMatchObject({ record: { controlPort: moved?.controlPort } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        holder.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("leaves an available installed port and its record unchanged", async () => {
    const f = await fixture();
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const free = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const installed = await installNative({ ...f.options, controlPort: free } as never);
    expect(
      await reassignOccupiedNativeControlPort({
        root: f.root,
        roots: f.trust,
        platform: f.platform,
        serviceStopped: async () => true,
      }),
    ).toBeNull();
    expect(await readNativeRecord(f.root)).toEqual(installed);
  });

  it("refuses to move an installed port while the connector owns its supervisor directory", async () => {
    const f = await fixture();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as { port: number }).port;
    try {
      const installed = await installNative({ ...f.options, controlPort: taken } as never);
      const owner = acquireNativeRootLock(join(f.root, "supervisor"));
      try {
        await expect(
          reassignOccupiedNativeControlPort({
            root: f.root,
            roots: f.trust,
            platform: f.platform,
            serviceStopped: async () => true,
          }),
        ).rejects.toMatchObject({ code: "temporarily_unavailable" });
        expect(await readNativeRecord(f.root)).toEqual(installed);
      } finally {
        owner.release();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        holder.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("refuses to move a port when the OS still reports this root's service running", async () => {
    const f = await fixture();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as { port: number }).port;
    try {
      const installed = await installNative({ ...f.options, controlPort: taken } as never);
      await expect(
        reassignOccupiedNativeControlPort({
          root: f.root,
          roots: f.trust,
          platform: f.platform,
          serviceStopped: async () => false,
        }),
      ).rejects.toMatchObject({ code: "temporarily_unavailable" });
      expect(await readNativeRecord(f.root)).toEqual(installed);
    } finally {
      await new Promise<void>((resolve, reject) =>
        holder.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("explains the actual port collision and starts the stopped connector on the replacement port", async () => {
    const f = await fixture();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as { port: number }).port;
    try {
      await installNative({ ...f.options, controlPort: taken } as never);
      const lines: string[] = [];
      const status = { command: "service-status", args: [] };
      const definition = {
        path: join(f.root, "service.plist"),
        contents: "service",
        install: [],
        start: { command: "service-start", args: [] },
        status,
        requiresLinger: false,
      } as never;
      await startNativeConnector(
        { root: f.root, output: { ...f.options.output, line: (text) => lines.push(text) } },
        {
          roots: f.trust,
          platform: f.platform,
          definition: async () => definition,
          execute: async (command) => (command === status ? 113 : 0),
        },
      );
      expect(lines.join("\n")).toMatch(
        new RegExp(`Another program uses port ${taken}, so Konteks uses port`),
      );
      expect(lines.join("\n")).toContain("Konteks is starting on this computer");
      expect((await readNativeRecord(f.root)).controlPort).not.toBe(taken);
    } finally {
      await new Promise<void>((resolve, reject) =>
        holder.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(["loaded", "raced"])("waits for a %s service's control socket before a repeated start succeeds", async state => {
    const f = await fixture();
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
    const controlPort = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    const installed = await installNative({ ...f.options, controlPort } as never);
    const status = { command: "service-status", args: [] };
    const definition = { status } as never;
    let elapsed = 0;
    const call = vi.spyOn(SupervisorControl.prototype, "call")
      .mockRejectedValueOnce(new RemoteInstanceError("control_socket_unavailable", "still booting"))
      .mockRejectedValueOnce(new RemoteInstanceError("control_socket_unavailable", "still booting"))
      .mockResolvedValue({});
    let checks = 0;
    const execute = vi.fn(async (_command: unknown) => state === "loaded" || ++checks >= 4 ? 0 : 113);
    try {
      await expect(startNativeConnector({ root: f.root, output: f.options.output }, {
        roots: f.trust, platform: f.platform, definition: async () => definition, execute,
        controlWaitMs: 10_000, now: () => elapsed, sleep: async (ms: number) => { elapsed += ms; },
      } as never)).resolves.toBeUndefined();
      expect(elapsed).toBeGreaterThan(0);
      expect(call).toHaveBeenCalledTimes(4);
      expect(execute.mock.calls.every(([command]) => command === status)).toBe(true);
      expect(await readNativeRecord(f.root)).toEqual(installed);
    } finally { call.mockRestore(); }
  });

  it("does not report a service that stopped during the control wait as already running", async () => {
    const f = await fixture();
    const installed = await installNative(f.options as never);
    const status = { command: "service-status", args: [] };
    let checks = 0;
    const call = vi.spyOn(SupervisorControl.prototype, "call")
      .mockRejectedValue(new RemoteInstanceError("control_socket_unavailable", "stopped while booting"));
    try {
      await expect(startNativeConnector({ root: f.root, output: f.options.output }, {
        roots: f.trust, platform: f.platform, definition: async () => ({ status } as never),
        execute: async () => ++checks === 1 ? 0 : 113,
        sleep: async () => { throw new Error("must not wait for a stopped service"); },
      })).rejects.toMatchObject({ code: "temporarily_unavailable" });
      expect(call).toHaveBeenCalledOnce();
      expect(await readNativeRecord(f.root)).toEqual(installed);
    } finally { call.mockRestore(); }
  });

  it("does not claim a loaded but unreachable service is running or change its port", async () => {
    const f = await fixture();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as { port: number }).port;
    try {
      const installed = await installNative({ ...f.options, controlPort: taken } as never);
      const status = { command: "service-status", args: [] };
      const definition = {
        path: join(f.root, "service.plist"),
        contents: "service",
        install: [],
        start: { command: "service-start", args: [] },
        status,
        requiresLinger: false,
      } as never;
      await expect(
        startNativeConnector(
          { root: f.root, output: f.options.output },
          {
            roots: f.trust,
            platform: f.platform,
            definition: async () => definition,
            execute: async () => 0,
            controlWaitMs: 0,
          },
        ),
      ).rejects.toMatchObject({
        code: "temporarily_unavailable",
        message: expect.stringMatching(
          /control socket.*unavailable.*Stop only this installation's service/,
        ),
      });
      expect(await readNativeRecord(f.root)).toEqual(installed);
    } finally {
      await new Promise<void>((resolve, reject) =>
        holder.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("says which service step failed, with the service manager's own words, and keeps it for doctor", async () => {
    const f = await fixture();
    await installNative(f.options as never);
    const status = { command: "service-status", args: [] };
    const register = { command: "service-register", args: ["/Create", "/TN", "label"] };
    const definition = { label: "label", path: join(f.root, "service.plist"), contents: "service", install: [register], start: { command: "service-start", args: [] }, status, requiresLinger: false } as never;
    const failing = startNativeConnector({ root: f.root, output: f.options.output }, {
      roots: f.trust, platform: f.platform, definition: async () => definition,
      execute: async command => command === status ? 113 : command === register ? { code: 1, stdout: "", stderr: "ERROR: Access is denied.\r\n" } : 0,
    });
    await expect(failing).rejects.toMatchObject({
      code: "temporarily_unavailable",
      message: "The native user service could not start: macOS did not load the Konteks launch agent (service-register /Create exited 1: ERROR: Access is denied.). To see every step, run konteks-remote --verbose start. Installed identity and credentials were preserved.",
    });
    const kept = JSON.parse(await readFile(join(f.root, "supervisor", "service-start-failure.json"), "utf8")) as { message: string };
    expect(kept.message).toContain("service-register /Create exited 1: ERROR: Access is denied.");
    // A start that works forgets it.
    await startNativeConnector({ root: f.root, output: f.options.output }, { roots: f.trust, platform: f.platform, definition: async () => definition, execute: async command => command === status ? 113 : 0 });
    await expect(readFile(join(f.root, "supervisor", "service-start-failure.json"), "utf8")).rejects.toThrow();
  });

  it("says a connector that stopped as soon as it started, with its log, where the service manager can tell", async () => {
    const f = await fixture();
    await installNative(f.options as never);
    await mkdir(join(f.root, "logs"), { recursive: true });
    await writeFile(join(f.root, "logs", "connector.log"), '{"level":60,"msg":"cannot read native-runtime.json"}\n');
    const status = { command: "service-status", args: [] };
    const definition = { label: "label", path: join(f.root, "service.unit"), contents: "service", install: [], start: { command: "service-start", args: [] }, status, requiresLinger: false } as never;
    await expect(startNativeConnector({ root: f.root, output: f.options.output }, {
      roots: f.trust, platform: f.platform, definition: async () => definition,
      // Stopped before the start, and again right after it.
      execute: async command => command === status ? 113 : 0, settleMs: 0, sleep: async () => undefined,
    })).rejects.toMatchObject({ message: expect.stringMatching(/started and stopped again at once\. The connector log ends: .*cannot read native-runtime\.json.*The whole log: .*connector\.log/) });
  });

  it("refuses port recovery when the service manager cannot determine whether this root is stopped", async () => {
    const f = await fixture();
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", resolve));
    const taken = (holder.address() as { port: number }).port;
    try {
      const installed = await installNative({ ...f.options, controlPort: taken } as never);
      const status = { command: "service-status", args: [] };
      const definition = { path: join(f.root, "service.plist"), contents: "service", install: [], start: { command: "service-start", args: [] }, status, requiresLinger: false } as never;
      await expect(startNativeConnector({ root: f.root, output: f.options.output }, {
        roots: f.trust, platform: f.platform, definition: async () => definition, execute: async () => 7,
      })).rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringMatching(/cannot confirm.*stopped/i) });
      expect(await readNativeRecord(f.root)).toEqual(installed);
    } finally {
      await new Promise<void>((resolve, reject) => holder.close(error => error ? reject(error) : resolve()));
    }
  });

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
    await expect(addNativeAgent({ root: f.root, agentId: "codex", output: f.options.output, deps: { roots: f.trust, platform: f.platform, manifest: f.olderManifest, fetchFn: f.fetchFn } })).rejects.toMatchObject({ code: "update_required" });
    // The installed release itself, which has no Codex package for this computer, adds nothing either.
    await expect(addNativeAgent({ root: f.root, agentId: "codex", output: f.options.output, deps: { roots: f.trust, platform: f.platform, manifest: f.oldManifest, fetchFn: f.fetchFn } })).rejects.toThrow();
    await expect(addNativeAgent({ root: f.root, agentId: "codex", output: f.options.output, deps: { roots: [], platform: f.platform, manifest: f.manifest, fetchFn: f.fetchFn } })).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(await readNativeRecord(f.root)).toEqual(before);
    expect(f.activate).toHaveBeenCalledTimes(1);
  });
  it("connects a computer with no agent at all, offering Claude Code and Codex instead of refusing", async () => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", join(f.root, "no-claude", "claude"));
    vi.stubEnv("CODEX_HOME", join(f.root, "no-codex"));
    vi.stubEnv("DSH_EXECUTABLE", "/no-dsh");
    vi.stubEnv("OPENCODE_EXECUTABLE", "/no-opencode");
    const { agents: _agents, ...options } = f.options;
    const offered: string[] = [];
    const record = await installNative({ ...options, deps: { ...options.deps, setupAgent: async (agent: string) => { offered.push(agent); return false; } } } as never);
    expect(offered).toEqual(["claude-code", "codex"]);
    expect(record.agents).toEqual([]);
    expect(f.activate).toHaveBeenCalledTimes(1);
    // It starts like any other connector: nothing to verify, nothing refused.
    await expect(loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform })).resolves.toMatchObject({ record: { agents: [] }, runners: [] });
    // Run again (the site's command pasted twice), it keeps the connected record.
    await expect(installNative({ ...options, deps: { ...options.deps, setupAgent: async () => false } } as never)).resolves.toEqual(record);
    expect(f.activate).toHaveBeenCalledTimes(1);

    // Later, `agent add codex` adds it from the same release: no newer release is needed.
    await mkdir(join(f.root, "no-codex"), { mode: 0o700 });
    const added = await addNativeAgent({ root: f.root, agentId: "codex", output: f.options.output, deps: { roots: f.trust, platform: f.platform, manifest: f.manifest, fetchFn: f.fetchFn } });
    expect(added).toMatchObject({ agents: ["codex"], instanceId: record.instanceId, manifestDigest: record.manifestDigest, codexHome: await realpath(join(f.root, "no-codex")) });
    expect(added.releaseId).not.toBe(record.releaseId);
    await expect(loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform })).resolves.toMatchObject({ record: { agents: ["codex"] }, runners: [{ RUNNER_AGENT_ID: "codex" }] });
    expect(f.activate).toHaveBeenCalledTimes(1);
  });
  it("connects with the agents found here plus the ones the person set up when asked", async () => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", join(f.root, "no-claude", "claude"));
    vi.stubEnv("CODEX_HOME", join(f.root, "new-codex"));
    vi.stubEnv("DSH_EXECUTABLE", "/no-dsh");
    vi.stubEnv("OPENCODE_EXECUTABLE", "/no-opencode");
    const { agents: _agents, ...options } = f.options;
    const setupAgent = vi.fn(async (agent: string) => {
      if (agent !== "codex") return false;
      await mkdir(join(f.root, "new-codex"), { mode: 0o700 });
      return true;
    });
    const record = await installNative({ ...options, deps: { ...options.deps, setupAgent } } as never);
    expect(record.agents).toEqual(["codex"]);
    expect(record.codexHome).toBe(await realpath(join(f.root, "new-codex")));
    expect(setupAgent.mock.invocationCallOrder[1]!).toBeLessThan(f.activate.mock.invocationCallOrder[0]!);
  });
  it("still refuses a missing agent the operator named in --agents", async () => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", join(f.root, "no-claude", "claude"));
    f.options.agents = ["claude-code"];
    const setupAgent = vi.fn(async () => true);
    await expect(installNative({ ...f.options, deps: { ...f.options.deps, setupAgent } } as never)).rejects.toMatchObject({ code: "prerequisite_missing" });
    expect(setupAgent).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
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
  it.each([
    // The agent list is packages' (7.1.0 names four; the Antigravity minor adds Google Antigravity).
    ["pi", expect.stringMatching(/^pi is no longer supported\. Choose Claude Code, Codex, DeepSeek Harness(,| or) OpenCode( or Google Antigravity)? on your computer\.$/)],
  ])("refuses %s before activation or downloads", async (retired, message) => {
    const f = await fixture();
    f.options.agents = ["codex", retired];
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "agent_unavailable", message });
    await expect(addNativeAgent({ root: f.root, agentId: retired, output: f.options.output } as never)).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.options.deps.fetchFn).not.toHaveBeenCalled();
  });
  it("never detects Google Antigravity at enrollment, and adds it there only after onboarding", async () => {
    const adapter = hostAgentInstallAdapter("antigravity")!;
    expect(adapter.offered).toBe(true);
    const locate = vi.spyOn(adapter, "locate").mockResolvedValue({ antigravityVersion: "1.2.1", antigravityRoot: "/nowhere" });
    const fetch = vi.spyOn(adapter, "fetch");
    try {
      vi.stubEnv("DSH_EXECUTABLE", "/no-dsh");
      vi.stubEnv("OPENCODE_EXECUTABLE", "/no-opencode");
      const g = await fixture();
      const enrolled = await recordNativeEnrollment({ root: g.root, coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", deps: g.options.deps as never });
      expect(enrolled.agents).not.toContain("antigravity");
      const h = await fixture();
      await expect(recordNativeEnrollment({ root: h.root, coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", agents: ["codex", "antigravity"], deps: h.options.deps as never }))
        .rejects.toMatchObject({ code: "agent_unavailable", message: "Google Antigravity is added after onboarding, once you agree to its download: konteks-remote agent add antigravity" });
      expect(fetch).not.toHaveBeenCalled();
    } finally { locate.mockRestore(); fetch.mockRestore(); }
  });
  it.each([
    ["en", "Downloading Google Antigravity from Google and checking Google's signature; this takes a minute or two."],
    ["id", "Mengunduh Google Antigravity dari Google dan memeriksa tanda tangan Google; proses ini memerlukan satu atau dua menit."],
  ] as const)("presents %s fetched-agent setup after the person's consent and preserves the signed-install record", async (locale, progress) => {
    const f = await fixture();
    vi.stubEnv("KONTEKS_SETUP_LOCALE", locale);
    const adapter = hostAgentInstallAdapter("antigravity")!;
    const folder = join(f.root, "agents", "antigravity", "1.2.1-darwin-arm64");
    const fields = { antigravityVersion: "1.2.1", antigravityRoot: folder };
    const lines: string[] = [];
    const output = createOutput({ json: false, stdout: { write: (text: string) => { lines.push(text.trimEnd()); return true; } } as never });
    let fetched = false;
    const spies = [
      vi.spyOn(adapter, "assertFetchable").mockImplementation(() => undefined),
      vi.spyOn(adapter, "locate").mockImplementation(async () => { if (!fetched) throw new Error("not fetched"); return fields; }),
      vi.spyOn(adapter, "fetch").mockImplementation(async request => { expect(request).toEqual({ root: f.root, consent: true }); fetched = true; await mkdir(folder, { recursive: true, mode: 0o700 }); return fields; }),
      vi.spyOn(adapter, "runnerSettings").mockImplementation(async record => {
        if (record.antigravityRoot !== folder || !fetched) throw new Error("does not verify");
        return { RUNNER_NATIVE_ANTIGRAVITY_ROOT: folder, RUNNER_BRIDGE_PREFIX: folder, RUNNER_BRIDGE_VERSION: "1.2.1" };
      }),
    ];
    try {
      const consent = terminalFetchConsent({ yes: true, locale, line: text => output.line(text) });
      const record = await installNative({ ...f.options, agents: ["codex", "antigravity"], output, deps: { ...f.options.deps, consent } } as never);
      expect(lines).toContain(progress);
      expect(lines.indexOf(progress)).toBeGreaterThan(1);
      expect(record).toMatchObject({ agents: ["codex", "antigravity"], ...fields });
      expect(f.activate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(record)).not.toMatch(/KONTEKS_SETUP_LOCALE|setupLocale|locale/);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it("installs, adds and removes Google Antigravity only on the person's yes, never consuming an activation on a no", async () => {
    const f = await fixture();
    const adapter = hostAgentInstallAdapter("antigravity")!;
    const folder = join(f.root, "agents", "antigravity", "1.2.1-darwin-arm64");
    const fields = { antigravityVersion: "1.2.1", antigravityRoot: folder };
    let fetched = false;
    const spies = [
      vi.spyOn(adapter, "assertFetchable").mockImplementation(() => undefined),
      vi.spyOn(adapter, "locate").mockImplementation(async () => { if (!fetched) throw new Error("not fetched"); return fields; }),
      vi.spyOn(adapter, "fetch").mockImplementation(async request => { expect(request).toEqual({ root: f.root, consent: true }); fetched = true; await mkdir(folder, { recursive: true, mode: 0o700 }); return fields; }),
      vi.spyOn(adapter, "runnerSettings").mockImplementation(async record => {
        if (record.antigravityRoot !== folder || !fetched) throw new Error("does not verify");
        return { RUNNER_NATIVE_ANTIGRAVITY_ROOT: folder, RUNNER_BRIDGE_PREFIX: folder, RUNNER_BRIDGE_VERSION: "1.2.1" };
      }),
    ];
    try {
      const asked: string[] = [];
      f.options.agents = ["codex", "antigravity"];
      // No: nothing downloaded, nothing activated.
      await expect(installNative({ ...f.options, deps: { ...f.options.deps, consent: async (_agent: string, text: string) => { asked.push(text); return false; } } } as never))
        .rejects.toMatchObject({ code: "agent_unavailable", message: "Nothing was downloaded: Google Antigravity was not added." });
      expect(asked).toEqual([adapter.consentText]);
      expect(adapter.fetch).not.toHaveBeenCalled();
      expect(f.activate).not.toHaveBeenCalled();
      // Yes: fetched before the activation, recorded beside Codex.
      const installed = await installNative({ ...f.options, deps: { ...f.options.deps, consent: async () => true } } as never);
      expect(installed).toMatchObject({ agents: ["codex", "antigravity"], ...fields });
      expect(f.activate).toHaveBeenCalledTimes(1);
      const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
      expect(loaded.runners.find(runner => runner.RUNNER_AGENT_ID === "antigravity")).toMatchObject({ RUNNER_NATIVE_ANTIGRAVITY_ROOT: folder, RUNNER_BRIDGE_VERSION: "1.2.1" });
      expect(await readdir(join(f.root, "releases", loaded.record.releaseId, "agents"))).toEqual(["codex"]);
      // Removed: signed out first, dropped from the record, its folders gone, Codex untouched.
      const signOut = vi.fn(async () => true);
      const lines: string[] = [];
      const output = { ...f.options.output, line: (text: string) => { lines.push(text); } };
      await writeFile(join(f.root, "credentials", "antigravity", "sign-in.json"), "{}");
      const removed = await removeNativeAgent({ root: f.root, agentId: "antigravity", output, deps: { roots: f.trust, platform: f.platform, signOut } });
      expect(signOut).toHaveBeenCalledWith(f.root, expect.objectContaining({ agents: ["codex", "antigravity"] }));
      expect(removed.agents).toEqual(["codex"]);
      expect(removed).not.toHaveProperty("antigravityVersion");
      expect(removed).not.toHaveProperty("antigravityRoot");
      expect(await readNativeRecord(f.root)).toEqual(removed);
      expect(await readdir(join(f.root, "credentials"))).toEqual(["codex"]);
      expect(await readdir(join(f.root, "workspaces"))).toEqual(["codex"]);
      await expect(readdir(join(f.root, "agents", "antigravity"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(lines.at(-1)).toBe("Google Antigravity removed from this computer: signed out, its download and its sign-ins here were deleted. Nothing else changed.");
      // Added back without reactivation or a release, once it is fetched again.
      fetched = true;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const added = await addNativeAgent({ root: f.root, agentId: "antigravity", output, deps: { roots: f.trust, platform: f.platform } });
      expect(added).toMatchObject({ agents: ["codex", "antigravity"], ...fields, releaseId: removed.releaseId });
      expect(lines.at(-1)).toBe("Google Antigravity 1.2.1 added: downloaded from Google and its signature checked; nothing else changed. To sign it in here with a Gemini API key: konteks-remote auth login antigravity --api-key. With Gemini Enterprise: konteks-remote auth login antigravity --enterprise --project <project id>");
      expect(f.activate).toHaveBeenCalledTimes(1);
      // Only Google Antigravity is removed this way.
      await expect(removeNativeAgent({ root: f.root, agentId: "codex", output, deps: { roots: f.trust, platform: f.platform, signOut } })).rejects.toMatchObject({ code: "agent_unavailable" });
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
  it.runIf(process.platform !== "win32")("installs the person's own OpenCode 2 beside bundled agents, with no package of it, and enrollment detects it", async () => {
    const f = await fixture();
    const opencode = await personOpenCode(f.root);
    vi.stubEnv("DSH_EXECUTABLE", join(f.root, "no-dsh"));
    expect(hostAgentInstallAdapter("opencode")?.offered).toBe(true);
    const g = await fixture();
    const enrolled = await recordNativeEnrollment({ root: g.root, coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", deps: g.options.deps as never });
    expect(enrolled.agents).toEqual(expect.arrayContaining(["codex", "opencode"]));
    await installNative({ ...f.options, agents: ["codex", "opencode"] } as never);
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(loaded.record).toMatchObject({ agents: ["codex", "opencode"], opencodeBinary: opencode.binary, opencodeVersion: "2.0.18" });
    expect(loaded.runners.find(runner => runner.RUNNER_AGENT_ID === "opencode")).toMatchObject({ RUNNER_NATIVE_OPENCODE_BINARY: opencode.binary, RUNNER_BRIDGE_VERSION: "2.0.18" });
    expect(loaded.unavailableAgents).toEqual([]);
    expect(await readdir(join(f.root, "releases", loaded.record.releaseId, "agents"))).toEqual(["codex"]);
    expect(await readdir(join(f.root, "credentials"))).toEqual(expect.arrayContaining(["codex", "opencode"]));
    // Nothing of OpenCode was downloaded: only the connector and Codex's package.
    expect(f.fetchFn.mock.calls.map(call => String(call[0])).some(url => /opencode/i.test(url))).toBe(false);
  });
  it.runIf(process.platform !== "win32")("refuses OpenCode 1, by name and with OpenCode 2's install command, before any activation is used", async () => {
    const f = await fixture();
    await personOpenCode(f.root, "1.18.33", "opencode-ai");
    const refusal = await installNative({ ...f.options, agents: ["codex", "opencode"] } as never).catch(error => error);
    expect(refusal).toMatchObject({ code: "prerequisite_missing", diagnostic: "opencode_unsupported_version" });
    expect(refusal.message).toBe("OpenCode 1 is not supported (found 1.18.33): install OpenCode 2 with `curl -fsSL https://opencode.ai/v2/install | bash`, then retry.");
    expect(f.activate).not.toHaveBeenCalled();
    // And a 2.x outside the supported range the same way.
    await personOpenCode(join(f.root, "three"), "3.0.0");
    await expect(installNative({ ...f.options, agents: ["codex", "opencode"] } as never)).rejects.toMatchObject({ diagnostic: "opencode_unsupported_version" });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it.runIf(process.platform !== "win32")("adds OpenCode to an installed runtime without a new release or reactivation, and refuses OpenCode 1 there too", async () => {
    const f = await fixture();
    const first = await installNative(f.options as never);
    await personOpenCode(f.root, "1.18.33", "opencode-ai");
    await expect(addNativeAgent({ root: f.root, agentId: "opencode", output: createOutput({ json: true }), deps: { roots: f.trust, platform: f.platform, fetchFn: f.fetchFn } } as never))
      .rejects.toMatchObject({ diagnostic: "opencode_unsupported_version" });
    expect(await readNativeRecord(f.root)).toEqual(first);
    const opencode = await personOpenCode(join(f.root, "two"));
    const fetches = f.fetchFn.mock.calls.length;
    const added = await addNativeAgent({ root: f.root, agentId: "opencode", output: createOutput({ json: true }), deps: { roots: f.trust, platform: f.platform, fetchFn: f.fetchFn } } as never);
    expect(added).toMatchObject({ agents: ["codex", "opencode"], releaseId: first.releaseId, opencodeBinary: opencode.binary, opencodeVersion: "2.0.18" });
    expect(f.fetchFn.mock.calls.length).toBe(fetches);
    expect(f.activate).toHaveBeenCalledTimes(1);
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(loaded.runners.map(runner => runner.RUNNER_AGENT_ID)).toEqual(["codex", "opencode"]);
    await expect(addNativeAgent({ root: f.root, agentId: "opencode", output: createOutput({ json: true }), deps: { roots: f.trust, platform: f.platform } } as never)).resolves.toMatchObject({ agents: ["codex", "opencode"] });
  });
  it.runIf(process.platform !== "win32")("keeps loading when the person's OpenCode went away or became OpenCode 1: OpenCode is left out with the reason, Codex runs", async () => {
    const f = await fixture();
    await personOpenCode(f.root);
    await installNative({ ...f.options, agents: ["codex", "opencode"] } as never);
    await rm(join(f.root, "person-opencode"), { recursive: true, force: true });
    await personOpenCode(join(f.root, "later"), "1.18.33", "opencode-ai");
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(loaded.runners.map(runner => runner.RUNNER_AGENT_ID)).toEqual(["codex"]);
    expect(loaded.unavailableAgents.map(entry => [entry.agentId, entry.error.diagnostic])).toEqual([["opencode", "opencode_not_found"]]);
    // Once OpenCode 2 is back (installed another way), the retry finds it again with no `agent add`.
    const back = await personOpenCode(join(f.root, "again"));
    await expect(loaded.unavailableAgents[0]!.relocate()).resolves.toMatchObject({ RUNNER_AGENT_ID: "opencode", RUNNER_NATIVE_OPENCODE_BINARY: back.binary, RUNNER_BRIDGE_VERSION: "2.0.18" });
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
