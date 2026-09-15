import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function testGitCommand(tool: { executable: string }, cwd: string, args: string[]) {
  return (
    await promisify(execFile)(tool.executable, ["-C", cwd, ...args], {
      env: {
        PATH: dirname(tool.executable),
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      timeout: 10_000,
    })
  ).stdout;
}

/** Test-host discovery only. Production takes an installer-recorded absolute executable. */
export async function testGitTool() {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      await access(candidate);
      const executable = await realpath(candidate);
      return {
        executable,
        digest:
          "sha256:" +
          createHash("sha256")
            .update(await readFile(executable))
            .digest("hex"),
      };
    } catch {
      /* Try another test-host installation. */
    }
  }
  throw new Error("Real Git is required for native workspace tests");
}
