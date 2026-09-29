import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canOpenOnComputer, onComputerDone, onComputerScript, openOnComputer, planOnComputer, readOnComputerWatches, removeOnComputerWatch, writeOnComputerWatch } from "../native/on-computer.js";

describe("a step the site brings to the front on this computer (on-computer)", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it("starts where the agent stands: install, then add, then sign in; nothing for a ready one", () => {
    const install = "curl -fsSL https://opencode.ai/v2/install | bash";
    expect(planOnComputer({ agentId: "opencode", state: "not_installed", installCommand: install }, "darwin"))
      .toEqual({ step: "install", commands: [install, "konteks-remote agent add opencode", "konteks-remote auth login opencode"], until: "ready" });
    expect(planOnComputer({ agentId: "dsh", state: "installed_not_added" }, "darwin"))
      .toEqual({ step: "add", commands: ["konteks-remote agent add dsh", "konteks-remote auth login dsh"], until: "ready" });
    // Google Antigravity is added (downloaded from Google), never installed by the person, and
    // signs in with Gemini Enterprise on the site, which carries its project and location.
    expect(planOnComputer({ agentId: "antigravity", state: "not_added", installCommand: "konteks-remote agent add antigravity" }, "darwin"))
      .toEqual({ step: "add", commands: ["konteks-remote agent add antigravity"], until: "added" });
    expect(planOnComputer({ agentId: "antigravity", state: "needs_sign_in" }, "darwin")).toBeNull();
    expect(planOnComputer({ agentId: "dsh", state: "needs_sign_in" }, "linux")).toEqual({ step: "sign_in", commands: ["konteks-remote auth login dsh"], until: "ready" });
    expect(planOnComputer({ agentId: "opencode", state: "not_installed", installCommand: "a", windowsInstallCommand: "b" }, "win32")?.commands[0]).toBe("b");
    expect(planOnComputer({ agentId: "dsh", state: "ready" }, "darwin")).toBeNull();
  });

  it("acts on this connector only, says in one line what it does, and ends with what to do next", () => {
    const script = onComputerScript({ step: "sign_in", commands: ["konteks-remote auth login dsh"], until: "ready" }, { agentId: "dsh", root: "/Users/p/Library/Application Support/konteks-remote", platform: "darwin" });
    expect(script).toContain("export KONTEKS_ROOT='/Users/p/Library/Application Support/konteks-remote'");
    expect(script).toContain("Konteks is setting up DeepSeek Harness on this computer.");
    expect(script).toContain("if konteks-remote auth login dsh; then");
    expect(script).toContain("DeepSeek Harness is set up. You can close this window");
    const windows = onComputerScript({ step: "add", commands: ["konteks-remote agent add antigravity"], until: "added" }, { agentId: "antigravity", root: "C:\\Users\\p\\konteks", platform: "win32" });
    expect(windows).toContain("$env:KONTEKS_ROOT = 'C:\\Users\\p\\konteks'");
    expect(windows).toContain("if ($ok) { konteks-remote agent add antigravity; $ok = $? }");
    expect(windows).toContain("sign it in on the Konteks site");
  });

  it("opens it in Terminal on a Mac, and only leaves it in a stand-in laptop's spool", async () => {
    const data = await mkdtemp(join(tmpdir(), "on-computer-")); dirs.push(data);
    const spawn = vi.fn();
    const file = await openOnComputer({ loginId: "login-1", script: "#!/bin/sh\necho hi\n", dataDir: data, platform: "darwin", env: {} }, { spawn });
    expect(file).toBe(join(data, "on-computer", "login-1.command"));
    expect((await stat(file)).mode & 0o777).toBe(0o700);
    expect(spawn).toHaveBeenCalledWith("open", ["-a", "Terminal", file]);

    const spool = join(data, "spool");
    const spooled = vi.fn();
    const inSpool = await openOnComputer({ loginId: "login-2", script: "#!/bin/sh\n", dataDir: data, platform: "darwin", env: { KONTEKS_E2E_NATIVE_CONNECTOR: "1", KONTEKS_E2E_ON_COMPUTER_SPOOL: spool } }, { spawn: spooled });
    expect(inSpool).toBe(join(spool, "login-2.command"));
    expect(await readFile(inSpool, "utf8")).toBe("#!/bin/sh\n");
    expect(spooled).not.toHaveBeenCalled();
    // A stand-in whose service carries no spool (an OS service) still never opens a real window.
    const ownFolder = await openOnComputer({ loginId: "login-4", script: "#!/bin/sh\n", dataDir: data, platform: "darwin", env: { KONTEKS_E2E_NATIVE_CONNECTOR: "1" } }, { spawn: spooled });
    expect(ownFolder).toBe(join(data, "on-computer", "login-4.command"));
    expect(spooled).not.toHaveBeenCalled();
    // A spool is honoured only on a stand-in laptop.
    await openOnComputer({ loginId: "login-3", script: "x", dataDir: data, platform: "win32", env: { KONTEKS_E2E_ON_COMPUTER_SPOOL: spool } }, { spawn: spooled });
    expect(spooled).toHaveBeenCalledWith("cmd.exe", ["/c", "start", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", join(data, "on-computer", "login-3.ps1")]);
  });

  it("ends an add-only step once the agent is added, any other once it is ready", () => {
    expect(onComputerDone("needs_sign_in", "added")).toBe(true);
    expect(onComputerDone("not_added", "added")).toBe(false);
    expect(onComputerDone("needs_sign_in", "ready")).toBe(false);
    expect(onComputerDone("ready")).toBe(true);
  });

  it("keeps a waiting step across a restart (adding an agent restarts the connector), and drops a damaged one", async () => {
    const data = await mkdtemp(join(tmpdir(), "on-computer-")); dirs.push(data);
    const watch = { instanceId: "i-1", loginId: "login-9", agentId: "antigravity" as const, until: "added" as const, deadline: 123 };
    await writeOnComputerWatch(data, watch);
    await writeFile(join(data, "on-computer", "bad.watch.json"), "{not json");
    await writeFile(join(data, "on-computer", "login-9.command"), "#!/bin/sh\n");
    expect(await readOnComputerWatches(data)).toEqual([watch]);
    await removeOnComputerWatch(data, "login-9");
    expect(await readOnComputerWatches(data)).toEqual([]);
    // Its script goes with it.
    await expect(stat(join(data, "on-computer", "login-9.command"))).rejects.toThrow();
  });

  it("is offered only where a window can come to the front", () => {
    expect(canOpenOnComputer(true, {})).toBe(true);
    expect(canOpenOnComputer(false, {})).toBe(false);
    expect(canOpenOnComputer(false, { KONTEKS_E2E_NATIVE_CONNECTOR: "1", KONTEKS_E2E_ON_COMPUTER_SPOOL: "/tmp/spool" })).toBe(true);
    expect(canOpenOnComputer(false, { KONTEKS_E2E_NATIVE_CONNECTOR: "1" })).toBe(true);
  });
});
