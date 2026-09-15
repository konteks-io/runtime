import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { findAgentBridge } from "@konteks/remote-release";
import { loadRunnerConfig } from "../config.js";
import { bridgeEnvironment, resolveBridgeSpawnSpec, resolveToolingCommand } from "../bridge/spec.js";
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

  it("rejects an unsupported agent family", () => {
    expect(() => loadRunnerConfig({ RUNNER_AGENT_ID: "cline" })).toThrow();
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
