import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_MIN_BINARY_BYTES, openCodeVersionOutput, parseOpenCodeVersion, resolveNativeOpenCodeInstallation, verifyNativeOpenCodeBinary } from "../native/opencode-installation.js";

const posix = process.platform !== "win32";
const V2 = "curl -fsSL https://opencode.ai/v2/install | bash";
const V2_WINDOWS = "npm install -g @opencode/cli";

describe("native OpenCode 2 discovery", () => {
  let base = "";
  afterEach(async () => { vi.unstubAllEnvs(); if (base) await rm(base, { recursive: true, force: true }); });
  const fresh = async () => (base = await realpath(await mkdtemp(join(tmpdir(), "opencode-install-"))));
  /** A native executable as far as the locator can tell (Mach-O magic, real size); never run by these tests. */
  const binary = async (path: string, magic: number[] = [0xcf, 0xfa, 0xed, 0xfe]) => {
    await mkdir(join(path, ".."), { recursive: true });
    const body = Buffer.alloc(OPENCODE_MIN_BINARY_BYTES + 16);
    Buffer.from(magic).copy(body);
    await writeFile(path, body);
    await chmod(path, 0o755);
    return path;
  };
  /** `npm install -g @opencode/cli` (or 1.x's `opencode-ai`): the package places `bin/opencode.exe`. */
  const npmPackage = async (root: string, fields: { name?: string; version?: string } = {}) => {
    await binary(join(root, "bin", "opencode.exe"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: fields.name ?? "@opencode/cli", version: fields.version ?? "2.0.18", bin: { opencode: "./bin/opencode.exe", opencode2: "./bin/opencode.exe" } }));
    return join(root, "bin", "opencode.exe");
  };
  /** A POSIX npm prefix with `bin/opencode` and `bin/opencode2` linked to the package's executable. */
  const npmPrefix = async (prefix: string, fields: { name?: string; version?: string } = {}, names = ["opencode", "opencode2"]) => {
    const exe = await npmPackage(join(prefix, "lib", "node_modules", ...(fields.name ?? "@opencode/cli").split("/")), fields);
    await mkdir(join(prefix, "bin"), { recursive: true });
    for (const name of names) await symlink(exe, join(prefix, "bin", name));
    return exe;
  };
  const noRun = () => vi.fn(async () => { throw new Error("must not run"); });
  const reports = (table: Record<string, string>) => vi.fn(async (path: string) => table[path] ?? null);

  it.runIf(posix)("follows npm's bin links on PATH to the package and reads its version without running anything", async () => {
    await fresh();
    const exe = await npmPrefix(join(base, "prefix"));
    const versionOutput = noRun();
    await expect(resolveNativeOpenCodeInstallation({ PATH: `${join(base, "empty")}:${join(base, "prefix", "bin")}` }, join(base, "home"), "darwin", { versionOutput }))
      .resolves.toEqual({ binary: exe, version: "2.0.18" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: join(base, "prefix", "bin") }, join(base, "home"), "linux", { versionOutput })).resolves.toEqual({ binary: exe, version: "2.0.18" });
    expect(versionOutput).not.toHaveBeenCalled();
  });

  it.runIf(posix)("prefers `opencode2` anywhere on PATH over an earlier `opencode` (OpenCode 1 claims that name too)", async () => {
    await fresh();
    await npmPrefix(join(base, "v1"), { name: "opencode-ai", version: "1.18.33" }, ["opencode"]);
    const v2 = await npmPrefix(join(base, "v2"), {}, ["opencode2"]);
    await expect(resolveNativeOpenCodeInstallation({ PATH: `${join(base, "v1", "bin")}:${join(base, "v2", "bin")}` }, join(base, "home"), "linux", { versionOutput: noRun() }))
      .resolves.toEqual({ binary: v2, version: "2.0.18" });
  });

  it("finds the homepage installer's ~/.opencode/bin (its opencode2 shim is never run) and asks the executable its version once", async () => {
    await fresh();
    const home = join(base, "home");
    const exe = await binary(join(home, ".opencode", "bin", "opencode"));
    await writeFile(join(home, ".opencode", "bin", "opencode2"), "#!/usr/bin/env bash\nexec \"$(dirname \"$0\")/opencode\" \"$@\"\n");
    await chmod(join(home, ".opencode", "bin", "opencode2"), 0o755);
    const versionOutput = reports({ [exe]: "opencode v2.0.18\n" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: join(home, ".opencode", "bin") }, home, "linux", { versionOutput })).resolves.toEqual({ binary: exe, version: "2.0.18" });
    // Not on PATH: the installer's folder is a documented location.
    await expect(resolveNativeOpenCodeInstallation({ PATH: "" }, home, "darwin", { versionOutput })).resolves.toEqual({ binary: exe, version: "2.0.18" });
    expect(versionOutput).toHaveBeenCalledTimes(1);
    expect(versionOutput).toHaveBeenCalledWith(exe);
  });

  it("resolves npm, homepage, scoop and Chocolatey shims on Windows without running them", async () => {
    await fresh();
    const versionOutput = reports({});
    // npm: %APPDATA%\npm\opencode2.cmd with node_modules beside it.
    const npm = join(base, "AppData", "Roaming", "npm");
    const npmExe = await npmPackage(join(npm, "node_modules", "@opencode", "cli"));
    await writeFile(join(npm, "opencode2.cmd"), "@ECHO off\r\n\"%~dp0\\node_modules\\@opencode\\cli\\bin\\opencode.exe\" %*\r\n");
    await expect(resolveNativeOpenCodeInstallation({ PATH: `C:\\Windows;${npm}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, join(base, "home"), "win32", { versionOutput })).resolves.toEqual({ binary: npmExe, version: "2.0.18" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: "", APPDATA: join(base, "AppData", "Roaming") }, join(base, "home"), "win32", { versionOutput })).resolves.toEqual({ binary: npmExe, version: "2.0.18" });
    // The homepage installer under Git Bash: %USERPROFILE%\.opencode\bin\opencode.exe beside opencode2.cmd.
    const profile = join(base, "Users", "person");
    const homepage = await binary(join(profile, ".opencode", "bin", "opencode.exe"), [0x4d, 0x5a, 0x90, 0x00]);
    await writeFile(join(profile, ".opencode", "bin", "opencode2.cmd"), "@echo off\r\n\"%~dp0opencode.exe\" %*\r\n");
    const homepageVersion = reports({ [homepage]: "2.1.3" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: join(profile, ".opencode", "bin"), PATHEXT: ".EXE;.CMD" }, profile, "win32", { versionOutput: homepageVersion })).resolves.toEqual({ binary: homepage, version: "2.1.3" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: "", USERPROFILE: profile }, join(base, "elsewhere"), "win32", { versionOutput: homepageVersion })).resolves.toEqual({ binary: homepage, version: "2.1.3" });
    // scoop: a small shim executable plus `opencode.shim` naming the real path.
    const scoop = join(base, "scoop");
    const scoopExe = await binary(join(scoop, "apps", "opencode", "current", "opencode.exe"), [0x4d, 0x5a, 0x90, 0x00]);
    await mkdir(join(scoop, "shims"), { recursive: true });
    await writeFile(join(scoop, "shims", "opencode.exe"), Buffer.from("MZ tiny shim"));
    await writeFile(join(scoop, "shims", "opencode.shim"), `path = "${scoopExe}"\r\n`);
    const scoopVersion = reports({ [scoopExe]: "opencode v2.0.18" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: join(scoop, "shims"), PATHEXT: ".EXE" }, join(base, "home"), "win32", { versionOutput: scoopVersion })).resolves.toEqual({ binary: scoopExe, version: "2.0.18" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: "", SCOOP: scoop }, join(base, "home"), "win32", { versionOutput: scoopVersion })).resolves.toEqual({ binary: scoopExe, version: "2.0.18" });
    // Chocolatey: <choco>\bin\opencode.exe is a shim for <choco>\lib\<package>\tools\opencode.exe.
    const choco = join(base, "chocolatey");
    const chocoExe = await binary(join(choco, "lib", "opencode-v2", "tools", "opencode.exe"), [0x4d, 0x5a, 0x90, 0x00]);
    await mkdir(join(choco, "bin"), { recursive: true });
    await writeFile(join(choco, "bin", "opencode.exe"), Buffer.from("MZ shimgen"));
    const chocoVersion = reports({ [chocoExe]: "2.0.18" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: "", ChocolateyInstall: choco }, join(base, "home"), "win32", { versionOutput: chocoVersion })).resolves.toEqual({ binary: chocoExe, version: "2.0.18" });
    // No install anywhere: named with the Windows install command.
    const refusal = await resolveNativeOpenCodeInstallation({ PATH: "" }, join(base, "nobody"), "win32", { versionOutput }).catch(error => error);
    expect(refusal).toMatchObject({ code: "prerequisite_missing", diagnostic: "opencode_not_found" });
    expect(refusal.message).toContain(V2_WINDOWS);
  });

  it.runIf(posix)("follows a Homebrew link into its Cellar and falls back to the npm global roots", async () => {
    await fresh();
    const brew = join(base, "homebrew");
    const cellar = await binary(join(brew, "Cellar", "opencode-v2", "2.0.18", "bin", "opencode"));
    await mkdir(join(brew, "bin"), { recursive: true });
    await symlink(join("..", "Cellar", "opencode-v2", "2.0.18", "bin", "opencode"), join(brew, "bin", "opencode2"));
    await expect(resolveNativeOpenCodeInstallation({ PATH: join(brew, "bin") }, join(base, "home"), "darwin", { versionOutput: reports({ [cellar]: "opencode v2.0.18" }) })).resolves.toEqual({ binary: cellar, version: "2.0.18" });
    const exe = await npmPackage(join(base, "custom-prefix", "lib", "node_modules", "@opencode", "cli"), { version: "2.0.19" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: "", npm_config_prefix: join(base, "custom-prefix") }, join(base, "home"), "linux", { versionOutput: noRun() })).resolves.toEqual({ binary: exe, version: "2.0.19" });
    const home = join(base, "home2");
    const npmGlobal = await npmPackage(join(home, ".npm-global", "lib", "node_modules", "@opencode", "cli"));
    await expect(resolveNativeOpenCodeInstallation({ PATH: "" }, home, "linux", { versionOutput: noRun() })).resolves.toEqual({ binary: npmGlobal, version: "2.0.18" });
  });

  it("honours an absolute OPENCODE_EXECUTABLE naming the executable or its package, and nothing else", async () => {
    await fresh();
    const exe = await npmPackage(join(base, "opt", "@opencode", "cli"));
    const other = await npmPrefix(join(base, "prefix"));
    for (const override of [exe, join(base, "opt", "@opencode", "cli")]) {
      await expect(resolveNativeOpenCodeInstallation({ OPENCODE_EXECUTABLE: override, PATH: join(base, "prefix", "bin") }, join(base, "home"), "linux", { versionOutput: noRun() }))
        .resolves.toEqual({ binary: exe, version: "2.0.18" });
    }
    expect(other).not.toBe(exe);
    await expect(resolveNativeOpenCodeInstallation({ OPENCODE_EXECUTABLE: "opencode", PATH: "" }, join(base, "home"), "linux")).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "opencode_not_found" });
    await expect(resolveNativeOpenCodeInstallation({ OPENCODE_EXECUTABLE: join(base, "missing"), PATH: join(base, "prefix", "bin") }, join(base, "home"), "linux")).rejects.toMatchObject({ diagnostic: "opencode_not_found" });
  });

  it("refuses OpenCode 1 by name, with the v2 install command, whether npm recorded it or it says so itself", async () => {
    await fresh();
    const v1 = await npmPackage(join(base, "v1", "node_modules", "opencode-ai"), { name: "opencode-ai", version: "1.18.33" });
    const byPackage = await resolveNativeOpenCodeInstallation({ OPENCODE_EXECUTABLE: v1, PATH: "" }, join(base, "home"), "linux", { versionOutput: noRun() }).catch(error => error);
    expect(byPackage).toMatchObject({ code: "prerequisite_missing", diagnostic: "opencode_unsupported_version", recoveryActions: [{ kind: "install_backend", agentId: "opencode" }] });
    expect(byPackage.message).toBe(`OpenCode 1 is not supported (found 1.18.33): install OpenCode 2 with \`${V2}\`, then retry.`);
    const curl1 = await binary(join(base, "old", ".opencode", "bin", "opencode"));
    const byOutput = await verifyNativeOpenCodeBinary(curl1, "linux", { versionOutput: reports({ [curl1]: "1.18.33" }) }).catch(error => error);
    expect(byOutput).toMatchObject({ diagnostic: "opencode_unsupported_version" });
    expect(byOutput.message).toContain("OpenCode 1 is not supported");
    const windows = await verifyNativeOpenCodeBinary(curl1, "win32", { versionOutput: reports({ [curl1]: "opencode v1.2.0" }) }).catch(error => error);
    expect(windows.message).toContain(V2_WINDOWS);
  });

  it("accepts 2.0.18 up to 3.0.0 only, and says which versions it takes", async () => {
    await fresh();
    for (const [reported, version] of [["opencode v2.0.18", "2.0.18"], ["2.0.19", "2.0.19"], ["opencode 2.9.1", "2.9.1"]] as const) {
      const exe = await binary(join(base, `ok-${version}`, "opencode"));
      await expect(verifyNativeOpenCodeBinary(exe, "linux", { versionOutput: reports({ [exe]: reported }) }), reported).resolves.toEqual({ binary: exe, version });
    }
    for (const reported of ["2.0.17", "3.0.0", "3.0.0-beta.1", "0.0.0-beta-17236", "garbage", ""]) {
      const exe = await binary(join(base, `bad-${reported || "empty"}`, "opencode"));
      const refusal = await verifyNativeOpenCodeBinary(exe, "linux", { versionOutput: reports({ [exe]: reported }) }).catch(error => error);
      expect(refusal, reported).toMatchObject({ code: "prerequisite_missing", diagnostic: "opencode_unsupported_version" });
      expect(refusal.message, reported).toContain(V2);
    }
    const exe = await binary(join(base, "old2", "opencode"));
    const refusal = await verifyNativeOpenCodeBinary(exe, "linux", { versionOutput: reports({ [exe]: "opencode v2.0.5" }) }).catch(error => error);
    expect(refusal.message).toBe(`OpenCode 2.0.5 is not a version Konteks supports (2.0.18 up to, but not including, 3.0.0). Install OpenCode 2 with \`${V2}\`, then retry.`);
  });

  it("prefers a supported install over an unsupported one found earlier, and reports the unsupported one when alone", async () => {
    await fresh();
    await npmPrefix(join(base, "a"), { version: "2.0.10" }, ["opencode2"]);
    const good = await npmPrefix(join(base, "b"), {}, ["opencode2"]);
    await expect(resolveNativeOpenCodeInstallation({ PATH: `${join(base, "a", "bin")}:${join(base, "b", "bin")}` }, join(base, "home"), "linux", { versionOutput: noRun() })).resolves.toEqual({ binary: good, version: "2.0.18" });
    await expect(resolveNativeOpenCodeInstallation({ PATH: join(base, "a", "bin") }, join(base, "home"), "linux", { versionOutput: noRun() })).rejects.toMatchObject({ diagnostic: "opencode_unsupported_version" });
  });

  it("does not take a script, a shim with nothing behind it, or a tiny file for OpenCode", async () => {
    await fresh();
    await mkdir(join(base, "bin"), { recursive: true });
    await writeFile(join(base, "bin", "opencode"), "#!/bin/sh\necho opencode v2.0.18\n");
    await chmod(join(base, "bin", "opencode"), 0o755);
    const versionOutput = noRun();
    const refusal = await resolveNativeOpenCodeInstallation({ PATH: join(base, "bin") }, join(base, "home"), "linux", { versionOutput }).catch(error => error);
    expect(refusal).toMatchObject({ code: "prerequisite_missing", diagnostic: "opencode_not_found" });
    expect(refusal.message).toBe(`OpenCode 2 is not installed for this user. Install it with \`${V2}\`, then retry.`);
    expect(versionOutput).not.toHaveBeenCalled();
  });

  it.runIf(posix && process.getuid?.() !== 0)("refuses an installation other users can change, and never runs it", async () => {
    await fresh();
    const exe = await binary(join(base, "shared", "opencode"));
    await chmod(exe, 0o775);
    const versionOutput = noRun();
    await expect(verifyNativeOpenCodeBinary(exe, "linux", { versionOutput })).rejects.toMatchObject({ diagnostic: "opencode_unsafe_install" });
    expect(versionOutput).not.toHaveBeenCalled();
    await chmod(exe, 0o755);
    await expect(verifyNativeOpenCodeBinary(exe, "linux", { versionOutput: reports({ [exe]: "2.0.18" }) })).resolves.toEqual({ binary: exe, version: "2.0.18" });
    // npm's package.json decides the version, so it must be safe too.
    const npmExe = await npmPackage(join(base, "npm", "@opencode", "cli"));
    await chmod(join(base, "npm", "@opencode", "cli", "package.json"), 0o666);
    const refusal = await verifyNativeOpenCodeBinary(npmExe, "linux", { versionOutput: noRun() }).catch(error => error);
    expect(refusal).toMatchObject({ diagnostic: "opencode_unsafe_install" });
    expect(refusal.message).toContain(V2);
  });

  it("reads the version line OpenCode prints", () => {
    expect(parseOpenCodeVersion("opencode v2.0.18\n")).toBe("2.0.18");
    expect(parseOpenCodeVersion("2.0.18")).toBe("2.0.18");
    expect(parseOpenCodeVersion("1.18.33\nsomething else")).toBe("1.18.33");
    expect(parseOpenCodeVersion("0.0.0-beta-17236")).toBe("0.0.0-beta-17236");
    expect(parseOpenCodeVersion("no version here")).toBeNull();
    expect(parseOpenCodeVersion(null)).toBeNull();
  });
});

