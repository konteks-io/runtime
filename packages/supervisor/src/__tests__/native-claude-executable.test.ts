import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNativeClaudeExecutable } from "../native/claude-executable.js";

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
});
