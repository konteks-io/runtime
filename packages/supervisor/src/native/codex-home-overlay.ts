import { chmod, link, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isFsErrorWithCode, RemoteInstanceError } from "@konteks/remote-common";

/**
 * A Konteks Codex session must not see the operator's own instruction or
 * memory files. Codex reads `$CODEX_HOME/AGENTS.md` and `AGENTS.override.md`
 * into `Config.user_instructions` independently of project-document discovery
 * (setting `project_doc_max_bytes` does not suppress them), loads personal
 * skills, prompts and plugin text, and its memories live under the same home.
 * The connector therefore points Codex at a private overlay that exposes the
 * login and thread store but none of those entries.
 */
export const CODEX_HOME_BLOCKED_ENTRIES: readonly string[] = Object.freeze([
  "AGENTS.md", "AGENTS.override.md", "skills", "prompts", "plugins", "instructions", ".tmp",
]);

/** Marks the exact home the connector prepared; the bridge refuses any other CODEX_HOME. */
export const CODEX_HOME_OVERLAY_MARKER = ".konteks-codex-overlay";

/** The real profile the overlay was made from, for a legacy record that has no codexHome yet. */
const CODEX_HOME_SOURCE = ".konteks-codex-home";

/** Codex's config carries instruction sources that would otherwise steer a session. */
const CODEX_CONFIG = "config.toml";
/** Tables that can name skills, prompts or plugins by an absolute path outside the overlay. */
const CODEX_CONFIG_BLOCKED_TABLES: ReadonlySet<string> = new Set(["plugins", "marketplaces", "skills", "prompts", "instructions"]);

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
 * profile holds is linked into the overlay except instruction, memory, skill,
 * prompt and plugin entries; `config.toml` is copied without its instruction
 * keys instead of linked. No real content is deleted.
 */
export async function prepareCodexHomeOverlay(realHome: string, overlay: string, rebind = true): Promise<string> {
  await ensurePrivateDirectory(overlay);
  const bound = await codexHomeBehindOverlay(overlay);
  // A legacy record has no codexHome: keep the profile its runner already
  // used, even when this process's CODEX_HOME now names another one.
  if (!rebind && bound !== null && resolve(bound) !== resolve(realHome)) return overlay;
  const entries = await readdir(realHome, { withFileTypes: true });
  const allowed = new Set(entries.map(entry => entry.name).filter(name => !blockedEntry(name) && name !== CODEX_CONFIG));
  await pruneOverlay(realHome, overlay, allowed);
  for (const entry of entries) {
    if (!allowed.has(entry.name) || entry.name === AUTH_ENTRY) continue;
    await linkEntry(join(realHome, entry.name), join(overlay, entry.name));
  }
  await refreshAuthLink(realHome, overlay, entries.some(entry => entry.name === AUTH_ENTRY));
  await writeSanitizedConfig(realHome, overlay);
  await writeFile(join(overlay, CODEX_HOME_OVERLAY_MARKER), "konteks-codex-home-overlay-v1\n", { mode: 0o600 });
  await writeFile(join(overlay, CODEX_HOME_SOURCE), `${realHome}\n`, { mode: 0o600 });
  return overlay;
}

/**
 * The login is the one shared entry that must not outlive a sign-in. On
 * Windows it is a hard link, so a sign-out and sign-in that replaces the real
 * file would otherwise leave the overlay on the old token. Re-link it on every
 * prepare; with no real login keep what the overlay holds (a sign-in may have
 * written it there when a dangling link could not be created).
 */
async function refreshAuthLink(realHome: string, overlay: string, realExists: boolean): Promise<void> {
  const linkPath = join(overlay, AUTH_ENTRY);
  if (!realExists) {
    await linkEntry(join(realHome, AUTH_ENTRY), linkPath, true).catch(() => undefined);
    return;
  }
  await rm(linkPath, { force: true, recursive: true });
  await linkEntry(join(realHome, AUTH_ENTRY), linkPath);
}

/** The operator's instruction sources and personal skill/prompt folders. */
function blockedEntry(name: string): boolean {
  return CODEX_HOME_BLOCKED_ENTRIES.includes(name) || isCodexMemoryEntry(name);
}

/** The real home behind an overlay, recorded when it was prepared. */
export async function codexHomeBehindOverlay(overlay: string): Promise<string | null> {
  const stored = await readFile(join(overlay, CODEX_HOME_SOURCE), "utf8").catch(() => null);
  const value = stored?.trim() ?? "";
  if (value.length > 0 && isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value)) return value;
  for (const entry of [AUTH_ENTRY, "sessions"]) {
    const target = await readlink(join(overlay, entry)).catch(() => null);
    if (target !== null) return dirname(resolve(overlay, target));
  }
  return null;
}

/** Drop instruction keys in any TOML spelling and skill/prompt/plugin tables. */
export function sanitizeCodexConfig(text: string): string {
  const cleaned = stripCodexConfig(text);
  return cleaned === null || containsInstructionSource(cleaned) ? "" : cleaned;
}

/**
 * Remove every assignment whose key path ends in an instruction source, and
 * every skill/prompt/plugin table. Any header this cannot parse fails the
 * whole sanitizer closed (an empty config is returned by the caller).
 */
