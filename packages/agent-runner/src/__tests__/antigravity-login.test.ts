import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findAgentBridge } from "@konteks/remote-release";
import { spawnBridge, type BridgeProcess } from "../bridge/process.js";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import {
  antigravityActiveSignIn, antigravityCredentialViews, antigravityIdentity, antigravityKeyFile, antigravityLoginChoice, antigravityLogout,
  readAntigravityApiKey, startAntigravityLogin, writeAntigravityApiKey, type GoogleSignInProcess,
} from "../auth/antigravity-auth.js";
import {
  antigravityStderrFailure,
  antigravityProcessEnvironment, antigravityRunnerAdapter, antigravityRuntimePaths, antigravitySpawn, antigravityTokenFiles, prepareAntigravityHome, readAntigravitySignIn,
  setAntigravityRelayUpstreamForTests, writeAntigravitySignIn,
} from "../host/antigravity.js";
import { projectReadiness } from "../readiness.js";
import { INITIAL_SCOPE_STATE } from "../auth/scope-store.js";

/**
 * Google Antigravity's sign-ins (CP3) against a fake `antigravity-acp` that
 * speaks ACP on stdio, prints the real server's sign-in lines on stderr and
 * records what it was started with (`fixtures/fake-antigravity.mjs`): the
 * Gemini API key typed hidden and relayed (never the server's), Gemini
 * Enterprise's Google link relayed (never the loopback licence picker), the
 * project the server resolved read back, the no-licence reason, sign-out,
 * and what the connected agent then reports.
 */
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-antigravity.mjs");
const KEY = "AIzaSyOWNER-real-gemini-key-0123456789";
const PROJECT = "gemini-enterprise-qa-25d3";
const OWNER = { GITHUB_TOKEN: "ghp_owner_token_must_not_reach_antigravity", GEMINI_API_KEY: "gemini-owner-env-key", GOOGLE_CLOUD_PROJECT: "owner-project", AGY_ACP_ENABLE_OAUTH: "owner-enables-google-oauth" };
const CORE_7_1 = { coreAcceptsRouteBilling: true };

/** One line the fake server recorded. */
interface Seen { kind: string; method?: string; params?: unknown; env: Record<string, string>; settings?: unknown; token?: string; status?: number }

