import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Preserve dependency executables in the signed file inventory. Windows has no
 * execute bit (Node reports none), so there a program is known by its
 * extension; without that a native entrypoint such as Claude Code's
 * `bin/claude.exe` was inventoried as data and the installer refused the
 * whole package (agent OS proof).
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

/**
 * The files the shared Codex proxy needs beside it: its entry and every
 * relative module it imports, transitively. The package used to copy a fixed
 * list, so a new import (`codex-socket.js`) was left behind and the proxy
 * could not even load.
 * `sourceExtension` reads `.ts` sources for a `.js` import, for tests.
 */
export function codexLocalProxyFiles(directory, { entry = "codex-local-proxy.js", sourceExtension = ".js" } = {}) {
  const found = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.shift();
    if (found.includes(file)) continue;
    const path = join(directory, file.replace(/\.js$/, sourceExtension));
    if (!existsSync(path)) throw new Error(`the Codex proxy imports ${file}, which is not in ${directory}`);
    found.push(file);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']\.\/([^"'/]+\.js)["']/g)) pending.push(match[1]);
  }
  return found;
}

/**
 * What the build changes in an agent's package for one platform. The Codex
 * bridge patch carries Konteks's session naming, so every platform gets it
 * (Windows shipped it unpatched and no thread read "[konteks]"); only
 * the shared app-server proxy is Unix-only.
 */
export function offlineAgentPatches(agent, os) {
  return {
    codexBridge: agent === "codex",
    codexLocalProxy: agent === "codex" && os !== "windows",
    claudeFiles: agent === "claude-code" ? ["acp-agent.js", "settings.js", "session-titles.js"] : [],
  };
}
