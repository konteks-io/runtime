import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAgentBridge } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { bridgeEnvironment, resolveBridgeSpawnSpec } from "../bridge/spec.js";
import {
  OPENCODE_INHERITED_VARIABLES, OPENCODE_KONTEKS_PERMISSIONS, bindOpenCodeWorkingCopy, openCodeEnvironment, openCodeKonteksSettings, openCodePermissionDecision,
  openCodeRunnerAdapter, openCodeRuntimePaths, openCodeWorkingCopyConfig, openCodeWorkingCopyKey, renderOpenCodeKonteksConfig, syncOpenCodeInstructions,
} from "../host/opencode.js";
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

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
      // The locked Konteks configuration, the repository's own config off, no file watcher.
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_FILEWATCHER_DISABLE: "1",
    });
    expect(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!)).toEqual(renderOpenCodeKonteksConfig());
    expect(paths.home).toBe(join("/rt/credentials/opencode", "opencode", "home"));
    for (const name of Object.keys(OWNER_SECRETS).filter(name => !(name in openCodeKonteksSettings()))) expect(spec.env[name], name).toBeUndefined();
    for (const value of Object.values(OWNER_SECRETS)) expect(JSON.stringify(spec.env)).not.toContain(value);
    // Nothing outside the allow-list, the private home, our settings and fixed switches is present.
    const fixed = new Set([...OPENCODE_INHERITED_VARIABLES, ...Object.keys(openCodeKonteksSettings()), "HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "NO_COLOR", "TERM", "SHELL"]);
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

  it("prepares the private home before spawning, and fails closed on sign-in until CP3", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-prepare-")); roots.push(root);
    const runner = config({ RUNNER_CREDENTIAL_DIR: join(root, "credentials") });
    const paths = openCodeRuntimePaths(runner.RUNNER_CREDENTIAL_DIR);
    await mkdir(join(paths.controlConfig, "opencode"), { recursive: true });
    await writeFile(join(paths.controlConfig, "opencode", "AGENTS.md"), "stale");
    await openCodeRunnerAdapter.prepareToSpawn(runner);
    for (const folder of [paths.home, paths.data, paths.state, paths.cache, paths.controlConfig]) expect((await lstat(folder)).isDirectory()).toBe(true);
    // The control process (discovery, sign-in) never carries a working copy's instructions.
    await expect(lstat(join(paths.controlConfig, "opencode", "AGENTS.md"))).rejects.toThrow();
    await expect(openCodeRunnerAdapter.prepareToSpawn(config({ RUNNER_NATIVE_OPENCODE_BINARY: undefined }))).rejects.toMatchObject({ code: "agent_unavailable" });
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

describe("the Konteks OpenCode configuration", () => {
  it("renders the contract's locked configuration in OpenCode 2's own key names", () => {
    expect(renderOpenCodeKonteksConfig()).toEqual({
      $schema: "https://opencode.ai/config.json",
      permissions: [
        { action: "*", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "*.env", effect: "ask" },
        { action: "read", resource: "*.env.*", effect: "ask" },
        { action: "read", resource: "*.env.example", effect: "allow" },
        { action: "list", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "todowrite", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "deny" },
        { action: "browser.*", resource: "*", effect: "deny" },
      ],
      share: "disabled", update: "disable", snapshots: false, lsp: false, formatter: false, plugins: [],
      agents: { title: { disabled: true }, plan: { disabled: true } },
    });
    // A fresh copy each time: nobody can change the next process's configuration.
    (renderOpenCodeKonteksConfig().permissions as Array<{ effect: string }>)[0]!.effect = "allow";
    expect(OPENCODE_KONTEKS_PERMISSIONS[0]!.effect).toBe("ask");
    expect(openCodeKonteksSettings()).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify(renderOpenCodeKonteksConfig()), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_FILEWATCHER_DISABLE: "1",
    });
  });

  it("decides like OpenCode: the last matching rule wins, after OpenCode's own defaults", () => {
    const resolved = [{ action: "*", resource: "*", effect: "allow" as const }, { action: "read", resource: "*.env", effect: "ask" as const }, ...OPENCODE_KONTEKS_PERMISSIONS];
    expect(openCodePermissionDecision(resolved, "bash", "git push")).toBe("ask");
    expect(openCodePermissionDecision(resolved, "read", "src/app.ts")).toBe("allow");
    expect(openCodePermissionDecision(resolved, "read", "app/.env")).toBe("ask");
    expect(openCodePermissionDecision(resolved, "read", ".env.production")).toBe("ask");
    expect(openCodePermissionDecision(resolved, "read", ".env.example")).toBe("allow");
    expect(openCodePermissionDecision(resolved, "external_directory", "/etc/passwd")).toBe("deny");
    // Code Mode's built-in browser is removed from the catalogue; Konteks' own browser server is another namespace.
    expect(openCodePermissionDecision(resolved, "browser.navigate", "https://example.com")).toBe("deny");
    expect(openCodePermissionDecision(resolved, "konteks-browser.browser_click", "*")).toBe("ask");
    expect(openCodePermissionDecision([{ action: "read", resource: "a.(b)", effect: "deny" }], "read", "a.(b)")).toBe("deny");
    expect(openCodePermissionDecision([{ action: "read", resource: "a.(b)", effect: "deny" }], "read", "aX(b)")).toBeUndefined();
  });
});

describe("one OpenCode process per working copy", () => {
  async function workingCopy(agents: string | null) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-wc-"))); roots.push(root);
    const wc = join(root, "work");
    await mkdir(wc);
    if (agents !== null) await writeFile(join(wc, "AGENTS.md"), agents);
    return { root, wc, credentials: join(root, "credentials") };
  }

  it("spawns with a config folder keyed by the working copy whose AGENTS.md links to the working copy's, and nothing secret", async () => {
    for (const [name, value] of Object.entries(OWNER_SECRETS)) vi.stubEnv(name, value);
    const f = await workingCopy("Always answer in French.");
    const binding = await openCodeRunnerAdapter.bindWorkingCopy!(config({ RUNNER_CREDENTIAL_DIR: f.credentials }), findAgentBridge("opencode")!, f.wc);
    const folder = openCodeWorkingCopyConfig(f.credentials, f.wc);
    expect(folder).toBe(join(openCodeRuntimePaths(f.credentials).configs, openCodeWorkingCopyKey(f.wc)));
    expect(openCodeWorkingCopyKey(f.wc)).toMatch(/^[0-9a-f]{16}$/);
    expect(openCodeWorkingCopyKey(`${f.wc}/`)).toBe(openCodeWorkingCopyKey(f.wc));
    expect(binding.env).toMatchObject({ XDG_CONFIG_HOME: folder, HOME: openCodeRuntimePaths(f.credentials).home, OPENCODE_CONFIG_PROJECT_DISABLE: "1" });
    for (const value of Object.values(OWNER_SECRETS)) expect(JSON.stringify(binding.env)).not.toContain(value);
    const link = join(folder, "opencode", "AGENTS.md");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(join(f.wc, "AGENTS.md"));
    expect(await readFile(link, "utf8")).toBe("Always answer in French.");
    await binding.release();
    await expect(lstat(folder)).rejects.toThrow();
  });

  it("keeps the folder while another process of the same working copy runs, and never shares it across working copies", async () => {
    const f = await workingCopy("rules");
    const other = join(f.root, "other");
    await mkdir(other);
    const first = await bindOpenCodeWorkingCopy(f.credentials, f.wc);
    const second = await bindOpenCodeWorkingCopy(f.credentials, f.wc);
    const elsewhere = await bindOpenCodeWorkingCopy(f.credentials, other);
    expect(first.env.XDG_CONFIG_HOME).toBe(second.env.XDG_CONFIG_HOME);
    expect(elsewhere.env.XDG_CONFIG_HOME).not.toBe(first.env.XDG_CONFIG_HOME);
    // The other working copy has no AGENTS.md: no link at all.
    await expect(lstat(join(elsewhere.env.XDG_CONFIG_HOME!, "opencode", "AGENTS.md"))).rejects.toThrow();
    await first.release();
    await first.release();
    expect((await lstat(join(second.env.XDG_CONFIG_HOME!, "opencode", "AGENTS.md"))).isSymbolicLink()).toBe(true);
    await second.release();
    await expect(lstat(second.env.XDG_CONFIG_HOME!)).rejects.toThrow();
    await elsewhere.release();
  });

  it("never links an AGENTS.md that points outside the working copy", async () => {
    const f = await workingCopy(null);
    await writeFile(join(f.root, "secret.txt"), "private key");
    await symlink(join(f.root, "secret.txt"), join(f.wc, "AGENTS.md"));
    const config = join(f.root, "config");
    expect(await syncOpenCodeInstructions(config, f.wc)).toBe("none");
    await expect(lstat(join(config, "opencode", "AGENTS.md"))).rejects.toThrow();
    // A link inside the working copy is followed to its real file.
    await rm(join(f.wc, "AGENTS.md"));
    await mkdir(join(f.wc, "docs"));
    await writeFile(join(f.wc, "docs", "rules.md"), "inside");
    await symlink(join(f.wc, "docs", "rules.md"), join(f.wc, "AGENTS.md"));
    expect(await syncOpenCodeInstructions(config, f.wc)).toBe("link");
    expect(await readlink(join(config, "opencode", "AGENTS.md"))).toBe(join(f.wc, "docs", "rules.md"));
  });

  it("copies AGENTS.md where symlinks are not allowed (Windows) and refreshes the copy before each prompt", async () => {
    const f = await workingCopy("v1");
    const denied = vi.fn(async () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); });
    const binding = await bindOpenCodeWorkingCopy(f.credentials, f.wc, { symlink: denied as never });
    const copy = join(binding.env.XDG_CONFIG_HOME!, "opencode", "AGENTS.md");
    expect((await lstat(copy)).isSymbolicLink()).toBe(false);
    expect(await readFile(copy, "utf8")).toBe("v1");
    await writeFile(join(f.wc, "AGENTS.md"), "v2");
    await binding.beforePrompt();
    expect(await readFile(copy, "utf8")).toBe("v2");
    await rm(join(f.wc, "AGENTS.md"));
    await binding.beforePrompt();
    await expect(lstat(copy)).rejects.toThrow();
    await binding.release();
    // Anything else than a missing privilege is not papered over.
    const broken = vi.fn(async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    await writeFile(join(f.wc, "AGENTS.md"), "v3");
    await expect(bindOpenCodeWorkingCopy(f.credentials, f.wc, { symlink: broken as never })).rejects.toThrow(/disk full/);
  });

  it("refuses a relative working copy and another family's runner", async () => {
    await expect(bindOpenCodeWorkingCopy("/cred", "work")).rejects.toMatchObject({ code: "agent_unavailable" });
    await expect(openCodeRunnerAdapter.bindWorkingCopy!(config(), findAgentBridge("codex")!, "/wc")).rejects.toThrow(/OpenCode/);
  });
});
