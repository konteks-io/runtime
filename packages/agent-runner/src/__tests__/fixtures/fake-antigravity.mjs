#!/usr/bin/env node
/* global process, setTimeout, fetch */
// A stand-in for Google's antigravity-acp server (tests only): ACP over stdio
// (newline-delimited JSON-RPC), the sign-in lines the real 1.2.1 server prints
// on stderr, and
// its files under GEMINI_HOME. It records what it was started with and asked
// for in `<private root>/fake-seen.jsonl`; `<private root>/fake.json` scripts it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const root = dirname(process.env.HOME ?? ".");
const control = existsSync(join(root, "fake.json")) ? JSON.parse(readFileSync(join(root, "fake.json"), "utf8")) : {};
const seen = join(root, "fake-seen.jsonl");
const note = value => appendFileSync(seen, `${JSON.stringify(value)}\n`);
const acp = join(process.env.GEMINI_HOME ?? join(root, "home", ".gemini"), "antigravity-acp");
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const log = line => process.stderr.write(`${line}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
note({ kind: "start", argv: process.argv.slice(2), env: process.env });

const DEFAULT_GOOGLE_LINK = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=fake.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A50695%2F&scope=openid&state=fake&access_type=offline&";

async function enterprise(id) {
  const settings = JSON.parse(readFileSync(join(acp, "settings.json"), "utf8"));
  note({ kind: "settings", settings });
  const { project = "none", location = "none" } = settings.gcp ?? {};
  log("I0929 00:23:53.873835 8325652864 credential_store.py:235] AGY_ACP_FORCE_FILE_STORAGE set; using file credential storage.");
  log("I0929 00:23:53.893421 6143586304 business_auth.py:257] Gemini Enterprise login will continue at http://127.0.0.1:50694/");
  log(`Open the following link to authenticate the ACP server: ${control.link ?? DEFAULT_GOOGLE_LINK}`);
  if (control.noLicence) log(`W0929 00:11:07.508528 6115536896 business_auth.py:462] Configured project=${project} location=${location} has no available license; falling through to the license picker (b/558693144).`);
  log("Open the following link to choose your Gemini Enterprise license: http://127.0.0.1:50694/");
  await sleep(20);
  if (control.outcome === "hang") return;
  if (control.outcome === "cancel") {
    send({ id, error: { code: -32000, message: "Gemini Enterprise license selection was cancelled: the browser tab was closed before a license was chosen. Sign in again to choose a license.", data: { reason: "ge_license_cancelled" } } });
    return;
  }
  await signedIn(id, project, location);
}

async function signedIn(id, project, location) {
  const resolved = { project: control.resolvedProject ?? project, location: control.resolvedLocation ?? location };
  mkdirSync(acp, { recursive: true });
  if (control.keepToken !== false) writeFileSync(join(acp, "acp_business_token.json"), JSON.stringify({ refresh_token: "fake-refresh" }), { mode: 0o600 });
  writeFileSync(join(acp, "settings.json"), JSON.stringify({ auth: { type: "oauth-business" }, gcp: resolved }));
  log(`I0929 00:24:32.723567 8325652864 server.py:2237] Gemini Enterprise sign-in resolved: project=${resolved.project} location=${resolved.location} user_tier=${control.tier ?? "gcp-ge-plus-tier"}`);
  await sleep(20);
  send({ id, result: {} });
}

async function apiKey(id, params) {
  const token = params?._meta?.["api-key"];
  note({ kind: "api-key", token });
  if (control.callRelay) {
    const base = process.env.GOOGLE_GEMINI_BASE_URL;
    const answer = await fetch(`${base}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": token }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    }).then(async response => ({ status: response.status, body: await response.text() }), error => ({ error: String(error) }));
    note({ kind: "relay-answer", ...answer });
  }
  send({ id, result: {} });
}

const handlers = {
  initialize: message => send({ id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { embeddedContext: true }, auth: control.noLogout ? {} : { logout: {} } },
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "oauth-business", name: "Log in with Gemini Enterprise" }, { id: "gemini-api-key", name: "Use Gemini API key" }, { id: "agent-platform", name: "Gemini Enterprise Agent Platform" }],
    agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.2.1" },
  } }),
  authenticate: message => {
    const method = message.params?.methodId;
    if (method === "oauth-business") void enterprise(message.id);
    else if (method === "gemini-api-key") void apiKey(message.id, message.params);
    else send({ id: message.id, error: { code: -32602, message: "unsupported method" } });
  },
  logout: message => {
    rmSync(join(acp, "acp_business_token.json"), { force: true });
    writeFileSync(join(acp, "settings.json"), JSON.stringify({}));
    send({ id: message.id, result: {} });
  },
};

createInterface({ input: process.stdin }).on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  note({ kind: "request", method: message.method, params: message.params });
  if (message.id === undefined) return;
  const handle = Object.hasOwn(handlers, message.method) ? handlers[message.method] : null;
  if (handle) handle(message);
  else send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
