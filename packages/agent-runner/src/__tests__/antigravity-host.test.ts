import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchedAgentPlatformPin, findAgentBridge } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { bridgeEnvironment, resolveBridgeSpawnSpec } from "../bridge/spec.js";
import { ANTIGRAVITY_SETTING_NAMES, antigravityEnvironment, antigravityProcessEnvironment, antigravityRunnerAdapter, antigravityRuntimePaths } from "../host/antigravity.js";
import { HOST_INHERITED_VARIABLES } from "../host/allow-list-environment.js";
import { hostAgentRunnerAdapter } from "../host/registry.js";
import { projectReadiness } from "../readiness.js";
import { INITIAL_SCOPE_STATE } from "../auth/scope-store.js";

/**
 * Credential and Google variables an owner commonly has set; none may reach
 * any Antigravity process (A5). The server hands everything it gets to its
 * `run_command` tool (CP0 B14), and would sign in from `GEMINI_API_KEY`.
 */
const OWNER_SECRETS: Record<string, string> = {
  GITHUB_TOKEN: "ghp_owner_token_must_not_reach_antigravity", GH_TOKEN: "gho_owner", GITHUB_PAT: "github_pat_owner",
  GEMINI_API_KEY: "gemini-owner-key", GOOGLE_API_KEY: "google-owner-key", GOOGLE_APPLICATION_CREDENTIALS: "/owner/gcp.json",
  GOOGLE_CLOUD_PROJECT: "owner-project", GOOGLE_CLOUD_LOCATION: "us", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_GEMINI_BASE_URL: "https://attacker.example",
  GEMINI_HOME: "/Users/owner/.gemini", GEMINI_MODEL: "owner-model", CLOUDSDK_CONFIG: "/Users/owner/.config/gcloud", CLOUDSDK_CORE_PROJECT: "owner",
  AGY_ADC_AUTH: "1", AGY_ACP_DISABLE_WORKSPACE_TRUST: "1", AGY_ACP_ENABLE_OAUTH: "1", AGY_ACP_ENABLE_GATEWAY_AUTH: "1", AGY_ACP_BAIC_BASE_URL: "https://baic.example",
  AGY_ACP_CCPA_ENDPOINT: "https://ccpa.example", AGY_ACP_DEFAULT_MODEL: "gemini-owner", AGY_CLI_DISABLE_AUTO_UPDATE: "false",
  ANTIGRAVITY_HARNESS_PATH: "/owner/harness", ANTIGRAVITY_CONVERSATION_ID: "owner-conv", ANTIGRAVITY_CSRF_TOKEN: "csrf",
  OPENAI_API_KEY: "sk-owner", ANTHROPIC_API_KEY: "sk-ant-owner", OPENROUTER_API_KEY: "sk-or-owner", DEEPSEEK_API_KEY: "sk-ds-owner",
  AWS_ACCESS_KEY_ID: "AKIAOWNER", AWS_SECRET_ACCESS_KEY: "aws-secret", AWS_PROFILE: "owner", AZURE_OPENAI_API_KEY: "azure-owner", AZURE_CLIENT_SECRET: "azure-secret",
  NPM_TOKEN: "npm-owner", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock", KONTEKS_LEASE: "lease", NODE_OPTIONS: "--require /owner/hook.js", CLAUDE_CODE_OAUTH_TOKEN: "claude-owner",
  XDG_CONFIG_HOME: "/Users/owner/.config", USER_HOME_OVERRIDE: "/Users/owner",
};

const pinned = fetchedAgentPlatformPin("antigravity");
const FOLDER = "/rt/agents/antigravity/1.2.1-darwin-arm64";
const config = (extra: Record<string, unknown> = {}) => RunnerConfigSchema.parse({
  RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: "/rt/credentials/antigravity", RUNNER_WORKSPACE_DIR: "/rt/workspaces/antigravity",
  RUNNER_BRIDGE_PREFIX: FOLDER, RUNNER_BRIDGE_VERSION: "1.2.1", RUNNER_NATIVE_ANTIGRAVITY_ROOT: FOLDER, ...extra,
});
/** The values distinctive enough to search for anywhere in an environment. */
const DISTINCT = Object.values(OWNER_SECRETS).filter(value => value.length >= 8 && value !== "/Users/owner/.gemini");
const FIXED = new Set([...HOST_INHERITED_VARIABLES, "HOME", "GEMINI_HOME", "AGY_ACP_FORCE_FILE_STORAGE", "NO_COLOR", "TERM", "SHELL"]);

