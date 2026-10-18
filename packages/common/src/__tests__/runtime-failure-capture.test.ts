import { link, lstat, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeFailureCapture, readRuntimeFailureCapture, writeRuntimeFailureCapture } from "../runtime-failure-capture.js";
import { jcsDigest } from "../digest.js";
import type { JsonValue } from "../jcs.js";
import type { RuntimeFailureObservation } from "../contracts.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lifecycle-capture-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

function observation(failureId = "update-one"): RuntimeFailureObservation {
  return {
    schemaVersion: 1, failureId, observedAt: "2026-10-18T07:00:00Z",
    instanceId: "instance", scope: { kind: "runtime" }, phase: "preparation",
    stage: "native_update_stage", code: "native_update_stage_failed",
    evidence: { kind: "runtime_exception" },
  };
}

it("publishes one private immutable identity-bound lifecycle capture and converges exact retries", async () => {
  const capture = createRuntimeFailureCapture("tenant", observation());
  expect(capture.failureDigest).toBe(jcsDigest(capture.observation as unknown as JsonValue));
  expect(Object.isFrozen(capture.observation)).toBe(true);
  const path = await writeRuntimeFailureCapture(dir, capture);
  const bytes = await readFile(path, "utf8");
  await expect(writeRuntimeFailureCapture(dir, capture)).resolves.toBe(path);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect((await lstat(path)).nlink).toBe(1);
  expect((await readRuntimeFailureCapture(path))?.capture).toEqual(capture);
  if (process.platform !== "win32") expect((await lstat(path)).mode & 0o077).toBe(0);
});

it("refuses changed bytes under one captured failure identity without replacing the original", async () => {
  const capture = createRuntimeFailureCapture("tenant", observation());
  const path = await writeRuntimeFailureCapture(dir, capture);
  const bytes = await readFile(path, "utf8");
  const changed = createRuntimeFailureCapture("tenant", { ...observation(), code: "different_failure" });
  await expect(writeRuntimeFailureCapture(dir, changed)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(bytes);
});

it("rejects raw exception fields instead of retaining them in the capture envelope", () => {
  const raw = { ...observation(), message: "private URL and local path" } as unknown as RuntimeFailureObservation;
  expect(() => createRuntimeFailureCapture("tenant", raw)).toThrow();
});

it.skipIf(process.platform === "win32")("refuses a symlink at a published capture name without touching its target", async () => {
  const capture = createRuntimeFailureCapture("tenant", observation());
  const path = await writeRuntimeFailureCapture(dir, capture);
  const kept = `${path}.kept`;
  await rename(path, kept);
  await symlink(kept, path);
  await expect(readRuntimeFailureCapture(path)).rejects.toThrow();
  await expect(writeRuntimeFailureCapture(dir, capture)).rejects.toThrow();
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(JSON.parse(await readFile(kept, "utf8"))).toEqual(capture);
});

it("recovers the exact publication link left by a crash before pending-file cleanup", async () => {
  const capture = createRuntimeFailureCapture("tenant", observation());
  const path = await writeRuntimeFailureCapture(dir, capture);
  await link(path, `${path}.pending`);
  expect((await lstat(path)).nlink).toBe(2);
  await expect(writeRuntimeFailureCapture(dir, capture)).resolves.toBe(path);
  expect((await lstat(path)).nlink).toBe(1);
  await expect(lstat(`${path}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readRuntimeFailureCapture(path))?.capture).toEqual(capture);
});

it("does not recover an unexpected hard link or remove a mismatched pending file", async () => {
  const capture = createRuntimeFailureCapture("tenant", observation());
  const path = await writeRuntimeFailureCapture(dir, capture);
  const extra = `${path}.extra`;
  await link(path, extra);
  await expect(readRuntimeFailureCapture(path)).rejects.toThrow();
  await writeFile(`${path}.pending`, JSON.stringify(capture), { mode: 0o600 });
  await expect(readRuntimeFailureCapture(path)).rejects.toThrow();
  expect((await lstat(path)).nlink).toBe(2);
  expect((await lstat(extra)).ino).toBe((await lstat(path)).ino);
  expect((await lstat(`${path}.pending`)).nlink).toBe(1);
});

it("keeps all fifty unhanded-off captures when capture capacity is exhausted", async () => {
  const paths: string[] = [];
  for (let n = 0; n < 50; n += 1) paths.push(await writeRuntimeFailureCapture(dir, createRuntimeFailureCapture("tenant", observation(`update-${n}`))));
  await expect(writeRuntimeFailureCapture(dir, createRuntimeFailureCapture("tenant", observation("update-overflow")))).rejects.toThrow();
  for (const path of paths) expect((await lstat(path)).isFile()).toBe(true);
  expect(dirname(paths[0]!)).toBe(dirname(paths[49]!));
});

it("recovers an already-admitted fiftieth capture left pending before publication", async () => {
  const retained: string[] = [];
  for (let n = 0; n < 49; n += 1) retained.push(await writeRuntimeFailureCapture(dir, createRuntimeFailureCapture("tenant", observation(`retained-${n}`))));
  const capture = createRuntimeFailureCapture("tenant", observation("admitted-fiftieth"));
  const path = await writeRuntimeFailureCapture(dir, capture);
  const bytes = await readFile(path, "utf8");
  // Reuse the real writer's private bytes and identity, at the pre-link crash boundary.
  await rename(path, `${path}.pending`);
  expect(await readdir(dirname(path))).toHaveLength(50);
  expect((await lstat(`${path}.pending`)).nlink).toBe(1);

  await expect(writeRuntimeFailureCapture(dir, capture)).resolves.toBe(path);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect((await readRuntimeFailureCapture(path))?.capture).toEqual(capture);
  expect((await lstat(path)).nlink).toBe(1);
  await expect(lstat(`${path}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  for (const kept of retained) expect((await lstat(kept)).isFile()).toBe(true);
});

it.skipIf(process.platform === "win32")("waits for its existing owner's directory durability barrier on the first capture", async () => {
  const owner = await lstat(dir);
  await expect(lstat(join(dir, "runtime-failure-captures"))).rejects.toMatchObject({ code: "ENOENT" });
  const handle = await open(dir, "r");
  const prototype = Object.getPrototypeOf(handle);
  const sync = prototype.sync;
  await handle.close();
  let enterOwnerSync!: () => void;
  let releaseOwnerSync!: () => void;
  const ownerSync = new Promise<void>(resolve => { enterOwnerSync = resolve; });
  const released = new Promise<void>(resolve => { releaseOwnerSync = resolve; });
  vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    const current = await this.stat();
    if (current.isDirectory() && current.dev === owner.dev && current.ino === owner.ino) {
      enterOwnerSync();
      await released;
    }
    await sync.call(this);
  });
  let completed = false;
  const writing = writeRuntimeFailureCapture(dir, createRuntimeFailureCapture("tenant", observation()))
    .then(path => { completed = true; return path; });
  try {
    const boundary = await Promise.race([
      ownerSync.then(() => "owner-sync-held"),
      writing.then(() => "write-returned"),
    ]);
    expect(boundary).toBe("owner-sync-held");
    expect(completed).toBe(false);
  } finally {
    releaseOwnerSync();
    await writing;
  }
});
