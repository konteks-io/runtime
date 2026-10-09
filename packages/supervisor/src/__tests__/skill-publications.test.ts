import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SkillPublicationStore } from "../state/skill-publications.js";
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-publications-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const id = "11111111-1111-4111-8111-111111111111";
function record(acceptedSequence = 1, tenantId = "tenant-a") {
  const treeDigest = `sha256:${"a".repeat(64)}`;
  return {
    version: 1,
    tenantId,
    runtimeId: "runtime-a",
    selection: {
      requestId: id,
      localId: "b".repeat(64),
      treeDigest,
      audience: { kind: "organization" },
      context: { kind: "global" },
      confirmation: { ongoingPublication: true },
    },
    receipt: { publicationId: id, revisionId: id, acceptedSequence, treeDigest },
  };
}
it("retains accepted intent across restart and refuses conflicting revision contents", async () => {
  await new SkillPublicationStore(dir).save(record());
  const files = await readdir(dir);
  expect(JSON.parse(await readFile(join(dir, files[0]!), "utf8"))).toEqual(record());
  await new SkillPublicationStore(dir).save(record());
  await expect(
    new SkillPublicationStore(dir).save({ ...record(), sourcePath: "/different" }),
  ).rejects.toThrow("revision changed");
});
it("serializes writes and never replaces newer acceptance with an older one", async () => {
  const store = new SkillPublicationStore(dir);
  await Promise.all([store.save(record(3)), store.save(record(2))]);
  const [file] = await readdir(dir);
  expect(JSON.parse(await readFile(join(dir, file!), "utf8")).receipt.acceptedSequence).toBe(3);
});
it("keeps tenant bindings separate and refuses mismatched artifact receipts", async () => {
  const store = new SkillPublicationStore(dir);
  await store.save(record());
  await store.save(record(1, "tenant-b"));
  expect(await readdir(dir)).toHaveLength(2);
  expect(() =>
    store.save({
      ...record(),
      receipt: { ...record().receipt, treeDigest: `sha256:${"f".repeat(64)}` },
    }),
  ).toThrow();
});

it("enumerates only consent retained for the exact tenant and runtime", async () => {
  const store = new SkillPublicationStore(dir);
  await store.save(record());
  await store.save(record(1, "tenant-b"));
  await store.save({ ...record(), runtimeId: "runtime-b" });
  expect(await store.list("tenant-a", "runtime-a")).toEqual([record()]);
  expect(
    await new SkillPublicationStore(join(dir, "absent")).list("tenant-a", "runtime-a"),
  ).toEqual([]);
});

it("accepts a repeated publication with a fresh request ID without rewriting consent", async () => {
  const store = new SkillPublicationStore(dir);
  await store.save(record());
  await new SkillPublicationStore(dir).save({
    ...record(),
    selection: { ...record().selection, requestId: "22222222-2222-4222-8222-222222222222" },
  });
  const [file] = await readdir(dir);
  expect(JSON.parse(await readFile(join(dir, file!), "utf8")).selection.requestId).toBe(id);
});

it("retains the accepted revision when a repeated request observes a newer base", async () => {
  const store = new SkillPublicationStore(dir);
  const selection = {
    ...record().selection,
    skillId: id,
    expectedRevision: "22222222-2222-4222-8222-222222222222",
  };
  const accepted = { ...record(), selection };
  await store.save(accepted);
  await store.save({ ...accepted, selection: { ...selection, expectedRevision: id } });
  expect(await store.list("tenant-a", "runtime-a")).toEqual([accepted]);
  await expect(
    store.save({
      ...accepted,
      selection: { ...selection, skillId: "33333333-3333-4333-8333-333333333333" },
    }),
  ).rejects.toThrow("Skill publication identity changed");
});

it("upgrades an explicitly reconfirmed legacy consent without replacing its original request", async () => {
  const store = new SkillPublicationStore(dir);
  await store.save(record());
  await store.save({
    ...record(),
    selection: {
      ...record().selection,
      requestId: "33333333-3333-4333-8333-333333333333",
      skillId: id,
      expectedRevision: id,
    },
  });
  expect((await store.list("tenant-a", "runtime-a"))[0]?.selection).toEqual({
    ...record().selection,
    skillId: id,
    expectedRevision: id,
  });
});

it("refuses changing the bound Skill even when the acceptance sequence advances", async () => {
  const store = new SkillPublicationStore(dir);
  const accepted = {
    ...record(),
    selection: { ...record().selection, skillId: id, expectedRevision: id },
  };
  await store.save(accepted);
  await expect(
    store.save({
      ...record(2),
      selection: {
        ...record(2).selection,
        skillId: "33333333-3333-4333-8333-333333333333",
        expectedRevision: id,
      },
    }),
  ).rejects.toThrow("Skill publication identity changed");
  expect(await store.list("tenant-a", "runtime-a")).toEqual([accepted]);
});
