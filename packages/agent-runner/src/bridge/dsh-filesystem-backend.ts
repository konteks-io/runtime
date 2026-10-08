import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { FsError, type FsDirEntry, type FsTarget } from "@deepseek-ai/dsh-fs";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";

/** This emitted module is copied into a native DSH profile's resolution tree.
 * Its bare owner imports resolve through that DSH installation, not Runtime. */
export const name = "konteks-session-filesystem";
export const Config = SandboxedFileSystem.Config;
export const inject = SandboxedFileSystem.inject;

export interface DshFileAuthority {
  readonly cwd: string;
  readonly readOnlyRoots: readonly string[];
}

interface ReadRoot { readonly path: string; readonly canonical: string }

function absoluteRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new Error("DSH file authority requires absolute local paths without control characters.");
  }
  return value;
}

export function parseDshFileAuthority(value: unknown): DshFileAuthority {
  if (typeof value !== "object" || value === null || !("cwd" in value) || !("readOnlyRoots" in value)) {
    throw new Error("DSH file authority is missing.");
  }
  if (!Array.isArray(value.readOnlyRoots)) throw new Error("DSH read roots must be an array.");
  return Object.freeze({ cwd: absoluteRoot(value.cwd), readOnlyRoots: Object.freeze(value.readOnlyRoots.map(absoluteRoot)) });
}

function under(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function rootContains(root: ReadRoot, path: string): boolean {
  return under(root.path, path) || under(root.canonical, path);
}

async function snapshotRoot(path: string): Promise<ReadRoot> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("DSH file authority roots must be directories.");
  return Object.freeze({ path: resolve(path), canonical });
}

/** Use the genuine native sandbox class; write/edit and their version guards
 * remain inherited. This confines the filesystem read/list APIs, not arbitrary
 * code, shell syscalls, or the sandbox's internal authorized mutation reads. */
export async function createDshReadFileSystem(authority: DshFileAuthority): Promise<typeof SandboxedFileSystem> {
  const parsed = parseDshFileAuthority(authority);
  const roots = Object.freeze(await Promise.all([parsed.cwd, ...parsed.readOnlyRoots].map(snapshotRoot)));
  return class DshReadFileSystem extends SandboxedFileSystem {
    constructor(...args: ConstructorParameters<typeof SandboxedFileSystem>) {
      super(...args);
      // Cordis activates this marker and fs from the same child fiber; duplicate
      // fs registration fails before this marker can be installed.
      this.ctx.provide("konteksFileAuthority", Object.freeze({ cwd: parsed.cwd, readOnlyRoots: parsed.readOnlyRoots }));
    }

    private async admitted(target: FsTarget, signal?: AbortSignal): Promise<FsTarget | undefined> {
      signal?.throwIfAborted();
      const displayPath = resolve(this.config.cwd, target.displayPath);
      const matching = roots.filter(root => rootContains(root, displayPath));
      if (matching.length === 0) return undefined;
      const fresh = await super.resolve(displayPath, signal === undefined ? undefined : { signal });
      for (const root of matching) {
        if (await realpath(root.path) !== root.canonical) throw new FsError("DSH read-root identity changed.", "FS_SANDBOX_DENIED");
        if (rootContains(root, resolve(fresh.displayPath)) && under(root.canonical, this.processPath(fresh))) return fresh;
      }
      return undefined;
    }

    private async required(target: FsTarget, signal?: AbortSignal): Promise<FsTarget> {
      const fresh = await this.admitted(target, signal);
      if (fresh === undefined) throw new FsError("The path is unavailable in this DSH session.", "FS_NOT_FOUND");
      return fresh;
    }

    override async stat(target: FsTarget, signal?: AbortSignal) {
      const fresh = await this.admitted(target, signal);
      return fresh === undefined ? undefined : super.stat(fresh, signal);
    }

    override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!roots.some(root => rootContains(root, resolve(opts?.cwd ?? this.config.cwd, path)))) return undefined;
      const target = await super.resolve(path, opts);
      if (await this.admitted(target, signal) === undefined) return undefined;
      return super.lstat(path, opts, signal);
    }

    override async readText(target: FsTarget, signal?: AbortSignal) {
      return super.readText(await this.required(target, signal), signal);
    }

    override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) {
      return super.readBytes(await this.required(target, signal), signal, maxBytes);
    }

    override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal) {
      return super.readByteRange(await this.required(target, signal), range, signal);
    }

    override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
      return this.readStream(target, signal);
    }

    private async *readStream(target: FsTarget, signal?: AbortSignal): AsyncGenerator<string> {
      // Admission happens at iteration, immediately before the native stream
      // opens, rather than only when an unused iterable is requested.
      const chunks = await super.streamText(await this.required(target, signal), signal);
      yield* chunks;
    }

    override async listDir(target: FsTarget, signal?: AbortSignal) {
      const entries = await super.listDir(await this.required(target, signal), signal);
      const visible: FsDirEntry[] = [];
      for (const entry of entries) {
        const fresh = await this.admitted(entry.target, signal);
        if (fresh !== undefined) visible.push({ ...entry, target: fresh });
      }
      return visible;
    }
  };
}

/** Cordis's real named-module plugin contract. The child class shares the
 * installation's Sandbox/Cordis owner; required consumers wait for its marker. */
export async function apply(ctx: ConstructorParameters<typeof SandboxedFileSystem>[0], config: ConstructorParameters<typeof SandboxedFileSystem>[1]): Promise<void> {
  // The stock bundled root bypasses ctx.fs. Refuse even an unexpected native
  // boot-time reintroduction instead of activating a partially fenced child.
  if (process.env.DSH_BUNDLED_SKILL_DIR !== undefined) throw new Error("DSH bundled skills cannot bypass the bound filesystem.");
  const document: unknown = JSON.parse(await readFile(new URL("./read-policy.json", import.meta.url), "utf8"));
  const authority = parseDshFileAuthority(document);
  if (config.cwd !== authority.cwd) throw new Error("DSH filesystem config and trusted authority disagree.");
  const backend = await createDshReadFileSystem(authority);
  await ctx.plugin(backend, config);
}
