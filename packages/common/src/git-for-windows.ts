import { statSync } from "node:fs";
import { win32 } from "node:path";

/** Where a person gets Git for Windows without winget. */
export const GIT_FOR_WINDOWS_DOWNLOAD = "https://git-scm.com/download/win";

/** winget's own package for Git for Windows, as a person would type it. */
export const GIT_FOR_WINDOWS_WINGET = ["install", "--id", "Git.Git", "-e", "--source", "winget"] as const;

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Git for Windows and the Git Bash Claude Code runs its commands in (D116).
 * In order: Anthropic's documented `CLAUDE_CODE_GIT_BASH_PATH`; every git.exe
 * on PATH, followed to the bash.exe of its own install (`cmd`, `bin` or
 * `mingw64\bin`); then the installer's `%ProgramFiles%\Git` and winget's
 * per-user `%LOCALAPPDATA%\Programs\Git`, which a terminal opened before the
 * install has no PATH entry for. A bash.exe without Git for Windows around it
 * (WSL's, in System32) is never taken. Only file checks; nothing is run.
 */
export function findGitForWindows(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = isFile): { git?: string; bash: string } | null {
  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && win32.isAbsolute(override) && exists(override)) return { bash: override };
  for (const directory of (env.PATH ?? "").split(";")) {
    if (!directory || !win32.isAbsolute(directory)) continue;
    const git = win32.join(directory, "git.exe");
    if (!exists(git)) continue;
    for (const bash of [win32.join(directory, "bash.exe"), win32.join(directory, "..", "bin", "bash.exe"), win32.join(directory, "..", "..", "bin", "bash.exe")]) {
      if (exists(bash)) return { git, bash };
    }
  }
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].map(root => (root ? win32.join(root, "Git") : undefined))
    .concat(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "Programs", "Git")] : []);
  for (const root of roots) {
    if (!root || !win32.isAbsolute(root)) continue;
    const bash = win32.join(root, "bin", "bash.exe");
    if (!exists(bash)) continue;
    const git = win32.join(root, "cmd", "git.exe");
    return exists(git) ? { git, bash } : { bash };
  }
  return null;
}
