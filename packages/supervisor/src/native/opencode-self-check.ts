import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { hostAgentFamily, hostInstallCommand } from "@konteks/remote-release";
import {
  OPENCODE_DISABLED_AGENTS, OPENCODE_KONTEKS_PERMISSIONS, openCodeKonteksSettings, openCodePermissionDecision, openCodeProcessEnvironment,
  openCodeRuntimePaths, type OpenCodePermissionRule, type OpenCodeRuntimePaths,
} from "@konteks/remote-agent-runner";

/**
 * Before OpenCode reads "ready", prove the locked Konteks configuration is in
 * force in the exact installation that will run: `opencode debug agents`
 * in the connector's private home, with the Konteks environment, lists every
 * agent's RESOLVED permission rules. OpenCode 2 is days old and moves fast; a
 * release that renames a key, reorders its defaults after ours or brings back
 * an agent we switch off must read "unsupported OpenCode installation", never
 * run ungoverned.
 *
 * `debug` goes through OpenCode's background service (`opencode serve
 * --service`), which keeps the environment it was first started with and, on
 * the default port, collides with the person's own service. So the check
 * pins a private loopback port and password in its own config folder, stops
 * any service of the private home before (so the one it uses is fresh, with
 * our environment) and after (so none is left running). Only services whose
 * environment names the private home are ever stopped: the person's own
 * OpenCode service is never touched.
 */

export type OpenCodeCommandRunner = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }) =>
  Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Finds and stops `opencode serve --service` processes of one private home (replaced only in tests). */
export interface OpenCodeServiceControl {
  /** Process ids of background services whose environment names this private home. */
  list(paths: OpenCodeRuntimePaths): Promise<number[]>;
  /** Stops them (SIGTERM, then SIGKILL); resolves when they are gone. */
  stop(pids: number[]): Promise<void>;
}

interface OpenCodeSelfCheckOptions {
  binary: string;
  version: string;
  /** The runner's credential directory; the private home is `<credentials>/opencode`. */
  credentialDir: string;
  run?: OpenCodeCommandRunner;
  services?: OpenCodeServiceControl;
  /** How long `debug agents` may take to show the configured agents (the service loads them after it starts). */
  deadlineMs?: number;
  /** How long an unchanged listing that is not in force is read before it counts as drift. */
  settledMs?: number;
  platform?: NodeJS.Platform;
  /** Passes remembered per (binary, version, file); replaced only in tests. */
  cache?: Map<string, true>;
}

const PASSED = new Map<string, true>();
const CHECK_FOLDER = "self-check";

export async function checkOpenCodeKonteksConfig(options: OpenCodeSelfCheckOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const cache = options.cache ?? PASSED;
  const file = await stat(options.binary);
  const key = [options.binary, options.version, file.ino, file.size, file.mtimeMs, JSON.stringify(openCodeKonteksSettings())].join("\u0000");
  if (cache.has(key)) return;
  const paths = openCodeRuntimePaths(options.credentialDir, platform);
  const configHome = join(paths.configs, CHECK_FOLDER);
  await prepareCheckHome(paths, configHome);
  const agents = await listAgentsPrivately(options, platform, paths, configHome);
  const drift = openCodeAgentsDrift(agents);
  if (drift.length > 0) {
    throw new RemoteInstanceError("prerequisite_missing",
      `Unsupported OpenCode installation: OpenCode ${options.version} does not keep the Konteks settings (${drift.slice(0, 4).join("; ")}${drift.length > 4 ? "; …" : ""}). Install a supported version with \`${hostInstallCommand(hostAgentFamily("opencode"), platform)}\`, then retry.`,
      { diagnostic: "opencode_unsupported_installation", recoveryActions: [{ kind: "install_backend", agentId: "opencode" }] });
  }
  if (cache.size >= 16) cache.delete(cache.keys().next().value as string);
  cache.set(key, true);
}

async function prepareCheckHome(paths: OpenCodeRuntimePaths, configHome: string): Promise<void> {
  for (const folder of [paths.home, paths.data, paths.state, paths.cache, join(configHome, "opencode")]) await mkdir(folder, { recursive: true, mode: 0o700 });
  // A private port and password: never the default port the person's own service holds.
  await writeSecretFile(join(configHome, "opencode", "service.json"),
    `${JSON.stringify({ hostname: "127.0.0.1", port: await freeLoopbackPort(), password: randomBytes(24).toString("base64url") }, null, 2)}\n`);
  await rm(join(configHome, "opencode", "AGENTS.md"), { force: true });
}

/** The resolved agent list, read with this check's private services stopped before and after. */
async function listAgentsPrivately(options: OpenCodeSelfCheckOptions, platform: NodeJS.Platform, paths: OpenCodeRuntimePaths, configHome: string): Promise<unknown> {
  const env = openCodeProcessEnvironment(options.credentialDir, configHome, undefined, platform);
  const run = options.run ?? runOpenCode;
  const services = options.services ?? (platform === "win32" ? NO_SERVICE_SCAN : processServiceControl(platform));
  const stopServices = async () => {
    await run(options.binary, ["service", "stop"], { env, cwd: paths.home, timeoutMs: 15_000 }).catch(() => undefined);
    const left = await services.list(paths);
    if (left.length > 0) await services.stop(left);
  };
  await stopServices();
  try {
    return await listAgents(run, options.binary, env, paths.home, options.deadlineMs ?? 20_000, options.settledMs ?? SETTLED_MS);
  } finally {
    await stopServices();
  }
}

