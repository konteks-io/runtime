import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const cliPath = fileURLToPath(new URL("../e2e/smoke-cli.ts", import.meta.url));
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("E2E native update phase CLI", () => {
  it("requires the native connector gate for every update and drain phase", () => {
    const directory = "/tmp/.runtime/native-cloud", root = "/tmp/.runtime/native-connector";
    const phases = [
      ["update-stage"],
      ["update-commit", "--release-id", "release-abc"],
      ["update-restore", "--expected-release-id", "release-next", "--previous-release-id", "release-prev"],
      ["update-drain"],
      ["update-drain-cancel"],
    ];
    for (const phase of phases) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...phase, "--directory", directory, "--root", root], {
        encoding: "utf8",
        env: { ...process.env, KONTEKS_E2E_NATIVE_CONNECTOR: "0" },
      });
      expect(result.status, `${phase[0]} should be gated: ${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/E2E native connector gate is required/i);
    }
  }, 15_000);

  it("rejects an installed root outside the canonical native connector sibling scope", async () => {
    const parent = await mkdtemp(join(tmpdir(), "konteks-e2e-update-path-")); directories.push(parent);
    const runtime = join(parent, ".runtime"), directory = join(runtime, "native-cloud"), root = join(runtime, "arbitrary-root");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "update-stage", "--directory", directory, "--root", root], {
      encoding: "utf8",
      env: { ...process.env, KONTEKS_E2E_NATIVE_CONNECTOR: "1" },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/fixed \.runtime sibling/i);

    const target = join(runtime, "native-connector-target"), link = join(runtime, "native-connector-alias");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link, "dir");
    const linked = spawnSync(process.execPath, ["--import", "tsx", cliPath, "update-stage", "--directory", directory, "--root", link], {
      encoding: "utf8",
      env: { ...process.env, KONTEKS_E2E_NATIVE_CONNECTOR: "1" },
    });
    expect(linked.status, `${linked.stdout}\n${linked.stderr}`).not.toBe(0);
    expect(`${linked.stdout}\n${linked.stderr}`).toMatch(/E2E native update state/i);
  });
});
