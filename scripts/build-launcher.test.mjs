import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./build-launcher.mjs", import.meta.url));
const platforms = { macos: "darwin", windows: "win32", debian: "linux" };

for (const [target, platform] of Object.entries(platforms)) {
  if (platform === process.platform) continue;
  test(`rejects ${target} packaging on ${process.platform} before building`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "konteks-launcher-platform-"));
    try {
      const env = { ...process.env };
      delete env.KONTEKS_RELEASE_ROOTS_JSON;
      const result = spawnSync(process.execPath, [script, "--os", target, "--out", "dist/artifact"], { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /launcher target must match the build host/);
      assert.deepEqual(readdirSync(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("rejects unknown launcher targets before building", () => {
  const result = spawnSync(process.execPath, [script, "--os", "unknown", "--out", "dist/artifact"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported launcher target/);
});

test("matching host proceeds to the release trust prerequisite", () => {
  const target = Object.entries(platforms).find(([, platform]) => platform === process.platform)?.[0];
  if (!target) return;
  const env = { ...process.env };
  delete env.KONTEKS_RELEASE_ROOTS_JSON;
  const result = spawnSync(process.execPath, [script, "--os", target, "--out", "dist/artifact"], { env, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /KONTEKS_RELEASE_ROOTS_JSON must be set/);
});
