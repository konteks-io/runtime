import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireNativeRootLock, antigravityInstallAdapter, ANTIGRAVITY_CONSENT_TEXT } from "@konteks/remote-supervisor";
import { runNativeAgentAdd, runNativeAgentRemove } from "../native/commands.js";
import { fetchHostAgent } from "../native/install.js";
import { terminalFetchConsent } from "../native/consent.js";
import { PassThrough } from "node:stream";
import { createOutput } from "../output.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-add-lifecycle-")); roots.push(root);
  const supervisor = join(root, "supervisor");
  const owner = acquireNativeRootLock(supervisor);
  const status = { command: "status", args: [] }, stop = { command: "stop", args: [] };
  let stopped = false, now = 0;
  const calls: string[] = [];
  const record = { instanceId: "instance", releaseId: "release-one", controlPort: 41800, agents: ["codex"] } as never;
  const successor = { ...record, agents: ["codex", "dsh"] } as never;
  const add = vi.fn(async () => {
    calls.push("add");
    const lock = acquireNativeRootLock(supervisor);
    lock.release();
    return successor;
  });
  const start = vi.fn(async () => { calls.push("start"); });
  const restore = vi.fn(async () => { calls.push("restore"); });
  const deps = {
    readRecord: async () => record,
    serviceDefinition: async () => ({ status, stop }) as never,
    execute: async (command: { command: string }) => {
      calls.push(command.command);
      if (command === stop) { stopped = true; return 0; }
      return stopped ? 113 : 0;
    },
    control: () => ({ call: async (request: { op: string }) => {
      calls.push(request.op);
      return request.op === "drain.status" ? { draining: true, reason: "update", activeAssignments: 0, openSessions: 0 } : {};
    } }),
    add, restore, start,
    sleep: async () => { now += 1_000; calls.push("wait"); },
    now: () => now,
    platform: { os: "macos", architecture: "arm64", containerBackend: "none", deploymentKind: "native_connector" },
    stopDeadlineMs: 3_000,
    pollMs: 1_000,
  };
  return { root, owner, calls, deps, add, start, restore };
}

