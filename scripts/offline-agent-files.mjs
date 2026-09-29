import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * Preserve dependency executables in the signed file inventory. Windows has no
 * execute bit (Node reports none), so there a program is known by its
 * extension; without that a native entrypoint such as Claude Code's
 * `bin/claude.exe` was inventoried as data and the installer refused the
 * whole package (agent OS proof, CP0-X).
 */
const WINDOWS_PROGRAM = /\.(?:exe|com|cmd|bat)$/i;
export async function inventoryOfflineFiles(root, paths, runtimeName, platform = process.platform) {
  const files = [];
  for (const path of paths) {
    const absolute = join(root, ...path.split("/"));
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(absolute)) { hash.update(chunk); sizeBytes += chunk.length; }
    files.push({
      path,
      digest: `sha256:${hash.digest("hex")}`,
      sizeBytes,
      executable: path === `bin/${runtimeName}` || (lstatSync(absolute).mode & 0o111) !== 0 || (platform === "win32" && WINDOWS_PROGRAM.test(path)),
    });
  }
  return files;
}
