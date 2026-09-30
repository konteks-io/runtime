import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchedAgentPlatformPin, findAgentBridge } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { bridgeEnvironment, resolveBridgeSpawnSpec } from "../bridge/spec.js";
import {
  ANTIGRAVITY_ENABLED_TOOLS, ANTIGRAVITY_MAX_INSTRUCTIONS_BYTES, ANTIGRAVITY_SESSION_META, ANTIGRAVITY_SETTING_NAMES, antigravityAgentErrorText, antigravityEnvironment,
  antigravityProcessEnvironment, antigravityPromptPrelude, antigravityRunnerAdapter, antigravityRuntimePaths, antigravityStderrFailure, prepareAntigravityHome,
  readAntigravitySignIn, renderAntigravitySettings, sweepAntigravityProcesses, verifyAntigravitySession, writeAntigravitySignIn,
} from "../host/antigravity.js";
import { HOST_INHERITED_VARIABLES } from "../host/allow-list-environment.js";
import { antigravityStderrFailure as stderrFailure, clearAntigravityAdminObservation, observeAntigravityAdminLine, readAntigravityAdminObservation } from "../host/antigravity.js";
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

  it.runIf(fetchedAgentPlatformPin("antigravity") !== undefined)("signs in only from the fetched copy, refuses personal Google sign-in (A10), and reads signed out with nothing held (CP3)", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agy-adapter-")));
    try {
      const runner = config({ RUNNER_CREDENTIAL_DIR: join(root, "credentials") });
      const logger = { info: () => undefined, warn: () => undefined };
      expect(() => antigravityRunnerAdapter.startLogin!({ config: config({ RUNNER_NATIVE_ANTIGRAVITY_ROOT: undefined }), events: {} as never, logger })).toThrow(/copy the connector fetched/);
      expect(() => antigravityRunnerAdapter.startLogin!({ config: runner, events: {} as never, logger, request: { loginOption: "google-account" } })).toThrow(/personal Google account is not available/);
      expect(() => antigravityRunnerAdapter.startLogin!({ config: runner, events: {} as never, logger, request: { loginOption: "chatgpt" } })).toThrow(/not one of Google Antigravity's/);
      await expect(antigravityRunnerAdapter.logout!(runner, { method: "gemini-api-key" })).rejects.toMatchObject({ code: "prerequisite_missing" });
      await expect(antigravityRunnerAdapter.identity!(runner, { openCodeFreeModels: false, coreAcceptsRouteBilling: true })).resolves.toEqual({ kind: "logged_out", credentials: [] });
      await expect(antigravityRunnerAdapter.siteLoginOptions!(runner)).resolves.toEqual(["gemini-enterprise"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("carries the locked session configuration: the tool filter, default mode only, two processes, a longer bootstrap", () => {
    expect(antigravityRunnerAdapter.sessionMeta).toEqual({ agy: {
      enabledTools: ["view_file", "list_directory", "search_directory", "find_file", "create_file", "edit_file", "run_command", "read_url_content", "search_web", "finish"],
      disabledTools: ["start_subagent", "generate_image", "ask_question"],
    } });
    expect(ANTIGRAVITY_ENABLED_TOOLS).not.toEqual(expect.arrayContaining(["start_subagent"]));
    expect(Object.isFrozen(ANTIGRAVITY_SESSION_META)).toBe(true);
    expect(antigravityRunnerAdapter.refusedSessionModes?.modeIds).toEqual(["auto_edit", "yolo"]);
    expect(antigravityRunnerAdapter.processLimits).toEqual({ executionProcesses: 2, queueMs: 120_000, idleExecutionMs: 300_000, controlIdleMs: 60_000 });
    expect(antigravityRunnerAdapter.sessionBootstrapTimeoutMs).toBe(30_000);
  });

  it("reports its pinned version, and no billing usage unless its identity says the key relay counts it (CP3)", () => {
    const view = projectReadiness({
      family: findAgentBridge("antigravity")!, authMode: "agent_local_subscription", connectionState: "ready", initializeResult: null,
      scope: INITIAL_SCOPE_STATE,
      identity: "logged_out", bridgeVersionCompatible: true, hostAgentVersion: antigravityRunnerAdapter.hostVersion(config()), lastProbeAt: null,
    });
    expect(view).toMatchObject({ agentId: "antigravity", displayName: "Google Antigravity", readiness: "not_configured", tokenUsageObservable: false, hostAgentVersion: "1.2.1" });
    expect(antigravityRunnerAdapter.hostVersion(config({ RUNNER_BRIDGE_VERSION: "unknown" }))).toBeUndefined();
  });
});

describe("Google Antigravity's private home (CP2)", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  const credentials = async () => { const dir = await realpath(await mkdtemp(join(tmpdir(), "agy-home-"))); dirs.push(dir); return join(dir, "credentials"); };

  it("writes settings.json from the connector's sign-in record only, exactly as the contract names it", async () => {
    expect(renderAntigravitySettings(null)).toBe("{}\n");
    expect(JSON.parse(renderAntigravitySettings({ method: "gemini-api-key" }))).toEqual({ auth: { type: "gemini-api-key" } });
    expect(JSON.parse(renderAntigravitySettings({ method: "oauth-business", gcp: { project: "gemini-enterprise-qa-25d3", location: "global" } })))
      .toEqual({ auth: { type: "oauth-business" }, gcp: { project: "gemini-enterprise-qa-25d3", location: "global" } });
    const cred = await credentials();
    const paths = await prepareAntigravityHome(cred);
    expect(await readFile(paths.settingsFile, "utf8")).toBe("{}\n");
    await writeAntigravitySignIn(cred, { method: "oauth-business", gcp: { project: "gemini-enterprise-qa-25d3", location: "global" } });
    await prepareAntigravityHome(cred);
    expect(JSON.parse(await readFile(paths.settingsFile, "utf8"))).toMatchObject({ auth: { type: "oauth-business" }, gcp: { project: "gemini-enterprise-qa-25d3" } });
    expect((await stat(paths.settingsFile)).mode & 0o777).toBe(0o600);
    // A project or location that is not one, or any other shape, is not a sign-in.
    await expect(writeAntigravitySignIn(cred, { method: "oauth-business", gcp: { project: "../../etc", location: "global" } } as never)).rejects.toThrow();
    await expect(writeAntigravitySignIn(cred, { method: "oauth-business", gcp: { project: "gemini-enterprise-qa-25d3", location: "asia" } } as never)).rejects.toThrow();
    await writeFile(paths.signIn, JSON.stringify({ method: "oauth-business" }));
    expect(await readAntigravitySignIn(cred)).toBeNull();
    await writeFile(paths.signIn, JSON.stringify({ method: "gemini-api-key", token: "x" }));
    expect(await readAntigravitySignIn(cred)).toBeNull();
    // CP3: the key in use keeps Enterprise's project for the next sign-in; settings name only the method.
    expect(JSON.parse(renderAntigravitySettings({ method: "gemini-api-key", gcp: { project: "gemini-enterprise-qa-25d3", location: "global" }, tier: "gcp-ge-plus-tier" }))).toEqual({ auth: { type: "gemini-api-key" } });
    expect(renderAntigravitySettings({ method: "none", gcp: { project: "gemini-enterprise-qa-25d3", location: "global" } })).toBe("{}\n");
    // Personal Google sign-in stays held back (A10): even a recorded one names no method.
    await writeFile(paths.signIn, JSON.stringify({ method: "oauth-personal" }));
    await prepareAntigravityHome(cred);
    expect(await readFile(paths.settingsFile, "utf8")).toBe("{}\n");
    await writeFile(paths.signIn, "not json");
    await prepareAntigravityHome(cred);
    expect(await readFile(paths.settingsFile, "utf8")).toBe("{}\n");
  });

  it("keeps the folders the person's alone, trusts nothing and owns an empty config/ and skills folders", async () => {
    const cred = await credentials();
    const paths = antigravityRuntimePaths(cred);
    await mkdir(join(paths.geminiHome, "antigravity-acp"), { recursive: true, mode: 0o755 });
    await chmod(paths.home, 0o755);
    // What someone else planted: trust for every folder, a global hook, MCP servers, skills.
    await writeFile(paths.trustFile, JSON.stringify({ trusted: ["/"] }));
    await mkdir(join(paths.geminiHome, "config", "skills", "evil"), { recursive: true });
    await writeFile(join(paths.geminiHome, "config", "hooks.json"), "{\"hooks\":[]}");
    await writeFile(join(paths.geminiHome, "config", "mcp_config.json"), "{}");
    await mkdir(join(paths.geminiHome, "antigravity-cli", "skills", "evil"), { recursive: true });
    // The server's own token file is left alone and never read.
    await writeFile(join(paths.geminiHome, "antigravity-acp", "acp_business_token.json"), "token", { mode: 0o600 });
    await prepareAntigravityHome(cred);
    for (const folder of [paths.root, paths.home, paths.geminiHome, join(paths.geminiHome, "antigravity-acp")]) expect((await stat(folder)).mode & 0o777, folder).toBe(0o700);
    await expect(stat(paths.trustFile)).rejects.toThrow();
    expect(await readdir(join(paths.geminiHome, "config"))).toEqual(["skills"]);
    expect(await readdir(join(paths.geminiHome, "config", "skills"))).toEqual([]);
    expect(await readdir(join(paths.geminiHome, "antigravity-cli", "skills"))).toEqual([]);
    expect(await readFile(join(paths.geminiHome, "antigravity-acp", "acp_business_token.json"), "utf8")).toBe("token");
    // The sign-in record and the delivered instructions live outside the agent's home.
    expect(paths.signIn.startsWith(paths.home)).toBe(false);
    expect(paths.instructions.startsWith(paths.home)).toBe(false);
  });

  it("prepareToSpawn refuses a runner without the fetched folder and builds the home otherwise", async () => {
    const cred = await credentials();
    await expect(antigravityRunnerAdapter.prepareToSpawn(config({ RUNNER_NATIVE_ANTIGRAVITY_ROOT: undefined }))).rejects.toThrow(/copy the connector fetched/);
    await antigravityRunnerAdapter.prepareToSpawn(config({ RUNNER_CREDENTIAL_DIR: cred }));
    expect(await readFile(antigravityRuntimePaths(cred).settingsFile, "utf8")).toBe("{}\n");
  });
});

describe("the working copy's AGENTS.md for Google Antigravity (A9)", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function setup() {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "agy-md-"))); dirs.push(dir);
    const wc = join(dir, "repo");
    await mkdir(wc);
    return { cred: join(dir, "credentials"), wc, dir };
  }

  it("goes in front of a session's first prompt as an embedded resource, and again only when it changed", async () => {
    const { cred, wc } = await setup();
    await writeFile(join(wc, "AGENTS.md"), "End every reply with PINEAPPLE.\n");
    const first = await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s-1" });
    expect(first!.blocks).toEqual([
      { type: "text", text: expect.stringContaining("AGENTS.md") },
      { type: "resource", resource: { uri: `file://${join(wc, "AGENTS.md")}`, mimeType: "text/markdown", text: "End every reply with PINEAPPLE.\n" } },
    ]);
    // Not remembered until the prompt carrying it was answered.
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s-1" })).not.toBeNull();
    await first!.delivered();
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s-1" })).toBeNull();
    // Another session (or a resumed one in a new process) is told separately; an edit is sent again.
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s-2" })).not.toBeNull();
    await writeFile(join(wc, "AGENTS.md"), "End every reply with MANGO.\n");
    const changed = await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s-1" });
    expect((changed!.blocks[1] as { resource: { text: string } }).resource.text).toContain("MANGO");
    expect((await stat(antigravityRuntimePaths(cred).instructions)).mode & 0o777).toBe(0o600);
  });

  it("is never read through a link that leaves the working copy, and is skipped when absent, empty or too large", async () => {
    const { cred, wc, dir } = await setup();
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s" })).toBeNull();
    await writeFile(join(dir, "secret.md"), "ssh key");
    await symlink(join(dir, "secret.md"), join(wc, "AGENTS.md"));
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s" })).toBeNull();
    await rm(join(wc, "AGENTS.md"));
    await writeFile(join(wc, "AGENTS.md"), "");
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s" })).toBeNull();
    await writeFile(join(wc, "AGENTS.md"), "x".repeat(ANTIGRAVITY_MAX_INSTRUCTIONS_BYTES + 1));
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s" })).toBeNull();
    // A link inside the working copy is fine.
    await rm(join(wc, "AGENTS.md"));
    await writeFile(join(wc, "RULES.md"), "inside");
    await symlink(join(wc, "RULES.md"), join(wc, "AGENTS.md"));
    expect(await antigravityPromptPrelude(cred, { cwd: wc, sessionKey: "s" })).not.toBeNull();
  });
});