const roots: string[] = [];
const servers: Server[] = [];
const bridges: BridgeProcess[] = [];
afterEach(async () => {
  setAntigravityRelayUpstreamForTests(undefined);
  for (const bridge of bridges.splice(0)) await bridge.stop().catch(() => undefined);
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(fake: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-login-"))); roots.push(root);
  const credentialDir = join(root, "credentials");
  const paths = antigravityRuntimePaths(credentialDir);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.root, "fake.json"), JSON.stringify(fake));
  const env = antigravityProcessEnvironment(credentialDir, { inherited: { ...process.env, ...OWNER } });
  const signIn: GoogleSignInProcess = {
    spec: { family: findAgentBridge("antigravity")!, command: process.execPath, args: [FAKE], env, cwd: paths.home },
    spawn: spawnBridge, clientVersion: "test", initializeTimeoutMs: 15_000,
  };
  const events: RunnerEvent[] = [];
  const bus = new RunnerEventBus();
  bus.subscribe(event => events.push(event));
  const logged: unknown[] = [];
  const logger = { info: (...args: unknown[]) => { logged.push(args); }, warn: (...args: unknown[]) => { logged.push(args); } };
  const seen = async () => existsSync(join(paths.root, "fake-seen.jsonl"))
    ? (await readFile(join(paths.root, "fake-seen.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Seen) : [];
  const login = (options: Partial<Parameters<typeof startAntigravityLogin>[0]> = {}) => startAntigravityLogin({ credentialDir, events: bus, logger, process: signIn, ...options });
  const loginEvents = () => events.flatMap(event => (event.kind === "login_event" ? [event.event] : []));
  return { root, credentialDir, paths, signIn, events, loginEvents, logged, seen, login, bus, logger };
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fakeGoogle(): Promise<{ origin: string; seen: Array<{ url?: string; headers: IncomingHttpHeaders }> }> {
  const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 12_480, cachedContentTokenCount: 8_192, candidatesTokenCount: 412, thoughtsTokenCount: 1_536, totalTokenCount: 14_428 } })}\r\n\r\n`);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("a Gemini API key (A7)", () => {
  it("is asked hidden, checked with Google, kept 0600 outside the agent's home, and never in an event or a log line", async () => {
    const t = await setup();
    const flow = t.login({ request: { method: "gemini-api-key" }, verifyKey: async key => (key === KEY ? "valid" : "rejected") });
    expect(t.loginEvents()).toContainEqual({ type: "prompt", label: "Gemini API key", secret: true });
    flow.input("short");
    flow.input("AIzaSyWRONG-key-000000000000000000000");
    await until(() => t.loginEvents().filter(event => event.type === "prompt").length === 3);
    flow.input(KEY);
    await expect(flow.done).resolves.toEqual({ code: 0 });
    expect(await readAntigravityApiKey(t.credentialDir)).toBe(KEY);
    const file = antigravityKeyFile(t.credentialDir);
    expect(file.startsWith(t.paths.relay)).toBe(true);
    expect(file.startsWith(t.paths.home)).toBe(false);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readAntigravitySignIn(t.credentialDir)).toEqual({ method: "gemini-api-key" });
    expect(JSON.stringify(t.events)).not.toContain(KEY);
    expect(JSON.stringify(t.logged)).not.toContain(KEY);
  });

  it("reaches the server only as a loopback relay and a per-process token; the relay puts the real key on Google's request and counts the turn", async () => {
    const t = await setup({ callRelay: true });
    const google = await fakeGoogle();
    setAntigravityRelayUpstreamForTests({ origin: google.origin });
    await writeAntigravityApiKey(t.credentialDir, KEY);
    await writeAntigravitySignIn(t.credentialDir, { method: "gemini-api-key" });
    await prepareAntigravityHome(t.credentialDir);
    const wrapped = antigravitySpawn(t.credentialDir, spawnBridge);
    const bridge = await wrapped({ spec: t.signIn.spec, initializeTimeoutMs: 15_000, clientVersion: "test",
      handlers: { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }), onCreateElicitation: async () => ({ action: "decline" }) as never, onExit: () => undefined } });
    bridges.push(bridge);
    const seen = await t.seen();
    const started = seen.find(entry => entry.kind === "start")!;
    const env = started.env;
    expect(env.GOOGLE_GEMINI_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    for (const secret of [KEY, ...Object.values(OWNER)]) expect(JSON.stringify(started), secret).not.toContain(secret);
    for (const name of ["GEMINI_API_KEY", "GITHUB_TOKEN", "GOOGLE_CLOUD_PROJECT", "AGY_ACP_ENABLE_OAUTH"]) expect(env[name]).toBeUndefined();
    const token = seen.find(entry => entry.kind === "api-key")!.token as string;
    expect(token).toBeTruthy();
    expect(token).not.toBe(KEY);
    expect(seen.find(entry => entry.kind === "relay-answer")).toMatchObject({ status: 200 });
    expect(google.seen[0]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(google.seen[0]!.url).toBe("/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");

    // A turn: the tokens Google reports between its start and its end, priced at the list price.
    const read = antigravityRunnerAdapter.measureTurn!(bridge)!;
    await new Promise<void>((resolve, reject) => {
      const req = request(`${env.GOOGLE_GEMINI_BASE_URL}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`, { method: "POST", headers: { "x-goog-api-key": token } }, res => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.end("{}");
    });
    expect(read()).toMatchObject({ provider: "google", model: "gemini-3.8-flash", totalTokens: 14_428, estimate: { amountMicros: 11_135 } });
    expect(antigravityRunnerAdapter.measureTurn!({} as BridgeProcess)).toBeNull();

    // The relay goes with its process.
    await bridge.stop();
    await until(async () => {
      try { await fetch(`${env.GOOGLE_GEMINI_BASE_URL}/v1beta/models`, { headers: { "x-goog-api-key": token } }); return false; } catch { return true; }
    });
  });

  it("spawns Gemini Enterprise and a signed-out home as before, with no relay", async () => {
    const t = await setup();
    await writeAntigravitySignIn(t.credentialDir, { method: "oauth-business", gcp: { project: PROJECT, location: "global" } });
    await writeAntigravityApiKey(t.credentialDir, KEY);
    let spawned: unknown;
    const wrapped = antigravitySpawn(t.credentialDir, async options => { spawned = options; return {} as BridgeProcess; });
    await wrapped({ spec: t.signIn.spec } as never);
    expect((spawned as { spec: unknown }).spec).toBe(t.signIn.spec);
  });
});

describe("Gemini Enterprise (machine-browser sign-in over ACP)", () => {
  it("asks the choice, project and location in the open, relays only Google's own link, and keeps the project the server resolved", async () => {
    const t = await setup({ resolvedLocation: "us" });
    const flow = t.login();
    expect(t.loginEvents()[0]).toMatchObject({ type: "prompt", secret: false, visible: true, label: expect.stringContaining("1 a Gemini API key, 2 Gemini Enterprise") });
    flow.input("2");
    await until(() => t.loginEvents().at(-1)?.type === "prompt" && (t.loginEvents().at(-1) as { label: string }).label.startsWith("Google Cloud project ID"));
    expect(t.loginEvents().at(-1)).toMatchObject({ type: "prompt", visible: true, label: "Google Cloud project ID" });
    flow.input("Not_A_Project");
    flow.input(PROJECT);
    expect(t.loginEvents().at(-1)).toMatchObject({ type: "prompt", visible: true, label: "Location: global, us, eu [global]" });
    flow.input("");
    await expect(flow.done).resolves.toEqual({ code: 0 });
    const events = t.loginEvents();
    const links = events.filter(event => event.type === "open_url");
    expect(links).toHaveLength(1);
    expect((links[0] as { url: string }).url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    // The licence picker on loopback finishes on this machine: never a link.
    expect(JSON.stringify(events)).not.toContain("127.0.0.1:50694");
    expect(events).toContainEqual({ type: "display", text: expect.stringContaining("Terminal auto-execution to Require review") });
    expect(events.at(-1)).toEqual({ type: "display", text: "Signed in to Gemini Enterprise Plus." });
    // The server read our settings, then rewrote the location after its picker; the connector kept the server's.
    const seen = await t.seen();
    expect(seen.find(entry => entry.kind === "settings")!.settings).toEqual({ auth: { type: "oauth-business" }, gcp: { project: PROJECT, location: "global" } });
    expect(seen.find(entry => entry.kind === "request" && entry.method === "authenticate")!.params).toEqual({ methodId: "oauth-business" });
    const started = seen.find(entry => entry.kind === "start")!;
    for (const secret of Object.values(OWNER)) expect(JSON.stringify(started)).not.toContain(secret);
    expect(started.env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    expect(await readAntigravitySignIn(t.credentialDir)).toEqual({ method: "oauth-business", gcp: { project: PROJECT, location: "us" }, tier: "gcp-ge-plus-tier" });
    // The file store: the token is a file in the private home, which the connector never reads.
    expect(existsSync(antigravityTokenFiles(t.credentialDir).business)).toBe(true);
    const identity = await antigravityIdentity(t.credentialDir, CORE_7_1);
    expect(identity).toMatchObject({ kind: "signal", tokenUsageObservable: false,
      credentials: [{ providerId: "google", label: "Gemini Enterprise Plus", kind: "sign_in", method: "oauth-business", billing: "subscription", state: "ready" }] });
    expect(identity).not.toHaveProperty("providerAdminBlocked");
    // A session that saw the organisation drop the Konteks servers: signed in,
    // but held back until MCP Servers is on (WS1-196).
    antigravityStderrFailure("I0929 server.py:2900] Admin MCP control active: dropping 2 client-requested custom MCP server(s) for this session.", t.credentialDir);
    expect(await antigravityIdentity(t.credentialDir, CORE_7_1)).toMatchObject({ kind: "signal", providerAdminBlocked: true });
  });

  it("started from the site with the project and location, asks nothing on this machine", async () => {
    const t = await setup();
    const flow = t.login({ request: { loginOption: "gemini-enterprise", gcp: { project: PROJECT, location: "global" } } });
    await expect(flow.done).resolves.toEqual({ code: 0 });
    expect(t.loginEvents().filter(event => event.type === "prompt")).toEqual([]);
    expect(t.loginEvents().filter(event => event.type === "open_url")).toHaveLength(1);
  });

  it("with no licence for the project: fails with reason no_license, keeps the key in use, and the Enterprise credential says why", async () => {
    const t = await setup({ noLicence: true, outcome: "cancel" });
    await writeAntigravityApiKey(t.credentialDir, KEY);
    await writeAntigravitySignIn(t.credentialDir, { method: "gemini-api-key" });
    const flow = t.login({ request: { method: "oauth-business", gcp: { project: PROJECT, location: "global" } } });
    await expect(flow.done).resolves.toEqual({ code: 1, reason: "no_license" });
    expect(t.loginEvents()).toContainEqual({ type: "display", text: expect.stringContaining(`gcloud services enable businessaicode.googleapis.com --project ${PROJECT}`) });
    expect(await readAntigravitySignIn(t.credentialDir)).toEqual({ method: "gemini-api-key", gcp: { project: PROJECT, location: "global" }, licence: "none" });
    const identity = await antigravityIdentity(t.credentialDir, CORE_7_1);
    expect(identity).toMatchObject({ kind: "signal", tokenUsageObservable: true, credentials: [
      { label: "Gemini API key", kind: "api_key", method: "gemini-api-key", billing: "pay_per_use", state: "ready" },
      { label: "Gemini Enterprise", kind: "sign_in", method: "oauth-business", state: "needs_sign_in", reason: "no_license" },
    ] });
    // An older Core refuses a reason it does not know: none is sent.
    const older = await antigravityIdentity(t.credentialDir, { coreAcceptsRouteBilling: false });
    expect(older.credentials[1]).not.toHaveProperty("reason");
  });

  it("gives up after Google's own time, relays no link that is not Google's, and needs the token file the server keeps", async () => {
    const hang = await setup({ outcome: "hang", link: "https://accounts.google.com.evil.example/o/oauth2/v2/auth?x=1" });
    const waiting = hang.login({ request: { method: "oauth-business", gcp: { project: PROJECT, location: "global" } }, signInTimeoutMs: 400 });
    await expect(waiting.done).resolves.toEqual({ code: 1 });
    expect(hang.loginEvents().filter(event => event.type === "open_url")).toEqual([]);
    expect(await readAntigravitySignIn(hang.credentialDir)).toBeNull();

    const noToken = await setup({ keepToken: false });
    const flow = noToken.login({ request: { method: "oauth-business", gcp: { project: PROJECT, location: "global" } } });
    await expect(flow.done).resolves.toEqual({ code: 1 });
    expect(noToken.loginEvents()).toContainEqual({ type: "display", text: expect.stringContaining("did not keep its sign-in in the connector's private folder") });
    expect(await readAntigravitySignIn(noToken.credentialDir)).toBeNull();
  });

  it("is cancelled by the person, which stops the server", async () => {
    const t = await setup({ outcome: "hang" });
    const flow = t.login({ request: { method: "oauth-business", gcp: { project: PROJECT, location: "global" } } });
    await until(() => t.loginEvents().some(event => event.type === "open_url"));
    await flow.cancel();
    await expect(flow.done).resolves.toEqual({ code: 1 });
  });
});

describe("which sign-in, and personal Google sign-in held back (A10)", () => {
  it("reads the request, refuses another agent's option, and never starts a personal Google sign-in while the switch is off", () => {
    expect(antigravityLoginChoice(undefined)).toBeNull();
    expect(antigravityLoginChoice({ method: "gemini-api-key" })).toBe("key");
    expect(antigravityLoginChoice({ method: "oauth-business" })).toBe("enterprise");
    expect(antigravityLoginChoice({ gcp: { project: PROJECT, location: "eu" } })).toBe("enterprise");
    expect(antigravityLoginChoice({ loginOption: "gemini-enterprise" })).toBe("enterprise");
    expect(() => antigravityLoginChoice({ loginOption: "google-account" })).toThrow(/personal Google account is not available/);
    expect(() => antigravityLoginChoice({ method: "oauth-personal" })).toThrow(/personal Google account is not available/);
    expect(() => antigravityLoginChoice({ loginOption: "opencode-console" })).toThrow(/not one of Google Antigravity's/);
    expect(() => antigravityLoginChoice({ method: "agent-platform" })).toThrow(/Gemini API key or Gemini Enterprise/);
    expect(antigravityLoginChoice({ loginOption: "google-account" }, true)).toBe("personal");
  });
});

describe("signing out (auth logout antigravity)", () => {
  it("signs Gemini Enterprise out over ACP and removes its token, keeps the project, and forgets the key", async () => {
    const t = await setup();
    const flow = t.login({ request: { method: "oauth-business", gcp: { project: PROJECT, location: "global" } } });
    await expect(flow.done).resolves.toEqual({ code: 0 });
    await writeAntigravityApiKey(t.credentialDir, KEY);
    await antigravityLogout({ credentialDir: t.credentialDir, process: t.signIn, request: { method: "oauth-business" } });
    expect((await t.seen()).some(entry => entry.kind === "request" && entry.method === "logout")).toBe(true);
    expect(existsSync(antigravityTokenFiles(t.credentialDir).business)).toBe(false);
    expect(await readAntigravitySignIn(t.credentialDir)).toEqual({ method: "gemini-api-key", gcp: { project: PROJECT, location: "global" } });
    await expect(antigravityLogout({ credentialDir: t.credentialDir, process: t.signIn, request: { method: "oauth-business" } })).rejects.toMatchObject({ code: "prerequisite_missing" });
    await antigravityLogout({ credentialDir: t.credentialDir, process: t.signIn });
    expect(await readAntigravityApiKey(t.credentialDir)).toBeNull();
    expect(await readAntigravitySignIn(t.credentialDir)).toEqual({ method: "none", gcp: { project: PROJECT, location: "global" } });
    await expect(antigravityLogout({ credentialDir: t.credentialDir, process: t.signIn, request: { method: "gemini-api-key" } })).rejects.toMatchObject({ code: "prerequisite_missing" });
    expect(await antigravityIdentity(t.credentialDir, CORE_7_1)).toEqual({ kind: "logged_out", credentials: [] });
  });

  it("removes the token even when the server offers no ACP logout", async () => {
    const t = await setup({ noLogout: true });
    await expect(t.login({ request: { method: "oauth-business", gcp: { project: PROJECT, location: "global" } } }).done).resolves.toEqual({ code: 0 });
    await antigravityLogout({ credentialDir: t.credentialDir, process: t.signIn });
    expect((await t.seen()).some(entry => entry.kind === "request" && entry.method === "logout")).toBe(false);
    expect(existsSync(antigravityTokenFiles(t.credentialDir).business)).toBe(false);
  });
});

describe("credentials and readiness per mix (CP3 prep)", () => {
  const gcp = { project: PROJECT, location: "global" as const };
  it("lists what is held, the one in use first, billed by how Google bills it", () => {
    expect(antigravityCredentialViews({ record: null, key: false, enterpriseToken: false }, CORE_7_1)).toEqual([]);
    expect(antigravityCredentialViews({ record: { method: "gemini-api-key" }, key: true, enterpriseToken: false }, CORE_7_1))
      .toEqual([{ providerId: "google", label: "Gemini API key", kind: "api_key", method: "gemini-api-key", billing: "pay_per_use", state: "ready" }]);
    const both = antigravityCredentialViews({ record: { method: "oauth-business", gcp, tier: "gcp-ge-plus-tier" }, key: true, enterpriseToken: true }, CORE_7_1);
    expect(both.map(view => [view.label, view.state, view.billing])).toEqual([["Gemini Enterprise Plus", "ready", "subscription"], ["Gemini API key", "ready", "pay_per_use"]]);
    const keyFirst = antigravityCredentialViews({ record: { method: "gemini-api-key", gcp, tier: "gcp-ge-plus-tier" }, key: true, enterpriseToken: true }, CORE_7_1);
    expect(keyFirst.map(view => view.method)).toEqual(["gemini-api-key", "oauth-business"]);
    const payg = antigravityCredentialViews({ record: { method: "oauth-business", gcp, tier: "gcp-ge-payg-tier" }, key: false, enterpriseToken: true }, CORE_7_1);
    expect(payg).toEqual([expect.objectContaining({ label: "Gemini Enterprise Pay-as-you-go", billing: "pay_per_use", state: "ready" })]);
    const lost = antigravityCredentialViews({ record: { method: "oauth-business", gcp }, key: false, enterpriseToken: false }, CORE_7_1);
    expect(lost).toEqual([expect.objectContaining({ label: "Gemini Enterprise", state: "needs_sign_in" })]);
    expect(lost[0]).not.toHaveProperty("reason");
  });

  it("is ready only when the sign-in in use is; otherwise not configured with login_locally", () => {
    expect(antigravityActiveSignIn({ record: { method: "gemini-api-key" }, key: false, enterpriseToken: true })).toBeNull();
    expect(antigravityActiveSignIn({ record: { method: "oauth-business", gcp, licence: "none" }, key: true, enterpriseToken: true })).toBeNull();
    expect(antigravityActiveSignIn({ record: { method: "oauth-business", gcp }, key: false, enterpriseToken: true })).toBe("oauth-business");
    expect(antigravityActiveSignIn({ record: { method: "oauth-personal" }, key: true, enterpriseToken: true })).toBeNull();
    const view = projectReadiness({
      family: findAgentBridge("antigravity")!, authMode: "agent_local_subscription", connectionState: "ready", initializeResult: null, scope: INITIAL_SCOPE_STATE,
      identity: "logged_out", credentials: antigravityCredentialViews({ record: { method: "oauth-business", gcp, licence: "none" }, key: false, enterpriseToken: false }, CORE_7_1),
      bridgeVersionCompatible: true, lastProbeAt: null,
    });
    expect(view).toMatchObject({ readiness: "not_configured", recoveryAction: "login_locally", credentials: [{ state: "needs_sign_in", reason: "no_license" }] });
    const keyed = projectReadiness({
      family: findAgentBridge("antigravity")!, authMode: "agent_local_subscription", connectionState: "ready", initializeResult: null, scope: INITIAL_SCOPE_STATE,
      identity: "signal", tokenUsageObservable: true, bridgeVersionCompatible: true, lastProbeAt: null,
    });
    expect(keyed).toMatchObject({ readiness: "ready", tokenUsageObservable: true });
  });
});
