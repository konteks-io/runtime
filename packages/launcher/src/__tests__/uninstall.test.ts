import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstallNative, type UninstallDeps } from "../native/uninstall.js";
import { writeOnboardState } from "../native/onboard-state.js";
import { createOutput } from "../output.js";

/**
 * W1-L2: a person asks their agent, in plain words, to remove Konteks from
 * this laptop. Work drains, Konteks revokes and tombstones the runtime, and
 * the connector's folder goes; the repository and agent logins stay.
 */
describe("uninstall", () => {
  let base: string;
  let root: string;
  let repository: string;
  let lines: string[];
  const output = () => {
    lines = [];
    return createOutput({ json: false, stdout: { write: (text: string) => { lines.push(text); return true; } } as never, stderr: { write: () => true } as never });
  };
  const service = { label: "dev.konteks.remote.x", path: "", contents: "", install: [], start: { command: "start", args: [] }, stop: { command: "stop", args: [] }, remove: [{ command: "remove", args: [] }], status: { command: "status", args: [] }, requiresLinger: false };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "konteks-uninstall-"));
    root = join(base, "konteks-remote");
    repository = join(base, "shop");
    await mkdir(join(root, "supervisor"), { recursive: true });
    await writeFile(join(root, "supervisor", "instance-key.jwk"), "{}");
    await mkdir(join(repository, ".git"), { recursive: true });
    await writeOnboardState(root, { schemaVersion: 1, step: "done", updatedAt: new Date().toISOString(), repositoryPath: repository } as never);
    service.path = join(base, "dev.konteks.remote.x.plist");
    await writeFile(service.path, "<plist/>");
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  function deps(calls: Array<{ op: string }>, answers: Record<string, unknown[]>): UninstallDeps & { executed: string[] } {
    const executed: string[] = [];
    return {
      executed,
      connected: async () => true,
      control: async () => ({
        call: vi.fn(async (request: { op: string }) => {
          calls.push(request);
          const queue = answers[request.op] ?? [{}];
          return queue.length > 1 ? queue.shift() : queue[0];
        }) as never,
      }),
      serviceDefinition: async () => service,
      execute: async command => { executed.push(command.command); return 0; },
      sleep: async () => undefined,
      now: () => 0,
    };
  }

  it("drains, has Konteks remove the runtime, unregisters the service and deletes only the connector folder", async () => {
    const calls: Array<{ op: string }> = [];
    const d = deps(calls, {
      "drain.status": [{ draining: true, reason: "remove", activeAssignments: 1, openSessions: 0 }, { draining: true, reason: "remove", activeAssignments: 0, openSessions: 0 }],
      "instance.retire": [{ outcome: "draining", activeAssignments: 0 }, { outcome: "removed", activeAssignments: 0 }],
    });
    const result = await uninstallNative({ root, output: output() }, d);

    expect(calls.map(call => call.op)).toEqual(["drain", "drain.status", "drain.status", "instance.retire", "instance.retire"]);
    expect(result).toMatchObject({ state: "uninstalled", runtime: "removed", repositoryPath: repository });
    expect(d.executed).toEqual(["stop", "remove"]);
    await expect(stat(root)).rejects.toThrow();
    await expect(stat(service.path)).rejects.toThrow();
    expect(await readdir(repository)).toEqual([".git"]);
    expect(lines.join("")).toContain("runtime is removed from your workspace");
    expect(lines.join("")).toContain(`Your repository at ${repository}`);
    expect(lines.join("")).toContain("One piece of work is still running on this machine");
  });

  it("says what the wait is for once, then only a line a minute", async () => {
    let now = 0;
    const running = { draining: true, reason: "remove", activeAssignments: 1, openSessions: 0 };
    const d = deps([], {
      "drain.status": [...Array.from({ length: 30 }, () => running), { ...running, activeAssignments: 0 }],
      "instance.retire": [{ outcome: "removed", activeAssignments: 0 }],
    });
    d.now = () => now;
    d.sleep = async () => { now += 5_000; };
    await uninstallNative({ root, output: output() }, d);
    const said = lines.join("").split("\n").filter(Boolean);
    expect(said.filter(line => line.includes("still running on this machine"))).toHaveLength(1);
    expect(said.filter(line => line.startsWith("Still waiting"))).toHaveLength(2);
  });

  it("still cleans up the machine, and says what is left on the site, when Konteks cannot be told", async () => {
    const d = deps([], {});
    d.control = async () => null;
    const result = await uninstallNative({ root, output: output() }, d);
    expect(result.runtime).toBe("not_told");
    await expect(stat(root)).rejects.toThrow();
    expect(lines.join("")).toContain("Settings → Runtimes");
  });

  it("removes nothing while work is still running after the wait", async () => {
    let now = 0;
    const d = deps([], { "drain.status": [{ draining: true, reason: "remove", activeAssignments: 2, openSessions: 0 }] });
    d.now = () => now;
    d.sleep = async () => { now += 20 * 60_000; };
    await expect(uninstallNative({ root, output: output() }, d)).rejects.toThrow(/nothing was removed/);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(d.executed).toEqual([]);
  });
});