describe("Google Antigravity's environment is an allow-list (A5)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("gets a private HOME and GEMINI_HOME, forced file storage, and none of the owner's credential, Google or Antigravity variables", () => {
    for (const [name, value] of Object.entries(OWNER_SECRETS)) vi.stubEnv(name, value);
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.local:3128");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/corp-ca.pem");
    const env = antigravityProcessEnvironment("/rt/credentials/antigravity");
    const paths = antigravityRuntimePaths("/rt/credentials/antigravity");
    expect(paths.home).toBe(join("/rt/credentials/antigravity", "antigravity", "home"));
    expect(paths.geminiHome).toBe(join(paths.home, ".gemini"));
    expect(env).toMatchObject({ HOME: paths.home, GEMINI_HOME: paths.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: "1", NO_COLOR: "1", TERM: "dumb",
      LANG: "en_US.UTF-8", HTTPS_PROXY: "http://proxy.local:3128", NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", PATH: process.env.PATH });
    for (const name of Object.keys(OWNER_SECRETS).filter(name => name !== "GEMINI_HOME")) expect(env[name], name).toBeUndefined();
    for (const value of DISTINCT) expect(JSON.stringify(env), value).not.toContain(value);
    expect(Object.keys(env).filter(name => !FIXED.has(name))).toEqual([]);
    // The connector's own relay address only when there is one, and only on loopback.
    expect(antigravityEnvironment({ home: paths, inherited: {}, relayBaseUrl: "http://127.0.0.1:41234" }).GOOGLE_GEMINI_BASE_URL).toBe("http://127.0.0.1:41234");
    for (const url of ["https://127.0.0.1:1", "http://localhost:1", "http://10.0.0.1:1", "http://127.0.0.1", "http://user:pw@127.0.0.1:1", "http://127.0.0.1:1/v1beta", "not a url"]) {
      expect(() => antigravityEnvironment({ home: paths, inherited: {}, relayBaseUrl: url }), url).toThrow(/127\.0\.0\.1/);
    }
    expect(ANTIGRAVITY_SETTING_NAMES).toEqual(["AGY_ACP_FORCE_FILE_STORAGE", "GOOGLE_GEMINI_BASE_URL"]);
  });

  it("keeps Windows' system variables and moves the profile folders into the private home", () => {
    const env = antigravityEnvironment({
      platform: "win32",
      inherited: { Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", TEMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\owner", APPDATA: "C:\\Users\\owner\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
        GITHUB_TOKEN: "ghp_owner", GEMINI_API_KEY: "key", GOOGLE_CLOUD_PROJECT: "p", AGY_ACP_DISABLE_WORKSPACE_TRUST: "1" },
      home: { home: "C:\\cred\\antigravity\\home", geminiHome: "C:\\cred\\antigravity\\home\\.gemini" },
    });
    expect(env).toMatchObject({ Path: "C:\\Windows\\system32", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", TEMP: "C:\\Temp",
      USERPROFILE: "C:\\cred\\antigravity\\home", APPDATA: "C:\\cred\\antigravity\\home\\AppData\\Roaming", LOCALAPPDATA: "C:\\cred\\antigravity\\home\\AppData\\Local",
      GEMINI_HOME: "C:\\cred\\antigravity\\home\\.gemini", AGY_ACP_FORCE_FILE_STORAGE: "1" });
    for (const name of ["GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "AGY_ACP_DISABLE_WORKSPACE_TRUST"]) expect(env[name], name).toBeUndefined();
  });

  it("refuses a relative home and a relative CA path", () => {
    expect(() => antigravityEnvironment({ home: { home: "home", geminiHome: "/h/.gemini" }, inherited: {} })).toThrow(/Google Antigravity home must be an absolute/);
    expect(() => antigravityEnvironment({ home: { home: "/h", geminiHome: "/h/.gemini" }, inherited: { NODE_EXTRA_CA_CERTS: "ca.pem" } })).toThrow(/absolute/);
  });

  // The real proof: a process started with the adapter's environment prints what it got.
  it.runIf(process.platform !== "win32")("a real child process started with it sees no GITHUB_TOKEN, GEMINI_API_KEY or GOOGLE_* from the parent", async () => {
    for (const [name, value] of Object.entries(OWNER_SECRETS)) vi.stubEnv(name, value);
    const dir = await mkdtemp(join(tmpdir(), "agy-env-"));
    try {
      const script = join(dir, "print-env");
      await writeFile(script, "#!/bin/sh\n/usr/bin/env\n");
      await chmod(script, 0o755);
      await mkdir(join(dir, "cred"), { recursive: true });
      const env = antigravityProcessEnvironment(join(dir, "cred"));
      const printed = await new Promise<string>((resolve, reject) => execFile(script, [], { env }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
      const names = printed.split("\n").filter(Boolean).map(line => line.slice(0, line.indexOf("=")));
      for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GEMINI_BASE_URL", "CLOUDSDK_CONFIG", "AGY_ACP_DISABLE_WORKSPACE_TRUST", "ANTIGRAVITY_HARNESS_PATH"]) {
        expect(names, name).not.toContain(name);
      }
      expect(names.filter(name => name.startsWith("GOOGLE_") || name.startsWith("CLOUDSDK_") || (name.startsWith("AGY_") && name !== "AGY_ACP_FORCE_FILE_STORAGE"))).toEqual([]);
      for (const value of DISTINCT) expect(printed, value).not.toContain(value);
      expect(printed).toContain("AGY_ACP_FORCE_FILE_STORAGE=1");
      expect(printed).toContain(`GEMINI_HOME=${join(dir, "cred", "antigravity", "home", ".gemini")}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the Antigravity runner adapter", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.runIf(pinned !== undefined)("spawns the pinned command from the fetched folder, in the runner's workspace, with the allow-list environment", () => {
    for (const [name, value] of Object.entries(OWNER_SECRETS)) vi.stubEnv(name, value);
    const spec = resolveBridgeSpawnSpec(config());
    expect(spec.command).toBe(join(FOLDER, pinned!.command));
    expect(spec.args).toEqual(pinned!.args);
    expect(spec.cwd).toBe("/rt/workspaces/antigravity");
    expect(Object.keys(spec.env).filter(name => !FIXED.has(name))).toEqual([]);
    for (const value of DISTINCT) expect(JSON.stringify(spec.env), value).not.toContain(value);
  });

  it("is the registered host adapter and never lends its settings to another family", () => {
    expect(hostAgentRunnerAdapter("antigravity")).toBe(antigravityRunnerAdapter);
    expect(findAgentBridge("antigravity")?.hostInstall?.launch).toBe("fetched");
    expect(() => bridgeEnvironment(config(), findAgentBridge("codex")!)).toThrow(/Google Antigravity/);
    expect(() => bridgeEnvironment(config({ RUNNER_AGENT_ID: "opencode", RUNNER_NATIVE_OPENCODE_BINARY: "/o/opencode" }), findAgentBridge("opencode")!)).toThrow(/Google Antigravity|OpenCode/);
    expect(() => resolveBridgeSpawnSpec(config({ RUNNER_NATIVE_ANTIGRAVITY_ROOT: undefined }))).toThrow(/copy the connector fetched/);
    expect(() => resolveBridgeSpawnSpec(config({ RUNNER_NATIVE_ANTIGRAVITY_ROOT: "agents/antigravity" }))).toThrow(/absolute/);
    // Another host agent's settings on an Antigravity runner are refused too.
    expect(() => resolveBridgeSpawnSpec(config({ RUNNER_NATIVE_OPENCODE_BINARY: "/o/opencode" }))).toThrow(/OpenCode/);
    expect(() => resolveBridgeSpawnSpec(config({ RUNNER_NATIVE_DSH_NODE: "/usr/bin/node" }))).toThrow(/DeepSeek Harness/);
  });

  it("fails closed until its private home and self-check (CP2) and sign-in (CP3) exist", async () => {
    const runner = config();
    await expect(antigravityRunnerAdapter.prepareToSpawn(runner)).rejects.toMatchObject({ code: "agent_unavailable", message: "Google Antigravity cannot run Konteks work on this computer yet." });
    expect(() => antigravityRunnerAdapter.startLogin!({ config: runner, events: {} as never, logger: { info: () => undefined, warn: () => undefined } })).toThrow(/cannot run Konteks work/);
    await expect(antigravityRunnerAdapter.logout!(runner)).rejects.toMatchObject({ code: "agent_unavailable" });
    await expect(antigravityRunnerAdapter.identity!(runner, { openCodeFreeModels: false, coreAcceptsRouteBilling: false })).resolves.toEqual({ kind: "logged_out" });
  });

  it("reports its pinned version, and no billing usage until the relay (CP3)", () => {
    const view = projectReadiness({
      family: findAgentBridge("antigravity")!, authMode: "agent_local_subscription", connectionState: "ready", initializeResult: null,
      scope: INITIAL_SCOPE_STATE,
      identity: "logged_out", bridgeVersionCompatible: true, hostAgentVersion: antigravityRunnerAdapter.hostVersion(config()), lastProbeAt: null,
    });
    expect(view).toMatchObject({ agentId: "antigravity", displayName: "Google Antigravity", readiness: "not_configured", tokenUsageObservable: false, hostAgentVersion: "1.2.1" });
    expect(antigravityRunnerAdapter.hostVersion(config({ RUNNER_BRIDGE_VERSION: "unknown" }))).toBeUndefined();
  });
});