/**
 * A freshly started service first lists no agents, then OpenCode's DEFAULT
 * agents (plan and title included, none of our rules) for about a second,
 * and only then the agents resolved with our configuration. So the listing is read until it is in force, or until it has
 * stayed the same for `SETTLED_MS` (a real drift), or until the deadline.
 */
const SETTLED_MS = 5_000;

async function listAgents(run: OpenCodeCommandRunner, binary: string, env: NodeJS.ProcessEnv, cwd: string, deadlineMs: number, settledMs: number): Promise<unknown> {
  const until = Date.now() + deadlineMs;
  let last: ListingSeen | null = null;
  for (;;) {
    const listing = await agentListing(run, binary, env, cwd, until);
    if (!listing.ok) return listing.stdout;
    const now = Date.now();
    const settled = listingSettled(listing.value, last, now, until, settledMs);
    if (settled.done) return listing.value;
    last = settled.last;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** One listing's text and when it was first seen unchanged. */
interface ListingSeen { text: string; since: number }

async function agentListing(run: OpenCodeCommandRunner, binary: string, env: NodeJS.ProcessEnv, cwd: string, until: number): Promise<{ ok: true; value: unknown } | { ok: false; stdout: string }> {
  const result = await run(binary, ["debug", "agents"], { env, cwd, timeoutMs: Math.max(1_000, Math.min(15_000, until - Date.now())) });
  if (result.code !== 0) {
    throw new RemoteInstanceError("agent_unavailable", "OpenCode could not check its settings on this computer. Try again in a moment.",
      { diagnostic: "opencode_self_check_failed", retryable: true });
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false, stdout: result.stdout };
  }
}

/** Whether to stop reading: the listing is in force, it stayed the same for `settledMs`, or the deadline passed. */
function listingSettled(parsed: unknown, last: ListingSeen | null, now: number, until: number, settledMs: number): { done: boolean; last: ListingSeen | null } {
  const loaded = !Array.isArray(parsed) || parsed.length > 0;
  if (loaded && openCodeAgentsDrift(parsed).length === 0) return { done: true, last };
  const seen = seenSince(last, JSON.stringify(parsed), now);
  return { done: now >= until || (loaded && now - seen.since >= settledMs), last: seen };
}

function seenSince(last: ListingSeen | null, text: string, now: number): ListingSeen {
  return last && last.text === text ? last : { text, since: now };
}

/** What each resolved agent must satisfy; plain lines naming what drifted, empty when in force. */
export function openCodeAgentsDrift(agents: unknown): string[] {
  if (!Array.isArray(agents)) return ["the agent list is not in the expected form"];
  const listed = agents as Array<{ id?: unknown; permissions?: unknown }>;
  const drift = listed.flatMap(agentDrift);
  if (!listed.some(agent => agent?.id === "build")) drift.push("the build agent is missing");
  return [...new Set(drift)];
}

function agentDrift(agent: { id?: unknown; permissions?: unknown }): string[] {
  const id = typeof agent?.id === "string" ? agent.id : null;
  if (id === null) return ["an agent has no id"];
  if (OPENCODE_DISABLED_AGENTS.includes(id)) return [`agent ${id} is not switched off`];
  const rules = readRules(agent.permissions);
  if (rules === null) return [`agent ${id}: permissions are not in the expected form`];
  return [...(konteksRulesLast(rules) ? [] : [`agent ${id}: the Konteks rules are not last`]), ...probeDrift(id, rules)];
}

function probeDrift(id: string, rules: readonly OpenCodePermissionRule[]): string[] {
  return PROBES.flatMap(([action, resource, expected, what]) => {
    const decision = openCodePermissionDecision(rules, action, resource);
    return decision === expected ? [] : [`agent ${id}: ${what} is ${decision ?? "unset"}, expected ${expected}`];
  });
}

/** Resolved decisions the Konteks configuration must produce for every agent. */
const PROBES: ReadonlyArray<readonly [string, string, OpenCodePermissionRule["effect"], string]> = [
  ["bash", "git push origin main", "ask", "a shell command"],
  ["edit", "src/index.ts", "ask", "an edit"],
  ["subagent", "general", "ask", "starting a subagent"],
  ["execute", "*", "ask", "a code block"],
  ["webfetch", "https://example.com", "ask", "a web fetch"],
  ["read", "src/index.ts", "allow", "reading a file"],
  ["read", ".env", "ask", "reading .env"],
  ["read", "config/.env.local", "ask", "reading .env.local"],
  ["external_directory", "/etc/passwd", "deny", "a folder outside the working copy"],
  ["browser", "*", "deny", "the built-in browser"],
  ["opencode_session_move", "*", "deny", "OpenCode's own Code Mode tools"],
];

/**
 * Whether the Konteks rules decide last: they are one unbroken block, and
 * nothing but `deny` rules follows it. OpenCode appends some rules of its own
 * after the configuration: since 2.0.21 (anomalyco/opencode#52309, "hide
 * browser tools unless a desktop is attached") every agent ends with
 * `browser * deny`. A deny after ours can only take something away, never
 * allow or ask what ours decide, so the guarantee holds; any `allow` or `ask`
 * after ours is drift, and the probes still pin every decision that matters.
 */
function konteksRulesLast(rules: readonly OpenCodePermissionRule[]): boolean {
  const size = OPENCODE_KONTEKS_PERMISSIONS.length;
  for (let end = rules.length; end >= size; end -= 1) {
    if (rules.slice(end - size, end).every((rule, index) => sameRule(rule, OPENCODE_KONTEKS_PERMISSIONS[index]!))) return true;
    if (rules[end - 1]!.effect !== "deny") return false;
  }
  return false;
}

function readRules(value: unknown): OpenCodePermissionRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: OpenCodePermissionRule[] = [];
  for (const rule of value as Array<Record<string, unknown>>) {
    if (typeof rule?.action !== "string" || typeof rule.resource !== "string" || !["allow", "ask", "deny"].includes(rule.effect as string)) return null;
    rules.push({ action: rule.action, resource: rule.resource, effect: rule.effect as OpenCodePermissionRule["effect"] });
  }
  return rules;
}

