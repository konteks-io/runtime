import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerConfigSchema } from "../config.js";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import {
  isOpenCodeFreeModel, listOpenCodeCredentials, openCodeCredentialViews, openCodeIdentityMaterial, openCodeLogout, openCodePtyCommand,
  openCodeSiteLoginOptions, parseOpenCodeAuthList, parseOpenCodeIntegrations, splitTerminalOutput, startOpenCodeLogin, type OpenCodeStoredCredential,
} from "../auth/opencode-auth.js";
import { openCodeCommandContext, openCodeRunnerAdapter, openCodeRuntimePaths } from "../host/opencode.js";

const FAKE = new URL("./fixtures/fake-opencode.mjs", import.meta.url).pathname;
/** Credential variables the owner has set; none may reach OpenCode's `auth` or `api`. */
const OWNER_SECRETS = { GITHUB_TOKEN: "ghp_owner_token", GH_TOKEN: "gho_owner", OPENAI_API_KEY: "sk-owner-openai", DEEPSEEK_API_KEY: "sk-owner-deepseek", OPENCODE_API_KEY: "oc-owner", AWS_SECRET_ACCESS_KEY: "aws-owner" };
const KEY = "sk-cp3-fake-deepseek-key-0123456789";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opencode-login-")); roots.push(root);
  // A native-looking executable: a script whose interpreter is this Node, by absolute path.
  const binary = join(root, "bin", "opencode");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(binary, `#!${process.execPath}\nimport(${JSON.stringify(FAKE)});\n`, { mode: 0o755 });
  await chmod(binary, 0o755);
  for (const [name, value] of Object.entries(OWNER_SECRETS)) vi.stubEnv(name, value);
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "opencode", RUNNER_CREDENTIAL_DIR: join(root, "credentials"), RUNNER_WORKSPACE_DIR: join(root, "workspaces"),
    RUNNER_BRIDGE_PREFIX: join(root, "bin"), RUNNER_BRIDGE_VERSION: "2.0.18", RUNNER_NATIVE_OPENCODE_BINARY: binary,
  });
  await openCodeRunnerAdapter.prepareToSpawn(config);
  const paths = openCodeRuntimePaths(config.RUNNER_CREDENTIAL_DIR);
  const calls = async () => (await readFile(join(paths.data, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; env: Record<string, string>; tty: boolean });
  const store = async (): Promise<Array<{ integration: string; method: string }>> => existsSync(join(paths.data, "fake-opencode.json")) ? JSON.parse(await readFile(join(paths.data, "fake-opencode.json"), "utf8")) : [];
  return { root, binary, config, paths, calls, store, context: openCodeCommandContext(config) };
}

function record(events: RunnerEventBus) {
  const seen: Array<Extract<RunnerEvent, { kind: "login_event" }>["event"]> = [];
  events.subscribe(event => { if (event.kind === "login_event") seen.push(event.event); });
  const waitFor = (predicate: (event: (typeof seen)[number]) => boolean, ms = 10_000) => vi.waitFor(() => { expect(seen.some(predicate)).toBe(true); }, { timeout: ms, interval: 20 });
  return { seen, waitFor };
}

