import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAgentBridge } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { bridgeEnvironment, resolveBridgeSpawnSpec } from "../bridge/spec.js";
import { OPENCODE_INHERITED_VARIABLES, openCodeEnvironment, openCodeRunnerAdapter, openCodeRuntimePaths } from "../host/opencode.js";
import { hostAgentRunnerAdapter } from "../host/registry.js";
import { projectReadiness } from "../readiness.js";
import { INITIAL_SCOPE_STATE } from "../auth/scope-store.js";

/** Credential variables an owner commonly has set; none may reach any OpenCode process. */
const OWNER_SECRETS: Record<string, string> = {
  GITHUB_TOKEN: "ghp_owner_token_must_not_reach_opencode", GH_TOKEN: "gho_owner", GITHUB_PAT: "github_pat_owner",
  OPENAI_API_KEY: "sk-owner", ANTHROPIC_API_KEY: "sk-ant-owner", OPENROUTER_API_KEY: "sk-or-owner", OPENROUTER_BASE_URL: "https://or.example",
  DEEPSEEK_API_KEY: "sk-ds-owner", GROQ_API_KEY: "gsk-owner", XAI_API_KEY: "xai-owner",
  AWS_ACCESS_KEY_ID: "AKIAOWNER", AWS_SECRET_ACCESS_KEY: "aws-secret", AWS_PROFILE: "owner", AZURE_OPENAI_API_KEY: "azure-owner", AZURE_CLIENT_SECRET: "azure-secret",
  GOOGLE_APPLICATION_CREDENTIALS: "/owner/gcp.json", GOOGLE_CLOUD_PROJECT: "owner-project", NPM_TOKEN: "npm-owner", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  OPENCODE_CONFIG_CONTENT: "{\"permissions\":[]}", OPENCODE_AUTH_CONTENT: "{}", OPENCODE_CONFIG_PROJECT_DISABLE: "owner-unlocked", OPENCODE_SERVER_PASSWORD: "owner-pw",
  KONTEKS_LEASE: "lease", NODE_OPTIONS: "--require /owner/hook.js", CLAUDE_CODE_OAUTH_TOKEN: "claude-owner",
};

const config = (extra: Record<string, unknown> = {}) => RunnerConfigSchema.parse({
  RUNNER_AGENT_ID: "opencode", RUNNER_CREDENTIAL_DIR: "/rt/credentials/opencode", RUNNER_WORKSPACE_DIR: "/rt/workspaces/opencode",
  RUNNER_BRIDGE_PREFIX: "/Users/p/.opencode/bin", RUNNER_BRIDGE_VERSION: "2.0.18", RUNNER_NATIVE_OPENCODE_BINARY: "/Users/p/.opencode/bin/opencode", ...extra,
});

