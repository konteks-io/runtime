import { chmod, link, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

/**
 * A Konteks Codex session must not see the operator's own instruction or
 * memory files. Codex reads `$CODEX_HOME/AGENTS.md` and `AGENTS.override.md`
 * into `Config.user_instructions` independently of project-document discovery
 * (setting `project_doc_max_bytes` does not suppress them), and its memories
 * live under the same home. The connector therefore points Codex at a private
 * overlay that exposes the login and thread store but none of those files.
 */
export const CODEX_HOME_INSTRUCTIONS: readonly string[] = Object.freeze(["AGENTS.md", "AGENTS.override.md"]);

/** Marks the exact home the connector prepared; the bridge refuses any other CODEX_HOME. */
export const CODEX_HOME_OVERLAY_MARKER = ".konteks-codex-overlay";

/** Memories are files or folders whose name starts with `memories`. */
export function isCodexMemoryEntry(name: string): boolean {
  return /^memories(?:[._-]|$)/i.test(name);
}

/** The one entry a fresh sign-in needs to write through to the shared profile. */
const AUTH_ENTRY = "auth.json";

const overlayRefusal = (diagnostic: string, message: string): RemoteInstanceError =>
  new RemoteInstanceError("prerequisite_missing", message, { diagnostic });

/**
 * Create or refresh the private Codex home overlay. Every entry the operator's
 * profile holds is linked into the overlay except the instruction and memory
 * entries; the overlay is the only CODEX_HOME a Konteks session gets. No real
 * file is copied and no real content is deleted.
 */
export async function prepareCodexHomeOverlay(realHome: string, overlay: string): Promise<string> {
  await ensurePrivateDirectory(overlay);
  const entries = await readdir(realHome, { withFileTypes: true });
  const allowed = new Set(entries.map(entry => entry.name).filter(name => !blockedEntry(name)));
  await pruneOverlay(realHome, overlay, allowed);
  for (const entry of entries) {
    if (!allowed.has(entry.name)) continue;
    await linkEntry(join(realHome, entry.name), join(overlay, entry.name));
  }
  // A profile that has not signed in yet still gets the operator's auth path:
  // a dangling link is replaced by the real file when Codex writes it. A
  // platform that cannot create a dangling link leaves sign-in to the overlay
  // rather than failing the whole installation.
  if (!entries.some(entry => entry.name === AUTH_ENTRY)) await linkEntry(join(realHome, AUTH_ENTRY), join(overlay, AUTH_ENTRY), true).catch(() => undefined);
  await writeFile(join(overlay, CODEX_HOME_OVERLAY_MARKER), "konteks-codex-home-overlay-v1\n", { mode: 0o600 });
  return overlay;
}

function blockedEntry(name: string): boolean {
  return CODEX_HOME_INSTRUCTIONS.includes(name) || isCodexMemoryEntry(name);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a directory");
    if (process.platform !== "win32") await chmod(path, 0o700);
  } catch {
    throw overlayRefusal("codex_home_overlay_unavailable", "The private Codex home for this session could not be prepared.");
  }
}

/** Remove instruction/memory entries and links whose real target disappeared; keep connector-created stores. */
async function pruneOverlay(realHome: string, overlay: string, allowed: ReadonlySet<string>): Promise<void> {
  for (const name of await readdir(overlay)) {
    const path = join(overlay, name);
    if (blockedEntry(name)) {
      const stat = await lstat(path).catch(() => null);
      // A link to the operator's file must go; a connector-created memory store
      // may still be open, so its removal is best effort.
      await rm(path, { recursive: true, force: true }).catch(error => {
        if (stat?.isSymbolicLink()) throw error;
      });
      continue;
    }
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isSymbolicLink()) continue;
    const target = await lstat(join(realHome, name)).catch(() => null);
    if (!allowed.has(name) || target === null) await rm(path, { force: true });
  }
}

/** Link one real entry; an existing connector-created real entry is left alone. */
async function linkEntry(target: string, linkPath: string, dangling = false): Promise<void> {
  if (await keepExisting(linkPath, target)) return;
  const stat = await lstat(target).catch(() => null);
  if (stat === null && !dangling) return;
  await createLink(target, linkPath, stat);
}

/** True when the overlay already holds the right link or a connector-created entry; removes a wrong link. */
async function keepExisting(linkPath: string, target: string): Promise<boolean> {
  const existing = await lstat(linkPath).catch(() => null);
  if (existing === null) return false;
  if (!existing.isSymbolicLink()) return true;
  const pointed = await readlink(linkPath).catch(() => null);
  if (pointed !== null && resolve(dirname(linkPath), pointed) === resolve(target)) return true;
  await rm(linkPath, { force: true });
  return false;
}

async function createLink(target: string, linkPath: string, stat: Awaited<ReturnType<typeof lstat>> | null): Promise<void> {
  try {
    if (stat?.isDirectory()) await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    else if (process.platform === "win32" && stat?.isFile()) await link(target, linkPath).catch(async () => symlink(target, linkPath, "file"));
    else await symlink(target, linkPath, "file");
  } catch {
    await rm(linkPath, { force: true }).catch(() => undefined);
    throw overlayRefusal("codex_home_overlay_link_failed", "The private Codex home could not link the shared Codex profile.");
  }
}
