import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireNativeRootLock, NATIVE_ROOT_LOCK_FILE } from "../native/root-lock.js";

let root: string;
const releases: Array<() => void> = [];
const children: ChildProcess[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-owner-")); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
  for (const release of releases.splice(0)) release();
  await rm(root, { recursive: true, force: true });
});
function acquire(path = root, onLost = vi.fn()) {
  const lock = acquireNativeRootLock(path, { onLost, checkIntervalMs: 20 });
  releases.push(() => lock.release());
  return lock;
}

describe("native data-root process ownership", () => {
  it("excludes another owner until release without deleting or replacing the lock inode", async () => {
    const lock = acquire();
    const before = await stat(join(root, NATIVE_ROOT_LOCK_FILE));
    expect(() => acquire()).toThrow();
    lock.assertOwned();
    lock.release();
    lock.release();
    const next = acquire();
    next.assertOwned();
    expect((await stat(join(root, NATIVE_ROOT_LOCK_FILE))).ino).toBe(before.ino);
    expect(() => lock.assertOwned()).toThrow();
  });

  it("rejects linked or permissive state without modifying the target", async () => {
    const target = join(root, "untouched");
    await writeFile(target, "do-not-modify", { mode: 0o600 });
    await symlink(target, join(root, NATIVE_ROOT_LOCK_FILE));
    expect(() => acquire()).toThrow();
    expect(await readFile(target, "utf8")).toBe("do-not-modify");
    await rm(join(root, NATIVE_ROOT_LOCK_FILE));
    if (process.platform !== "win32") {
      await chmod(root, 0o755);
      expect(() => acquire()).toThrow();
      await chmod(root, 0o700);
    }
  });

  it("fails closed once if its backing file is replaced and never reacquires", async () => {
    const lost = vi.fn();
    const lock = acquire(root, lost);
    await rename(join(root, NATIVE_ROOT_LOCK_FILE), join(root, "retained-lock"));
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
    expect(() => lock.assertOwned()).toThrow();
    lock.release();
    expect(await stat(join(root, "retained-lock"))).toBeDefined();
  });

  it("keeps a paused process exclusive and recovers immediately after process death", async () => {
    const moduleUrl = new URL("../../dist/native/root-lock.js", import.meta.url).href;
    const code = `import { acquireNativeRootLock } from ${JSON.stringify(moduleUrl)}; const lock = acquireNativeRootLock(process.argv[1]); process.send('ready'); process.on('message', () => { lock.release(); process.exit(0); });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    const ready = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("ownership child exited before readiness"); })]);
    expect(ready[0]).toBe("ready");
    expect(() => acquire()).toThrow();
    if (process.platform !== "win32") {
      child.kill("SIGSTOP");
      expect(() => acquire()).toThrow();
    }
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    acquire().assertOwned();
  });
});
