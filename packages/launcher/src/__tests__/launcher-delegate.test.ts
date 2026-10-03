import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegateToInstalledRelease, installedReleaseLauncher, LAUNCHER_DELEGATED_ENV, launcherChildEnv, runInstalledRelease } from "../native/launcher-delegate.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** A per-user root as an installed Windows connector leaves it: the record and one release folder. */
async function installedRoot(options: { releaseId?: string; bundleVersion?: string; file?: string | null } = {}) {
  const base = await mkdtemp(join(tmpdir(), "launcher-delegate-")); roots.push(base);
  const root = join(base, "konteks-remote");
  const releaseId = options.releaseId ?? "release-Ab12Cd";
  await mkdir(join(root, "releases", "release-Ab12Cd"), { recursive: true });
  await writeFile(join(root, "native-runtime.json"), JSON.stringify({ schemaVersion: 1, releaseId, bundleVersion: options.bundleVersion ?? "0.10.12" }));
  const file = options.file === undefined ? "konteks-connector.exe" : options.file;
  if (file) await writeFile(join(root, "releases", "release-Ab12Cd", file), "release-executable");
  return { base, root, executable: join(root, "releases", "release-Ab12Cd", file ?? "konteks-connector.exe") };
}

const msi = "C:\\Program Files\\konteks-remote\\konteks-remote.exe";
function input(root: string, args: string[], overrides: Partial<Parameters<typeof installedReleaseLauncher>[0]> = {}): Parameters<typeof installedReleaseLauncher>[0] {
  return { platform: "win32", execPath: msi, args: ["--root", root, ...args], env: {}, launcherVersion: "v0.10.11", defaultRoot: () => root, ...overrides };
}

