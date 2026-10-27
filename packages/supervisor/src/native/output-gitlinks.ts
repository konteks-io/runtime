import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";

const treeGitlink = /^160000 commit ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/u;
const indexGitlink = /^160000 ([a-f0-9]{40}(?:[a-f0-9]{24})?) 0\t(.+)$/u;
const changed = () => new RemoteInstanceError("capability_unavailable", "Generated delivery output contains an unsupported submodule state.", { diagnostic: "gitlink_changed" });

function parseGitlinks(value: Buffer, pattern: RegExp): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of new TextDecoder("utf-8", { fatal: true }).decode(value).split("\0")) {
    if (!row.startsWith("160000 ")) continue;
    const match = pattern.exec(row);
    if (!match || result.has(match[2]!)) throw changed();
    result.set(match[2]!, match[1]!);
  }
  return result;
}

/** Gitlinks remain source metadata; they are never delivered as regular files. */
export function baselineGitlinks(tree: Buffer): ReadonlyMap<string, string> {
  return parseGitlinks(tree, treeGitlink);
}

export function acceptUnchangedGitlink(row: string, baseline: ReadonlyMap<string, string>, seen: Set<string>): boolean {
  if (!row.startsWith("160000 ")) return false;
  const match = treeGitlink.exec(row);
  if (!match || baseline.get(match[2]!) !== match[1] || seen.has(match[2]!)) throw changed();
  seen.add(match[2]!);
  return true;
}

export function requireAllGitlinksSeen(baseline: ReadonlyMap<string, string>, seen: ReadonlySet<string>): void {
  if (baseline.size !== seen.size) throw changed();
}

/** The real index can contain a staged gitlink change that a private index hides. */
export async function verifyEmptyGitlinks(root: string, baseline: ReadonlyMap<string, string>, index: Buffer): Promise<void> {
  const current = parseGitlinks(index, indexGitlink);
  if (baseline.size !== current.size) throw changed();
  for (const [path, oid] of baseline) {
    if (current.get(path) !== oid) throw changed();
    await verifyEmptyDirectory(root, path);
  }
}

function checkedPath(root: string, relative: string): string {
  if (isAbsolute(relative) || relative.includes("\\") || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(relative) ||
      relative.split("/").some(part => part === "" || part === "." || part === "..")) throw changed();
  return join(root, relative);
}

async function verifyEmptyDirectory(root: string, relative: string): Promise<void> {
  const path = checkedPath(root, relative);
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw changed();
  const directory = await opendir(path);
  try {
    if (await directory.read()) {
      throw new RemoteInstanceError("capability_unavailable", "Generated delivery output contains a populated submodule.", { diagnostic: "gitlink_not_empty" });
    }
  } finally { await directory.close(); }
}
