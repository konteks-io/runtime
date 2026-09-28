import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, win32 } from "node:path";

/**
 * The real path of `<workingCopy>/AGENTS.md` when it is a regular file inside
 * the working copy; else null. A link that leaves the working copy (to
 * `~/.ssh/...`, say) never counts, so no agent is ever handed a file from
 * outside the repository as its instructions (OpenCode CP2, Antigravity A9).
 */
export async function instructionsInside(workingCopy: string): Promise<string | null> {
  try {
    const path = win32.isAbsolute(workingCopy) && !posix.isAbsolute(workingCopy) ? win32 : posix;
    const root = await realpath(workingCopy);
    const file = await realpath(path.join(workingCopy, "AGENTS.md"));
    const inside = relative(root, file);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}
