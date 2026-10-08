import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_KONTEKS_PERMISSIONS, openCodeRuntimePaths, type RunnerConfig } from "@konteks/remote-agent-runner";
import { checkOpenCodeKonteksConfig, openCodeAgentsDrift, type OpenCodeCommandRunner, type OpenCodeServiceControl } from "../native/opencode-self-check.js";
import { openCodeInstallAdapter } from "../native/host-agents.js";

/** `opencode debug agents` from OpenCode 2.0.18 with the Konteks configuration (live; home paths shortened). */
const CAPTURED = readFileSync(new URL("./fixtures/opencode-2.0.18-debug-agents.json", import.meta.url), "utf8");
/** The same from OpenCode 2.0.21 (live; extra fields and system prompts dropped): every agent now ends with OpenCode's own `browser * deny`. */
const CAPTURED_2_0_21 = readFileSync(new URL("./fixtures/opencode-2.0.21-debug-agents.json", import.meta.url), "utf8");
type Agent = { id: string; permissions: Array<{ action: string; resource: string; effect: string }> };
/** Expected rule effects for this candidate, projected from preserved historical schema captures.
 * These are fixture inputs, not fresh output from either installed provider. */
function expectedFileApprovalListing(capture: string): string {
  const list = JSON.parse(capture) as Agent[];
  for (const agent of list) {
    const start = agent.permissions.findIndex(rule => rule.action === "*" && rule.resource === "*" && rule.effect === "ask");
    if (start < 0) throw new Error("historical Konteks rule block missing");
    for (const rule of agent.permissions.slice(start)) {
      if (["read", "list", "glob", "grep"].includes(rule.action) && rule.effect === "allow") rule.effect = "ask";
    }
  }
  return JSON.stringify(list);
}
const EXPECTED = expectedFileApprovalListing(CAPTURED);
const EXPECTED_2_0_21 = expectedFileApprovalListing(CAPTURED_2_0_21);
const agents = (): Agent[] => JSON.parse(EXPECTED) as Agent[];

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(outputs: string[]) {
  const root = await mkdtemp(join(tmpdir(), "opencode-self-check-")); roots.push(root);
  const binary = join(root, "opencode");
  await writeFile(binary, "binary");
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const events: string[] = [];
  const run = vi.fn<OpenCodeCommandRunner>(async (_binary, args, options) => {
    calls.push({ args, env: options.env, cwd: options.cwd });
    events.push(args.join(" "));
    if (args[0] === "service") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: outputs.length > 1 ? outputs.shift()! : outputs[0]!, stderr: "" };
  });
  const leftovers = [4242];
  const services: OpenCodeServiceControl = {
    list: vi.fn(async () => { events.push("scan"); return [...leftovers]; }),
    stop: vi.fn(async (pids: number[]) => { events.push(`kill ${pids.join(",")}`); leftovers.length = 0; }),
  };
  const credentialDir = join(root, "credentials");
  const check = (cache = new Map<string, true>()) => checkOpenCodeKonteksConfig({ binary, version: "2.0.18", credentialDir, run, services, cache, deadlineMs: 3_000, settledMs: 400 });
  return { root, binary, credentialDir, run, calls, events, services, check, paths: openCodeRuntimePaths(credentialDir) };
}

