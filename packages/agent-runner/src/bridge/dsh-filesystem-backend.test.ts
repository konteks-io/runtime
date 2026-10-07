import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Inject } from "@deepseek-ai/cordis";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDshReadFileSystem, parseDshFileAuthority } from "./dsh-filesystem-backend.js";

let root: string, cwd: string, selected: string, outside: string;
const contexts: Context[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "konteks-dsh-read-fence-"));
  cwd = join(root, "workspace"); selected = join(root, "selected"); outside = join(root, "outside");
  for (const path of [cwd, selected, outside]) await mkdir(path);
  for (const path of [cwd, selected, outside]) await writeFile(join(path, "SKILL.md"), "---\nname: fixture\ndescription: public fixture\n---\nlocal content\n");
});
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
});

async function backend(workingCopy = cwd, mode: "read-only" | "workspace-write" = "workspace-write"): Promise<FileSystem> {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide("sandboxPolicy", { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: workingCopy }) });
  const Backend = await createDshReadFileSystem({ cwd: workingCopy, readOnlyRoots: [selected] });
  await ctx.plugin(Backend, { cwd: workingCopy });
  expect(ctx.get("konteksFileAuthority")).toMatchObject({ cwd: workingCopy, readOnlyRoots: [selected] });
  return ctx.fs;
}

async function textStream(fs: FileSystem, target: FsTarget): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of await fs.streamText(target)) parts.push(chunk);
  return parts.join("");
}

type ReadOperation = (fs: FileSystem, target: FsTarget) => Promise<unknown>;
const reads: Array<[string, ReadOperation]> = [
  ["text", (fs, target) => fs.readText(target)],
  ["stream", textStream],
  ["bytes", (fs, target) => fs.readBytes(target, undefined, 4096)],
  ["byte range", (fs, target) => fs.readByteRange(target, { offset: 0, length: 16 })],
];

describe("native filesystem read authority", () => {
  it.each(reads)("refuses outside %s before returning content", async (_name, read) => {
    const fs = await backend();
    const target = await fs.resolve(join(outside, "SKILL.md"));
    await expect(read(fs, target)).rejects.toMatchObject({ code: "FS_NOT_FOUND" });
  });

  it("preserves workspace and selected skill reads, listing and ancestor metadata absence", async () => {
    const fs = await backend();
    expect(await fs.readText(await fs.resolve("SKILL.md"))).toContain("local content");
    expect(await textStream(fs, await fs.resolve(join(selected, "SKILL.md")))).toContain("local content");
    expect((await fs.listDir(await fs.resolve(cwd))).map(entry => entry.name)).toEqual(["SKILL.md"]);
    expect(await fs.stat(await fs.resolve(root))).toBeUndefined();
    expect(await fs.lstat(join(outside, "SKILL.md"))).toBeUndefined();
    await expect(fs.listDir(await fs.resolve(outside))).rejects.toMatchObject({ code: "FS_NOT_FOUND" });
  });

  it("refuses a followed directory symlink escape while retaining an admitted root alias", async () => {
    await symlink(outside, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
    const alias = join(root, "workspace-alias");
    await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const fs = await backend(alias);
    await expect(fs.readText(await fs.resolve("escape/SKILL.md"))).rejects.toMatchObject({ code: "FS_NOT_FOUND" });
    expect((await fs.listDir(await fs.resolve(alias))).map(entry => entry.name)).toEqual(["SKILL.md"]);
    expect(await fs.readText(await fs.resolve("SKILL.md"))).toContain("local content");
    // Native skill discovery stores processPath(target), then get/stream
    // resolves that canonical spelling again, including /tmp-style aliases.
    const canonical = fs.processPath(await fs.resolve("SKILL.md"));
    expect(await fs.readText(await fs.resolve(canonical))).toContain("local content");
    expect(await textStream(fs, await fs.resolve(canonical))).toContain("local content");
  });

  it("rechecks an unused stream target when iteration begins", async () => {
    const fs = await backend();
    const path = join(cwd, "SKILL.md");
    const stream = await fs.streamText(await fs.resolve(path));
    await unlink(path);
    await symlink(join(outside, "SKILL.md"), path, "file");
    await expect((async () => { for await (const _chunk of stream) throw new Error("Outside content was yielded."); })()).rejects.toMatchObject({ code: "FS_NOT_FOUND" });
  });

  it("refuses a selected-root identity change", async () => {
    const fs = await backend();
    await rename(selected, join(root, "old-selected"));
    await symlink(outside, selected, process.platform === "win32" ? "junction" : "dir");
    await expect(fs.readText(await fs.resolve(join(selected, "SKILL.md")))).rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });
  });

  it("retains genuine sandbox write/edit, version guards and read-only refusal", async () => {
    const fs = await backend();
    const target = await fs.resolve("notes.txt");
    const written = await fs.writeText(target, "before");
    const edited = await fs.editText(target, { oldString: "before", newString: "after", replaceAll: false }, { version: written.version });
    expect(edited.after).toBe("after");
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("after");
    await expect(fs.editText(target, { oldString: "after", newString: "bad", replaceAll: false }, { version: written.version })).rejects.toMatchObject({ code: "FS_STALE_VERSION" });
    const readOnly = await backend(cwd, "read-only");
    await expect(readOnly.writeText(await readOnly.resolve("notes.txt"), "bad")).rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });
  });

  it("retains module dependencies when native loader entry injections are merged", async () => {
    const ctx = new Context();
    contexts.push(ctx);
    const dependencies = Inject.resolve(["skills"]);
    // This is the genuine loader's Inject.resolve(entry.inject, fiber.inject)
    // operation; existing module dependencies remain in the same native map.
    Inject.resolve(["fs", "konteksFileAuthority"], dependencies);
    let active = false;
    const fiber = ctx.plugin({ inject: dependencies, apply() { active = true; } });
    expect(Object.keys(fiber.inject).sort()).toEqual(["fs", "konteksFileAuthority", "skills"]);
    await fiber;
    expect(active).toBe(false);
    ctx.provide("skills", {});
    ctx.provide("fs", {});
    await fiber;
    expect(active).toBe(false);
    ctx.provide("konteksFileAuthority", {});
    await fiber;
    expect(active).toBe(true);
  });

  it("rejects malformed authority rather than defaulting to process cwd", () => {
    expect(() => parseDshFileAuthority({ cwd: ".", readOnlyRoots: [] })).toThrow();
    expect(() => parseDshFileAuthority({ cwd, readOnlyRoots: [null] })).toThrow();
  });
});
