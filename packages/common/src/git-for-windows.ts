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
 * Git for Windows and the Git Bash Claude Code runs its commands in.
 * In order: Anthropic's documented `CLAUDE_CODE_GIT_BASH_PATH`; every git.exe
 * on PATH, followed to the bash.exe of its own install (`cmd`, `bin` or
 * `mingw64\bin`); then the installer's `%ProgramFiles%\Git` and winget's
 * per-user `%LOCALAPPDATA%\Programs\Git`, which a terminal opened before the
 * install has no PATH entry for. A bash.exe without Git for Windows around it
 * (WSL's, in System32) is never taken. Only file checks; nothing is run.
 */
type GitForWindows = { git?: string; bash: string };

export function findGitForWindows(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = isFile): GitForWindows | null {
  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && win32.isAbsolute(override) && exists(override)) return { bash: override };
  return gitOnPath(env.PATH ?? "", exists) ?? gitInstallRoot(env, exists);
}

/** The first git.exe on PATH whose own install carries bash.exe. */
function gitOnPath(path: string, exists: (path: string) => boolean): GitForWindows | null {
  for (const directory of path.split(";")) {
    if (!directory || !win32.isAbsolute(directory)) continue;
    const git = win32.join(directory, "git.exe");
    if (!exists(git)) continue;
    const bash = [win32.join(directory, "bash.exe"), win32.join(directory, "..", "bin", "bash.exe"), win32.join(directory, "..", "..", "bin", "bash.exe")].find(exists);
    if (bash) return { git, bash };
  }
  return null;
}

/** The installer's and winget's install roots, which a terminal opened before the install has no PATH entry for. */
function gitInstallRoot(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): GitForWindows | null {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].map(root => (root ? win32.join(root, "Git") : undefined))
    .concat(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "Programs", "Git")] : []);
  const root = roots.find(candidate => candidate !== undefined && win32.isAbsolute(candidate) && exists(win32.join(candidate, "bin", "bash.exe")));
  if (!root) return null;
  const bash = win32.join(root, "bin", "bash.exe");
  const git = win32.join(root, "cmd", "git.exe");
  return exists(git) ? { git, bash } : { bash };
}
