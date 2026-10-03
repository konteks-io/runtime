import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRemoteFileTreeDigest, sha256Hex } from "@konteks/remote-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeAgentHomeSkillLinks, syncAgentHomeSkills, verifyAgentHomeSkillRead } from "../skills/home-sync.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "konteks-home-skills-")); roots.push(root);
  const home = join(root, ".claude-deepseek"); await mkdir(home, { mode: 0o700 });
  const stage = async (version: string, ids = ["review"]) => {
    const directory = join(root, `skills-${version}`); await mkdir(directory, { mode: 0o700 });
    const skills = await Promise.all(ids.map(async id => {
      const folder = join(directory, `org-${id}`); await mkdir(folder, { mode: 0o700 });
      await writeFile(join(folder, "SKILL.md"), `---\nname: ${id}\ndescription: Test\n---\n${version}`, { mode: 0o600 });
      await mkdir(join(folder, "references"), { mode: 0o700 });
      await writeFile(join(folder, "references", "rules.md"), version, { mode: 0o600 });
      await mkdir(join(folder, "scripts"), { mode: 0o700 });
      await writeFile(join(folder, "scripts", "check.sh"), "#!/bin/sh\nprintf 'skill-ok'\n", { mode: 0o700 });
      await mkdir(join(folder, "assets"), { mode: 0o700 });
      await writeFile(join(folder, "assets", "sample.bin"), Buffer.from([0, 1, 255]), { mode: 0o600 });
      const entries = await Promise.all(["SKILL.md", "references/rules.md", "scripts/check.sh", "assets/sample.bin"].map(async path => {
        const bytes = await readFile(join(folder, path));
        return { path, mode: path.startsWith("scripts/") ? 0o700 as const : 0o600 as const, sizeBytes: bytes.length, digest: `sha256:${sha256Hex(bytes)}`, contentBase64: bytes.toString("base64") };
      }));
      return { skillId: id, version, name: `org-${id}`, description: "Test", directory: folder, skillFile: join(folder, "SKILL.md"),
        treeDigest: computeRemoteFileTreeDigest(entries), fileModes: Object.fromEntries(entries.map(e => [e.path, e.mode])) };
    }));
    return { root: directory, catalogDigest: version, skills };
  };
  const owner = { workspaceId: "workspace-a", instanceId: "machine-a" };
  const assertAuthorized = vi.fn(async () => undefined);
  return { root, home, stage, owner, assertAuthorized };
}

