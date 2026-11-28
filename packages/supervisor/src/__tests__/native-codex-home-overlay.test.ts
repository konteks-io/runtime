import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexHomeBehindOverlay, prepareCodexHomeOverlay, sanitizeCodexConfig } from "../native/codex-home-overlay.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function homes(): Promise<{ root: string; real: string; overlay: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-home-overlay-"));
  roots.push(root);
  const real = join(root, "operator-codex");
  const overlay = join(root, "credentials", "codex", "codex-home");
  await mkdir(join(real, "sessions"), { recursive: true });
  await mkdir(join(real, "memories"), { recursive: true });
  await mkdir(join(real, "skills", "personal"), { recursive: true });
  await mkdir(join(real, "prompts"), { recursive: true });
  await mkdir(join(real, "plugins", "personal"), { recursive: true });
  await writeFile(join(real, "auth.json"), "{}\n");
  await writeFile(join(real, "sessions", "rollout.jsonl"), "{}\n");
  await writeFile(join(real, "AGENTS.md"), "operator AGENTS\n");
  await writeFile(join(real, "AGENTS.override.md"), "operator override\n");
  await writeFile(join(real, "memories", "note.md"), "private memory\n");
  await writeFile(join(real, "memories_1.sqlite"), "private memory db\n");
  await writeFile(join(real, "skills", "personal", "SKILL.md"), "PERSONAL_SKILL\n");
  await writeFile(join(real, "prompts", "personal.md"), "PERSONAL_PROMPT\n");
  await writeFile(join(real, "plugins", "personal", "plugin.md"), "PERSONAL_PLUGIN\n");
  await writeFile(join(real, "config.toml"), [
    'model = "approved"',
    'developer_instructions = "OPERATOR_CONFIG_INSTRUCTIONS"',
    'model_instructions_file = "/operator/model.md"',
    'experimental_instructions_file = "/operator/experimental.md"',
    "",
    "[projects.\"/tmp/example\"]",
    'trust_level = "trusted"',
    "",
  ].join("\n"));
  return { root, real, overlay };
}

