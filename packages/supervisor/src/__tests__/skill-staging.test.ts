import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, lstat, chmod, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageOrganizationSkills } from "../skills/staging.js";
import { computeRemoteFileTreeDigest, computeRemoteSkillCatalogDigest } from "../../../common/src/contracts.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = Date.parse("2026-09-06T10:00:00Z");
const binding = { workspaceId: "org", sessionId: "s", assignmentId: "a", attempt: 1, instanceId: "i" };
function tree(missingSkill = false) {
  const files = [
    [missingSkill ? "README.md" : "SKILL.md", Buffer.from("# Review\nRead references/rules.md; run scripts/check.sh."), 0o600],
    ["references/rules.md", Buffer.from("Check the artifact."), 0o600],
    ["scripts/check.sh", Buffer.from("#!/bin/sh\nexit 0\n"), 0o700],
    ["assets/bytes.bin", Buffer.from([0, 255, 13]), 0o600],
  ] as const;
  const entries = files.map(([path, bytes, mode]) => ({ path, mode, sizeBytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, contentBase64: bytes.toString("base64") }));
  return { format: "konteks-file-tree-v1" as const, treeDigest: computeRemoteFileTreeDigest(entries), entries };
}
function catalog(t = tree(), scope = binding) {
  const body = { version: 1 as const, binding: scope, skills: [{ skillId: "skill1", version: "v1", name: "review", description: "Review source", required: true as const, transfer: {
    version: 1 as const, transferId: "t1", binding: scope, direction: "to_runtime" as const, purpose: "organization_skill" as const, revision: "skill-v1", artifactRef: "artifact:one", treeDigest: t.treeDigest,
    sizeBytes: t.entries.reduce((n, e) => n + e.sizeBytes, 0), fileCount: t.entries.length, expiresAt: "2026-09-06T11:00:00Z",
  } }] };
  return { ...body, catalogDigest: computeRemoteSkillCatalogDigest(body) };
}
async function setup(t = tree()) {
  const root = await mkdtemp(join(tmpdir(), "konteks-skills-test-")); roots.push(root);
  const c = catalog(t);
  const fetchTree = vi.fn(async () => t);
  const assertAuthorized = vi.fn(async () => undefined);
  return { root, c, fetchTree, assertAuthorized, args: { scratchRoot: join(root, "private"), catalog: c, authority: { binding, catalogDigest: c.catalogDigest }, now: () => now, fetchTree, assertAuthorized } };
}