describe("OpenCode's environment is an allow-list", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("spawns `<binary> acp` with a private home and none of the owner's credential variables", () => {
    for (const [name, value] of Object.entries(OWNER_SECRETS)) vi.stubEnv(name, value);
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.local:3128");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/corp-ca.pem");
    const spec = resolveBridgeSpawnSpec(config());
    expect(spec.command).toBe("/Users/p/.opencode/bin/opencode");
    expect(spec.args).toEqual(["acp"]);
    expect(spec.cwd).toBe("/rt/workspaces/opencode");
    const paths = openCodeRuntimePaths("/rt/credentials/opencode");
    expect(spec.env).toMatchObject({
      HOME: paths.home, XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state, XDG_CACHE_HOME: paths.cache, XDG_CONFIG_HOME: paths.controlConfig,
      NO_COLOR: "1", LANG: "en_US.UTF-8", HTTPS_PROXY: "http://proxy.local:3128", NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", PATH: process.env.PATH,
    });
    expect(paths.home).toBe(join("/rt/credentials/opencode", "opencode", "home"));
    for (const name of Object.keys(OWNER_SECRETS)) expect(spec.env[name], name).toBeUndefined();
    for (const value of Object.values(OWNER_SECRETS)) expect(JSON.stringify(spec.env)).not.toContain(value);
    // Nothing outside the allow-list, the private home and fixed switches is present.
    const fixed = new Set([...OPENCODE_INHERITED_VARIABLES, "HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "NO_COLOR", "TERM", "SHELL"]);
    expect(Object.keys(spec.env).filter(name => !fixed.has(name))).toEqual([]);
  });

  it("keeps Windows' system variables (case-insensitively) and moves the profile folders into the private home", () => {
    const env = openCodeEnvironment({
      platform: "win32",
      inherited: { Path: "C:\\Windows\\system32;C:\\nodejs", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", TEMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\owner", APPDATA: "C:\\Users\\owner\\AppData\\Roaming", GITHUB_TOKEN: "ghp_owner", GH_TOKEN: "gho", OPENCODE_CONFIG: "C:\\owner.json" },
      home: { home: "/cred/opencode/home", data: "/cred/opencode/data", state: "/cred/opencode/state", cache: "/cred/opencode/cache", config: "/cred/opencode/config/control" },
    });
    expect(env).toMatchObject({ Path: "C:\\Windows\\system32;C:\\nodejs", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", TEMP: "C:\\Temp",
      USERPROFILE: "/cred/opencode/home" });
    expect(env.APPDATA).toContain("AppData");
    expect(env.APPDATA).not.toContain("owner");
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "OPENCODE_CONFIG"]) expect(env[name], name).toBeUndefined();
  });

  it("passes only Konteks' own OpenCode settings, never one that could carry a credential", () => {
    const home = { home: "/h/home", data: "/h/data", state: "/h/state", cache: "/h/cache", config: "/h/config" };
    const env = openCodeEnvironment({ home, inherited: { PATH: "/usr/bin", OPENCODE_CONFIG_CONTENT: "{\"owner\":true}" },
      settings: { OPENCODE_CONFIG_CONTENT: "{\"permissions\":[]}", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_AUTH_CONTENT: "{}" } });
    expect(env).toMatchObject({ OPENCODE_CONFIG_CONTENT: "{\"permissions\":[]}", OPENCODE_CONFIG_PROJECT_DISABLE: "1" });
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(() => openCodeEnvironment({ home, inherited: {}, settings: { GITHUB_TOKEN: "x" } })).toThrow(/not an OpenCode setting/);
    expect(() => openCodeEnvironment({ home: { ...home, home: "relative" }, inherited: {} })).toThrow(/absolute/);
    expect(() => openCodeEnvironment({ home, inherited: { NODE_EXTRA_CA_CERTS: "ca.pem" } })).toThrow(/absolute/);
    expect(openCodeEnvironment({ home, inherited: { SHELL: "zsh" } }).SHELL).toBeUndefined();
    expect(openCodeEnvironment({ home, inherited: { SHELL: "/bin/zsh" } }).SHELL).toBe("/bin/zsh");
  });
});

describe("the OpenCode runner adapter", () => {
  it("is the registered host adapter and never lends its settings to another family", () => {
    expect(hostAgentRunnerAdapter("opencode")).toBe(openCodeRunnerAdapter);
    expect(() => bridgeEnvironment(config(), findAgentBridge("codex")!)).toThrow(/OpenCode/);
    expect(() => bridgeEnvironment(config({ RUNNER_AGENT_ID: "dsh" }), findAgentBridge("dsh")!)).toThrow(/OpenCode|DeepSeek/);
    expect(() => resolveBridgeSpawnSpec(config({ RUNNER_NATIVE_OPENCODE_BINARY: undefined }))).toThrow(/OpenCode 2 at an absolute local path/);
    expect(() => resolveBridgeSpawnSpec(config({ RUNNER_NATIVE_OPENCODE_BINARY: "opencode" }))).toThrow(/absolute/);
    // dsh settings on an OpenCode runner are refused too.
    expect(() => resolveBridgeSpawnSpec(config({ RUNNER_NATIVE_DSH_NODE: "/usr/bin/node" }))).toThrow(/DeepSeek Harness/);
  });

  it("fails closed until its locked configuration (CP2) and sign-in (CP3) exist", async () => {
    const runner = config();
    await expect(openCodeRunnerAdapter.prepareToSpawn(runner)).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(() => openCodeRunnerAdapter.startLogin!({ config: runner, events: {} as never, logger: { info: () => undefined } })).toThrow(/cannot run Konteks work/);
    await expect(openCodeRunnerAdapter.logout!(runner)).rejects.toMatchObject({ code: "agent_unavailable" });
    await expect(openCodeRunnerAdapter.identity!(runner)).resolves.toEqual({ kind: "logged_out" });
  });

  it("reports its verified version and billing usage like the bundled agents", () => {
    const view = projectReadiness({
      family: findAgentBridge("opencode")!, authMode: "agent_local_subscription", connectionState: "ready", initializeResult: null,
      scope: INITIAL_SCOPE_STATE,
      identity: "logged_out", bridgeVersionCompatible: true, hostAgentVersion: openCodeRunnerAdapter.hostVersion(config()), lastProbeAt: null,
    });
    expect(view).toMatchObject({ agentId: "opencode", displayName: "OpenCode", readiness: "not_configured", tokenUsageObservable: true, hostAgentVersion: "2.0.18" });
    expect(openCodeRunnerAdapter.hostVersion(config({ RUNNER_BRIDGE_VERSION: "unknown" }))).toBeUndefined();
  });
});
