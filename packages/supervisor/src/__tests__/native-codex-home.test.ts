import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveNativeCodexHome } from "../native/codex-home.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-codex-home-")); roots.push(root);
  const profile = join(root, ".codex"); await mkdir(profile, { mode: 0o755 });
  return { root, profile };
}
it("resolves the normal profile or explicit operator override without copying files", async () => {
  const { root, profile } = await fixture();
  expect(await resolveNativeCodexHome({}, root)).toBe(profile);
  expect(await resolveNativeCodexHome({ CODEX_HOME: profile }, "/different-user")).toBe(profile);
});
it("rejects missing, relative, broad and linked profiles without silently falling back", async () => {
  const { root, profile } = await fixture();
  for (const path of ["relative", "/", root, join(root, "missing"), `${profile}\n`]) {
    await expect(resolveNativeCodexHome({ CODEX_HOME: path }, root)).rejects.toThrow(/local Codex/);
  }
  const link = join(root, "link"); await symlink(profile, link, "dir");
  await expect(resolveNativeCodexHome({ CODEX_HOME: link }, root)).rejects.toThrow(/non-linked/);
});
it.skipIf(process.platform === "win32")("rejects profiles writable by another user", async () => {
  const { root, profile } = await fixture(); await chmod(profile, 0o777);
  await expect(resolveNativeCodexHome({}, root)).rejects.toThrow(/not writable/);
});