describe("the one OpenCode command detection runs", () => {
  let base = "";
  afterEach(async () => { vi.unstubAllEnvs(); if (base) await rm(base, { recursive: true, force: true }); });

  it.runIf(posix)("never passes the owner's GITHUB_TOKEN or any credential variable, and leaves no home behind", async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "opencode-version-")));
    const secrets: Record<string, string> = {
      GITHUB_TOKEN: "ghp_owner_token_must_not_reach_opencode", GH_TOKEN: "gho_owner", OPENAI_API_KEY: "sk-owner", ANTHROPIC_API_KEY: "sk-ant-owner",
      OPENROUTER_API_KEY: "sk-or-owner", AWS_ACCESS_KEY_ID: "AKIAOWNER", AWS_SECRET_ACCESS_KEY: "aws-secret", AZURE_OPENAI_API_KEY: "azure-owner",
      GOOGLE_APPLICATION_CREDENTIALS: "/owner/gcp.json", OPENCODE_CONFIG_CONTENT: "{\"permissions\":[]}", OPENCODE_AUTH_CONTENT: "{}", NPM_TOKEN: "npm-owner",
      DEEPSEEK_API_KEY: "sk-ds-owner", COPILOT_TOKEN: "copilot", SOME_PASSWORD: "hunter2",
    };
    for (const [name, value] of Object.entries(secrets)) vi.stubEnv(name, value);
    vi.stubEnv("HTTPS_PROXY", "http://proxy.local:3128");
    vi.stubEnv("LANG", "en_US.UTF-8");
    // Stands in for the executable: prints the environment it was given and where it ran.
    const probe = join(base, "print-env");
    await writeFile(probe, "#!/bin/sh\nenv\necho \"CWD=$(pwd)\"\n");
    await chmod(probe, 0o755);
    const before = new Set(await readdir(tmpdir()));
    const output = await openCodeVersionOutput(probe);
    expect(output).not.toBeNull();
    const seen = Object.fromEntries(output!.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    for (const name of Object.keys(secrets)) expect(seen[name], name).toBeUndefined();
    for (const value of Object.values(secrets)) expect(output).not.toContain(value);
    expect(Object.keys(seen).filter(name => /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(name))).toEqual([]);
    expect(Object.keys(seen).filter(name => name.startsWith("OPENCODE_"))).toEqual([]);
    expect(seen).toMatchObject({ HTTPS_PROXY: "http://proxy.local:3128", LANG: "en_US.UTF-8", NO_COLOR: "1" });
    expect(seen.PATH).toBe(process.env.PATH);
    // A throwaway private home and working folder, removed afterwards.
    const scratch = /konteks-opencode-[^/]+/.exec(seen.HOME ?? "")?.[0];
    expect(scratch).toBeDefined();
    expect(seen.CWD).toContain(scratch);
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) expect(seen[name], name).toContain(scratch);
    const after = (await readdir(tmpdir())).filter(name => name.startsWith("konteks-opencode-") && !before.has(name));
    expect(after).toEqual([]);
  });
});
