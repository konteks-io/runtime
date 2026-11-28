import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexHomeOverlay } from "../native/codex-home-overlay.js";

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
  await writeFile(join(real, "auth.json"), "{}\n");
  await writeFile(join(real, "config.toml"), "model = \"x\"\n");
  await writeFile(join(real, "sessions", "rollout.jsonl"), "{}\n");
  await writeFile(join(real, "AGENTS.md"), "operator AGENTS\n");
  await writeFile(join(real, "AGENTS.override.md"), "operator override\n");
  await writeFile(join(real, "memories", "note.md"), "private memory\n");
  await writeFile(join(real, "memories_1.sqlite"), "private memory db\n");
  return { root, real, overlay };
}

describe("the private Codex home overlay", () => {
  it("links the login and thread store but never the operator's instructions or memories", async () => {
    const f = await homes();
    await prepareCodexHomeOverlay(f.real, f.overlay);
    expect(await readFile(join(f.overlay, "auth.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(f.overlay, "config.toml"), "utf8")).toBe("model = \"x\"\n");
    expect(await readFile(join(f.overlay, "sessions", "rollout.jsonl"), "utf8")).toBe("{}\n");
    for (const blocked of ["AGENTS.md", "AGENTS.override.md", "memories", "memories_1.sqlite"]) {
      await expect(lstat(join(f.overlay, blocked))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await lstat(join(f.overlay, "auth.json"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(f.overlay, ".konteks-codex-overlay"), "utf8")).toBe("konteks-codex-home-overlay-v1\n");
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

  it("removes an instruction or memory entry a session created in the overlay", async () => {
    const f = await homes();
    await prepareCodexHomeOverlay(f.real, f.overlay);
    await writeFile(join(f.overlay, "AGENTS.md"), "leaked\n");
    await mkdir(join(f.overlay, "memories"));
    await prepareCodexHomeOverlay(f.real, f.overlay);
    for (const blocked of ["AGENTS.md", "memories"]) {
      await expect(lstat(join(f.overlay, blocked))).rejects.toMatchObject({ code: "ENOENT" });
    }
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