describe("what Google Antigravity reports, read for the person", () => {
  const MODEL = { id: "model", type: "select", currentValue: "gemini-3.8-flash-high", options: [{ value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }] };
  const MODE = { id: "mode", type: "select", currentValue: "default", options: [{ value: "default" }, { value: "auto_edit" }, { value: "yolo" }] };

  it("a session must offer a model and sit in the default mode", () => {
    expect(() => verifyAntigravitySession({ configOptions: [MODEL, MODE], modes: { currentModeId: "default" } })).not.toThrow();
    expect(() => verifyAntigravitySession({ configOptions: [MODEL] })).not.toThrow();
    expect(() => verifyAntigravitySession({ configOptions: [MODE] })).toThrow(/offers no model choice/);
    expect(() => verifyAntigravitySession({})).toThrow(/Update the connector/);
    expect(() => verifyAntigravitySession({ configOptions: [MODEL, { ...MODE, currentValue: "yolo" }] })).toThrow(/outside its default mode/);
    expect(() => verifyAntigravitySession({ configOptions: [MODEL], modes: { currentModeId: "auto_edit" } })).toThrow(/outside its default mode/);
  });

  it("stderr lines that need the person end the wait as a sign-in, naming the Business AI Code API for a missing licence", () => {
    const licence = antigravityStderrFailure("W0928 23:44:03.945413 6108344320 business_auth.py:462] Configured project=gemini-enterprise-qa-25d3 location=global has no available license; falling through to the license picker (b/558693144).");
    expect(licence).toMatchObject({ code: "agent_auth_required", diagnostic: "antigravity_no_licence" });
    expect(licence!.message).toContain("gcloud services enable businessaicode.googleapis.com --project <project id>");
    expect(licence!.message).not.toContain("gemini-enterprise-qa-25d3");
    for (const line of ["Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?x", "Open the following link to choose your Gemini Enterprise license: http://127.0.0.1:50694/",
      "I0929 00:23:53.875517 6143586304 credential_manager.py:561] Credentials missing or invalid. Launching browser login flow..."]) {
      expect(antigravityStderrFailure(line), line).toMatchObject({ code: "agent_auth_required", diagnostic: "antigravity_sign_in_needed" });
    }
    expect(antigravityStderrFailure("I0929 00:23:53.873835 credential_store.py:235] AGY_ACP_FORCE_FILE_STORAGE set; using file credential storage.")).toBeNull();
  });

  it("quota and model failures sent as reply text become plain, classified turn errors", () => {
    expect(antigravityAgentErrorText("Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 4 days, 23 hours."))
      .toEqual({ class: "provider_failure", message: "Your Gemini quota for this period is used up. The session is kept and can continue once it resets.", retryable: true });
    expect(antigravityAgentErrorText("Agent execution error: 429 RESOURCE_EXHAUSTED")).toMatchObject({ class: "provider_failure", retryable: true });
    expect(antigravityAgentErrorText("Agent execution error: 503 UNAVAILABLE: backend")).toMatchObject({ class: "provider_failure", retryable: true, message: expect.stringContaining("Google had a problem") });
    expect(antigravityAgentErrorText("Agent execution error: model gemini-3.1-pro-high is not allowed by your administrator")).toEqual({ class: "provider_failure", retryable: false, message: "This model is not available to your Gemini Enterprise licence. Pick another model." });
    expect(antigravityAgentErrorText("Agent execution error: 403 PERMISSION_DENIED")).toMatchObject({ class: "agent_auth_required" });
    expect(antigravityAgentErrorText("Agent execution error: something else")).toEqual({ class: "provider_failure", retryable: false, message: "Google Antigravity could not finish this turn." });
    expect(antigravityAgentErrorText("Hello! The usage limit reached is fine.")).toBeNull();
  });

  it("stops only the leftover processes whose HOME is this runner's private home", async () => {
    const stopped: number[][] = [];
    let asked: { home: string; programs: readonly string[] } | null = null;
    const count = await sweepAntigravityProcesses("/rt/credentials/antigravity", {
      list: async (home, programs) => { asked = { home, programs }; return [101, 102]; },
      stop: async pids => { stopped.push(pids); },
    });
    expect(count).toBe(2);
    expect(asked).toEqual({ home: antigravityRuntimePaths("/rt/credentials/antigravity").home, programs: ["agy_acp_server", "localharness"] });
    expect(stopped).toEqual([[101, 102]]);
    expect(await sweepAntigravityProcesses("/rt/credentials/antigravity", { list: async () => [], stop: async () => { throw new Error("never"); } })).toBe(0);
  });
});

