import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

/** Operator process configuration only. Never take a profile path from Core or ACP. */
export async function resolveNativeCodexHome(env: NodeJS.ProcessEnv = process.env, operatorHome = homedir()): Promise<string> {
  const path = env.CODEX_HOME ?? join(operatorHome, ".codex");
  const invalid = () => new RemoteInstanceError("prerequisite_missing", "Open your local Codex once, then restart the connector with the same user-owned CODEX_HOME. The profile must be an absolute, non-linked directory, not writable by other users.");
  if (!isAbsolute(path) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(path) || resolve(path) === parse(path).root || resolve(path) === resolve(operatorHome)) throw invalid();
  try {
    const before = await lstat(path);
    if (!before.isDirectory() || (process.platform !== "win32" && (before.uid !== process.getuid?.() || (before.mode & 0o022) !== 0))) throw invalid();
    const canonical = await realpath(path);
    const after = await lstat(path);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.uid !== after.uid) throw invalid();
    return canonical;
  } catch {
    throw invalid();
  }
}