describe("native agent-add ownership lifecycle", () => {
  it("waits for the stopped supervisor to release ownership before adding dsh and restarting", async () => {
    const f = await fixture();
    const sleep = f.deps.sleep;
    f.deps.sleep = async () => { await sleep(); f.owner.release(); };
    await runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never);
    expect(f.add).toHaveBeenCalledTimes(2);
    expect(f.calls.indexOf("drain")).toBeLessThan(f.calls.indexOf("stop"));
    expect(f.calls).toEqual(expect.arrayContaining(["drain.status", "stop", "add", "wait", "start"]));
    expect(f.calls.lastIndexOf("add")).toBeLessThan(f.calls.indexOf("start"));
    expect(f.restore).not.toHaveBeenCalled();
  });

  it("stops a connector running in a terminal, not as the service, adds the agent and says how to start it again (W1-D3)", async () => {
    const f = await fixture();
    const lines: string[] = [];
    // The service manager reports it stopped, yet the connector answers.
    f.deps.execute = async (command: { command: string }) => { f.calls.push(command.command); return 113; };
    const control = f.deps.control();
    f.deps.control = () => ({ call: async (request: { op: string }) => {
      if (request.op === "shutdown") f.owner.release();
      return control.call(request);
    } });
    await runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: (text: string) => { lines.push(text); return true; } } as never }) }, f.deps as never);
    expect(f.calls.indexOf("drain")).toBeLessThan(f.calls.indexOf("shutdown"));
    expect(f.calls.indexOf("shutdown")).toBeLessThan(f.calls.indexOf("add"));
    expect(f.calls).not.toContain("stop");
    expect(f.start).not.toHaveBeenCalled();
    expect(lines.join("")).toContain("is added. Konteks stopped to add it; konteks-remote start starts it again, in the background.");
  });

  it("refuses an install it cannot run before stopping anything (W1-D3)", async () => {
    const f = await fixture();
    const { RemoteInstanceError } = await import("@konteks/remote-common");
    (f.deps as Record<string, unknown>).locate = async () => { throw new RemoteInstanceError("prerequisite_missing" as never, "DeepSeek Harness 0.2.0-rc.2 is not a version Konteks supports."); };
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
        .rejects.toThrow("0.2.0-rc.2 is not a version Konteks supports");
      expect(f.calls).not.toContain("drain");
      expect(f.calls).not.toContain("stop");
      expect(f.add).not.toHaveBeenCalled();
    } finally { f.owner.release(); }
  });

  it("offers Claude Code's official installer before stopping anything, and changes nothing on a no (D116)", async () => {
    const f = await fixture();
    const { RemoteInstanceError } = await import("@konteks/remote-common");
    const ensurePersonal = vi.fn(async () => { throw new RemoteInstanceError("agent_unavailable", "Nothing was installed: Claude Code was not added."); });
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "claude-code", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, { ...f.deps, ensurePersonal } as never))
        .rejects.toThrow("Nothing was installed: Claude Code was not added.");
      expect(ensurePersonal).toHaveBeenCalledWith("claude-code", expect.anything());
      expect(f.calls).toEqual([]);
      expect(f.add).not.toHaveBeenCalled();
    } finally { f.owner.release(); }
  });

  it("signs a just-installed Claude Code in once the connector is back (D116)", async () => {
    const f = await fixture();
    const sleep = f.deps.sleep;
    f.deps.sleep = async () => { await sleep(); f.owner.release(); };
    const ensurePersonal = vi.fn(async () => "set_up" as const);
    const closeAgents = vi.fn(async () => undefined);
    await runNativeAgentAdd({ root: f.root, agent: "claude-code", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, { ...f.deps, ensurePersonal, closeAgents } as never);
    expect(f.start).toHaveBeenCalledOnce();
    expect(closeAgents).toHaveBeenCalledWith(expect.objectContaining({ agents: ["claude-code"], signInNow: ["claude-code"], missing: [] }));
    expect(f.start.mock.invocationCallOrder[0]!).toBeLessThan(closeAgents.mock.invocationCallOrder[0]!);
  });

  it("adds straight away when nothing runs at all", async () => {
    const f = await fixture();
    f.owner.release();
    f.deps.execute = async (command: { command: string }) => { f.calls.push(command.command); return 113; };
    f.deps.control = () => ({ call: async () => { throw new Error("connect ECONNREFUSED"); } });
    await runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never);
    expect(f.calls).toEqual(["status", "add"]);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("leaves the service stopped and the original record intact if ownership never releases", async () => {
    const f = await fixture();
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
        .rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringMatching(/owns this native data directory/) });
      expect(f.add).toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.restore).not.toHaveBeenCalled();
    } finally { f.owner.release(); }
  });

  it("waits for the OS service to finish stopping before trying the installer lock", async () => {
    const f = await fixture();
    const execute = f.deps.execute, sleep = f.deps.sleep;
    let stoppingChecks = 0, waits = 0;
    f.deps.execute = async command => {
      if (command.command === "status" && f.calls.includes("stop") && stoppingChecks++ < 2) {
        f.calls.push("status-still-running");
        return 0;
      }
      return execute(command);
    };
    f.deps.sleep = async () => { await sleep(); if (++waits === 2) f.owner.release(); };
    await runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never);
    expect(waits).toBe(2);
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.calls.indexOf("add")).toBeGreaterThan(f.calls.lastIndexOf("status-still-running"));
    expect(f.start).toHaveBeenCalledOnce();
  });

  it("fails closed if the service manager cannot confirm the stopped state", async () => {
    const f = await fixture();
    const execute = f.deps.execute;
    f.deps.execute = async command => command.command === "status" && f.calls.includes("stop") ? 7 : execute(command);
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
        .rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringMatching(/cannot confirm.*stopped/) });
      expect(f.add).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    } finally { f.owner.release(); }
  });

  it("refuses an unknown initial service state before draining or changing agents", async () => {
    const f = await fixture();
    f.deps.execute = async () => 7;
    try {
      await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
        .rejects.toMatchObject({ code: "temporarily_unavailable", message: expect.stringMatching(/cannot confirm.*service state/) });
      expect(f.add).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.calls).not.toContain("drain");
    } finally { f.owner.release(); }
  });

  it("restores the previous record before restarting it if the successor start fails", async () => {
    const f = await fixture();
    f.owner.release();
    f.start.mockRejectedValueOnce(new Error("new service failed to start"));
    await expect(runNativeAgentAdd({ root: f.root, agent: "dsh", output: createOutput({ json: false, stdout: { write: () => true } as never }) }, f.deps as never))
      .rejects.toThrow("new service failed to start");
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.calls.indexOf("restore")).toBeLessThan(f.calls.lastIndexOf("start"));
  });
});

