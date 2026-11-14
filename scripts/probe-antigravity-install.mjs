#!/usr/bin/env node
// Installation and optional sandbox qualification, invoked by E2E in a fresh
// private directory. Uses the shipped downloader, verifier and start check.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { fetchNativeAntigravity, verifyNativeAntigravityRecord, checkAntigravityServer } from "@konteks/remote-supervisor";
import { RunnerConfigSchema, RunnerEventBus, antigravityRunnerAdapter, resolveBridgeSpawnSpec, spawnBridge } from "@konteks/remote-agent-runner";

const work = process.argv[2];
if (!work || !isAbsolute(work) || (await readdir(work)).length !== 0) {
  throw new Error("probe requires a fresh absolute private directory");
}
if (process.argv[3] !== undefined && process.argv[3] !== "--live") throw new Error("invalid probe mode");
const root = join(work, "runtime");
await mkdir(root, { mode: 0o700 });
const result = { platform: process.platform, architecture: process.arch, checks: [] };
try {
  const record = await fetchNativeAntigravity({ root, consent: true });
  result.checks.push("production-download");
  const installed = await verifyNativeAntigravityRecord(record, root);
  result.checks.push("production-integrity");
  result.version = installed.version;
  const config = RunnerConfigSchema.parse({
    RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: join(work, "credentials"),
    RUNNER_WORKSPACE_DIR: join(work, "workspace"), RUNNER_BRIDGE_PREFIX: installed.root,
    RUNNER_BRIDGE_VERSION: installed.version, RUNNER_NATIVE_ANTIGRAVITY_ROOT: installed.root,
  });
  await checkAntigravityServer({ config });
  result.checks.push("production-self-check");
  if (process.argv[3] === "--live") await liveTurn(config, process.argv[4], result);
  result.outcome = "passed";
} catch (error) {
  result.outcome = "failed";
  result.code = typeof error?.code === "string" ? error.code : "probe_failed";
  result.diagnostic = typeof error?.diagnostic === "string" ? error.diagnostic : null;
  result.requestErrorCode = typeof error?.code === "number" ? error.code : null;
  result.failure = antigravityRunnerAdapter.agentErrorText(`Agent execution error: ${String(error?.message ?? "")}`);
  if (String(error?.message ?? "").startsWith("live turn ")) result.probeError = error.message;
  process.exitCode = 1;
} finally {
  await rm(join(work, "credentials"), { recursive: true, force: true });
}
await writeFile(join(work, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(result));

async function liveTurn(config, envFile, result) {
  const env = parseEnv(await readFile(envFile, "utf8"));
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("sandbox key missing");
  await antigravityRunnerAdapter.prepareToSpawn(config);
  const events = new RunnerEventBus();
  const login = antigravityRunnerAdapter.startLogin({ config, events, request: { method: "gemini-api-key" } });
  login.input(key);
  const authenticated = await Promise.race([login.done, new Promise(resolve => setTimeout(() => resolve({ code: 1 }), 30_000).unref())]);
  if (authenticated.code !== 0) { await login.cancel(); throw new Error("sandbox key validation failed"); }
  result.checks.push("production-key-sign-in");
  let bridge;
  try {
    bridge = await spawnLiveBridge(config);
    await proveLiveSession(config, bridge, result);
  } finally {
    try { await bridge?.stop(); }
    finally {
      try { await antigravityRunnerAdapter.logout(config, { method: "gemini-api-key" }); }
      finally { await antigravityRunnerAdapter.sweepLeftovers(config); }
    }
  }
}

async function spawnLiveBridge(config) {
  await mkdir(config.RUNNER_WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  let reply = "";
  const bridge = await antigravityRunnerAdapter.wrapSpawn(config, spawnBridge)({
    spec: resolveBridgeSpawnSpec(config), initializeTimeoutMs: 60_000, clientVersion: config.RUNNER_BRIDGE_VERSION,
    handlers: { onSessionUpdate: params => {
      const update = params.update ?? params;
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") reply = (reply + update.content.text).slice(0, 4096);
    }, onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onCreateElicitation: async () => ({ action: "decline" }), onExit: () => undefined },
  });
  bridge.probeReply = () => reply;
  return bridge;
}

async function proveLiveSession(config, bridge, result) {
  const session = await bridge.connection.newSession({ cwd: config.RUNNER_WORKSPACE_DIR, mcpServers: [], _meta: antigravityRunnerAdapter.sessionMeta });
  antigravityRunnerAdapter.verifySession(session);
  const options = session.configOptions.find(option => option.id === "model").options.flatMap(option => option.options ?? [option]);
  result.offeredModels = options.map(option => option.value).filter(value => /^gemini-[a-z0-9._-]{1,100}$/.test(value)).slice(0, 64);
  const flash = options.filter(option => /flash/.test(option.value));
  flash.sort((a, b) => modelRank(a.value) - modelRank(b.value));
  if (!flash.length) throw new Error("no low-cost Flash model offered");
  result.model = flash[0].value;
  const configured = await bridge.connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: result.model });
  antigravityRunnerAdapter.verifySession(configured);
  result.checks.push("production-model-discovery");
  const response = await Promise.race([
    bridge.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Reply with exactly OK. Do not use tools or read any files." }] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("live turn timed out")), 60_000).unref()),
  ]);
  const reply = bridge.probeReply();
  result.turn = { stopReason: response.stopReason, replyCharacters: reply.length, replyMatches: reply.trim() === "OK", failure: antigravityRunnerAdapter.agentErrorText(reply) };
  if (response.stopReason !== "end_turn" || !result.turn.replyMatches) throw new Error("live turn did not answer correctly");
  result.checks.push("production-live-turn");
}

function modelRank(value) {
  if (/lite/.test(value)) return 0;
  return /low/.test(value) ? 1 : 2;
}
