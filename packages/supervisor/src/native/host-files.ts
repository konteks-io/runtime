import { isAbsolute } from "node:path";

/**
 * Checks for paths and files found on the person's computer (their own agent
 * installs, Node, profiles) before the connector trusts or runs them.
 */

/** An absolute path with no control, format or surrogate characters. */
export function plainAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(path);
}

/** Owned by this user or root, and not writable by group or others. */
export function safelyOwned(info: { uid: number; mode: number }): boolean {
  return (info.uid === process.getuid?.() || info.uid === 0) && (info.mode & 0o022) === 0;
}

/** The absolute folders of a PATH-style variable, split on `separator`. */
export function absolutePathEntries(value: string | undefined, separator: string): string[] {
  return (value ?? "").split(separator).filter(directory => directory.length > 0 && isAbsolute(directory));
}