function stripCodexConfig(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let denyTable = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*\[/.test(line)) {
      const denied = tableDecision(line);
      if (denied === null) return null;
      denyTable = denied;
      if (!denyTable) kept.push(line);
      continue;
    }
    if (denyTable) continue;
    if (instructionAssignment(line)) {
      index = skipValue(lines, index);
      continue;
    }
    index = keepValue(lines, index, kept);
  }
  return kept.join("\n");
}

function tableDecision(line: string): boolean | null {
  const path = tablePath(line);
  return path === null ? null : CODEX_CONFIG_BLOCKED_TABLES.has(path[0]!.toLowerCase());
}

/** Keep an assignment's line and any multi-line value without judging its contents. */
function keepValue(lines: readonly string[], index: number, kept: string[]): number {
  const end = skipValue(lines, index);
  kept.push(lines[index]!);
  for (let next = index + 1; next <= end; next++) kept.push(lines[next]!);
  return end;
}

const INSTRUCTION_ASSIGNMENT =
  /(?:^|[\s.[{,"'])(?:["'])?(?:developer_instructions|model_instructions_file|experimental_instructions_file|base_instructions|compact_prompt|instructions)(?:["'])?\s*=/i;

/** Recognizes bare, quoted, dotted, inline-table and table-scoped instruction keys. */
function instructionAssignment(line: string): boolean {
  return INSTRUCTION_ASSIGNMENT.test(line);
}

function containsInstructionSource(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const denied = tableDecision(line);
      if (denied === null || denied) return true;
      continue;
    }
    if (instructionAssignment(line)) return true;
  }
  return false;
}

function tablePath(line: string): string[] | null {
  const match = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
  return match === null ? null : splitKeyPath(match[1]!);
}

/** Split a dotted TOML key path, keeping quoted segments and their dots intact. */
function splitKeyPath(raw: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (quote !== null) {
      quote = char === quote && raw[index - 1] !== "\\" ? null : quote;
      current += char;
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      current += char;
    } else if (char === ".") {
      if (!pushPart(parts, current)) return null;
      current = "";
    } else {
      current += char;
    }
  }
  return finishPath(parts, current, quote);
}

function isQuote(char: string): boolean {
  return char === '"' || char === "'";
}

function pushPart(parts: string[], current: string): boolean {
  const part = takePart(current);
  if (part === null) return false;
  parts.push(part);
  return true;
}

function finishPath(parts: string[], current: string, quote: string | null): string[] | null {
  if (quote !== null) return null;
  const last = takePart(current);
  return last === null ? null : [...parts, last];
}

function takePart(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : unquoteKey(trimmed);
}

function unquoteKey(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** The last line of the denied key's value: a multi-line string or array, else its own line. */
function skipValue(lines: readonly string[], index: number): number {
  return multilineEnd(lines, index, '"""') ?? multilineEnd(lines, index, "'''") ?? arrayEnd(lines, index);
}

function multilineEnd(lines: readonly string[], index: number, delimiter: string): number | null {
  const line = lines[index]!;
  const first = line.indexOf(delimiter);
  if (first === -1) return null;
  if (line.indexOf(delimiter, first + 3) !== -1) return index;
  for (let next = index + 1; next < lines.length; next++) if (lines[next]!.includes(delimiter)) return next;
  return null;
}

function arrayEnd(lines: readonly string[], index: number): number {
  const line = lines[index]!;
  const value = line.slice(line.indexOf("=") + 1).trim();
  if (!value.startsWith("[") || value.includes("]")) return index;
  for (let next = index + 1; next < lines.length; next++) if (lines[next]!.includes("]")) return next;
  return index;
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
  for (const name of await readdir(overlay)) await pruneEntry(realHome, overlay, allowed, name);
}

async function pruneEntry(realHome: string, overlay: string, allowed: ReadonlySet<string>, name: string): Promise<void> {
  const path = join(overlay, name);
  if (name === CODEX_CONFIG) {
    await removeConfigLink(path);
    return;
  }
  if (blockedEntry(name)) {
    await removeBlocked(path);
    return;
  }
  await removeStaleLink(realHome, allowed, path, name);
}

async function removeConfigLink(path: string): Promise<void> {
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) await rm(path, { force: true });
}

async function removeStaleLink(realHome: string, allowed: ReadonlySet<string>, path: string, name: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isSymbolicLink()) return;
  const target = await lstat(join(realHome, name)).catch(() => null);
  if (!allowed.has(name) || target === null) await rm(path, { force: true });
}

/** A link to the operator's file must go; a connector-created memory store may still be open. */
async function removeBlocked(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  await rm(path, { recursive: true, force: true }).catch(error => {
    if (stat?.isSymbolicLink()) throw error;
  });
}

/** Copy the operator's config without its instruction keys; never link the real file. */
async function writeSanitizedConfig(realHome: string, overlay: string): Promise<void> {
  const target = join(overlay, CODEX_CONFIG);
  const source = await readFile(join(realHome, CODEX_CONFIG), "utf8").catch(error => {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  const current = await readFile(target, "utf8").catch(() => null);
  if (source === null) {
    if (current !== null) await rm(target, { force: true });
    return;
  }
  const sanitized = sanitizeCodexConfig(source);
  if (current === sanitized) return;
  await rm(target, { force: true });
  await writeFile(target, sanitized, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(target, 0o600);
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
