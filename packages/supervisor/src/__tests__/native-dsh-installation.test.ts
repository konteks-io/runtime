import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNativeDshInstallation, resolveNativeDshNode, verifyNativeDshRoot } from "../native/dsh-installation.js";

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

  it("finds the newest supported copy `npx @deepseek-ai/dsh` left in npm's cache, after every installed one", async () => {
    const base = await fresh();
    const home = join(base, "home");
    const npx = (cache: string, hash: string, version: string) => pkg(join(cache, "_npx", hash, "node_modules", "@deepseek-ai", "dsh"), { version });
    await npx(join(home, ".npm"), "0a", "0.1.5-rc.2");
    const latest = await npx(join(home, ".npm"), "1b", "0.1.5-rc.3");
    await npx(join(home, ".npm"), "2c", "0.1.8");
    await mkdir(join(home, ".npm", "_npx", "3d", "node_modules"), { recursive: true });
    await expect(resolveNativeDshInstallation({ PATH: "" }, home, "darwin")).resolves.toEqual(expected(latest, "0.1.5-rc.3"));
    const next = await npx(join(home, ".npm"), "4e", "0.1.7-rc.2");
    await expect(resolveNativeDshInstallation({ PATH: "" }, home, "linux")).resolves.toEqual(expected(next));
    // An installed copy still wins over the cache; npm_config_cache and Windows' %LOCALAPPDATA% are honoured.
    const prefix = join(base, "prefix");
    const installed = await pkg(join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh"), { version: "0.1.5-rc.3" });
    await expect(resolveNativeDshInstallation({ PATH: "", npm_config_prefix: prefix }, home, "linux")).resolves.toEqual(expected(installed, "0.1.5-rc.3"));
    const custom = await npx(join(base, "custom-cache"), "5f", "0.1.5-rc.3");
    await expect(resolveNativeDshInstallation({ PATH: "", npm_config_cache: join(base, "custom-cache") }, join(base, "other"), "linux")).resolves.toEqual(expected(custom, "0.1.5-rc.3"));
    const local = await npx(join(base, "Local", "npm-cache"), "6a", "0.1.5-rc.3");
    await expect(resolveNativeDshInstallation({ PATH: "", LOCALAPPDATA: join(base, "Local") }, join(base, "winhome"), "win32")).resolves.toEqual(expected(local, "0.1.5-rc.3"));
    // Only unsupported copies: say so, not "not installed".
    await expect(resolveNativeDshInstallation({ PATH: "" }, join(base, "only-old"), "linux").catch(() => null)).resolves.toBeNull();
    await npx(join(base, "only-old", ".npm"), "7b", "0.1.3-alpha.2");
    await expect(resolveNativeDshInstallation({ PATH: "" }, join(base, "only-old"), "linux")).rejects.toMatchObject({ diagnostic: "dsh_unsupported_version" });
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
    const old = await pkg(join(base, "old"), { version: "0.1.5-rc.2" });
    const refusal = await resolveNativeDshInstallation({ DSH_EXECUTABLE: old, PATH: "" }, join(base, "home"), "linux").catch(error => error);
    expect(refusal).toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_unsupported_version" });
    expect(refusal.message).toContain("0.1.5-rc.2");
    expect(refusal.message).toContain("npm install -g @deepseek-ai/dsh@0.1.7-rc.2");
    await expect(verifyNativeDshRoot(await pkg(join(base, "next"), { version: "0.1.8-alpha.1" }), "linux")).rejects.toMatchObject({ diagnostic: "dsh_unsupported_version" });
  });

  it("prefers a supported install over an unsupported one found earlier", async () => {
    const base = await fresh();
    const old = await pkg(join(base, "a", "node_modules", "@deepseek-ai", "dsh"), { version: "0.1.5-rc.2" });
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

describe("the Node that runs the person's DeepSeek Harness", () => {
  let base = "";
  afterEach(async () => { if (base) await rm(base, { recursive: true, force: true }); });
  const file = async (path: string, mode = 0o755) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, "#!/bin/sh\n"); await chmod(path, mode); return path; };
  const install = (root: string) => ({ root, entry: join(root, "lib", "bin.js"), version: "0.1.7-rc.2" });
  const versions = (table: Record<string, string>) => async (node: string) => table[node] ?? null;

  it("prefers the Node beside the npm prefix dsh was installed into, then PATH", async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "dsh-node-")));
    const prefix = join(base, ".nvm", "versions", "node", "v22.20.0");
    const root = join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
    const beside = await file(join(prefix, "bin", "node"));
    const onPath = await file(join(base, "usr", "bin", "node"));
    const version = versions({ [beside]: "v22.20.0", [onPath]: "v24.1.0" });
    await expect(resolveNativeDshNode(install(root), { PATH: join(base, "usr", "bin") }, "darwin", { version })).resolves.toBe(beside);
    await expect(resolveNativeDshNode(install(join(base, "elsewhere", "dsh")), { PATH: join(base, "usr", "bin") }, "linux", { version })).resolves.toBe(onPath);
  });

  it("finds node.exe beside a Node install's own node_modules and on PATH on Windows", async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "dsh-node-")));
    const nodejs = join(base, "Program Files", "nodejs");
    const beside = await file(join(nodejs, "node.exe"));
    const version = versions({ [beside]: "v24.0.0" });
    await expect(resolveNativeDshNode(install(join(nodejs, "node_modules", "@deepseek-ai", "dsh")), { PATH: "" }, "win32", { version })).resolves.toBe(beside);
    const appDataRoot = join(base, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh");
    await expect(resolveNativeDshNode(install(appDataRoot), { PATH: `C:\\Windows;${nodejs}` }, "win32", { version })).resolves.toBe(beside);
    await expect(resolveNativeDshNode(install(appDataRoot), { PATH: "", ProgramFiles: join(base, "Program Files") }, "win32", { version })).resolves.toBe(beside);
  });

  it("accepts only the Node versions dsh supports (^22.19.0 or >=24) and says what to install", async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "dsh-node-")));
    const node = await file(join(base, "bin", "node"));
    for (const [reported, ok] of [["v22.19.0", true], ["v22.23.2", true], ["v24.3.1", true], ["v25.0.0", true], ["v22.18.9", false], ["v23.11.0", false], ["v20.17.0", false], ["garbage", false]] as const) {
      const attempt = resolveNativeDshNode(install(join(base, "x")), { PATH: join(base, "bin") }, "linux", { version: versions({ [node]: reported }) });
      if (ok) await expect(attempt, reported).resolves.toBe(node);
      else await expect(attempt, reported).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_node_unsupported" });
    }
    const refusal = await resolveNativeDshNode(install(join(base, "x")), { PATH: join(base, "none") }, "linux", { version: versions({}) }).catch(error => error);
    expect(refusal).toMatchObject({ diagnostic: "dsh_node_unsupported" });
    expect(refusal.message).toMatch(/Node 22\.19 or newer/);
  });

  it("honours an absolute DSH_NODE override and refuses a Node other users can modify", async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "dsh-node-")));
    const override = await file(join(base, "custom", "node"));
    const version = versions({ [override]: "v22.23.2" });
    await expect(resolveNativeDshNode(install(join(base, "x")), { DSH_NODE: override, PATH: "" }, "linux", { version })).resolves.toBe(override);
    await expect(resolveNativeDshNode(install(join(base, "x")), { DSH_NODE: "node", PATH: "" }, "linux", { version })).rejects.toMatchObject({ code: "prerequisite_missing" });
    if (posix) {
      await chmod(override, 0o777);
      await expect(resolveNativeDshNode(install(join(base, "x")), { DSH_NODE: override, PATH: "" }, "linux", { version })).rejects.toMatchObject({ code: "prerequisite_missing" });
    }
  });

  it.runIf(posix)("reads the version by running the candidate itself when not injected", async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "dsh-node-")));
    const node = join(base, "bin", "node");
    await mkdir(join(base, "bin"), { recursive: true });
    await writeFile(node, "#!/bin/sh\necho v22.21.0\n");
    await chmod(node, 0o755);
    await expect(resolveNativeDshNode(install(join(base, "x")), { PATH: join(base, "bin") }, "linux")).resolves.toBe(node);
  });
});
