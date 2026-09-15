import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

/**
 * Locate the operator's own installed Claude Code CLI. Search order adapted
 * from bb's provider-claude-code session options: explicit operator override,
 * `claude` on PATH, then the documented native/Homebrew/npm-local locations.
 * Operator process configuration only; never take this path from Core or ACP.
 */
export async function resolveNativeClaudeExecutable(env: NodeJS.ProcessEnv = process.env, operatorHome = homedir()): Promise<string> {
  const invalid = () => new RemoteInstanceError("prerequisite_missing", "Install Claude Code for this user (https://claude.ai/install.sh), sign in with `claude auth login`, then retry. The executable must be user- or root-owned and not writable by other users.");
  const binary = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates: string[] = [];
  if (env.CLAUDE_CODE_EXECUTABLE) {
    if (!isAbsolute(env.CLAUDE_CODE_EXECUTABLE) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(env.CLAUDE_CODE_EXECUTABLE)) throw invalid();
    candidates.push(env.CLAUDE_CODE_EXECUTABLE);
  } else {
    for (const directory of (env.PATH ?? "").split(delimiter)) if (directory && isAbsolute(directory)) candidates.push(join(directory, binary));
    // Root must not inherit a user-writable per-user install.
    if (process.getuid?.() !== 0) candidates.push(join(operatorHome, ".local", "bin", binary), join(operatorHome, ".claude", "local", binary));
    if (process.platform !== "win32") candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  }
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const info = await lstat(canonical);
      const owner = info.uid === process.getuid?.() || info.uid === 0;
      if (!info.isFile() || (process.platform !== "win32" && (!owner || (info.mode & 0o022) !== 0))) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch { /* try the next documented location */ }
  }
  throw invalid();
}
