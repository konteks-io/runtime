import { chmod, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { findAgentBridge, installOfflineAgentPackage } from "@konteks/remote-release";
import { loadRunnerConfig } from "../config.js";
import { bridgeEnvironment, resolveBridgeSpawnSpec, resolveToolingCommand, verifyNativeRunnerPackage } from "../bridge/spec.js";
import { importHostCache, planHostCacheImport } from "../auth/host-cache-import.js";
import { RunnerEventSchema } from "../events.js";

describe("bridge spawn spec", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the local native Codex profile without exposing it to other runner families", () => {
    vi.stubEnv("CODEX_HOME", "/unvalidated/inherited");
    const config = loadRunnerConfig({ RUNNER_AGENT_ID: "codex" });
    const family = findAgentBridge("codex")!;
    expect(bridgeEnvironment(config, family).CODEX_HOME).toBeUndefined();
    const native = { ...config, RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture().profile, RUNNER_NATIVE_CODEX_HOME: "/operator/.codex" };
    const env = bridgeEnvironment(native, family);
    expect(env.CODEX_HOME).toBe("/operator/.codex");
    expect(env.HOME).toBe(config.RUNNER_CREDENTIAL_DIR);
    expect(() => bridgeEnvironment({ ...native, RUNNER_AUTH_MODE: "gateway_keyed" }, family)).toThrow(/native personal/);
    expect(() => bridgeEnvironment({ ...config, RUNNER_NATIVE_CODEX_HOME: "/operator/.codex" }, family)).toThrow(/native personal/);
    expect(() => bridgeEnvironment(native, findAgentBridge("claude-code")!)).toThrow(/native personal/);
    expect(() => bridgeEnvironment({ ...native, RUNNER_NATIVE_CODEX_HOME: "relative" }, family)).toThrow(/absolute/);
  });
  it("runs a native Claude runner with the operator's installed CLI and personal login home", () => {
    const config = loadRunnerConfig({ RUNNER_AGENT_ID: "claude-code" });
    const family = findAgentBridge("claude-code")!;
    expect(bridgeEnvironment(config, family).CLAUDE_CODE_EXECUTABLE).toBeUndefined();
    const native = { ...config, RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture().profile, RUNNER_NATIVE_CLAUDE_EXECUTABLE: "/operator/.local/bin/claude" };
    const env = bridgeEnvironment(native, family);
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/operator/.local/bin/claude");
    expect(env.HOME).toBe(userInfo().homedir);
    expect(env.USER).toBe(userInfo().username);
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.CI).toBeUndefined();
    expect(resolveToolingCommand(native, family, family.tooling.identitySignal!)).toEqual({ command: "/operator/.local/bin/claude", args: ["auth", "status", "--json"] });
    expect(() => bridgeEnvironment({ ...native, RUNNER_AUTH_MODE: "gateway_keyed" }, family)).toThrow(/native personal Claude/);
    expect(() => bridgeEnvironment({ ...config, RUNNER_NATIVE_CLAUDE_EXECUTABLE: "/operator/.local/bin/claude" }, family)).toThrow(/native personal Claude/);
    expect(() => bridgeEnvironment(native, findAgentBridge("codex")!)).toThrow(/native personal Claude/);
    expect(() => bridgeEnvironment({ ...native, RUNNER_NATIVE_CLAUDE_EXECUTABLE: "claude" }, family)).toThrow(/native personal Claude/);
  });
  it("selects only a signed native Codex proxy for a locally bound socket", () => {
    const profile = offlineFixture().profile;
    const config = { ...loadRunnerConfig({ RUNNER_AGENT_ID: "codex" }), RUNNER_NATIVE_PACKAGE_PROFILE: { ...profile, codexLocalProxy: { version: 1 as const, entrypoint: "konteks/proxy.js" } }, RUNNER_NATIVE_CODEX_HOME: "/operator/.codex", RUNNER_NATIVE_CODEX_SOCKET: "/operator/.codex/private/control.sock" };
    const env = bridgeEnvironment(config, findAgentBridge("codex")!);
    expect(env.CODEX_PATH).toBe("/opt/konteks/bridges/konteks/proxy.js");
    expect(env.KONTEKS_NATIVE_CODEX_SOCKET).toBe(config.RUNNER_NATIVE_CODEX_SOCKET);
    expect(() => bridgeEnvironment({ ...config, RUNNER_NATIVE_PACKAGE_PROFILE: profile }, findAgentBridge("codex")!)).toThrow(/signed native proxy/);
    expect(() => bridgeEnvironment({ ...config, RUNNER_NATIVE_CODEX_SOCKET: "ws://remote" }, findAgentBridge("codex")!)).toThrow(/absolute local socket/);
  });

  it("preserves explicit native additional CA trust without inheriting TLS bypasses or credentials", () => {
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/local/operator/ca.pem");
    vi.stubEnv("CODEX_CA_CERTIFICATE", "/local/operator/codex-ca.pem");
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    vi.stubEnv("OPENAI_API_KEY", "must-not-leak");
    const config = loadRunnerConfig({ RUNNER_AGENT_ID: "codex" });
    expect(bridgeEnvironment(config, findAgentBridge("codex")!).NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(bridgeEnvironment(config, findAgentBridge("codex")!).CODEX_CA_CERTIFICATE).toBeUndefined();
    const native = { ...config, RUNNER_NATIVE_PACKAGE_PROFILE: offlineFixture().profile };
    const env = bridgeEnvironment(native, findAgentBridge("codex")!);
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/local/operator/ca.pem");
    expect(env.CODEX_CA_CERTIFICATE).toBe("/local/operator/codex-ca.pem");
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "relative.pem");
    expect(() => bridgeEnvironment(native, findAgentBridge("codex")!)).toThrow(/absolute/);
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/local/operator/ca.pem");
    vi.stubEnv("CODEX_CA_CERTIFICATE", "relative.pem");
    expect(() => bridgeEnvironment(native, findAgentBridge("codex")!)).toThrow(/absolute/);
  });

  it("spawns the vendored binary with a private HOME and a sanitized environment", () => {
    const config = loadRunnerConfig({ RUNNER_AGENT_ID: "claude-code", RUNNER_CREDENTIAL_DIR: "/credentials", RUNNER_BRIDGE_PREFIX: "/opt/konteks/bridges", ANTHROPIC_API_KEY: "sk-ant-leak", KONTEKS_LEASE: "lease" });
    const spec = resolveBridgeSpawnSpec(config);
    expect(spec.command).toBe("/opt/konteks/bridges/bin/claude-agent-acp");
    expect(spec.env.HOME).toBe("/credentials");
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.KONTEKS_LEASE).toBeUndefined();
    expect(spec.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("points a gateway-keyed bridge at the gateway through its documented base-URL variable", () => {
    const config = loadRunnerConfig({ RUNNER_AGENT_ID: "codex", RUNNER_AUTH_MODE: "gateway_keyed", RUNNER_GATEWAY_BASE_URL: "http://gateway:41810/agents/codex/openai" });
    expect(bridgeEnvironment(config, findAgentBridge("codex")!).OPENAI_BASE_URL).toBe("http://gateway:41810/agents/codex/openai");
    const multi = loadRunnerConfig({ RUNNER_AGENT_ID: "opencode", RUNNER_AUTH_MODE: "gateway_keyed", RUNNER_GATEWAY_BASE_URL: "http://gateway:41810/agents/opencode" });
    const env = bridgeEnvironment(multi, findAgentBridge("opencode")!);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://gateway:41810/agents/opencode/anthropic");
    expect(env.DEEPSEEK_BASE_URL).toBe("http://gateway:41810/agents/opencode/deepseek");
  });

  it("refuses a gateway-keyed runner without a gateway base URL", () => {
    const config = loadRunnerConfig({ RUNNER_AGENT_ID: "codex", RUNNER_AUTH_MODE: "gateway_keyed" });
    expect(() => resolveBridgeSpawnSpec(config)).toThrow(/gateway/);
  });

  it("runs the person's own DeepSeek Harness launcher with their Node and the Konteks overlay, in a private dsh home", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-inherited-must-not-reach-dsh-000000");
    vi.stubEnv("DSH_HOME", "/inherited/dsh-home");
    vi.stubEnv("DSH_PERMISSION_MODE", "danger-full-access");
    const config = loadRunnerConfig({
      RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: "/rt/credentials/dsh", RUNNER_WORKSPACE_DIR: "/rt/workspaces/dsh",
      RUNNER_BRIDGE_PREFIX: "/usr/lib/node_modules/@deepseek-ai/dsh", RUNNER_NATIVE_DSH_ROOT: "/usr/lib/node_modules/@deepseek-ai/dsh",
      RUNNER_NATIVE_DSH_ENTRY: "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js", RUNNER_NATIVE_DSH_NODE: "/usr/bin/node",
    });
    const spec = resolveBridgeSpawnSpec(config);
    expect(spec.command).toBe("/usr/bin/node");
    expect(spec.args).toEqual([
      "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js", "--profile", "acp",
      "--patch", join("/rt/credentials/dsh", "konteks-dsh", "konteks-dsh.patch.yml"),
      "--patch", join("/rt/credentials/dsh", "konteks-dsh", "konteks-dsh-ask.patch.yml"),
    ]);
    expect(spec.cwd).toBe("/rt/workspaces/dsh");
    expect(spec.env).toMatchObject({
      DSH_HOME: join("/rt/credentials/dsh", ".dsh"), DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1", HOME: "/rt/credentials/dsh",
    });
    // The key lives only in the credential document; nothing secret or DSH_* is inherited.
    expect(spec.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(spec.env.PATH?.split(process.platform === "win32" ? ";" : ":")[0]).toBe("/usr/bin");
    expect(Object.keys(spec.env).filter(key => /KEY|TOKEN|SECRET/i.test(key))).toEqual([]);
    // Without a located launcher and Node there is nothing safe to spawn.
    expect(() => resolveBridgeSpawnSpec({ ...config, RUNNER_NATIVE_DSH_NODE: undefined })).toThrow(/DeepSeek Harness/);
    expect(() => resolveBridgeSpawnSpec({ ...config, RUNNER_NATIVE_DSH_ENTRY: "lib/bin.js" })).toThrow(/DeepSeek Harness/);
    // dsh-only settings never leak to another family.
    expect(() => bridgeEnvironment({ ...config, RUNNER_AGENT_ID: "codex" }, findAgentBridge("codex")!)).toThrow(/DeepSeek Harness/);
  });

  it("rejects an unsupported agent family", () => {
    expect(() => loadRunnerConfig({ RUNNER_AGENT_ID: "cline" })).toThrow();
  });
});

