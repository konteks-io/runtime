import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNativeDshInstallation, verifyNativeDshRoot } from "../native/dsh-installation.js";

const posix = process.platform !== "win32";

describe("native DeepSeek Harness discovery", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const fresh = async () => (root = await realpath(await mkdtemp(join(tmpdir(), "dsh-install-"))));
  /** An installed `@deepseek-ai/dsh` package as npm lays it out. */
  const pkg = async (dir: string, fields: { name?: string; version?: string; bin?: unknown } = {}) => {
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(join(dir, "lib", "bin.js"), "#!/usr/bin/env node\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: fields.name ?? "@deepseek-ai/dsh", version: fields.version ?? "0.1.7-rc.2", bin: fields.bin ?? { dsh: "lib/bin.js" } }));
    return dir;
  };
  const expected = (dir: string, version = "0.1.7-rc.2") => ({ root: dir, entry: join(dir, "lib", "bin.js"), version });

  it.runIf(posix)("follows an npm global bin symlink on PATH to the package, without running it", async () => {
    const base = await fresh();
    const prefix = join(base, "prefix"), home = join(base, "home");
    const installed = await pkg(join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh"));
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink(join(installed, "lib", "bin.js"), join(prefix, "bin", "dsh"));
    await expect(resolveNativeDshInstallation({ PATH: `${join(base, "empty")}:${join(prefix, "bin")}` }, home, "darwin")).resolves.toEqual(expected(installed));
    await expect(resolveNativeDshInstallation({ PATH: join(prefix, "bin") }, home, "linux")).resolves.toEqual(expected(installed));
  });

  it("finds the package beside a shim it never parses or runs (npm on Windows and POSIX, pnpm/volta shims)", async () => {
    const base = await fresh();
    // Windows npm: %APPDATA%\npm\dsh.cmd with node_modules beside it.
    const npm = join(base, "AppData", "Roaming", "npm");
    const windows = await pkg(join(npm, "node_modules", "@deepseek-ai", "dsh"));
    await writeFile(join(npm, "dsh.cmd"), "@ECHO off\r\nnode \"%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js\" %*\r\n");
    await expect(resolveNativeDshInstallation({ PATH: `C:\\Windows;${npm}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, join(base, "home"), "win32")).resolves.toEqual(expected(windows));
    // A non-symlink POSIX shim under <prefix>/bin with the package in <prefix>/lib/node_modules.
    const prefix = join(base, "prefix");
    const unix = await pkg(join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh"), { version: "0.1.7" });
    await mkdir(join(prefix, "bin"), { recursive: true });
    await writeFile(join(prefix, "bin", "dsh"), "#!/bin/sh\nexec node ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js \"$@\"\n");
    await expect(resolveNativeDshInstallation({ PATH: join(prefix, "bin") }, join(base, "home"), "linux")).resolves.toEqual(expected(unix, "0.1.7"));
  });

  it("falls back to the npm global package roots when PATH has no dsh", async () => {
    const base = await fresh();
    const prefix = join(base, "custom-prefix");
    const unix = await pkg(join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh"));
    await expect(resolveNativeDshInstallation({ PATH: "", npm_config_prefix: prefix }, join(base, "home"), "linux")).resolves.toEqual(expected(unix));
    const home = join(base, "home");
    const npmGlobal = await pkg(join(home, ".npm-global", "lib", "node_modules", "@deepseek-ai", "dsh"));
    await expect(resolveNativeDshInstallation({ PATH: "" }, home, "darwin")).resolves.toEqual(expected(npmGlobal));
    const appData = join(base, "AppData", "Roaming");
    const windows = await pkg(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh"));
    await expect(resolveNativeDshInstallation({ PATH: "", APPDATA: appData }, join(base, "winhome"), "win32")).resolves.toEqual(expected(windows));
  });

  it("honours an absolute operator override naming the package root or its launcher", async () => {
    const base = await fresh();
    const installed = await pkg(join(base, "opt", "dsh"));
    await expect(resolveNativeDshInstallation({ DSH_EXECUTABLE: installed, PATH: "" }, join(base, "home"), "linux")).resolves.toEqual(expected(installed));
    await expect(resolveNativeDshInstallation({ DSH_EXECUTABLE: join(installed, "lib", "bin.js"), PATH: "" }, join(base, "home"), "linux")).resolves.toEqual(expected(installed));
    await expect(resolveNativeDshInstallation({ DSH_EXECUTABLE: "dsh", PATH: "" }, join(base, "home"), "linux")).rejects.toMatchObject({ code: "prerequisite_missing" });
  });

  it("refuses an out-of-range version and says which version to install", async () => {
    const base = await fresh();
    const old = await pkg(join(base, "old"), { version: "0.1.6-alpha.2" });
    const refusal = await resolveNativeDshInstallation({ DSH_EXECUTABLE: old, PATH: "" }, join(base, "home"), "linux").catch(error => error);
    expect(refusal).toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_unsupported_version" });
    expect(refusal.message).toContain("0.1.6-alpha.2");
    expect(refusal.message).toContain("npm install -g @deepseek-ai/dsh@0.1.7-rc.2");
    await expect(verifyNativeDshRoot(await pkg(join(base, "next"), { version: "0.1.8-alpha.1" }), "linux")).rejects.toMatchObject({ diagnostic: "dsh_unsupported_version" });
  });

  it("prefers a supported install over an unsupported one found earlier", async () => {
    const base = await fresh();
    const old = await pkg(join(base, "a", "node_modules", "@deepseek-ai", "dsh"), { version: "0.1.5-rc.3" });
    const good = await pkg(join(base, "b", "node_modules", "@deepseek-ai", "dsh"));
    await writeFile(join(base, "a", "dsh.cmd"), ""); await writeFile(join(base, "b", "dsh.cmd"), "");
    expect(old).not.toBe(good);
    await expect(resolveNativeDshInstallation({ PATH: `${join(base, "a")};${join(base, "b")}`, PATHEXT: ".CMD" }, join(base, "home"), "win32")).resolves.toEqual(expected(good));
  });

  it("refuses a package that is not dsh, or whose launcher escapes the package", async () => {
    const base = await fresh();
    await expect(verifyNativeDshRoot(await pkg(join(base, "other"), { name: "dsh-lookalike" }), "linux")).rejects.toMatchObject({ code: "prerequisite_missing" });
    await expect(verifyNativeDshRoot(await pkg(join(base, "escape"), { bin: { dsh: "../outside.js" } }), "linux")).rejects.toMatchObject({ code: "prerequisite_missing" });
    await expect(verifyNativeDshRoot(await pkg(join(base, "nobin"), { bin: { other: "lib/bin.js" } }), "linux")).rejects.toMatchObject({ code: "prerequisite_missing" });
    await expect(resolveNativeDshInstallation({ PATH: join(base, "missing") }, join(base, "home"), "linux")).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_not_found" });
  });

  it.runIf(posix)("refuses an installation other users can modify", async () => {
    const base = await fresh();
    const installed = await pkg(join(base, "shared"));
    await chmod(join(installed, "lib", "bin.js"), 0o666);
    await expect(verifyNativeDshRoot(installed, "linux")).rejects.toMatchObject({ diagnostic: "dsh_unsafe_install" });
    await chmod(join(installed, "lib", "bin.js"), 0o644);
    await chmod(installed, 0o777);
    await expect(verifyNativeDshRoot(installed, "linux")).rejects.toMatchObject({ diagnostic: "dsh_unsafe_install" });
    await chmod(installed, 0o755);
    await expect(verifyNativeDshRoot(installed, "linux")).resolves.toEqual(expected(installed));
  });
});
