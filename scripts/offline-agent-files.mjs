import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { join } from "node:path";

/** Preserve dependency executables in the signed file inventory. */
export async function inventoryOfflineFiles(root, paths, runtimeName) {
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
      executable: path === `bin/${runtimeName}` || (lstatSync(absolute).mode & 0o111) !== 0,
    });
  }
  return files;
}
