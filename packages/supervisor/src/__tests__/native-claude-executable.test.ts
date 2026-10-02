import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeInstaller, resolveNativeClaudeExecutable } from "../native/claude-executable.js";

describe("native Claude Code executable discovery", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const executable = async (path: string, mode = 0o755) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, mode);
  };

  it("prefers PATH, then the documented per-user locations, returning the canonical binary", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "claude-exe-")));
    const home = join(root, "home"), pathBin = join(root, "path-bin"), installed = join(root, "lib", "claude.exe");
    await executable(installed);
    await mkdir(pathBin, { recursive: true });
    await symlink(installed, join(pathBin, "claude"));
    await expect(resolveNativeClaudeExecutable({ PATH: pathBin }, home)).resolves.toBe(installed);
    await executable(join(home, ".local", "bin", "claude"));
    await expect(resolveNativeClaudeExecutable({ PATH: join(root, "missing") }, home)).resolves.toBe(join(home, ".local", "bin", "claude"));
  });

  it("honours an absolute operator override and refuses unsafe or missing executables", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "claude-exe-")));
    const override = join(root, "override", "claude");
    await executable(override);
    await expect(resolveNativeClaudeExecutable({ CLAUDE_CODE_EXECUTABLE: override, PATH: "" }, join(root, "home"))).resolves.toBe(override);
    await expect(resolveNativeClaudeExecutable({ CLAUDE_CODE_EXECUTABLE: "claude" }, join(root, "home"))).rejects.toMatchObject({ code: "prerequisite_missing" });
    await chmod(override, 0o777);
    await expect(resolveNativeClaudeExecutable({ CLAUDE_CODE_EXECUTABLE: override }, join(root, "home"))).rejects.toMatchObject({ code: "prerequisite_missing" });
    await chmod(override, 0o644);
    await expect(resolveNativeClaudeExecutable({ CLAUDE_CODE_EXECUTABLE: override }, join(root, "home"))).rejects.toMatchObject({ code: "prerequisite_missing" });
  });

  it("finds the official Windows installer's claude.exe under the user's profile (D116)", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "claude-exe-")));
    const profile = join(root, "Users", "person");
    const installed = join(profile, ".local", "bin", "claude.exe");
    await executable(installed);
    // A fresh terminal's PATH does not have the installer's folder yet.
    await expect(resolveNativeClaudeExecutable({ PATH: join(root, "Windows", "System32") }, profile, "win32")).resolves.toBe(installed);
  });

  it("names the platform's own official installer when Claude Code is missing (D116)", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "claude-exe-")));
    const windows = resolveNativeClaudeExecutable({ PATH: "" }, join(root, "empty"), "win32");
    await expect(windows).rejects.toMatchObject({ code: "prerequisite_missing", message: expect.stringContaining("irm https://claude.ai/install.ps1 | iex") });
    await expect(resolveNativeClaudeExecutable({ PATH: "" }, join(root, "empty"), "win32")).rejects.not.toMatchObject({ message: expect.stringContaining("install.sh") });
    await expect(resolveNativeClaudeExecutable({ CLAUDE_CODE_EXECUTABLE: join(root, "missing", "claude") }, join(root, "empty"), "darwin")).rejects.toMatchObject({ code: "prerequisite_missing", message: expect.stringContaining("curl -fsSL https://claude.ai/install.sh | bash") });
    expect(claudeCodeInstaller("win32")).toEqual({ url: "https://claude.ai/install.ps1", command: "irm https://claude.ai/install.ps1 | iex" });
    expect(claudeCodeInstaller("linux")).toEqual({ url: "https://claude.ai/install.sh", command: "curl -fsSL https://claude.ai/install.sh | bash" });
  });

  it("finds npm's Windows install behind its claude.cmd shim, the package's own claude.exe (D116)", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "claude-exe-")));
    const appData = join(root, "AppData", "Roaming");
    const npmBin = join(appData, "npm");
    const packaged = join(npmBin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    await executable(packaged);
    // npm puts only the shim on PATH; Node cannot start a .cmd without a shell.
    await writeFile(join(npmBin, "claude.cmd"), "@echo off\r\n");
    await expect(resolveNativeClaudeExecutable({ PATH: npmBin, APPDATA: appData }, join(root, "profile"), "win32")).resolves.toBe(packaged);
  });
});
