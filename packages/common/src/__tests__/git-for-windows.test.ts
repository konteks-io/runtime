import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { findGitForWindows, GIT_FOR_WINDOWS_DOWNLOAD } from "../git-for-windows.js";

/** A fake Windows disk: only these files exist. */
const disk = (...files: string[]) => (path: string) => files.map(file => file.toLowerCase()).includes(win32.normalize(path).toLowerCase());
const PF = "C:\\Program Files";
const LOCAL = "C:\\Users\\person\\AppData\\Local";

describe("finding Git for Windows and its Git Bash (D116)", () => {
  it("follows git.exe on PATH to the Git Bash beside it, from cmd or mingw64\\bin", () => {
    const env = { PATH: `C:\\Windows\\System32;${PF}\\Git\\cmd` };
    expect(findGitForWindows(env, disk(`${PF}\\Git\\cmd\\git.exe`, `${PF}\\Git\\bin\\bash.exe`))).toEqual({ git: `${PF}\\Git\\cmd\\git.exe`, bash: `${PF}\\Git\\bin\\bash.exe` });
    const mingw = { PATH: "D:\\Tools\\Git\\mingw64\\bin" };
    expect(findGitForWindows(mingw, disk("D:\\Tools\\Git\\mingw64\\bin\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe"))?.bash).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });

  it("finds the installer's and winget's folders when a fresh install is not on PATH yet", () => {
    expect(findGitForWindows({ PATH: "", ProgramFiles: PF }, disk(`${PF}\\Git\\bin\\bash.exe`, `${PF}\\Git\\cmd\\git.exe`))).toEqual({ git: `${PF}\\Git\\cmd\\git.exe`, bash: `${PF}\\Git\\bin\\bash.exe` });
    expect(findGitForWindows({ PATH: "", LOCALAPPDATA: LOCAL }, disk(`${LOCAL}\\Programs\\Git\\bin\\bash.exe`))?.bash).toBe(`${LOCAL}\\Programs\\Git\\bin\\bash.exe`);
  });

  it("honours CLAUDE_CODE_GIT_BASH_PATH, Anthropic's documented setting, when it names a file", () => {
    expect(findGitForWindows({ CLAUDE_CODE_GIT_BASH_PATH: "E:\\PortableGit\\bin\\bash.exe" }, disk("E:\\PortableGit\\bin\\bash.exe"))?.bash).toBe("E:\\PortableGit\\bin\\bash.exe");
    expect(findGitForWindows({ CLAUDE_CODE_GIT_BASH_PATH: "bash.exe" }, disk("bash.exe"))).toBeNull();
  });

  it("never takes WSL's bash.exe, or anything without a Git for Windows beside it", () => {
    expect(findGitForWindows({ PATH: "C:\\Windows\\System32", ProgramFiles: PF, LOCALAPPDATA: LOCAL }, disk("C:\\Windows\\System32\\bash.exe"))).toBeNull();
    expect(GIT_FOR_WINDOWS_DOWNLOAD).toBe("https://git-scm.com/download/win");
  });
});