describe("the private Codex home overlay", () => {
  it("links the login and thread store but never personal instructions, skills, prompts or plugins", async () => {
    const f = await homes();
    await prepareCodexHomeOverlay(f.real, f.overlay);
    expect(await readFile(join(f.overlay, "auth.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(f.overlay, "sessions", "rollout.jsonl"), "utf8")).toBe("{}\n");
    // config.toml is a sanitized copy, never a link to the operator's file.
    expect((await lstat(join(f.overlay, "config.toml"))).isSymbolicLink()).toBe(false);
    const config = await readFile(join(f.overlay, "config.toml"), "utf8");
    expect(config).toContain('model = "approved"');
    expect(config).toContain('trust_level = "trusted"');
    for (const denied of ["developer_instructions", "model_instructions_file", "experimental_instructions_file", "OPERATOR_CONFIG_INSTRUCTIONS"]) {
      expect(config).not.toContain(denied);
    }
    for (const blocked of ["AGENTS.md", "AGENTS.override.md", "memories", "memories_1.sqlite", "skills", "prompts", "plugins"]) {
      await expect(lstat(join(f.overlay, blocked))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await lstat(join(f.overlay, "auth.json"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(f.overlay, ".konteks-codex-overlay"), "utf8")).toBe("konteks-codex-home-overlay-v1\n");
    expect(await codexHomeBehindOverlay(f.overlay)).toBe(f.real);
  });

  it("strips a multi-line or array instruction value and keeps every other top-level key", () => {
    const sanitized = sanitizeCodexConfig([
      'developer_instructions = """',
      "OPERATOR_MULTILINE",
      '"""',
      'compact_prompt = ["one", "two"]',
      'model = "approved"',
      "",
      "[features]",
      "memories = false",
      "",
      '[plugins."personal"]',
      "enabled = true",
      "",
      "[marketplaces.personal]",
      'source = "/operator/home/.codex/.tmp/personal"',
      "",
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"));
    expect(sanitized).not.toContain("OPERATOR_MULTILINE");
    expect(sanitized).not.toContain("developer_instructions");
    expect(sanitized).not.toContain("compact_prompt");
    expect(sanitized).toContain('model = "approved"');
    expect(sanitized).toContain("[features]");
    expect(sanitized).toContain("memories = false");
    expect(sanitized).not.toContain("[plugins");
    expect(sanitized).not.toContain("[marketplaces");
    expect(sanitized).not.toContain("personal");
    expect(sanitized).toContain('[projects."/tmp/example"]');
  });

  it("picks up a new real entry, drops one that disappeared, and never deletes a connector-created store", async () => {
    const f = await homes();
    await prepareCodexHomeOverlay(f.real, f.overlay);
    await writeFile(join(f.real, "history.jsonl"), "one\n");
    await prepareCodexHomeOverlay(f.real, f.overlay);
    expect(await readFile(join(f.overlay, "history.jsonl"), "utf8")).toBe("one\n");
    await rm(join(f.real, "history.jsonl"));
    await prepareCodexHomeOverlay(f.real, f.overlay);
    await expect(lstat(join(f.overlay, "history.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(f.overlay, "connector-store"));
    await writeFile(join(f.overlay, "connector-store", "own.txt"), "kept\n");
    await prepareCodexHomeOverlay(f.real, f.overlay);
    expect(await readFile(join(f.overlay, "connector-store", "own.txt"), "utf8")).toBe("kept\n");
  });

  it("removes an instruction, skill or memory entry a session created in the overlay", async () => {
    const f = await homes();
    await prepareCodexHomeOverlay(f.real, f.overlay);
    await writeFile(join(f.overlay, "AGENTS.md"), "leaked\n");
    await mkdir(join(f.overlay, "memories"));
    await mkdir(join(f.overlay, "skills"));
    await prepareCodexHomeOverlay(f.real, f.overlay);
    for (const blocked of ["AGENTS.md", "memories", "skills"]) {
      await expect(lstat(join(f.overlay, blocked))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps the profile a legacy record's runner already used when the environment names another", async () => {
    const f = await homes();
    await prepareCodexHomeOverlay(f.real, f.overlay);
    const other = join(f.root, "other-codex");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "auth.json"), "{\"other\":true}\n");
    await prepareCodexHomeOverlay(other, f.overlay, false);
    expect(await codexHomeBehindOverlay(f.overlay)).toBe(f.real);
    expect(await readFile(join(f.overlay, "auth.json"), "utf8")).toBe("{}\n");
    // A record that names its profile is authoritative and may rebind.
    await prepareCodexHomeOverlay(other, f.overlay);
    expect(await codexHomeBehindOverlay(f.overlay)).toBe(other);
    expect(await readFile(join(f.overlay, "auth.json"), "utf8")).toBe("{\"other\":true}\n");
  });

  it("points a not-yet-signed-in profile's auth at the real path and refuses a non-directory overlay", async () => {
    const f = await homes();
    await rm(join(f.real, "auth.json"));
    await prepareCodexHomeOverlay(f.real, f.overlay);
    expect((await lstat(join(f.overlay, "auth.json"))).isSymbolicLink()).toBe(true);
    const file = join(f.root, "not-a-directory");
    await writeFile(file, "x");
    await expect(prepareCodexHomeOverlay(f.real, file)).rejects.toMatchObject({ diagnostic: "codex_home_overlay_unavailable" });
    await rm(f.overlay, { recursive: true, force: true });
    await symlink(join(f.root, "elsewhere"), f.overlay, "dir");
    await expect(prepareCodexHomeOverlay(f.real, f.overlay)).rejects.toMatchObject({ diagnostic: "codex_home_overlay_unavailable" });
  });
});
