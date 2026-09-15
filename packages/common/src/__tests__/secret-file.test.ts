import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRestrictedMode, readOrCreateSecretFile, writeSecretFile } from "../secret-file.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

posixOnly("restricted secret files", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kr-secret-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("flushes candidate bytes before rename and its directory before reporting success", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const order: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { order.push(String(args[0]) === dir ? "directory-sync" : "file-sync"); await sync(); });
      return handle;
    });
    vi.mocked(fs.rename).mockImplementation(async (...args) => { order.push("rename"); await actual.rename(...args); });
    await writeSecretFile(join(dir, "activation-attempt.json"), "non-secret-nonce");
    expect(order).toEqual(["file-sync", "rename", "directory-sync"]);
  });

  it("creates a 0600 file once and returns the same value afterwards", async () => {
    const args = { bytes: 32, dataDir: dir, encoding: "base64url" as const, fileName: "control.token" };
    const first = await readOrCreateSecretFile(args);
    const second = await readOrCreateSecretFile(args);
    expect(first).toBe(second);
    expect((await stat(join(dir, "control.token"))).mode & 0o777).toBe(0o600);
  });

  it("repairs a permissive mode on start", async () => {
    const path = join(dir, "instance-key.jwk");
    await writeSecretFile(path, "{}");
    await chmod(path, 0o644);
    await assertRestrictedMode(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("writes atomically through a temp file", async () => {
    const path = join(dir, "nested", "lease.json");
    await writeSecretFile(path, "one");
    await writeSecretFile(path, "two");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
