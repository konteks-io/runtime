import { isAbsolute, normalize } from "node:path";
import { spawnPiped, type SpawnRequest, type PipedChildProcess } from "./process.js";

export interface LinuxExecutionMountPolicy {
  /** Caller must authenticate/pin this executable before selecting the owner. */
  executable: string;
  /** Same-path writable mounts over a read-only host view. No implicit HOME. */
  writableRoots: readonly string[];
}

/** Process ownership primitive, not a qualified lifecycle profile or sandbox
 * authorization. Caller owns verified policy/configuration selection. The
 * private PID namespace covers detached descendants; /run, /tmp and /dev do
 * not expose their host counterparts. Host networking and other host reads are
 * unchanged, so this alone cannot qualify arbitrary tools or local MCP daemons.
 * No fallback is permitted if the selected namespace mechanism cannot start. */
export function createLinuxExecutionSpawner(policy: LinuxExecutionMountPolicy): (request: SpawnRequest) => PipedChildProcess {
  const path = (value: string) => isAbsolute(value) && normalize(value) === value && !/[\p{Cc}\p{Cf}]/u.test(value);
  if (process.platform !== "linux" || !path(policy.executable) || !policy.writableRoots.length ||
    policy.writableRoots.some(root => !path(root) || ["/", "/proc", "/dev", "/run", "/tmp"].includes(root))) {
    throw new Error("Unsupported Linux execution mount policy");
  }
  const executable = policy.executable;
  const roots = [...new Set(policy.writableRoots)];
  return request => {
    if (!path(request.command)) throw new Error("Execution command must be an absolute verified path");
    return spawnPiped({ ...request, command: executable, detached: true,
      args: ["--ro-bind", "/", "/", "--unshare-user", "--unshare-pid", "--proc", "/proc",
        "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/tmp",
        ...roots.flatMap(root => ["--bind", root, root]), "--die-with-parent", "--new-session", "--", request.command, ...request.args],
    });
  };
}