describe("the Windows konteks-remote command runs the installed release's own code (D131)", () => {
  it("resolves the record's release executable for an ordinary command, with --root before or after it", async () => {
    const { root, executable } = await installedRoot();
    await expect(installedReleaseLauncher(input(root, ["start"]))).resolves.toEqual({ executable, bundleVersion: "0.10.12" });
    await expect(installedReleaseLauncher({ ...input(root, []), args: ["update", `--root=${root}`] })).resolves.toEqual({ executable, bundleVersion: "0.10.12" });
    await expect(installedReleaseLauncher({ ...input(root, []), args: ["--json", "doctor"] })).resolves.toEqual({ executable, bundleVersion: "0.10.12" });
    // No command at all (help, --version) is the installed release's too.
    await expect(installedReleaseLauncher(input(root, ["--help"]))).resolves.toEqual({ executable, bundleVersion: "0.10.12" });
  });

  it("finds a release staged before the rename by its old file name", async () => {
    const { root, executable } = await installedRoot({ file: "connector.exe" });
    await expect(installedReleaseLauncher(input(root, ["status"]))).resolves.toEqual({ executable, bundleVersion: "0.10.12" });
  });

  it("runs the installer's own code for install, uninstall and the enrollment's staging", async () => {
    const { root } = await installedRoot();
    for (const command of ["install", "uninstall", "stage-enrollment"]) {
      await expect(installedReleaseLauncher(input(root, ["--json", command]))).resolves.toBeNull();
    }
  });

  it("runs its own code when nothing is installed yet, or the record names no release", async () => {
    const { root } = await installedRoot();
    await rm(join(root, "native-runtime.json"));
    await expect(installedReleaseLauncher(input(root, ["status"]))).resolves.toBeNull();
    const pending = await installedRoot({ releaseId: "pending" });
    await expect(installedReleaseLauncher(input(pending.root, ["onboard"]))).resolves.toBeNull();
    const missing = await installedRoot({ file: null });
    await expect(installedReleaseLauncher(input(missing.root, ["status"]))).resolves.toBeNull();
  });

  it("runs its own code when it is newer than the installed release, and the release's when that is as new or newer", async () => {
    const older = await installedRoot({ bundleVersion: "0.10.9" });
    await expect(installedReleaseLauncher(input(older.root, ["update"]))).resolves.toBeNull();
    const same = await installedRoot({ bundleVersion: "0.10.11" });
    await expect(installedReleaseLauncher(input(same.root, ["update"]))).resolves.toEqual({ executable: same.executable, bundleVersion: "0.10.11" });
    const broken = await installedRoot({ bundleVersion: "not-a-version" });
    await expect(installedReleaseLauncher(input(broken.root, ["update"]))).resolves.toBeNull();
  });

  it("never follows a release id or a file that leaves the per-user root", async () => {
    for (const releaseId of ["..\\..\\Windows", "release-Ab12Cd\\..\\..", "release-../x", "release-Ab12Cd/../../x"]) {
      const { root } = await installedRoot({ releaseId });
      await expect(installedReleaseLauncher(input(root, ["status"]))).resolves.toBeNull();
    }
    const directory = await installedRoot({ file: null });
    await mkdir(join(directory.root, "releases", "release-Ab12Cd", "konteks-connector.exe"));
    await expect(installedReleaseLauncher(input(directory.root, ["status"]))).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("never follows a link: not for the executable, its release folder or the record", async () => {
    const outside = await mkdtemp(join(tmpdir(), "launcher-delegate-outside-")); roots.push(outside);
    await writeFile(join(outside, "konteks-connector.exe"), "someone-else");
    const linkedFile = await installedRoot({ file: null });
    await symlink(join(outside, "konteks-connector.exe"), join(linkedFile.root, "releases", "release-Ab12Cd", "konteks-connector.exe"));
    await expect(installedReleaseLauncher(input(linkedFile.root, ["status"]))).resolves.toBeNull();
    const linkedFolder = await installedRoot({ file: null });
    await rm(join(linkedFolder.root, "releases", "release-Ab12Cd"), { recursive: true });
    await symlink(outside, join(linkedFolder.root, "releases", "release-Ab12Cd"));
    await expect(installedReleaseLauncher(input(linkedFolder.root, ["status"]))).resolves.toBeNull();
    const linkedRecord = await installedRoot();
    await writeFile(join(outside, "native-runtime.json"), JSON.stringify({ releaseId: "release-Ab12Cd", bundleVersion: "0.10.12" }));
    await rm(join(linkedRecord.root, "native-runtime.json"));
    await symlink(join(outside, "native-runtime.json"), join(linkedRecord.root, "native-runtime.json"));
    await expect(installedReleaseLauncher(input(linkedRecord.root, ["status"]))).resolves.toBeNull();
  });

  // Windows: a junction needs no privilege, so anyone who can write the root could make one.
  it.runIf(process.platform === "win32")("never follows a junction from the release folder to elsewhere", async () => {
    const outside = await mkdtemp(join(tmpdir(), "launcher-delegate-outside-")); roots.push(outside);
    await writeFile(join(outside, "konteks-connector.exe"), "someone-else");
    const linked = await installedRoot({ file: null });
    await rm(join(linked.root, "releases", "release-Ab12Cd"), { recursive: true });
    await symlink(outside, join(linked.root, "releases", "release-Ab12Cd"), "junction");
    await expect(installedReleaseLauncher(input(linked.root, ["status"]))).resolves.toBeNull();
  });

  it("is only the installed Windows command's: not another OS, a release's own executable, node, or a delegated run", async () => {
    const { root, executable } = await installedRoot();
    await expect(installedReleaseLauncher(input(root, ["status"], { platform: "darwin" }))).resolves.toBeNull();
    await expect(installedReleaseLauncher(input(root, ["status"], { execPath: executable }))).resolves.toBeNull();
    await expect(installedReleaseLauncher(input(root, ["status"], { execPath: "C:\\Program Files\\nodejs\\node.exe" }))).resolves.toBeNull();
    await expect(installedReleaseLauncher(input(root, ["status"], { env: { [LAUNCHER_DELEGATED_ENV]: "1" } }))).resolves.toBeNull();
    // The name is matched as Windows does, whatever its case.
    await expect(installedReleaseLauncher(input(root, ["status"], { execPath: "C:\\PROGRA~1\\konteks-remote\\KONTEKS-REMOTE.EXE" }))).resolves.toEqual({ executable, bundleVersion: "0.10.12" });
  });

  it("hands the release the person's environment without the installer's own baked values, and marks the run", () => {
    const env = launcherChildEnv({ PATH: "x", KONTEKS_RELEASE_ROOTS_JSON: "{}", KONTEKS_LAUNCHER_VERSION: "v0.10.11", KONTEKS_CORE_URL: "https://api.konteks.io", KONTEKS_RELAY_URL: "wss://person.example/relay" }, ["KONTEKS_CORE_URL"]);
    expect(env).toEqual({ PATH: "x", KONTEKS_RELAY_URL: "wss://person.example/relay", [LAUNCHER_DELEGATED_ENV]: "1" });
  });

  it("passes the arguments and the exit code straight through", async () => {
    const base = await mkdtemp(join(tmpdir(), "launcher-delegate-run-")); roots.push(base);
    const out = join(base, "seen.json");
    const script = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), mark: process.env.KONTEKS_REMOTE_VIA_LAUNCHER ?? null })); process.exit(7)";
    const code = await runInstalledRelease(process.execPath, ["-e", script, out, "auth", "login", "dsh", "--provider", "a b"], { env: launcherChildEnv(process.env, []) });
    expect(code).toBe(7);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ args: ["auth", "login", "dsh", "--provider", "a b"], mark: "1" });
  });

  it("falls back to its own code when the release cannot be started", async () => {
    const { root, executable } = await installedRoot();
    const notStarted = await runInstalledRelease(join(root, "missing", "konteks-connector.exe"), ["status"], { env: {} });
    expect(notStarted).toBeNull();
    const lines: string[] = [];
    const ran: string[][] = [];
    const code = await delegateToInstalledRelease({ ...input(root, ["status"]), stderr: { write: (text: string) => { lines.push(text); return true; } } }, {
      run: async (path, args) => { ran.push([path, ...args]); return null; },
    });
    expect(code).toBeNull();
    expect(ran).toEqual([[executable, "--root", root, "status"]]);
    expect(lines.join("")).toMatch(/could not start the installed release 0\.10\.12; running this installer's own copy instead/);
  });

  it("returns the release's exit code, and runs nothing where the installer's own code applies", async () => {
    const { root, executable } = await installedRoot();
    const ran: string[][] = [];
    const run = async (path: string, args: readonly string[]) => { ran.push([path, ...args]); return 3; };
    await expect(delegateToInstalledRelease(input(root, ["doctor"]), { run })).resolves.toBe(3);
    await expect(delegateToInstalledRelease(input(root, ["uninstall"]), { run })).resolves.toBeNull();
    expect(ran).toEqual([[executable, "--root", root, "doctor"]]);
  });
});
