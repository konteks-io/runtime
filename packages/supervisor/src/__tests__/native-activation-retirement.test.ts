import { mkdtemp, readFile, readdir, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSecretFile } from "@konteks/remote-common";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { archiveRetiredActivation, completeActivationRetirement, resumeActivationRetirement } from "../native/activation-retirement.js";

const fault = vi.hoisted(() => ({ failAt: 0, moves: 0 }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, rename: async (...args: Parameters<typeof real.rename>) => {
    if (String(args[1]).replaceAll("\\", "/").includes("/data/")) {
      fault.moves++;
      if (fault.moves === fault.failAt) throw new Error("interrupted archive");
    }
    return real.rename(...args);
  } };
});

let root: string;
let owner: ReturnType<typeof acquireNativeRootLock>;
const previous = { previousActivationId: "previous", activationId: "replacement", keyDigest: "old-key-digest" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "activation-retirement-")); owner = acquireNativeRootLock(root);
  fault.moves = 0; fault.failAt = 0;
  await writeSecretFile(join(root, "instance-key.jwk"), "original-private-fixture");
  await writeSecretFile(join(root, "activation-attempt.json"), "original-attempt-fixture");
  await mkdir(join(root, "journal")); await writeSecretFile(join(root, "journal", "retained"), "original-journal-fixture");
});
afterEach(async () => { owner.release(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function archive() {
  const names = await readdir(join(root, "retired-enrollments"));
  expect(names).toHaveLength(1);
  return join(root, "retired-enrollments", names[0]!);
}

describe("confirmed unstarted enrollment retirement", () => {
  it("preserves private state under exclusive ownership until a different replacement key is seeded", async () => {
    await archiveRetiredActivation(root, previous, owner);
    owner.assertOwned();
    const kept = await archive();
    expect(await readFile(join(kept, "data", "instance-key.jwk"), "utf8")).toBe("original-private-fixture");
    expect(await readFile(join(kept, "data", "journal", "retained"), "utf8")).toBe("original-journal-fixture");
    await expect(completeActivationRetirement(root, { activationId: "replacement", keyDigest: previous.keyDigest }, owner)).rejects.toMatchObject({ code: "recovery_required" });
    await completeActivationRetirement(root, { activationId: "replacement", keyDigest: "new-key-digest" }, owner);
    expect(await resumeActivationRetirement(root, "replacement", owner)).toBeNull();
    expect(await readFile(join(kept, "data", "instance-key.jwk"), "utf8")).toBe("original-private-fixture");
  });

  it("finishes an interrupted archive without deleting or duplicating its original entries", async () => {
    fault.failAt = 2;
    await expect(archiveRetiredActivation(root, previous, owner)).rejects.toThrow("interrupted archive");
    fault.failAt = 0;
    expect((await resumeActivationRetirement(root, "replacement", owner))?.state).toBe("ready");
    const kept = await archive();
    expect(await readFile(join(kept, "data", "instance-key.jwk"), "utf8")).toBe("original-private-fixture");
    expect(await readFile(join(kept, "data", "activation-attempt.json"), "utf8")).toBe("original-attempt-fixture");
    await expect(resumeActivationRetirement(root, "different-command", owner)).rejects.toMatchObject({ code: "recovery_required" });
  });

  it("refuses a redirected archive destination before moving the original key", async () => {
    const outside = await mkdtemp(join(tmpdir(), "activation-outside-"));
    try {
      await symlink(outside, join(root, "retired-enrollments"), process.platform === "win32" ? "junction" : "dir");
      await expect(archiveRetiredActivation(root, previous, owner)).rejects.toMatchObject({ code: "recovery_required" });
      expect(await readFile(join(root, "instance-key.jwk"), "utf8")).toBe("original-private-fixture");
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