/** The shape OpenCode 2.0.18's `api integration.list` returned in the private home (trimmed). */
const INTEGRATION_LIST = JSON.stringify({ location: { directory: "/home" }, data: [
  { id: "302ai", name: "302.AI", methods: [{ type: "key" }, { type: "env", names: ["302AI_API_KEY"] }], connections: [] },
  { id: "opencode", name: "OpenCode Console", methods: [{ type: "key", label: "API key (service account)" }, { type: "env", names: ["OPENCODE_API_KEY"] },
    { id: "device", type: "oauth", label: "OpenCode Console account", form: [{ key: "server", hidden: true, type: "string", format: "uri", default: "https://opencode.ai/console" }] }], connections: [] },
  { id: "openai", name: "OpenAI", methods: [{ type: "key" }, { id: "chatgpt-browser", type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { id: "chatgpt-headless", type: "oauth", label: "ChatGPT Pro/Plus (headless)" }], connections: [] },
  { id: "github-copilot", name: "GitHub Copilot", methods: [{ type: "env", names: ["GITHUB_TOKEN"] }, { id: "device", type: "oauth", label: "Login with GitHub Copilot", form: [
    { key: "deploymentType", required: true, type: "string", options: [{ value: "github.com", label: "GitHub.com" }, { value: "enterprise", label: "GitHub Enterprise" }] },
    { key: "enterpriseUrl", required: true, when: [{ key: "deploymentType", op: "eq", value: "enterprise" }], type: "string" }] }], connections: [] },
  { id: "gitlab", name: "GitLab Duo", methods: [{ type: "key" }, { id: "pkce", type: "oauth", label: "Login with GitLab (OAuth)", form: [{ key: "instanceUrl", type: "string", default: "https://gitlab.com" }] }], connections: [] },
  { id: "snowflake-cortex", name: "Snowflake Cortex", methods: [{ type: "key", label: "Paste PAT", form: [{ key: "account", required: true, type: "string" }] }, { id: "browser", type: "oauth", label: "Login with Snowflake", form: [{ key: "account", required: true, type: "string" }] }], connections: [] },
  { id: "xai", name: "xAI", methods: [{ type: "key", label: "Manually enter API Key" }, { id: "device", type: "oauth", label: "SuperGrok Subscription" }], connections: [] },
  { id: "poe", name: "Poe", methods: [{ type: "key" }, { id: "browser", type: "oauth", label: "Login with Poe (browser)" }], connections: [] },
  { id: "Bad Id", name: "x", methods: [{ type: "key" }], connections: [] },
] });

describe("what the installed OpenCode can sign in to", () => {
  it("reads OpenCode's own integration list: methods it can drive, with the non-secret answers they need", () => {
    const integrations = parseOpenCodeIntegrations(INTEGRATION_LIST);
    expect(integrations.map(integration => integration.id)).toEqual(["302ai", "opencode", "openai", "github-copilot", "gitlab", "snowflake-cortex", "xai", "poe"]);
    const byId = Object.fromEntries(integrations.map(integration => [integration.id, integration]));
    expect(byId.opencode!.methods).toEqual([
      { id: "key", kind: "api_key", label: "API key (service account)", answers: [] },
      // A hidden field keeps OpenCode's own default.
      { id: "device", kind: "sign_in", label: "OpenCode Console account", answers: [] },
    ]);
    // A required choice takes its first (GitHub.com); a field asked only for another choice is skipped.
    expect(byId["github-copilot"]!.methods).toEqual([{ id: "device", kind: "sign_in", label: "Login with GitHub Copilot", answers: ["deploymentType=github.com"] }]);
    expect(byId.gitlab!.methods.find(method => method.id === "pkce")!.answers).toEqual(["instanceUrl=https://gitlab.com"]);
    // A required field with no default and no choices is left to the person's own OpenCode.
    expect(byId["snowflake-cortex"]!.methods).toEqual([]);
  });

  it("advertises only the reviewed site sign-ins this OpenCode offers", () => {
    const all = parseOpenCodeIntegrations(INTEGRATION_LIST);
    expect(openCodeSiteLoginOptions(all)).toEqual(["opencode-console", "chatgpt", "github-copilot", "supergrok", "gitlab", "poe"]);
    expect(openCodeSiteLoginOptions(all.filter(integration => integration.id !== "xai" && integration.id !== "poe"))).toEqual(["opencode-console", "chatgpt", "github-copilot", "gitlab"]);
  });
});

describe("what the private home is signed in to", () => {
  // A real sign-in, as `auth list --format json` printed it, plus a key and an environment credential.
  const AUTH_LIST = JSON.stringify([
    { id: "opencode", name: "OpenCode Console", connections: [{ type: "credential", id: "cred_0e79a18cd0018mhkAVqUItFMIk", label: "Personal", method: "oauth" }] },
    { id: "openai", name: "OpenAI", connections: [{ type: "credential", id: "cred_chatgpt", label: "Plus", method: "oauth" }, { type: "credential", id: "cred_openai_key", label: "OpenAI", method: "key" }] },
    { id: "opencode-go", name: "OpenCode Go", connections: [{ type: "credential", id: "cred_go", label: "OpenCode Go", method: "key" }] },
    { id: "DeepSeek", name: "DeepSeek", connections: [{ type: "credential", id: "cred_ds", label: "DeepSeek", method: "key" }] },
    { id: "github-copilot", name: "GitHub Copilot", connections: [{ type: "environment", name: "GITHUB_TOKEN" }] },
  ]);

  it("reports each credential with a plain label, how it signed in, and how its provider bills", () => {
    const stored = parseOpenCodeAuthList(AUTH_LIST);
    expect(stored.map(credential => credential.integrationId)).toEqual(["opencode", "openai", "openai", "opencode-go", "deepseek"]);
    const views = openCodeCredentialViews(stored);
    expect(views).toEqual([
      // The Console sign-in is Zen credit: pay-as-you-go, not a plan.
      { providerId: "opencode", label: "OpenCode Console account", kind: "sign_in", method: "device", billing: "pay_per_use", state: "ready" },
      { providerId: "openai", label: "ChatGPT Plus or Pro", kind: "sign_in", method: "chatgpt-headless", billing: "subscription", state: "ready" },
      { providerId: "openai", label: "OpenAI key", kind: "api_key", method: "key", billing: "pay_per_use", state: "ready" },
      // OpenCode Go is a plan behind a key.
      { providerId: "opencode-go", label: "OpenCode Go key", kind: "api_key", method: "key", billing: "subscription", state: "ready" },
      { providerId: "deepseek", label: "DeepSeek key", kind: "api_key", method: "key", billing: "pay_per_use", state: "ready" },
    ]);
    // Never an account name or credential id in what the site sees.
    expect(JSON.stringify(views)).not.toMatch(/Personal|Plus"|cred_/);
    expect(openCodeCredentialViews(stored, true).every(view => view.state === "needs_sign_in")).toBe(true);
  });

  it("fingerprints (provider, method, credential id), never a secret, and reads ready on free models only when switched on", () => {
    const stored: OpenCodeStoredCredential[] = [
      { integrationId: "openai", integrationName: "OpenAI", credentialId: "cred_b", method: "key" },
      { integrationId: "opencode", integrationName: "OpenCode Console", credentialId: "cred_a", method: "oauth" },
    ];
    expect(openCodeIdentityMaterial(stored, false)).toBe("opencode\nopenai\tkey\tcred_b\nopencode\toauth\tcred_a");
    expect(openCodeIdentityMaterial([...stored].reverse(), true)).toBe(openCodeIdentityMaterial(stored, false));
    expect(openCodeIdentityMaterial([], false)).toBeNull();
    expect(openCodeIdentityMaterial([], true)).toBe("opencode\nfree-models");
    expect(isOpenCodeFreeModel("opencode/muse-spark-1.3-contributor-free")).toBe(true);
    expect(isOpenCodeFreeModel("opencode/claude-sonnet-5")).toBe(false);
    expect(isOpenCodeFreeModel("openai/gpt-free")).toBe(false);
    expect(openCodeRunnerAdapter.offersModel!("opencode/space-bunny-free", { openCodeFreeModels: false, coreAcceptsRouteBilling: true })).toBe(false);
    expect(openCodeRunnerAdapter.offersModel!("opencode/space-bunny-free", { openCodeFreeModels: true, coreAcceptsRouteBilling: true })).toBe(true);
    expect(openCodeRunnerAdapter.offersModel!("anthropic/claude-sonnet-5", { openCodeFreeModels: false, coreAcceptsRouteBilling: false })).toBe(true);
  });

  it("identity and readiness run OpenCode's own `auth list` in the private home, with none of the owner's credential variables", async () => {
    const f = await fixture();
    const off = { openCodeFreeModels: false, coreAcceptsRouteBilling: true };
    await expect(openCodeRunnerAdapter.identity!(f.config, off)).resolves.toEqual({ kind: "logged_out", credentials: [] });
    const free = await openCodeRunnerAdapter.identity!(f.config, { ...off, openCodeFreeModels: true });
    expect(free).toMatchObject({ kind: "signal", credentials: [] });
    await writeFile(join(f.paths.data, "fake-opencode.json"), JSON.stringify([{ integration: "opencode", id: "cred_console", label: "Personal", method: "oauth" }]));
    const signedIn = await openCodeRunnerAdapter.identity!(f.config, off);
    expect(signedIn).toMatchObject({ kind: "signal", credentials: [{ providerId: "opencode", kind: "sign_in", billing: "pay_per_use", state: "ready" }] });
    expect(signedIn.kind === "signal" && free.kind === "signal" && signedIn.fingerprint !== free.fingerprint).toBe(true);
    // The same credential, read again, is the same identity.
    expect(await openCodeRunnerAdapter.identity!(f.config, { ...off, openCodeFreeModels: true })).toEqual(signedIn);
    const calls = await f.calls();
    expect(calls.map(call => call.args)).toEqual(Array(4).fill(["auth", "list", "--standalone", "--format", "json"]));
    // A runner whose private home does not exist yet creates it first (it is the commands' working folder).
    const fresh = RunnerConfigSchema.parse({ ...f.config, RUNNER_CREDENTIAL_DIR: join(f.root, "fresh-credentials") });
    await expect(openCodeRunnerAdapter.identity!(fresh, off)).resolves.toEqual({ kind: "logged_out", credentials: [] });
    for (const call of calls) {
      expect(call.env.HOME).toBe(f.paths.home);
      expect(call.env.XDG_DATA_HOME).toBe(f.paths.data);
      expect(call.env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1");
      for (const [name, value] of Object.entries(OWNER_SECRETS)) {
        expect(call.env[name], name).toBeUndefined();
        expect(JSON.stringify(call.env)).not.toContain(value);
      }
    }
  });
});

describe("signing OpenCode in", () => {
  it("relays a subscription's link and device code from OpenCode's own login, and names the option the site started", async () => {
    const f = await fixture();
    const events = new RunnerEventBus();
    const { seen } = record(events);
    const flow = startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, loginId: "login-site", request: { loginOption: "opencode-console" } });
    expect(await flow.done).toEqual({ code: 0 });
    expect(seen).toContainEqual({ type: "open_url", url: "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli", userCode: "ABCD-EFGH" });
    // The spinner's redraws arrive as one line each time the text changes, not a stream of frames.
    expect(seen.filter(event => event.type === "display" && /Waiting for authorization/.test(event.text))).toHaveLength(1);
    expect(seen.some(event => event.type === "prompt")).toBe(false);
    const login = (await f.calls()).find(call => call.args[1] === "login")!;
    expect(login.args).toEqual(["auth", "login", "opencode", "--method", "device", "--standalone"]);
    expect(login.env.HOME).toBe(f.paths.home);
    for (const name of Object.keys(OWNER_SECRETS)) expect(login.env[name], name).toBeUndefined();
    expect(await f.store()).toEqual([expect.objectContaining({ integration: "opencode", method: "oauth" })]);
  });

  it("passes a required choice as a non-secret answer (GitHub Copilot: github.com)", async () => {
    const f = await fixture();
    const flow = startOpenCodeLogin({ context: f.context, events: new RunnerEventBus(), stateDir: f.paths.root, request: { loginOption: "github-copilot" } });
    expect(await flow.done).toEqual({ code: 0 });
    expect((await f.calls()).find(call => call.args[1] === "login")!.args).toEqual(["auth", "login", "github-copilot", "--method", "device", "--answer", "deploymentType=github.com", "--standalone"]);
  });

  it("refuses a site sign-in this OpenCode does not offer, and reports a failed login", async () => {
    const f = await fixture();
    const events = new RunnerEventBus();
    const { seen } = record(events);
    expect(await startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, request: { loginOption: "supergrok" } }).done).toEqual({ code: 1 });
    expect(seen).toContainEqual({ type: "display", text: "This OpenCode does not offer SuperGrok sign-in." });
    // OpenCode's own login failed: the flow fails (the variable reaches the fake only because the test adds it past the allow-list).
    const failing = { ...f.context, env: { ...f.context.env, FAKE_OPENCODE_LOGIN_EXIT: "1" } };
    expect(await startOpenCodeLogin({ context: failing, events, stateDir: f.paths.root, request: { loginOption: "opencode-console" } }).done).toEqual({ code: 1 });
    expect(seen).toContainEqual({ type: "display", text: "OpenCode did not finish signing OpenCode Console in." });
  });

  it.runIf(process.platform !== "win32" && openCodePtyCommand(["x"]) !== null)("relays OpenCode's own key prompt as a hidden prompt: never an argument, an environment variable, an event or a log line", async () => {
    const f = await fixture();
    const events = new RunnerEventBus();
    const { seen, waitFor } = record(events);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const flow = startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, logger, request: { provider: "deepseek" } });
    await waitFor(event => event.type === "prompt");
    expect(seen.find(event => event.type === "prompt")).toEqual({ type: "prompt", label: "DeepSeek API key", secret: true });
    flow.input(KEY);
    expect(await flow.done).toEqual({ code: 0 });
    // OpenCode's own prompt received it, through the pseudo-terminal.
    expect(await readFile(join(f.paths.data, "received-key.txt"), "utf8")).toBe(KEY);
    const login = (await f.calls()).find(call => call.args[1] === "login")!;
    expect(login.tty).toBe(true);
    expect(login.args).toEqual(["auth", "login", "deepseek", "--method", "key", "--standalone"]);
    expect(JSON.stringify(login.args) + JSON.stringify(login.env)).not.toContain(KEY);
    // The fake echoed the key back; the relay dropped that line.
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(JSON.stringify(logger.info.mock.calls) + JSON.stringify(logger.warn.mock.calls)).not.toContain(KEY);
    expect(seen).toContainEqual({ type: "display", text: "Connected to DeepSeek" });
    expect(await f.store()).toEqual([expect.objectContaining({ integration: "deepseek", method: "key" })]);
    const views = openCodeCredentialViews(await listOpenCodeCredentials(f.context));
    expect(views).toEqual([{ providerId: "deepseek", label: "DeepSeek key", kind: "api_key", method: "key", billing: "pay_per_use", state: "ready" }]);
  });

  it("asks which provider (subscriptions first) in the open, then runs the chosen one", async () => {
    const f = await fixture();
    const events = new RunnerEventBus();
    const { seen, waitFor } = record(events);
    const flow = startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, personal: { exists: () => false, list: vi.fn() } });
    await waitFor(event => event.type === "prompt");
    expect(seen.find(event => event.type === "prompt")).toEqual({ type: "prompt", label: "Number or provider id", secret: false, visible: true });
    const menu = seen.find(event => event.type === "display")!;
    expect(menu.type === "display" && menu.text).toContain("1. OpenCode Console account\n  2. ChatGPT Plus or Pro\n  3. GitHub Copilot\n  4. Poe");
    flow.input("nope");
    await waitFor(event => event.type === "display" && event.text === 'OpenCode has no provider called "nope".');
    flow.input("2");
    expect(await flow.done).toEqual({ code: 0 });
    expect((await f.calls()).find(call => call.args[1] === "login")!.args).toEqual(["auth", "login", "openai", "--method", "chatgpt-headless", "--standalone"]);
  });

  it("asks which method when a provider has several and none was named", async () => {
    const f = await fixture();
    const events = new RunnerEventBus();
    const { waitFor, seen } = record(events);
    const flow = startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, request: { provider: "openai" } });
    await waitFor(event => event.type === "prompt");
    expect(seen.find(event => event.type === "display")).toEqual({ type: "display", text: "OpenAI can sign in these ways:\n  1. API key\n  2. ChatGPT Pro/Plus (browser)\n  3. ChatGPT Pro/Plus (headless)" });
    flow.input("3");
    expect(await flow.done).toEqual({ code: 0 });
    expect(await startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, request: { provider: "openai", method: "nope" } }).done).toEqual({ code: 1 });
    expect(await startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, request: { provider: "unknown-provider" } }).done).toEqual({ code: 1 });
  });

  it("offers once to repeat the person's own OpenCode sign-ins, reading them only through its `auth list` after a yes", async () => {
    const f = await fixture();
    const list = vi.fn(async () => [{ integrationId: "openai", integrationName: "OpenAI", credentialId: "c1", method: "oauth" }, { integrationId: "deepseek", integrationName: "DeepSeek", credentialId: "c2", method: "key" }]);
    const personal = { exists: () => true, list };
    const events = new RunnerEventBus();
    const { seen, waitFor } = record(events);
    const first = startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, personal });
    await waitFor(event => event.type === "prompt");
    expect(seen.find(event => event.type === "prompt")).toMatchObject({ secret: false, visible: true, label: expect.stringContaining("your own OpenCode") });
    expect(list).not.toHaveBeenCalled();
    first.input("yes");
    await waitFor(event => event.type === "display" && /signed in to: OpenAI \(sign-in\), DeepSeek \(key\)/.test(event.text));
    expect(list).toHaveBeenCalledTimes(1);
    // Their own providers come first in the menu.
    await waitFor(event => event.type === "display" && /1\. ChatGPT Plus or Pro \(your own OpenCode uses it\)/.test(event.text));
    await first.cancel();
    // Asked once: the next sign-in goes straight to the menu, unless --reuse asks again.
    const again = record(events);
    const second = startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, personal });
    await again.waitFor(event => event.type === "prompt");
    expect(again.seen.find(event => event.type === "prompt")).toMatchObject({ label: "Number or provider id" });
    await second.cancel();
    const declined = record(events);
    const third = startOpenCodeLogin({ context: f.context, events, stateDir: f.paths.root, personal, request: { reuse: true } });
    await declined.waitFor(event => event.type === "prompt");
    third.input("no");
    await declined.waitFor(event => event.type === "prompt" && event.label === "Number or provider id");
    expect(list).toHaveBeenCalledTimes(1);
    await third.cancel();
  });
});