describe("native agent home Skill delivery", () => {
  it("preflights every cleanup collision before removing any owned link", async () => {
    const f = await fixture(); const paths = await syncAgentHomeSkills({ ...f, staged: await f.stage("1", ["review", "build"]) });
    const retained = await readlink(paths[0]!);
    await unlink(paths[1]!);
    await mkdir(paths[1]!); await writeFile(join(paths[1]!, "SKILL.md"), "personal replacement");
    await expect(removeAgentHomeSkillLinks(f)).rejects.toMatchObject({ code: "local_io_failure" });
    expect(await readlink(paths[0]!)).toBe(retained);
    expect(await readFile(join(paths[1]!, "SKILL.md"), "utf8")).toBe("personal replacement");
    expect(await readFile(join(f.home, ".konteks-skill-sync", "state.json"))).toBeDefined();
  });
  it("resumes cleanup after a recorded link was already removed", async () => {
    const f = await fixture(); const paths = await syncAgentHomeSkills({ ...f, staged: await f.stage("1", ["review", "build"]) });
    await unlink(paths[0]!);
    expect(await removeAgentHomeSkillLinks(f)).toBe(1);
    await expect(readlink(paths[1]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes interrupted publication links recorded only in pending ownership", async () => {
    const f = await fixture(); const paths = await syncAgentHomeSkills({ ...f, staged: await f.stage("1") });
    const statePath = join(f.home, ".konteks-skill-sync", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { links: Record<string, string>; pending?: Record<string, string> };
    state.pending = state.links; state.links = {};
    await writeFile(statePath, JSON.stringify(state));
    expect(await removeAgentHomeSkillLinks(f)).toBe(1);
    await expect(readlink(paths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes owned discovery links and binding while preserving personal Skills", async () => {
    const f = await fixture(); const staged = await f.stage("1");
    const paths = await syncAgentHomeSkills({ ...f, staged });
    await mkdir(join(f.home, "skills", "personal"));
    await writeFile(join(f.home, "skills", "personal", "SKILL.md"), "personal");
    expect(await removeAgentHomeSkillLinks(f)).toBe(1);
    await expect(readlink(paths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(f.home, ".konteks-skill-sync", "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.home, "skills", "personal", "SKILL.md"), "utf8")).toBe("personal");
    expect(await removeAgentHomeSkillLinks(f)).toBe(0);
  });
  it("refuses removal for a different runtime owner", async () => {
    const f = await fixture(); const paths = await syncAgentHomeSkills({ ...f, staged: await f.stage("1") });
    await expect(removeAgentHomeSkillLinks({ ...f, owner: { ...f.owner, instanceId: "other" } })).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    expect(await readlink(paths[0]!)).toBeDefined();
  });
  it("creates missing owned parents for a nested native agent home", async () => {
    const f = await fixture(); const home = join(f.root, ".config", "opencode");
    const staged = await f.stage("1");
    const paths = await syncAgentHomeSkills({ ...f, home, staged });
    expect(await readFile(join(paths[0]!, "SKILL.md"), "utf8")).toContain("1");
    if (process.platform !== "win32") expect((await stat(join(f.root, ".config"))).mode & 0o777).toBe(0o700);
  });
  it("refuses a linked parent before creating a nested agent home", async () => {
    const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside);
    await symlink(outside, join(f.root, ".config"), process.platform === "win32" ? "junction" : "dir");
    await expect(syncAgentHomeSkills({ ...f, home: join(f.root, ".config", "opencode"), staged: await f.stage("1") })).rejects.toMatchObject({ code: "local_io_failure" });
    await expect(stat(join(outside, "opencode"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform === "win32")("refuses a writable parent before creating a nested agent home", async () => {
    const f = await fixture(); const parent = join(f.root, ".config"); await mkdir(parent); await chmod(parent, 0o777);
    await expect(syncAgentHomeSkills({ ...f, home: join(parent, "opencode"), staged: await f.stage("1") })).rejects.toMatchObject({ code: "local_io_failure" });
    await expect(stat(join(parent, "opencode"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("publishes a complete staged Skill in the selected profile without changing personal Skills", async () => {
    const f = await fixture(); const personal = join(f.home, "skills", "personal");
    await mkdir(personal, { recursive: true }); await writeFile(join(personal, "SKILL.md"), "personal");
    const staged = await f.stage("1");
    const paths = await syncAgentHomeSkills({ ...f, staged });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(join(".claude-deepseek", "skills", "konteks-"));
    expect(await readlink(paths[0]!)).toContain(join(".claude-deepseek", ".konteks-skill-sync", "trees"));
    expect(await readFile(join(paths[0]!, "references", "rules.md"), "utf8")).toBe("1");
    expect(await readFile(join(paths[0]!, "assets", "sample.bin"))).toEqual(Buffer.from([0, 1, 255]));
    if (process.platform !== "win32") expect((await stat(join(paths[0]!, "scripts", "check.sh"))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(personal, "SKILL.md"), "utf8")).toBe("personal");
  });
  it("keeps complete Skill files after the runtime staging cache is removed", async () => {
    const f = await fixture(); const staged = await f.stage("1");
    const paths = await syncAgentHomeSkills({ ...f, staged });
    await rm(staged.root, { recursive: true });
    expect(await readFile(join(paths[0]!, "SKILL.md"), "utf8")).toContain("1");
    expect(await readFile(join(paths[0]!, "references", "rules.md"), "utf8")).toBe("1");
  });
  it("refuses a modified staged reference before publishing an agent home link", async () => {
    const f = await fixture(); const staged = await f.stage("1");
    await writeFile(join(staged.skills[0]!.directory, "references", "rules.md"), "tampered");
    await expect(syncAgentHomeSkills({ ...f, staged })).rejects.toMatchObject({ code: "capability_unavailable" });
    await expect(readlink(join(f.home, "skills", `konteks-${sha256Hex("review")}`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves but refuses an edited retained copy on a later sync", async () => {
    const f = await fixture(); const staged = await f.stage("1");
    const paths = await syncAgentHomeSkills({ ...f, staged });
    await writeFile(join(paths[0]!, "references", "rules.md"), "personal edit");
    await expect(syncAgentHomeSkills({ ...f, staged })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(await readFile(join(paths[0]!, "references", "rules.md"), "utf8")).toBe("personal edit");
    expect(await readFile(join(staged.skills[0]!.directory, "references", "rules.md"), "utf8")).toBe("1");
  });
  it("updates and removes only links owned by the same workspace and machine", async () => {
    const f = await fixture();
    const first = await syncAgentHomeSkills({ ...f, staged: await f.stage("1", ["review", "testing"]) });
    const second = await syncAgentHomeSkills({ ...f, staged: await f.stage("2") });
    expect(second[0]).toBe(first[0]);
    expect(await readFile(join(second[0]!, "SKILL.md"), "utf8")).toContain("2");
    await expect(readlink(first[1]!)).rejects.toMatchObject({ code: "ENOENT" });
    await syncAgentHomeSkills({ ...f, staged: await f.stage("3", []) });
    await expect(readlink(first[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["workspaceId", "instanceId"] as const)("refuses another %s before changing a home", async key => {
    const f = await fixture(); const staged = await f.stage("1");
    const paths = await syncAgentHomeSkills({ ...f, staged });
    await expect(syncAgentHomeSkills({ ...f, owner: { ...f.owner, [key]: "other" }, staged: await f.stage("2") })).rejects.toMatchObject({ code: "workspace_binding_invalid" });
    expect(await readFile(join(paths[0]!, "SKILL.md"), "utf8")).toContain("1");
  });
  it("refuses a replaced managed link and preserves the user's replacement", async () => {
    const f = await fixture(); const paths = await syncAgentHomeSkills({ ...f, staged: await f.stage("1") });
    await rm(paths[0]!); await mkdir(paths[0]!); await writeFile(join(paths[0]!, "SKILL.md"), "personal replacement");
    await expect(syncAgentHomeSkills({ ...f, staged: await f.stage("2") })).rejects.toMatchObject({ code: "local_io_failure" });
    expect(await readFile(join(paths[0]!, "SKILL.md"), "utf8")).toBe("personal replacement");
  });
  it("refuses linked profile or Skills roots", async () => {
    const f = await fixture(); const linked = join(f.root, "linked-profile");
    await symlink(f.home, linked, "junction");
    await expect(syncAgentHomeSkills({ ...f, home: linked, staged: await f.stage("1") })).rejects.toMatchObject({ code: "local_io_failure" });
    await symlink(f.root, join(f.home, "skills"), "junction");
    await expect(syncAgentHomeSkills({ ...f, staged: await f.stage("2") })).rejects.toMatchObject({ code: "local_io_failure" });
  });
  it("does not publish when live authority has been lost", async () => {
    const f = await fixture(); const staged = await f.stage("1");
    const paths = await syncAgentHomeSkills({ ...f, staged });
    await expect(syncAgentHomeSkills({ ...f, staged: await f.stage("2"), assertAuthorized: async () => { throw new Error("revoked"); } })).rejects.toThrow("revoked");
    expect(await readFile(join(paths[0]!, "SKILL.md"), "utf8")).toContain("1");
  });
  it("recovers an interrupted update without adopting unrelated folders", async () => {
    const f = await fixture(); const old = await f.stage("1", ["review", "testing"]);
    const paths = await syncAgentHomeSkills({ ...f, staged: old });
    const next = await f.stage("2", ["review", "new-skill"]);
    const statePath = join(f.home, ".konteks-skill-sync", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.pending = Object.fromEntries(next.skills.map(s => [`konteks-${sha256Hex(s.skillId)}`, s.directory]));
    await writeFile(statePath, JSON.stringify(state));
    await rm(paths[0]!); await symlink(next.skills[0]!.directory, paths[0]!, "junction");
    const added = join(f.home, "skills", `konteks-${sha256Hex("new-skill")}`);
    await symlink(next.skills[1]!.directory, added, "junction");
    const final = await syncAgentHomeSkills({ ...f, staged: await f.stage("3") });
    expect(await readFile(join(final[0]!, "SKILL.md"), "utf8")).toContain("3");
    await expect(readlink(added)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readlink(paths[1]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses an existing personal folder even if it uses a managed-looking name", async () => {
    const f = await fixture(); const path = join(f.home, "skills", `konteks-${sha256Hex("review")}`);
    await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), "personal");
    await expect(syncAgentHomeSkills({ ...f, staged: await f.stage("1") })).rejects.toMatchObject({ code: "local_io_failure" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("personal");
  });
});

it("verifies complete retained content after staging is removed and rejects edits", async () => {
 const f = await fixture(); const staged = await f.stage("1");
 await syncAgentHomeSkills({ ...f, staged });
 const options = { home: f.home, owner: f.owner, skill: staged.skills[0]! };
 await rm(staged.root, { recursive: true });
 expect(await verifyAgentHomeSkillRead(options)).toBe(true);
 const link = join(f.home, "skills", `konteks-${sha256Hex("review")}`);
 await writeFile(join(link, "references", "rules.md"), "tampered");
 expect(await verifyAgentHomeSkillRead(options)).toBe(false);
});
it("refuses a read under a foreign owner or a replaced discovery version", async () => {
 const f = await fixture(); const first = await f.stage("1");
 await syncAgentHomeSkills({ ...f, staged: first });
 const options = { home: f.home, owner: f.owner, skill: first.skills[0]! };
 expect(await verifyAgentHomeSkillRead({ ...options, owner: { ...f.owner, workspaceId: "foreign" } })).toBe(false);
 const second = await f.stage("2"); await syncAgentHomeSkills({ ...f, staged: second });
 expect(await verifyAgentHomeSkillRead(options)).toBe(false);
 expect(await verifyAgentHomeSkillRead({ ...options, skill: second.skills[0]! })).toBe(true);
});