describe("the organisation's MCP Servers setting as a Gemini Enterprise session shows it (antigravity CP6)", () => {
  it("records the servers dropped by the admin setting, never zero, clears on an allowlist that keeps ours, and never writes a secret", async () => {
    const credentialDir = await mkdtemp(join(tmpdir(), "agy-admin-"));
    try {
      expect(await readAntigravityAdminObservation(credentialDir)).toBeNull();
      const at = () => new Date("2026-09-29T01:02:03.000Z");
      await observeAntigravityAdminLine("I0929 00:25:18.673131 server.py:2900] Admin MCP control active: dropping 0 client-requested custom MCP server(s) for this session.", credentialDir, at);
      expect(await readAntigravityAdminObservation(credentialDir)).toBeNull();
      await observeAntigravityAdminLine("I0929 00:25:18.673131 server.py:2900] Admin MCP control active: dropping 3 client-requested custom MCP server(s) for this session.", credentialDir, at);
      expect(await readAntigravityAdminObservation(credentialDir)).toEqual({ mcpServersOffAt: "2026-09-29T01:02:03.000Z" });
      const file = join(credentialDir, "antigravity", "admin-controls.json");
      expect(((await stat(file)).mode & 0o077)).toBe(0);
      expect(await readFile(file, "utf8")).toBe('{"mcpServersOffAt":"2026-09-29T01:02:03.000Z"}\n');
      await observeAntigravityAdminLine("I0929 mcp_servers.py:1] Admin MCP allowlist active: custom MCP servers ['konteks-platform', 'konteks-result'] -> ['konteks-platform', 'konteks-result'].", credentialDir, at);
      expect(await readAntigravityAdminObservation(credentialDir)).toBeNull();
      await observeAntigravityAdminLine("I0929 mcp_servers.py:1] Admin MCP allowlist active: custom MCP servers ['konteks-platform', 'konteks-result'] -> [].", credentialDir, at);
      expect(await readAntigravityAdminObservation(credentialDir)).not.toBeNull();
      await clearAntigravityAdminObservation(credentialDir);
      expect(await readAntigravityAdminObservation(credentialDir)).toBeNull();
      // Read from every execution process's stderr, beside the licence lines:
      // dropped servers end the session at once as an access error, recorded
      // before it returns so the identity read that follows sees it (WS1-196).
      expect(stderrFailure("I0929 server.py:2900] Admin MCP control active: dropping 4 client-requested custom MCP server(s) for this session.", credentialDir))
        .toMatchObject({ code: "agent_unavailable", diagnostic: "antigravity_mcp_servers_off", message: expect.stringContaining("MCP Servers is turned off") });
      expect(await readAntigravityAdminObservation(credentialDir)).not.toBeNull();
      expect(((await stat(join(credentialDir, "antigravity", "admin-controls.json"))).mode & 0o077)).toBe(0);
      await clearAntigravityAdminObservation(credentialDir);
      expect(stderrFailure("I0929 server.py:2900] Admin MCP control active: dropping 0 client-requested custom MCP server(s) for this session.", credentialDir)).toBeNull();
      expect(await readAntigravityAdminObservation(credentialDir)).toBeNull();
    } finally {
      await rm(credentialDir, { recursive: true, force: true });
    }
  });
});
