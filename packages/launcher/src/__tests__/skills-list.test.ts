import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { listSkills } from "../native/control-commands.js";
import { createOutput } from "../output.js";

async function list(scope: unknown, json = false, locale: "en" | "id" = "en") {
  let text = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  const value = { skills: [{ skillId: "11111111-1111-4111-8111-111111111111", name: "review", version: "1.0.0", description: "Review", treeDigest: `sha256:${"a".repeat(64)}`, sizeBytes: 1, fileCount: 1, ...(scope ? { scope } : {}) }], catalogDigest: "catalog-a", installed: "unknown", loaded: "unknown" };
  const call = vi.fn(async (_request: unknown, schema: { parse(value: unknown): unknown }) => schema.parse(value));
  await listSkills({ output: createOutput({ json, stdout, locale }), control: { call } } as never);
  return { text, value };
}
it("shows selected application systems and initiative restrictions", async () => {
  const { text } = await list({ tenantId: "tenant-a", audience: { kind: "systems", systemRefs: ["system-a", "system-b"] }, context: { kind: "initiatives", initiativeRefs: ["initiative-a"] } });
  expect(text).toContain("Systems: system-a, system-b");
  expect(text).toContain("Initiatives: initiative-a");
  expect(text).toContain("1.0.0");
  expect(text).toContain("not yet verified");
});
it("shows personal owner and authorized global context in Indonesian", async () => {
  const { text } = await list({ tenantId: "tenant-a", audience: { kind: "personal", ownerUserRef: "user:default/alice" }, context: { kind: "global" } }, false, "id");
  expect(text).toContain("Pribadi: user:default/alice");
  expect(text).toContain("Semua konteks yang diizinkan");
});
it("does not infer organization scope for legacy catalog entries", async () => {
  const { text } = await list(undefined);
  expect(text).toContain("Unknown scope");
});
it("keeps JSON structured without adding terminal labels", async () => {
  const { text, value } = await list(undefined, true);
  expect(JSON.parse(text)).toEqual(value);
});

it("shows the organization tenant without treating global context as unrestricted access", async () => {
  const { text } = await list({ tenantId: "tenant-a", audience: { kind: "organization" }, context: { kind: "global" } });
  expect(text).toContain("Organization: tenant-a");
  expect(text).toContain("All authorized contexts");
});