describe("native agent package verification (WS2-156)", () => {
  it("hashes the package on first use, then reuses it while unchanged, and logs which", async () => {
    const fixture = offlineFixture();
    const root = await mkdtemp(join(tmpdir(), "runner-package-"));
    try {
      const archive = join(root, "package.tgz"), prefix = join(root, "agent");
      await writeFile(archive, fixture.archive, { mode: 0o600 });
      await installOfflineAgentPackage(archive, prefix, fixture.artifact as never);
      const config = { ...loadRunnerConfig({ RUNNER_AGENT_ID: "codex" }), RUNNER_BRIDGE_PREFIX: prefix,
        RUNNER_NATIVE_PACKAGE_PROFILE: fixture.profile, RUNNER_NATIVE_PACKAGE_ARTIFACT: fixture.artifact } as never;
      const logger = { info: vi.fn() };
      const modes = () => logger.info.mock.calls.map(call => call[0] as { event: string; stage: string; mode: string; durationMs: number });
      await verifyNativeRunnerPackage(config, logger as never);
      await verifyNativeRunnerPackage(config, logger as never);
      expect(modes().map(entry => entry.mode)).toEqual(["full", "cached"]);
      expect(modes().every(entry => entry.event === "native.bootstrap.stage" && entry.stage === "package_verify" && entry.durationMs >= 0)).toBe(true);
      // A touched file, even with its old bytes, is hashed again.
      const later = new Date(Date.now() + 5_000);
      await utimes(join(prefix, "bridge/index.js"), later, later);
      await verifyNativeRunnerPackage(config, logger as never);
      expect(modes().at(-1)?.mode).toBe("full");
      // The profile the runner was configured with is still enforced on the cached path.
      await expect(verifyNativeRunnerPackage({ ...(config as object), RUNNER_NATIVE_PACKAGE_PROFILE: { ...fixture.profile, os: "debian" } } as never))
        .rejects.toThrow(/profile changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("host-cache import (documented bridges only)", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kr-import-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses clearly for a bridge with no documented import", () => {
    expect(() => planHostCacheImport(findAgentBridge("claude-code")!)).toThrow(/no safe host-cache import/);
  });

  it("copies a private regular file once and never mutates the source", async () => {
    const plan = planHostCacheImport(findAgentBridge("codex")!);
    const source = join(dir, "auth.json");
    await writeFile(source, "{}", { mode: 0o600 });
    const credentialDir = join(dir, "credentials");
    await importHostCache({ plan, sourcePath: source, credentialDir });
    await expect(importHostCache({ plan, sourcePath: source, credentialDir })).rejects.toThrow(/already holds a login/);
  });

  it.skipIf(process.platform === "win32")("refuses a world-readable source", async () => {
    const plan = planHostCacheImport(findAgentBridge("codex")!);
    const source = join(dir, "auth.json");
    await writeFile(source, "{}");
    await chmod(source, 0o644);
    await expect(importHostCache({ plan, sourcePath: source, credentialDir: join(dir, "c") })).rejects.toThrow(/readable by other users/);
  });
});

describe("runner event schema", () => {
  it("is closed and carries no stdio", () => {
    expect(RunnerEventSchema.safeParse({ kind: "stdout", text: "x" }).success).toBe(false);
    expect(RunnerEventSchema.safeParse({ kind: "bridge_exited", code: 1, signal: null, extra: true }).success).toBe(false);
  });
});