describe("signing OpenCode out", () => {
  it("removes every credential of one provider, or all, through `auth logout <provider> <credential>`", async () => {
    const f = await fixture();
    await writeFile(join(f.paths.data, "fake-opencode.json"), JSON.stringify([
      { integration: "opencode", id: "cred_a", label: "Personal", method: "oauth" }, { integration: "opencode", id: "cred_b", label: "Personal", method: "oauth" },
      { integration: "deepseek", id: "cred_c", label: "DeepSeek", method: "key" },
    ]));
    expect(await openCodeLogout(f.context, "opencode")).toBe(2);
    expect((await f.store()).map(entry => entry.integration)).toEqual(["deepseek"]);
    await expect(openCodeLogout(f.context, "openai")).rejects.toMatchObject({ code: "prerequisite_missing" });
    await openCodeRunnerAdapter.logout!(f.config);
    expect(await f.store()).toEqual([]);
    const logouts = (await f.calls()).filter(call => call.args[1] === "logout").map(call => call.args);
    expect(logouts).toEqual([["auth", "logout", "opencode", "cred_a", "--standalone"], ["auth", "logout", "opencode", "cred_b", "--standalone"], ["auth", "logout", "deepseek", "cred_c", "--standalone"]]);
  });
});

describe("OpenCode's terminal output", () => {
  it("splits redraws into lines and wraps key entry in a pseudo-terminal that never carries the key", () => {
    expect(splitTerminalOutput("◒  Waiting\u001b[999D\u001b[J◐  Waiting.\u001b[999D\u001b[J\r\n●  Enter code: ABCD-EFGH\r\n")).toEqual(["◒  Waiting", "◐  Waiting.", "●  Enter code: ABCD-EFGH"]);
    const argv = ["/Users/p/.opencode/bin/opencode", "auth", "login", "deepseek", "--method", "key", "--standalone"];
    expect(openCodePtyCommand(argv, "darwin", path => path === "/usr/bin/script")).toEqual({ command: "/bin/sh", args: ["-c", 'cat | exec "$@"', "sh",
      "/usr/bin/script", "-q", "/dev/null", "/bin/sh", "-c", 'stty rows 40 cols 120 -echo 2>/dev/null; exec "$@"', "sh", ...argv] });
    expect(openCodePtyCommand(["/opt/o'c/opencode", "auth"], "linux", path => path === "/usr/bin/script")!.args.slice(3)).toEqual(
      ["/usr/bin/script", "-q", "-e", "-c", "stty rows 40 cols 120 -echo 2>/dev/null; exec '/opt/o'\\''c/opencode' 'auth'", "/dev/null"]);
    expect(openCodePtyCommand(argv, "win32")).toBeNull();
    expect(openCodePtyCommand(argv, "darwin", () => false)).toBeNull();
  });
});
