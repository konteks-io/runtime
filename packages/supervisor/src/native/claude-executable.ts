import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

/**
 * Anthropic's official Claude Code installer for a platform: the script's
 * address and the one line a person runs (PowerShell on Windows, a shell
 * elsewhere). The only source Konteks names or runs for Claude Code.
 */
export function claudeCodeInstaller(platform: NodeJS.Platform = process.platform): { url: string; command: string } {
  return platform === "win32"
    ? { url: "https://claude.ai/install.ps1", command: "irm https://claude.ai/install.ps1 | iex" }
    : { url: "https://claude.ai/install.sh", command: "curl -fsSL https://claude.ai/install.sh | bash" };
}

/**
 * Locate the operator's own installed Claude Code CLI. Search order adapted
 * from bb's provider-claude-code session options: explicit operator override,
 * `claude` on PATH, then the documented native/Homebrew/npm-local locations.
 * Operator process configuration only; never take this path from Core or ACP.
 */
export async function resolveNativeClaudeExecutable(env: NodeJS.ProcessEnv = process.env, operatorHome = homedir(), platform: NodeJS.Platform = process.platform): Promise<string> {
  const windows = platform === "win32";
  // What is missing and the one thing to do, with this platform's own installer.
  const invalid = () => new RemoteInstanceError("prerequisite_missing", `Claude Code is not installed for this user. Install it with Anthropic's installer (${claudeCodeInstaller(platform).command}), then retry.${windows ? "" : " It must be owned by you or root and not writable by others."}`);
  const binary = windows ? "claude.exe" : "claude";
  const candidates: string[] = [];
  if (env.CLAUDE_CODE_EXECUTABLE) {
    if (!isAbsolute(env.CLAUDE_CODE_EXECUTABLE) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(env.CLAUDE_CODE_EXECUTABLE)) throw invalid();
    candidates.push(env.CLAUDE_CODE_EXECUTABLE);
  } else {
    for (const directory of (env.PATH ?? "").split(delimiter)) if (directory && isAbsolute(directory)) candidates.push(join(directory, binary));
    // Root must not inherit a user-writable per-user install. The official
    // installer puts it in ~/.local/bin (%USERPROFILE%\.local\bin\claude.exe on
    // Windows), which a terminal opened before it ran has no PATH entry for.
    if (process.getuid?.() !== 0) candidates.push(join(operatorHome, ".local", "bin", binary), join(operatorHome, ".claude", "local", binary));
    if (windows) {
      // npm on Windows puts only a claude.cmd shim on PATH, which Node cannot
      // start without a shell; the package's own claude.exe is beside it.
      for (const prefix of [env.npm_config_prefix, env.APPDATA ? join(env.APPDATA, "npm") : undefined]) {
        if (prefix && isAbsolute(prefix)) candidates.push(join(prefix, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
      }
    } else candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  }
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const info = await lstat(canonical);
      const owner = info.uid === process.getuid?.() || info.uid === 0;
      if (!info.isFile() || (!windows && (!owner || (info.mode & 0o022) !== 0))) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch { /* try the next documented location */ }
  }
  throw invalid();
}