function sameRule(a: OpenCodePermissionRule, b: OpenCodePermissionRule): boolean {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address !== null && typeof address === "object" ? resolve(address.port) : reject(new Error("no loopback port"))));
    });
  });
}

const runOpenCode: OpenCodeCommandRunner = (binary, args, options) => new Promise(resolve => {
  execFile(binary, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

/** Windows: no process environment to read; the private registration's `service stop` is the only stop. */
const NO_SERVICE_SCAN: OpenCodeServiceControl = { list: async () => [], stop: async () => undefined };

/**
 * Background services of one private home, found by their environment: on
 * Linux `/proc/<pid>/environ`, on macOS `ps eww` (the environment follows the
 * command). A process counts only when its own `XDG_STATE_HOME` or `HOME` is
 * exactly the private home's, so the person's own service never matches.
 */
function processServiceControl(platform: NodeJS.Platform = process.platform): OpenCodeServiceControl {
  return {
    async list(paths) {
      const listing = await capture("ps", platform === "linux" ? ["-e", "-ww", "-o", "pid=,args="] : ["-axww", "-o", "pid=,command="]);
      const pids: number[] = [];
      for (const line of listing.split("\n")) {
        const pid = serviceProcessPid(line);
        if (pid === null) continue;
        const env = await processEnvironment(pid, platform);
        if (env !== null && ownsPrivateHome(env, paths)) pids.push(pid);
      }
      return pids;
    },
    async stop(pids) {
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        for (const pid of pids) { try { process.kill(pid, signal); } catch { /* already gone */ } }
        for (let wait = 0; wait < 50 && pids.some(alive); wait += 1) await new Promise(resolve => setTimeout(resolve, 100));
        if (!pids.some(alive)) return;
      }
      throw new RemoteInstanceError("agent_unavailable", "An OpenCode background service of this connector did not stop.", { diagnostic: "opencode_service_stop_failed", retryable: true });
    },
  };
}

/** The pid on a `ps` line of another process running OpenCode's `serve --service`; null for any other line. */
function serviceProcessPid(line: string): number | null {
  const match = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!match || !/\bserve --service\b/.test(match[2]!) || !/opencode/i.test(match[2]!)) return null;
  const pid = Number(match[1]);
  return pid === process.pid ? null : pid;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** `NAME=value` pairs (Linux) or the raw `ps eww` text (macOS) of one process. */
async function processEnvironment(pid: number, platform: NodeJS.Platform): Promise<string[] | string | null> {
  if (platform === "linux") {
    try { return (await readFile(`/proc/${pid}/environ`, "utf8")).split("\u0000"); } catch { return null; }
  }
  const text = await capture("ps", ["eww", "-o", "command=", "-p", String(pid)]).catch(() => "");
  return text.trim() === "" ? null : text.trim();
}

function ownsPrivateHome(env: string[] | string, paths: OpenCodeRuntimePaths): boolean {
  const wanted = [`XDG_STATE_HOME=${paths.state}`, `HOME=${paths.home}`];
  if (Array.isArray(env)) return env.some(entry => wanted.includes(entry));
  // `ps eww` separates entries by spaces; a path may contain spaces, so the
  // exact assignment must be followed by a space or the end.
  return wanted.some(assignment => env.includes(` ${assignment} `) || env.endsWith(` ${assignment}`));
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error && !stdout ? reject(error) : resolve(String(stdout))));
  });
}