describe("the OpenCode start self-check", () => {
  it("accepts the expected configured 2.0.18 listing in the private home and leaves no service running", async () => {
    const f = await fixture([EXPECTED]);
    await expect(f.check()).resolves.toBeUndefined();
    const debug = f.calls.find(call => call.args[0] === "debug")!;
    expect(debug.args).toEqual(["debug", "agents"]);
    expect(debug.env).toMatchObject({ HOME: f.paths.home, XDG_DATA_HOME: f.paths.data, XDG_STATE_HOME: f.paths.state, XDG_CONFIG_HOME: join(f.paths.configs, "self-check"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_FILEWATCHER_DISABLE: "1" });
    expect(JSON.parse(debug.env.OPENCODE_CONFIG_CONTENT!).permissions).toEqual(OPENCODE_KONTEKS_PERMISSIONS);
    for (const name of Object.keys(debug.env)) expect(name).not.toMatch(/TOKEN|API_KEY|SECRET/);
    // Its service runs on a private port with a password, never the default one the person's own service holds.
    const service = JSON.parse(await readFile(join(f.paths.configs, "self-check", "opencode", "service.json"), "utf8"));
    expect(service).toMatchObject({ hostname: "127.0.0.1", port: expect.any(Number), password: expect.stringMatching(/.{24,}/) });
    expect(service.port).not.toBe(49374);
    // Any service of the private home is stopped before (a fresh one gets our environment) and after.
    expect(f.events).toEqual(["service stop", "scan", "kill 4242", "debug agents", "service stop", "scan"]);
  });

  it("waits while the freshly started service lists no agents, then OpenCode's defaults, before our configuration applies", async () => {
    // The live 2.0.18 timeline: [] at 0.3 s, defaults (plan and title, none of our rules) until 1.5 s, then ours.
    const defaults = agents().map(agent => ({ ...agent, permissions: agent.permissions.slice(0, -OPENCODE_KONTEKS_PERMISSIONS.length) }));
    defaults.push({ id: "plan", permissions: [] }, { id: "title", permissions: [] });
    const f = await fixture(["[]\n", JSON.stringify(defaults), JSON.stringify(defaults), EXPECTED]);
    await f.check();
    expect(f.calls.filter(call => call.args[0] === "debug")).toHaveLength(4);
  });

  it("remembers a pass per binary, version and file, and checks again when the file changes", async () => {
    const f = await fixture([EXPECTED]);
    const cache = new Map<string, true>();
    await f.check(cache);
    await f.check(cache);
    expect(f.calls.filter(call => call.args[0] === "debug")).toHaveLength(1);
    await utimes(f.binary, new Date(), new Date(Date.now() + 60_000));
    await f.check(cache);
    expect(f.calls.filter(call => call.args[0] === "debug")).toHaveLength(2);
  });

  const drifted = (change: (list: Agent[]) => void) => { const list = agents(); change(list); return JSON.stringify(list); };
  it.each([
    ["a rule after ours", drifted(list => list[0]!.permissions.push({ action: "bash", resource: "*", effect: "allow" })), /build: the Konteks rules are not last.*shell command is allow/],
    ["our catch-all ask missing", drifted(list => { for (const agent of list) agent.permissions = agent.permissions.filter((rule, index, all) => !(index === all.length - 12 && rule.action === "*")); }), /the Konteks rules are not last.*shell command is allow/],
    [".env no longer gated", drifted(list => { for (const agent of list) agent.permissions.push({ action: "read", resource: "*.env", effect: "allow" }); }), /reading \.env is allow/],
    ["outside folders not denied", drifted(list => { for (const agent of list) agent.permissions.push({ action: "external_directory", resource: "*", effect: "allow" }); }), /folder outside the working copy is allow/],
    ["the built-in browser back", drifted(list => { for (const agent of list) agent.permissions.push({ action: "browser", resource: "*", effect: "allow" }); }), /built-in browser is allow/],
    ["OpenCode's own Code Mode tools back", drifted(list => { for (const agent of list) agent.permissions.push({ action: "opencode_session_move", resource: "*", effect: "ask" }); }), /own Code Mode tools is ask/],
    ["plan back", drifted(list => list.push({ id: "plan", permissions: [] } as Agent)), /agent plan is not switched off/],
    ["title back", drifted(list => list.push({ id: "title", permissions: [] } as Agent)), /agent title is not switched off/],
    ["no build agent", drifted(list => list.splice(list.findIndex(agent => agent.id === "build"), 1)), /build agent is missing/],
    ["an unreadable listing", "Error: something new", /not in the expected form/],
    ["no agents at all", "[]", /build agent is missing/],
  ])("reads %s as an unsupported OpenCode installation, and still stops the service", async (_name, output, reason) => {
    const f = await fixture([output]);
    const failure = f.check();
    await expect(failure).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "opencode_unsupported_installation", message: expect.stringMatching(/^Unsupported OpenCode installation: OpenCode 2\.0\.18/) });
    await expect(failure).rejects.toThrow(reason);
    expect(f.events.slice(-2)).toEqual(["service stop", "scan"]);
  });

  it("does not remember a failure", async () => {
    const f = await fixture(["[]"]);
    const cache = new Map<string, true>();
    await expect(f.check(cache)).rejects.toMatchObject({ diagnostic: "opencode_unsupported_installation" });
    expect(cache.size).toBe(0);
  });

  it("reads a debug command that failed to run as not ready yet, and still stops the service", async () => {
    const f = await fixture([EXPECTED]);
    f.run.mockImplementation(async (_binary, args) => { f.events.push(args.join(" ")); return args[0] === "debug" ? { code: null, stdout: "", stderr: "timed out" } : { code: 0, stdout: "", stderr: "" }; });
    await expect(f.check()).rejects.toMatchObject({ code: "agent_unavailable", diagnostic: "opencode_self_check_failed", retryable: true });
    expect(f.events.slice(-2)).toEqual(["service stop", "scan"]);
  });

  it.each([CAPTURED, CAPTURED_2_0_21])("refuses a preserved historical listing whose named file operations still run unasked", capture => {
    expect(openCodeAgentsDrift(JSON.parse(capture))).toContain("agent build: reading a file is allow, expected ask");
    expect(openCodeAgentsDrift(JSON.parse(capture))).toContain("agent build: searching file names is allow, expected ask");
    expect(openCodeAgentsDrift(JSON.parse(capture))).toContain("agent build: searching file contents is allow, expected ask");
  });

  it("names every drift on the projected configured listing as none", () => {
    expect(openCodeAgentsDrift(agents())).toEqual([]);
  });

  it("accepts the expected configured 2.0.21 listing with its existing final `browser * deny`", async () => {
    const list = JSON.parse(EXPECTED_2_0_21) as Agent[];
    for (const agent of list) expect(agent.permissions.at(-1)).toEqual({ action: "browser", resource: "*", effect: "deny" });
    expect(openCodeAgentsDrift(list)).toEqual([]);
    const f = await fixture([EXPECTED_2_0_21]);
    await expect(f.check()).resolves.toBeUndefined();
  });

  const after21 = (rules: Agent["permissions"]) => { const list = JSON.parse(EXPECTED_2_0_21) as Agent[]; for (const agent of list) agent.permissions.push(...rules); return list; };
  it("accepts any further deny after the Konteks rules, but the probes still pin every decision", () => {
    expect(openCodeAgentsDrift(after21([{ action: "websearch", resource: "*", effect: "deny" }]))).toEqual([]);
    expect(openCodeAgentsDrift(after21([{ action: "*", resource: "*", effect: "deny" }]))).toContain("agent build: reading a file is deny, expected ask");
  });

  it.each([
    ["an ask after OpenCode's deny", [{ action: "external_directory", resource: "*", effect: "ask" }], /build: the Konteks rules are not last.*folder outside the working copy is ask/],
    ["an allow after OpenCode's deny", [{ action: "browser", resource: "*", effect: "allow" }], /build: the Konteks rules are not last.*built-in browser is allow/],
    ["an allow between denies", [{ action: "edit", resource: "*", effect: "allow" }, { action: "browser", resource: "*", effect: "deny" }], /build: the Konteks rules are not last.*an edit is allow/],
  ])("reads %s on 2.0.21 as drift", (_name, rules, reason) => {
    expect(openCodeAgentsDrift(after21(rules as Agent["permissions"])).join("; ")).toMatch(reason);
  });

  it("reads the Konteks rules split by OpenCode's deny as drift", () => {
    const list = agents();
    for (const agent of list) agent.permissions.splice(agent.permissions.length - 3, 0, { action: "browser", resource: "*", effect: "deny" });
    expect(openCodeAgentsDrift(list)).toContain("agent build: the Konteks rules are not last");
  });
});

describe("the OpenCode install adapter", () => {
  it("runs the self-check at runner start with the runner's binary, version and private home, and is offered", async () => {
    const check = vi.fn(async () => undefined);
    const config = { RUNNER_NATIVE_OPENCODE_BINARY: "/opt/opencode/bin/opencode", RUNNER_BRIDGE_VERSION: "2.0.18", RUNNER_CREDENTIAL_DIR: "/cred" } as RunnerConfig;
    await openCodeInstallAdapter.selfCheck(config, { openCodeSelfCheck: check });
    expect(check).toHaveBeenCalledWith({ binary: "/opt/opencode/bin/opencode", version: "2.0.18", credentialDir: "/cred" });
    await expect(openCodeInstallAdapter.selfCheck({ ...config, RUNNER_NATIVE_OPENCODE_BINARY: undefined }, { openCodeSelfCheck: check })).rejects.toMatchObject({ diagnostic: "opencode_not_found" });
    expect(openCodeInstallAdapter.offered).toBe(true);
  });
});