describe("Google Antigravity's add and remove (antigravity CP6)", () => {
  const quiet = () => { const lines: string[] = []; return { lines, output: { ...createOutput({ json: false, stdout: { write: () => true } as never }), line: (text: string) => { lines.push(text); } } }; };

  it("asks the consent line and downloads while the service keeps running, then stops, adds and restarts", async () => {
    const f = await fixture();
    f.owner.release();
    const asked: string[] = [];
    const fetchAgent = vi.fn(async (host, root: string, consent) => {
      f.calls.push("fetch");
      expect(await consent!(host.agentId, host.consentText!)).toBe(true);
      expect(root).toBe(f.root);
      return {};
    }) as unknown as typeof fetchHostAgent;
    await runNativeAgentAdd({ root: f.root, agent: "antigravity", output: quiet().output }, { ...f.deps, fetchAgent, consent: async (_agent: string, text: string) => { asked.push(text); return true; } } as never);
    expect(asked).toEqual([ANTIGRAVITY_CONSENT_TEXT]);
    expect(f.calls.indexOf("fetch")).toBeLessThan(f.calls.indexOf("drain"));
    expect(f.calls).toEqual(expect.arrayContaining(["fetch", "drain", "stop", "add", "start"]));
  });

  it("changes and stops nothing when the person says no, or the download fails", async () => {
    for (const failure of ["no", "download"] as const) {
      const f = await fixture();
      f.owner.release();
      const fetchAgent = vi.fn(async (host, root: string, consent) => {
        if (failure === "no") return fetchHostAgent(host, root, consent);
        throw new Error("the download server could not be reached");
      }) as unknown as typeof fetchHostAgent;
      const located = vi.spyOn(antigravityInstallAdapter, "locate").mockRejectedValue(new Error("not fetched"));
      const fetched = vi.spyOn(antigravityInstallAdapter, "fetch");
      const pinned = vi.spyOn(antigravityInstallAdapter, "assertFetchable").mockImplementation(() => undefined);
      try {
        await expect(runNativeAgentAdd({ root: f.root, agent: "antigravity", output: quiet().output }, { ...f.deps, fetchAgent, consent: async () => false } as never))
          .rejects.toThrow(failure === "no" ? /Nothing was downloaded: Google Antigravity was not added\./ : /could not be reached/);
        expect(fetched).not.toHaveBeenCalled();
        expect(f.calls).toEqual([]);
        expect(f.add).not.toHaveBeenCalled();
      } finally { located.mockRestore(); fetched.mockRestore(); pinned.mockRestore(); }
    }
  });

  it("says already installed for a listed copy that verifies, and fetches a listed copy that no longer does", async () => {
    const f = await fixture();
    f.owner.release();
    const listed = { instanceId: "instance", releaseId: "release-one", controlPort: 41800, agents: ["codex", "antigravity"] } as never;
    const settings = vi.spyOn(antigravityInstallAdapter, "runnerSettings").mockResolvedValue({ RUNNER_BRIDGE_PREFIX: "/x", RUNNER_BRIDGE_VERSION: "1.2.1" });
    const fetchAgent = vi.fn(async () => { f.calls.push("fetch"); return {}; }) as unknown as typeof fetchHostAgent;
    try {
      const first = quiet();
      await runNativeAgentAdd({ root: f.root, agent: "antigravity", output: first.output }, { ...f.deps, readRecord: async () => listed, fetchAgent, consent: async () => true } as never);
      expect(first.lines).toEqual(["Google Antigravity is already installed; no restart is needed."]);
      expect(f.calls).toEqual([]);
      settings.mockRejectedValue(new Error("does not match Google's release"));
      await runNativeAgentAdd({ root: f.root, agent: "antigravity", output: quiet().output }, { ...f.deps, readRecord: async () => listed, fetchAgent, consent: async () => true } as never);
      expect(f.calls).toEqual(expect.arrayContaining(["fetch", "stop", "add", "start"]));
    } finally { settings.mockRestore(); }
  });

  it("shows the consent line verbatim and reads a yes in a terminal, takes --yes as the answer, and refuses without a terminal", async () => {
    const lines: string[] = [];
    const input = new PassThrough();
    const shown: string[] = [];
    const output = new PassThrough();
    output.on("data", chunk => shown.push(String(chunk)));
    const asking = terminalFetchConsent({ line: text => lines.push(text), input, output });
    const answer = asking("antigravity", ANTIGRAVITY_CONSENT_TEXT);
    input.write("y\n");
    await expect(answer).resolves.toBe(true);
    expect(shown.join("")).toBe(`${ANTIGRAVITY_CONSENT_TEXT} `);
    const declining = terminalFetchConsent({ line: text => lines.push(text), input: (() => { const empty = new PassThrough(); empty.end("\n"); return empty; })(), output: new PassThrough() });
    await expect(declining("antigravity", ANTIGRAVITY_CONSENT_TEXT)).resolves.toBe(false);
    await expect(terminalFetchConsent({ yes: true, line: text => lines.push(text) })("antigravity", ANTIGRAVITY_CONSENT_TEXT)).resolves.toBe(true);
    expect(lines).toEqual([ANTIGRAVITY_CONSENT_TEXT, "Answered yes with --yes."]);
    if (process.stdin.isTTY !== true) {
      await expect(terminalFetchConsent({ line: text => lines.push(text) })("antigravity", ANTIGRAVITY_CONSENT_TEXT)).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringMatching(/--yes/) });
      expect(lines.at(-1)).toBe(ANTIGRAVITY_CONSENT_TEXT);
    }
  });

  it("removes it after one yes: drains, stops, removes, restarts; a no or another agent changes nothing", async () => {
    const f = await fixture();
    f.owner.release();
    const listed = { instanceId: "instance", releaseId: "release-one", controlPort: 41800, agents: ["codex", "antigravity"] } as never;
    const remove = vi.fn(async () => { f.calls.push("remove"); return { instanceId: "instance", agents: ["codex"] } as never; });
    const base = { ...f.deps, readRecord: async () => listed, remove };
    const declined = quiet();
    await runNativeAgentRemove({ root: f.root, agent: "antigravity", output: declined.output }, { ...base, confirm: async () => false } as never);
    expect(declined.lines).toEqual(["Nothing was removed; Google Antigravity is still added here."]);
    expect(f.calls).toEqual([]);
    await expect(runNativeAgentRemove({ root: f.root, agent: "codex", output: quiet().output }, { ...base, confirm: async () => true } as never))
      .rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringMatching(/Only Google Antigravity, which Konteks downloads, can: konteks-remote agent remove antigravity/) });
    expect(f.calls).toEqual([]);
    const questions: string[] = [];
    await runNativeAgentRemove({ root: f.root, agent: "antigravity", output: quiet().output }, { ...base, confirm: async (question: string) => { questions.push(question); return true; } } as never);
    expect(questions).toEqual([expect.stringMatching(/^Remove Google Antigravity from this computer\? Konteks signs it out, deletes its download and its sign-ins here/)]);
    expect(f.calls.indexOf("drain")).toBeLessThan(f.calls.indexOf("stop"));
    expect(f.calls.indexOf("stop")).toBeLessThan(f.calls.indexOf("remove"));
    expect(f.calls.indexOf("remove")).toBeLessThan(f.calls.indexOf("start"));
  });
});
