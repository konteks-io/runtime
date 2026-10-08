import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDshKonteksProfile } from "./dsh-profile.js";
import { dshControlReadPaths, prepareDshControlReadProfile, prepareDshReadProfile, renderDshReadFence } from "./dsh-read-profile.js";

let root: string, credentialDir: string, cwd: string, selected: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "konteks-dsh-profile-"));
  credentialDir = join(root, "credentials"); cwd = join(root, "workspace"); selected = join(root, "selected");
  for (const path of [credentialDir, cwd, selected]) await mkdir(path);
  await writeDshKonteksProfile(join(credentialDir, "konteks-dsh"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function prepare() {
  return prepareDshReadProfile({ credentialDir, entry: "/public/native/dsh/lib/bin.js", command: ["--profile", "acp"], cwd, readOnlyRoots: [selected],
    environment: { HOME: credentialDir, DSH_HOME: join(credentialDir, ".dsh"), DSH_BUNDLED_SKILL_DIR: "/outside/bundled", PATH: "/public/bin" } });
}

function lastPatch(args: readonly string[] | undefined): string {
  if (args === undefined) throw new Error("Missing bound argv.");
  const path = args.at(-1);
  if (path === undefined) throw new Error("Missing final patch.");
  return path;
}

describe("DSH per-child profile composition", () => {
  it("writes immutable trusted policy before spawn and preserves native launch/credential options", async () => {
    const binding = await prepare();
    const patch = lastPatch(binding.args);
    expect(JSON.parse(await readFile(join(dirname(patch), "read-policy.json"), "utf8"))).toEqual({ cwd, readOnlyRoots: [selected] });
    expect(await readFile(join(dirname(patch), "filesystem-backend.mjs"))).toEqual(await readFile(new URL("../../dist/bridge/dsh-filesystem-backend.js", import.meta.url)));
    expect(await readFile(patch, "utf8")).toContain("inject: [fs, konteksFileAuthority]");
    expect(await readFile(patch, "utf8")).not.toContain("bundledSkillDir");
    expect(binding.args?.slice(0, 2)).toEqual(["/public/native/dsh/lib/bin.js", "--profile"]);
    expect(binding.args?.slice(3, 5)).toEqual(["--from-default-profile", "acp"]);
    expect(binding.args?.filter(value => value === "--patch")).toHaveLength(3);
    expect(binding.env.HOME).toBe(credentialDir);
    expect(binding.env.DSH_HOME).toBe(join(credentialDir, ".dsh"));
    expect(binding.env.DSH_BUNDLED_SKILL_DIR).toBeUndefined();
    expect(binding.cwd).toBe(cwd);
    expect(binding.authority).toEqual({ cwd, readOnlyRoots: [selected] });
    await binding.beforePrompt();
    await binding.release();
    await binding.release();
    await expect(readFile(patch)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses separate child profiles without importing the restrictive control overlay", async () => {
    const first = await prepare(), second = await prepare();
    expect(first.args?.[2]).not.toBe(second.args?.[2]);
    expect(lastPatch(first.args)).not.toBe(lastPatch(second.args));
    expect(first.args).not.toContain(dshControlReadPaths(credentialDir).patchPath);
    await first.release();
    await second.beforePrompt();
    await second.release();
  });

  it("retries only a failed owned cleanup after its parent identity is restored", async () => {
    const binding = await prepare();
    const patch = lastPatch(binding.args);
    const profiles = dirname(dirname(patch));
    const parked = `${profiles}-temporarily-unavailable`;
    await rename(profiles, parked);
    await writeFile(profiles, "owned temporary obstruction");
    await expect(binding.release()).rejects.toThrow("remain directories");
    await rm(profiles);
    await rename(parked, profiles);
    await binding.release();
    await binding.release();
    await expect(readFile(patch)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses changed policy bytes before a later prompt", async () => {
    const binding = await prepare();
    const patch = lastPatch(binding.args);
    await writeFile(join(dirname(patch), "read-policy.json"), JSON.stringify({ cwd: root, readOnlyRoots: [] }));
    await expect(binding.beforePrompt()).rejects.toThrow("bound read policy changed");
    await binding.release();
  });

  it("prepares a restrictive control filesystem before native model/session discovery", async () => {
    await prepareDshControlReadProfile(credentialDir);
    const paths = dshControlReadPaths(credentialDir);
    expect(JSON.parse(await readFile(join(paths.policyDir, "read-policy.json"), "utf8"))).toEqual({ cwd: paths.cwd, readOnlyRoots: [] });
    expect(await readFile(paths.patchPath, "utf8")).toContain(`cwd: ${JSON.stringify(paths.cwd)}`);
    expect(await readFile(paths.patchPath, "utf8")).toContain("- id: agent-loop\n  inject: [fs, konteksFileAuthority]");
    expect(await readFile(paths.patchPath, "utf8")).toContain("- id: fs-sandbox\n  disabled: true");
  });

  it("refuses a child environment pointing outside its owned profile resolution tree", async () => {
    await expect(prepareDshReadProfile({ credentialDir, entry: "/public/native/dsh/lib/bin.js", command: ["--profile", "acp"], cwd, readOnlyRoots: [selected],
      environment: { DSH_HOME: join(root, "another-home") } })).rejects.toThrow("owned profile home disagree");
  });

  it("retains stock skill source/rank selection while replacing its whole config", () => {
    const patch = renderDshReadFence(join(root, "backend.mjs"), { cwd, readOnlyRoots: [selected] });
    expect(patch).toContain("includeDefaultRoots: true");
    expect(patch).toContain(`customSkillDirs: ${JSON.stringify([selected])}`);
    expect(patch).toContain("- id: skill-filesystem\n  inject: [fs, konteksFileAuthority]");
    expect(patch).toContain("- id: agent-instructions\n  inject: [fs, konteksFileAuthority]");
  });
});
