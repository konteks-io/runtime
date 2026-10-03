import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productionUninstallDeps, uninstallNative, type UninstallDeps } from "../native/uninstall.js";
import { acquireNativeRootLock } from "@konteks/remote-supervisor";
import { writeOnboardState } from "../native/onboard-state.js";
import { createOutput } from "../output.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rmdir: vi.fn(actual.rmdir) };
});

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

  it("production cleanup refuses a held runtime lock and releases its installer lock", async () => {
    await chmod(root, 0o700); await chmod(join(root, "supervisor"), 0o700);
    await mkdir(join(root, "installer"), { mode: 0o700 });
    await writeFile(join(root, "native-runtime.json"), "{}", { mode: 0o600 });
    const owner = acquireNativeRootLock(join(root, "supervisor"));
    const d = productionUninstallDeps({ root, serviceDefinition: async () => service, execute: async () => 0 });
    try {
      await expect(d.cleanupSkillHomes!()).rejects.toMatchObject({ code: "temporarily_unavailable" });
      owner.assertOwned();
      const installer = acquireNativeRootLock(join(root, "installer"));
      installer.release();
      expect(await stat(root)).toBeDefined();
    } finally { owner.release(); }
  });

  it("production cleanup reads the local binding and preserves personal Skill content", async () => {
    await chmod(root, 0o700); await chmod(join(root, "supervisor"), 0o700);
    await mkdir(join(root, "installer"), { mode: 0o700 });
    const home = join(base, "agent-home"), metadata = join(home, ".konteks-skill-sync"), skills = join(home, "skills");
    await mkdir(metadata, { recursive: true, mode: 0o700 }); await mkdir(skills, { mode: 0o700 });
    const tree = join(metadata, "retained"); await mkdir(tree, { mode: 0o700 });
    const name = `konteks-${"a".repeat(64)}`;
    await symlink(tree, join(skills, name), process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(skills, "personal")); await writeFile(join(skills, "personal", "SKILL.md"), "keep");
    await writeFile(join(metadata, "state.json"), JSON.stringify({ version: 1, workspaceId: "workspace", instanceId: "instance", links: { [name]: tree } }), { mode: 0o600 });
    await writeFile(join(root, "native-runtime.json"), JSON.stringify({ schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance", workspaceId: "workspace", releaseId: "release", manifestDigest: "digest", bundleVersion: "0.8.10-e2e", coreUrl: "https://127.0.0.1:7443", relayUrl: "wss://127.0.0.1:7443/relay/runtime", controlPort: 43210, agents: [], agentSkillHomes: [home] }), { mode: 0o600 });
    const d = productionUninstallDeps({ root, serviceDefinition: async () => service, execute: async () => 0 });
    await writeFile(join(root, "native-uninstall.pending"), "foreign-marker\n", { mode: 0o600 });
    await expect(d.cleanupSkillHomes!()).rejects.toMatchObject({ code: "local_io_failure" });
    expect(await readlink(join(skills, name))).toBe(tree);
    await rm(join(root, "native-uninstall.pending"));
    await d.cleanupSkillHomes!();
    await expect(readlink(join(skills, name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(skills, "personal", "SKILL.md"), "utf8")).toBe("keep");
    expect(await stat(root)).toBeDefined();
    expect(() => acquireNativeRootLock(join(root, "supervisor"))).toThrow(/uninstall/i);
    await d.cleanupSkillHomes!(); // A failed folder removal can safely retry.
  });

  it("refuses cleanup without an install record while a runtime still owns its data", async () => {
    await chmod(root, 0o700); await chmod(join(root, "supervisor"), 0o700);
    await mkdir(join(root, "installer"), { mode: 0o700 });
    const owner = acquireNativeRootLock(join(root, "supervisor"));
    const d = productionUninstallDeps({ root, serviceDefinition: async () => service, execute: async () => 0 });
    try {
      await expect(d.cleanupSkillHomes!()).rejects.toMatchObject({ code: "temporarily_unavailable" });
      owner.assertOwned();
      expect(await readFile(join(root, "supervisor", "instance-key.jwk"), "utf8")).toBe("{}");
    } finally { owner.release(); }
  });

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

  it("waits for the connector to finish shutting down before deleting its folder, and removes a late write (W1-Z6)", async () => {
    const d = deps([], {
      "drain.status": [{ draining: true, reason: "remove", activeAssignments: 0, openSessions: 0 }],
      "instance.retire": [{ outcome: "removed", activeAssignments: 0 }],
    });
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "konteks-remote"), "#!/bin/sh");
    let checks = 0;
    const seen: boolean[] = [];
    d.receipt = async () => "receipt-1";
    d.shutDown = async before => {
      expect(before).toBe("receipt-1");
      checks += 1;
      seen.push(await stat(root).then(() => true, () => false));
      // The connector writes its receipt as its last act.
      if (checks === 2) await writeFile(join(root, "supervisor", "shutdown-complete"), "receipt-2");
      return checks >= 3;
    };
    await uninstallNative({ root, output: output() }, d);
    expect(seen).toEqual([true, true, true]);
    await expect(stat(root)).rejects.toThrow();
  });

  it("preserves the installation when shutdown completion cannot be proved", async () => {
    const d = deps([], {
      "drain.status": [{ draining: true, reason: "remove", activeAssignments: 0, openSessions: 0 }],
      "instance.retire": [{ outcome: "removed", activeAssignments: 0 }],
    });
    let now = 0;
    d.now = () => now;
    d.sleep = async ms => { now += ms; };
    d.receipt = async () => "old-receipt";
    d.shutDown = async () => false;
    await expect(uninstallNative({ root, output: output() }, d)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(await stat(root)).toBeDefined();
    expect(await readdir(repository)).toEqual([".git"]);
  });

  it("preserves the installation when owned Skill cleanup refuses", async () => {
    const d = deps([], {
      "drain.status": [{ draining: true, reason: "remove", activeAssignments: 0, openSessions: 0 }],
      "instance.retire": [{ outcome: "removed", activeAssignments: 0 }],
    });
    d.cleanupSkillHomes = async () => {
      expect(d.executed).toEqual(["stop", "remove"]);
      expect(await stat(root)).toBeDefined();
      throw new Error("changed Skill link");
    };
    await expect(uninstallNative({ root, output: output() }, d)).rejects.toThrow("changed Skill link");
    expect(await stat(root)).toBeDefined();
  });

  it("preserves files created by a new installer at the final empty-folder removal", async () => {
    const d = deps([], {}); d.control = async () => null;
    vi.mocked(rmdir).mockImplementationOnce(async path => {
      expect(path).toBe(root);
      await writeFile(join(root, "new-installation.txt"), "keep-new-owner");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return actual.rmdir(path);
    });
    await expect(uninstallNative({ root, output: output() }, d)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(await readFile(join(root, "new-installation.txt"), "utf8")).toBe("keep-new-owner");
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
    expect(lines.join("")).toContain("Customize → Runtimes");
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