describe("native organization skill staging", () => {
  it("stages the entire pinned tree privately without touching personal skills or executing scripts", async () => {
    const { root, args, fetchTree, assertAuthorized } = await setup();
    const personal = join(root, ".claude", "skills", "review");
    await mkdir(personal, { recursive: true }); await writeFile(join(personal, "SKILL.md"), "personal");
    const staged = await stageOrganizationSkills(args);
    expect(await readFile(staged.skills[0]!.skillFile, "utf8")).toContain("references/rules.md");
    expect(await readFile(join(staged.skills[0]!.directory, "assets/bytes.bin"))).toEqual(Buffer.from([0, 255, 13]));
    expect(await readFile(join(personal, "SKILL.md"), "utf8")).toBe("personal");
    expect(fetchTree).toHaveBeenCalledWith(args.catalog.skills[0]!.transfer);
    expect(assertAuthorized.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await lstat(staged.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(staged.skills[0]!.directory, "scripts/check.sh"))).mode & 0o777).toBe(0o700);
    expect(staged.catalogDigest).toBe(args.catalog.catalogDigest);
    expect((await readdir(args.scratchRoot)).some(p => p.startsWith(".stage-"))).toBe(false);
  });

  it("rejects a foreign binding or unapproved catalog before downloading or creating state", async () => {
    const { args, fetchTree } = await setup();
    for (const authority of [{ ...args.authority, binding: { ...binding, workspaceId: "other" } }, { ...args.authority, catalogDigest: `sha256:${"0".repeat(64)}` }]) {
      await expect(stageOrganizationSkills({ ...args, authority })).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    }
    expect(fetchTree).not.toHaveBeenCalled();
    await expect(lstat(args.scratchRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails missing required SKILL.md, corrupted bytes and fetch errors without committing partial files", async () => {
    for (const missing of [true, false]) {
      const { args } = await setup(tree(missing));
      if (!missing) args.fetchTree.mockResolvedValue({ ...tree(), treeDigest: `sha256:${"0".repeat(64)}` });
      await expect(stageOrganizationSkills(args)).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(await readdir(args.scratchRoot)).toEqual([]);
    }
    const { args } = await setup(); args.fetchTree.mockRejectedValue(new Error("secret raw network details"));
    const error = await stageOrganizationSkills(args).catch(e => e);
    expect(String(error)).not.toContain("secret raw");
    expect(error.cause).toBeUndefined();
    expect(await readdir(args.scratchRoot)).toEqual([]);
  });

  it("rechecks authorization and expiry after transfer; revoked or stale content is not committed", async () => {
    const { args } = await setup();
    args.assertAuthorized.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("revoked"));
    await expect(stageOrganizationSkills(args)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await readdir(args.scratchRoot)).toEqual([]);
    const second = await setup(); let current = now;
    second.args.fetchTree.mockImplementation(async () => { current += 2 * 3600_000; return tree(); });
    await expect(stageOrganizationSkills({ ...second.args, now: () => current })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await readdir(second.args.scratchRoot)).toEqual([]);
  });

  it("verifies cached bytes instead of trusting a completion marker", async () => {
    const { args, fetchTree } = await setup();
    const first = await stageOrganizationSkills(args);
    expect((await stageOrganizationSkills(args)).root).toBe(first.root);
    expect(fetchTree).toHaveBeenCalledTimes(1);
    await writeFile(first.skills[0]!.skillFile, "tampered");
    await expect(stageOrganizationSkills(args)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await readFile(first.skills[0]!.skillFile, "utf8")).toBe("tampered");
  });

  it.each(["symlink", "hardlink", "extra", "mode"])("rejects %s modifications to cached trees", async kind => {
    const { args, root } = await setup();
    const staged = await stageOrganizationSkills(args);
    const file = staged.skills[0]!.skillFile;
    if (kind === "extra") await writeFile(join(staged.skills[0]!.directory, "extra"), "unapproved");
    else if (kind === "mode") await chmod(file, 0o644);
    else {
      const outside = join(root, "outside"); await writeFile(outside, "outside");
      await rm(file); if (kind === "symlink") await symlink(outside, file); else await link(outside, file);
    }
    await expect(stageOrganizationSkills(args)).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("deduplicates concurrent staging and reuses identical content across assignments without refetching", async () => {
    const { args, fetchTree } = await setup();
    const [a, b] = await Promise.all([stageOrganizationSkills(args), stageOrganizationSkills(args)]);
    expect(a.root).toBe(b.root);
    const fetchesSoFar = fetchTree.mock.calls.length;
    // Another assignment carrying the SAME skills shares the staged tree: the
    // directory is keyed by content, and reuse revalidates it against THIS
    // assignment's own manifest instead of fetching it again.
    const other = catalog(tree(), { ...binding, assignmentId: "other" });
    const next = await stageOrganizationSkills({ ...args, catalog: other, authority: { binding: other.binding, catalogDigest: other.catalogDigest } });
    expect(next.root).toBe(a.root);
    expect(fetchTree.mock.calls.length).toBe(fetchesSoFar);
    expect(await readFile(a.skills[0]!.skillFile, "utf8")).toContain("# Review");
    // Different content is a different tree, staged apart and fetched once.
    const rules = Buffer.from("Check the artifact twice.");
    const entries = tree().entries.map(e => e.path === "references/rules.md"
      ? { ...e, sizeBytes: rules.length, digest: `sha256:${createHash("sha256").update(rules).digest("hex")}`, contentBase64: rules.toString("base64") }
      : e);
    const changedTree = { format: "konteks-file-tree-v1" as const, treeDigest: computeRemoteFileTreeDigest(entries), entries };
    const changed = catalog(changedTree, { ...binding, assignmentId: "changed" });
    const fetchChanged = vi.fn(async () => changedTree);
    const third = await stageOrganizationSkills({ ...args, catalog: changed, authority: { binding: changed.binding, catalogDigest: changed.catalogDigest }, fetchTree: fetchChanged });
    expect(third.root).not.toBe(a.root);
    expect(fetchChanged).toHaveBeenCalledTimes(1);
    expect(await readFile(join(third.skills[0]!.directory, "references/rules.md"), "utf8")).toBe("Check the artifact twice.");
  });

  it("retains digest-bound executable metadata on Windows instead of guessing it from stat", async () => {
    const { args } = await setup();
    vi.stubGlobal("process", new Proxy(process, { get(target, key) { return key === "platform" ? "win32" : Reflect.get(target, key); } }));
    const first = await stageOrganizationSkills(args);
    expect((await stageOrganizationSkills(args)).root).toBe(first.root);
    const path = join(first.root, ".catalog.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    expect(receipt.modes.review["scripts/check.sh"]).toBe(0o700);
    receipt.modes.review["scripts/check.sh"] = 0o600;
    await writeFile(path, JSON.stringify(receipt));
    await expect(stageOrganizationSkills(args)).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("rejects symlink or broad staging roots without modifying the target", async () => {
    const { root, args } = await setup(); const outside = join(root, "outside");
    await mkdir(outside); await symlink(outside, args.scratchRoot);
    await expect(stageOrganizationSkills(args)).rejects.toMatchObject({ code: "local_io_failure" });
    expect(await readdir(outside)).toEqual([]);
    await expect(stageOrganizationSkills({ ...args, scratchRoot: "/" })).rejects.toMatchObject({ code: "local_io_failure" });
  });
});
