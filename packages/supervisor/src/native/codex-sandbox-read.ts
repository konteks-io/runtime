import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The local group Codex's elevated Windows sandbox runs commands as. Those
 * users read only what an ACL grants them, and Codex deliberately leaves the
 * person's profile out, so a skill or session context staged under the
 * connector's private root there was "Access is denied" to the agent
 * (11-01, ops session 3405088b on a Windows PC).
 */
export const CODEX_SANDBOX_GROUP = "CodexSandboxUsers";

type RunFile = (file: string, args: readonly string[]) => Promise<unknown>;

export interface CodexSandboxReadInput {
  platform: NodeJS.Platform;
  agentId: string;
  /** Directories the agent must read and never write: staged skills and session context. */
  directories: readonly string[];
  run?: RunFile;
  logger?: { warn(fields: object, message: string): void };
}

/**
 * Lets Codex's sandbox users read (never write) the staged read-only
 * directories on Windows. The grant is inheritable, so what is staged under
 * them later is readable too, and repeating it changes nothing. Without the
 * group (unelevated sandbox, older Codex) there is nothing to grant: the
 * failure is logged and the turn goes on, as it would have before.
 */
export async function grantCodexSandboxRead(input: CodexSandboxReadInput): Promise<void> {
  if (input.platform !== "win32" || input.agentId !== "codex") return;
  const run = input.run ?? promisify(execFile);
  for (const directory of new Set(input.directories)) {
    try {
      await run("icacls", [
        directory,
        "/grant",
        `${CODEX_SANDBOX_GROUP}:(OI)(CI)(RX)`,
        "/T",
        "/C",
        "/Q",
      ]);
    } catch (error) {
      input.logger?.warn(
        {
          event: "codex_sandbox.read_grant_failed",
          directory,
          error: error instanceof Error ? error.message : String(error),
        },
        "codex sandbox read grant failed",
      );
    }
  }
}
