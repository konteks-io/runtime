import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_KONTEKS_PERMISSIONS, openCodeRuntimePaths, type RunnerConfig } from "@konteks/remote-agent-runner";
import { checkOpenCodeKonteksConfig, openCodeAgentsDrift, type OpenCodeCommandRunner, type OpenCodeServiceControl } from "../native/opencode-self-check.js";
import { openCodeInstallAdapter } from "../native/host-agents.js";

/** `opencode debug agents` from OpenCode 2.0.18 with the Konteks configuration (live, 2026-09-28; home paths shortened). */
const CAPTURED = readFileSync(new URL("./fixtures/opencode-2.0.18-debug-agents.json", import.meta.url), "utf8");
type Agent = { id: string; permissions: Array<{ action: string; resource: string; effect: string }> };
const agents = (): Agent[] => JSON.parse(CAPTURED) as Agent[];

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
  it("passes on OpenCode 2.0.18's resolved rules, in the private home with the Konteks environment, and leaves no service running", async () => {
    const f = await fixture([CAPTURED]);
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
    const f = await fixture(["[]\n", JSON.stringify(defaults), JSON.stringify(defaults), CAPTURED]);
    await f.check();
    expect(f.calls.filter(call => call.args[0] === "debug")).toHaveLength(4);
  });

  it("remembers a pass per binary, version and file, and checks again when the file changes", async () => {
    const f = await fixture([CAPTURED]);
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
    ["our catch-all ask missing", drifted(list => { for (const agent of list) agent.permissions = agent.permissions.filter((rule, index, all) => !(index === all.length - 10 && rule.action === "*")); }), /the Konteks rules are not last.*shell command is allow/],
    [".env no longer gated", drifted(list => { for (const agent of list) agent.permissions = agent.permissions.filter(rule => !(rule.resource === "*.env" && rule.effect === "ask")); }), /reading \.env is allow/],
    ["outside folders not denied", drifted(list => { for (const agent of list) agent.permissions.push({ action: "external_directory", resource: "*", effect: "allow" }); }), /folder outside the working copy is allow/],
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
    const f = await fixture([CAPTURED]);
    f.run.mockImplementation(async (_binary, args) => { f.events.push(args.join(" ")); return args[0] === "debug" ? { code: null, stdout: "", stderr: "timed out" } : { code: 0, stdout: "", stderr: "" }; });
    await expect(f.check()).rejects.toMatchObject({ code: "agent_unavailable", diagnostic: "opencode_self_check_failed", retryable: true });
    expect(f.events.slice(-2)).toEqual(["service stop", "scan"]);
  });

  it("names every drift on the captured listing as none", () => {
    expect(openCodeAgentsDrift(agents())).toEqual([]);
  });
});

describe("the OpenCode install adapter", () => {
  it("runs the self-check at runner start with the runner's binary, version and private home, and stays not offered", async () => {
    const check = vi.fn(async () => undefined);
    const config = { RUNNER_NATIVE_OPENCODE_BINARY: "/opt/opencode/bin/opencode", RUNNER_BRIDGE_VERSION: "2.0.18", RUNNER_CREDENTIAL_DIR: "/cred" } as RunnerConfig;
    await openCodeInstallAdapter.selfCheck(config, { openCodeSelfCheck: check });
    expect(check).toHaveBeenCalledWith({ binary: "/opt/opencode/bin/opencode", version: "2.0.18", credentialDir: "/cred" });
    await expect(openCodeInstallAdapter.selfCheck({ ...config, RUNNER_NATIVE_OPENCODE_BINARY: undefined }, { openCodeSelfCheck: check })).rejects.toMatchObject({ diagnostic: "opencode_not_found" });
    expect(openCodeInstallAdapter.offered).toBe(false);
  });
});
