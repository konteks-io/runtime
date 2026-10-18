import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

/** Called by the local installer, never from cloud input. Bind once so a
 * service restart under a different environment cannot silently switch homes. */
export function nativeSkillHomeBinding(
  codexHome?: string,
  env: NodeJS.ProcessEnv = process.env,
  operatorHome = homedir(),
): { claudeConfigDir: string; agentSkillHomes: string[] } {
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ?? join(operatorHome, ".claude");
  const agentSkillHomes = [
    ...new Set([
      join(operatorHome, ".codex"),
      codexHome ?? env.CODEX_HOME ?? join(operatorHome, ".codex"),
      join(operatorHome, ".agents"),
      join(operatorHome, ".claude"),
      claudeConfigDir,
    ]),
  ];
  for (const path of agentSkillHomes) assertSafeSkillHome(path, operatorHome);
  return { claudeConfigDir, agentSkillHomes };
}

function assertSafeSkillHome(path: string, operatorHome: string): void {
  const resolved = resolve(path);
  if (
    !isAbsolute(path) ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(path) ||
    resolved === parse(path).root ||
    resolved === resolve(operatorHome)
  ) {
    throw new RemoteInstanceError(
      "prerequisite_missing",
      "Native Skill discovery requires absolute local agent profile directories.",
    );
  }
}
