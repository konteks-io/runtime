import { createHash, sign } from "node:crypto";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, computeBundleManifestDigest, writeSecretFile } from "@konteks/remote-common";
import { buildReleaseFixture } from "@konteks/remote-release";
import { acquireNativeRootLock, hostAgentInstallAdapter, loadNativeInstallation, OPENCODE_MIN_BINARY_BYTES, SupervisorStore, verifyInstalledNativeConnector } from "@konteks/remote-supervisor";
import { addNativeAgent, installNative, readNativeRecord, reassignOccupiedNativeControlPort, recordNativeEnrollment, restoreNativeRecord } from "../native/install.js";
import { startNativeConnector } from "../native/commands.js";
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
        new RegExp(`Control port ${taken} is occupied by another local process`),
      );
      expect(lines.join("\n")).toContain("Native user service started");
      expect((await readNativeRecord(f.root)).controlPort).not.toBe(taken);
    } finally {
      await new Promise<void>((resolve, reject) =>
        holder.close((error) => (error ? reject(error) : resolve())),
      );
    }
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
  it("keeps Google Antigravity gated until its security checkpoint: never detected, installed, added or fetched", async () => {
    const f = await fixture();
    const adapter = hostAgentInstallAdapter("antigravity")!;
    expect(adapter.offered).toBe(false);
    const fetch = vi.spyOn(adapter, "fetch");
    const locate = vi.spyOn(adapter, "locate");
    vi.stubEnv("DSH_EXECUTABLE", join(f.root, "no-dsh"));
    vi.stubEnv("OPENCODE_EXECUTABLE", join(f.root, "no-opencode"));
    const g = await fixture();
    const enrolled = await recordNativeEnrollment({ root: g.root, coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", deps: g.options.deps as never });
    expect(enrolled.agents).not.toContain("antigravity");
    f.options.agents = ["codex", "antigravity"];
    await expect(installNative(f.options as never)).rejects.toMatchObject({ code: "agent_unavailable", message: "antigravity cannot be added on this computer yet." });
    await expect(addNativeAgent({ root: f.root, agentId: "antigravity", output: f.options.output } as never)).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.options.deps.fetchFn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    fetch.mockRestore();
    locate.mockRestore();
  });
  it.runIf(process.platform !== "win32")("installs the person's own OpenCode 2 beside bundled agents, with no package of it, and enrollment detects it (CP6)", async () => {
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
  it.runIf(process.platform !== "win32")("keeps loading when the person's OpenCode went away or became OpenCode 1: OpenCode is left out with the reason, Codex runs (CP6)", async () => {
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
