import { spawn } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_UPDATE_TARGET_ENV, bundleManifestSigningBytes, computeBundleManifestDigest, jcsDigest, RemoteInstanceError, writeSecretFile, type JsonValue } from "@konteks/remote-common";
import { buildReleaseFixture, nativeServiceExecutable, resolveNativeConnectorExecutable, verifyNativeRelease, type CodeIdentity } from "@konteks/remote-release";
import { acquireNativeRootLock, isDeferredUpdateAttempt, loadNativeInstallation, OPENCODE_MIN_BINARY_BYTES, readNativeUpdateLedger, SupervisorStore, verifyInstalledNativeConnector, type NativeRuntimeRecord, type NativeUpdateAttempt } from "@konteks/remote-supervisor";
import { installNative, readNativeRecord, restoreNativeRecord } from "../native/install.js";
import { checkNativeUpdate, commitNativeUpdate, stageNativeUpdate, type NativeUpdateDeps } from "../native/update.js";
import { earlierFailure, earlierFailureNote, keepLauncherCurrent, refreshInstalledLauncher, runNativeUpdate, selfUpdateNote, type NativeUpdateTransactionDeps } from "../native/update-transaction.js";
import { createOutput } from "../output.js";
import { activateServiceExecutable } from "../native/service-executable.js";
import { nativePlatform, nativeServiceDefinition, startNativeServiceDefinition, type NativeServiceCommand } from "../native/service.js";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { testGitCommand, testGitTool } from "../../../supervisor/src/__tests__/native-git-fixture.js";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture({ oldVersion = "1.0.0", nextVersion = "1.1.0", openCode = false }: { oldVersion?: string; nextVersion?: string; openCode?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-cli-update-")); roots.push(root);
  if (openCode) {
    // The person's own OpenCode 2 as npm installs it (never run: its version is in package.json).
    const pkg = join(root, "person-opencode", "lib", "node_modules", "@opencode", "cli");
    await mkdir(join(pkg, "bin"), { recursive: true });
    const body = Buffer.alloc(OPENCODE_MIN_BINARY_BYTES + 16);
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(body);
    await writeFile(join(pkg, "bin", "opencode.exe"), body, { mode: 0o755 });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.18" }));
    vi.stubEnv("OPENCODE_EXECUTABLE", join(pkg, "bin", "opencode.exe"));
  }
  const claudeTool = join(root, "operator-claude");
  await writeFile(claudeTool, "claude-not-executed", { mode: 0o700 });
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", claudeTool);
  const keys = buildReleaseFixture();
  const claude = offlineFixture("macos", "arm64", "claude-code");
  const connector = (version: string) => {
    const bytes = Buffer.from(`test-native-executable-not-run-${version}`);
    return { bytes, artifact: { id: "connector", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: `https://releases.example/connector-${version}`, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, sizeBytes: bytes.byteLength } };
  };
  const old = connector(oldVersion), next = connector(nextVersion);
  const signed = (body: Record<string, unknown>) => {
    const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
    return { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
  };
  const base = { protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], expiresAt: "2027-01-01T00:00:00Z" };
  const oldManifest = signed({ ...base, bundleVersion: oldVersion, nativeArtifacts: [old.artifact, claude.artifact] });
  const manifest = signed({ ...base, bundleVersion: nextVersion, nativeArtifacts: [next.artifact, claude.artifact] });
  const trust = [{ ...keys.root, coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }] }];
  const platform = { os: "macos", architecture: "arm64", deploymentKind: "native_connector", containerBackend: "none" } as const;
  const activate = vi.fn(async ({ release }: { release: { manifest: typeof manifest } }) => {
    await writeSecretFile(join(root, "supervisor", "identity.json"), JSON.stringify({ instanceId: "instance", workspaceId: "tenant", activationId: "activation-123", activatedAt: new Date().toISOString(), administrativeStatus: "provisioning", exchangeNonce: "nonce" }));
    await writeSecretFile(join(root, "supervisor", "manifest.json"), JSON.stringify({ manifest: release.manifest, manifestDigest: release.manifest.digest }));
    return { instanceId: "instance", manifest: release.manifest, manifestDigest: release.manifest.digest, provisioningWindowExpiresAt: "2026-10-01T00:00:00Z" };
  });
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = requestUrl(input);
    return new Response(url === claude.artifact.url ? claude.archive : url === next.artifact.url ? next.bytes : old.bytes);
  });
  const output = createOutput({ json: true });
  const installed = await installNative({ root, activationId: "activation-123", coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", agents: openCode ? ["claude-code", "opencode"] : ["claude-code"], output, deps: { roots: trust, platform, manifest: oldManifest, activate, fetchFn, git: null } } as never);
  await writeFile(join(root, "credentials", "claude-code", "keep"), "credential-owned-by-agent");
  const deps = { roots: trust, platform, fetchFn };
  return { root, output, trust, platform, manifest, oldManifest, fetchFn, installed, deps };
}

async function directoryBytes(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryBytes(path);
      for (const [name, bytes] of Object.entries(nested)) files[join(entry.name, name)] = bytes;
    } else {
      files[entry.name] = (await readFile(path)).toString("base64");
    }
  }
  return files;
}

async function retainedWorkspace(root: string) {
  const workspaceRoot = join(root, "workspaces", "claude-code");
  const cwd = join(workspaceRoot, "retained-ticket");
  await mkdir(cwd, { recursive: true });
  const tool = await testGitTool();
  const git = (args: string[]) => testGitCommand(tool, cwd, args);
  await git(["init", "--initial-branch=main"]);
  for (const name of ["tracked.txt", "staged.txt", "deleted.txt"]) await writeFile(join(cwd, name), "baseline\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await git(["add", "."]);
  await git(["-c", "user.name=Update fixture", "-c", "user.email=update@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "retained baseline"]);
  await writeFile(join(cwd, "tracked.txt"), "unstaged edit\n");
  await writeFile(join(cwd, "staged.txt"), "staged contents\n");
  await git(["add", "staged.txt"]);
  await writeFile(join(cwd, "staged.txt"), "unstaged contents after staging\n");
  await rm(join(cwd, "deleted.txt"));
  await writeFile(join(cwd, "untracked.txt"), "untracked contents\n");
  await writeFile(join(cwd, "ignored.txt"), "ignored contents\n");
  // Opaque retained bytes: this fixture never opens an agent or claims these records establish ownership.
  const retained = {
    "workspaces/claude-code/.workspace-recovery/retained.owner.json": '{"checkpointId":"retained","state":"writing"}\n',
    "workspaces/claude-code/.workspace-recovery/retained.checkpoint.json": '{"retained":"local checkpoint bytes"}\n',
    "supervisor/journal/assignments.jsonl": '{"assignmentId":"retained","attempt":1,"state":"completed"}\n',
    "supervisor/journal/local-execution.jsonl": '{"claimId":"retained-claim","phase":"settled"}\n',
    "credentials/claude-code/session-refs.json": '{"retained-session":"retained-provider-reference"}\n',
  };
  for (const [name, bytes] of Object.entries(retained)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeSecretFile(path, bytes);
  }
  const directories = [workspaceRoot, join(root, "supervisor", "journal"), join(root, "credentials", "claude-code")];
  const snapshot = async () => ({
    files: await Promise.all(directories.map(directoryBytes)),
    status: await git(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all", "--ignored"]),
    index: await git(["ls-files", "--stage"]),
  });
  const before = await snapshot();
  for (const status of [" M tracked.txt", "MM staged.txt", " D deleted.txt", "?? untracked.txt", "!! ignored.txt"]) expect(before.status).toContain(status);
  expect(await git(["show", ":staged.txt"])).toBe("staged contents\n");
  return { assertPreserved: async () => expect(await snapshot()).toEqual(before) };
}

describe("native update staging and commit", () => {
  it("refuses a changed fixed target before acquiring the installer lock, downloading, or staging files", async () => {
    const f = await fixture();
    const before = await readdir(join(f.root, "releases"));
    const lock = acquireNativeRootLock(join(f.root, "installer"));
    f.fetchFn.mockClear();
    vi.stubEnv(NATIVE_UPDATE_TARGET_ENV, JSON.stringify({ bundleVersion: "1.2.0", manifestDigest: f.manifest.digest }));
    try {
      await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } })).rejects.toMatchObject({ code: "update_required" });
      expect(f.fetchFn).not.toHaveBeenCalled();
      expect(await readdir(join(f.root, "releases"))).toEqual(before);
      expect(await readNativeRecord(f.root)).toEqual(f.installed);
    } finally { lock.release(); }
  });

  it("pins the verified channel bytes across the installer lock so a moving latest release cannot change the requested update", async () => {
    const f = await fixture();
    vi.stubEnv(NATIVE_UPDATE_TARGET_ENV, JSON.stringify({ bundleVersion: "1.1.0", manifestDigest: f.manifest.digest }));
    let channelReads = 0;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith("native-manifest.json")) {
        channelReads += 1;
        return new Response(JSON.stringify(channelReads === 1 ? f.manifest : f.oldManifest));
      }
      return f.fetchFn(input, init);
    });
    const staged = await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, fetchFn } });
    expect(staged).toMatchObject({ status: "staged", release: { manifest: { bundleVersion: "1.1.0", digest: f.manifest.digest } } });
    expect(channelReads).toBe(1);
  });

  it("offers a newer signed rc build with the same release core", async () => {
    const f = await fixture({ oldVersion: "0.7.6-rc.1", nextVersion: "0.7.6-rc.2" });
    expect(await checkNativeUpdate({ root: f.root, deps: { ...f.deps, manifest: f.manifest } })).toMatchObject({
      status: "available", release: { manifest: { bundleVersion: "0.7.6-rc.2" } },
    });
  });
  it("explains the long signed-package staging wait and how to return to the result", async () => {
    const f = await fixture();
    const lines: string[] = [];
    const output = { ...f.output, line: (line: string) => { lines.push(line); } };
    await stageNativeUpdate({ root: f.root, output, deps: { ...f.deps, manifest: f.manifest } });
    expect(lines[0]).toContain("Staging native release 1.1.0");
    expect(lines[0]).toMatch(/download|verify|unpack/i);
    expect(lines[0]).toMatch(/minute/i);
    expect(lines[0]).toMatch(/leave.*running|return.*result/i);
    expect(lines.at(-1)).toContain("staged");
  });

  it.runIf(process.platform !== "win32")("restages only bundled agents: the person's own OpenCode keeps running from their install across an update", async () => {
    const f = await fixture({ openCode: true });
    const staged = await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } });
    if (staged.status !== "staged") throw new Error("unreachable");
    expect(await readdir(join(staged.directory, "agents"))).toEqual(["claude-code"]);
    const successor = await commitNativeUpdate({ root: f.root, releaseId: staged.releaseId, output: f.output, deps: f.deps });
    expect(successor).toMatchObject({ agents: ["claude-code", "opencode"], opencodeVersion: "2.0.18" });
    const loaded = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(loaded.runners.map(runner => runner.RUNNER_AGENT_ID)).toEqual(["claude-code", "opencode"]);
    expect(f.fetchFn.mock.calls.map(call => String(call[0])).some(url => /opencode/i.test(url))).toBe(false);
  });

  it("stages a strictly newer signed release beside the running one and commits it, keeping the previous directory", async () => {
    const f = await fixture();
    expect(await checkNativeUpdate({ root: f.root, deps: { ...f.deps, manifest: f.oldManifest } })).toMatchObject({ status: "current", bundleVersion: "1.0.0" });
    const staged = await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } });
    expect(staged.status).toBe("staged");
    if (staged.status !== "staged") throw new Error("unreachable");
    // Nothing running changed: the record still names the previous release.
    expect(await readNativeRecord(f.root)).toEqual(f.installed);
    expect(await readFile(join(staged.directory, "konteks-connector"))).toEqual(Buffer.from("test-native-executable-not-run-1.1.0"));
    expect(await readFile(join(staged.directory, "connector"))).toEqual(Buffer.from("test-native-executable-not-run-1.1.0"));
    expect(JSON.parse(await readFile(join(staged.directory, "manifest.json"), "utf8"))).toEqual(f.manifest);

    const successor = await commitNativeUpdate({ root: f.root, releaseId: staged.releaseId, output: f.output, deps: f.deps });
    expect(successor).toMatchObject({ instanceId: "instance", workspaceId: "tenant", releaseId: staged.releaseId, bundleVersion: "1.1.0", manifestDigest: f.manifest.digest, agents: ["claude-code"] });
    expect(await new SupervisorStore(join(f.root, "supervisor")).manifest()).toEqual({ manifest: f.manifest, manifestDigest: f.manifest.digest });
    await expect(loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform })).resolves.toMatchObject({ record: { releaseId: staged.releaseId } });
    const releases = await readdir(join(f.root, "releases"));
    expect(releases).toEqual(expect.arrayContaining([f.installed.releaseId, staged.releaseId]));
    expect(await readFile(join(f.root, "credentials", "claude-code", "keep"), "utf8")).toBe("credential-owned-by-agent");

    await restoreNativeRecord(f.root, successor.releaseId, f.installed, { roots: f.trust, platform: f.platform });
    await expect(loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform })).resolves.toMatchObject({ record: { releaseId: f.installed.releaseId, bundleVersion: "1.0.0" } });
  });
  it("says another update is still running when one holds the installation, instead of a bare ownership refusal (RCA 2026-10-01)", async () => {
    const f = await fixture();
    const held = acquireNativeRootLock(join(f.root, "installer"));
    try {
      await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } })).rejects.toThrow("Another update or install of this connector is still running (it may be downloading a release). Wait for it to finish, then run `konteks-remote status`.");
    } finally { held.release(); }
    await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } })).resolves.toMatchObject({ status: "staged" });
  });
  it("updates from a release staged before the rename, and rolls back to it", async () => {
    const f = await fixture();
    // The installed release as an older connector staged it: `connector` only.
    const previous = join(f.root, "releases", f.installed.releaseId);
    await rm(join(previous, "konteks-connector"));
    expect(await resolveNativeConnectorExecutable(previous, "macos")).toBe(join(previous, "connector"));
    const before = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    await expect(verifyInstalledNativeConnector(before.release, previous, f.platform)).resolves.toBeUndefined();

    const staged = await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } });
    if (staged.status !== "staged") throw new Error("unreachable");
    expect(await resolveNativeConnectorExecutable(staged.directory, "macos")).toBe(join(staged.directory, "konteks-connector"));
    // Once the transition copy is dropped, a release with only the Konteks name commits too.
    await rm(join(staged.directory, "connector"));
    const successor = await commitNativeUpdate({ root: f.root, releaseId: staged.releaseId, output: f.output, deps: f.deps });
    const after = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    await expect(verifyInstalledNativeConnector(after.release, staged.directory, f.platform)).resolves.toBeUndefined();

    // Rollback returns to the pre-rename folder; the service is found under its old name.
    await restoreNativeRecord(f.root, successor.releaseId, f.installed, { roots: f.trust, platform: f.platform });
    const restored = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(restored.record.releaseId).toBe(f.installed.releaseId);
    await expect(verifyInstalledNativeConnector(restored.release, previous, f.platform)).resolves.toBeUndefined();
    expect(await resolveNativeConnectorExecutable(previous, "macos")).toBe(join(previous, "connector"));
  });
  it("refuses same-version, untrusted and tampered releases without touching the record", async () => {
    const f = await fixture();
    const retained = await retainedWorkspace(f.root);
    expect(await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.oldManifest } })).toMatchObject({ status: "current" });
    await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, roots: [], manifest: f.manifest } })).rejects.toMatchObject({ code: "bundle_untrusted" });
    // A digest mismatch during download leaves no candidate behind.
    const corrupt = vi.fn<typeof fetch>().mockImplementation(async (input, init) => requestUrl(input).endsWith("connector-1.1.0") ? new Response(Buffer.from("tampered-bytes-of-the-same-length")) : f.fetchFn(input, init));
    await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, fetchFn: corrupt, manifest: f.manifest, retryDelayMs: 0 } })).rejects.toThrow(/connector-1\.1\.0: native artifact size or digest mismatch/);
    expect((await readdir(join(f.root, "releases"))).filter(name => name.startsWith(".candidate-"))).toEqual([]);
    expect(await readNativeRecord(f.root)).toEqual(f.installed);
    await retained.assertPreserved();
    // A staged release whose connector bytes change before commit is refused.
    const staged = await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } });
    if (staged.status !== "staged") throw new Error("unreachable");
    await writeFile(join(staged.directory, "connector"), "test-native-executable-not-run-1.1.X", { mode: 0o700 });
    await expect(commitNativeUpdate({ root: f.root, releaseId: staged.releaseId, output: f.output, deps: f.deps })).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(await readNativeRecord(f.root)).toEqual(f.installed);
    await expect(commitNativeUpdate({ root: f.root, releaseId: "../escape", output: f.output, deps: f.deps })).rejects.toMatchObject({ code: "install_state_corrupt" });
    await retained.assertPreserved();
  });
});

describe("the publisher identity an update must keep", () => {
  const signedBy = (publisher: string): CodeIdentity => ({ signed: true, publisher });
  /** The installed connector reads as `installed`, the staged candidate as `candidate`. */
  const identities = (installed: CodeIdentity, candidate: CodeIdentity) => vi.fn<NonNullable<NativeUpdateDeps["codeIdentity"]>>(async (file) => (file.includes(".candidate-") ? candidate : installed));
  const capture = (f: Awaited<ReturnType<typeof fixture>>) => {
    const lines: string[] = [];
    return { lines, output: { ...f.output, line: (line: string) => { lines.push(line); } } };
  };

  it("stages an update signed by the installed connector's publisher", async () => {
    const f = await fixture();
    const { lines, output } = capture(f);
    const codeIdentity = identities(signedBy("macos identifier \"dev.konteks.connector\" and anchor apple generic and certificate leaf[subject.OU] = TEAM"), signedBy("macos identifier \"dev.konteks.connector\" and anchor apple generic and certificate leaf[subject.OU] = TEAM"));
    await expect(stageNativeUpdate({ root: f.root, output, deps: { ...f.deps, manifest: f.manifest, codeIdentity } })).resolves.toMatchObject({ status: "staged" });
    expect(lines).toContain("The update is signed by the same publisher as this connector.");
    expect(codeIdentity.mock.calls.map(call => call[1])).toEqual(["macos", "macos"]);
  });

  it("refuses an update from another publisher, or an unsigned one, once the installed connector is signed, and changes nothing", async () => {
    const f = await fixture();
    for (const candidate of [signedBy("macos another team"), { signed: false } as const]) {
      const codeIdentity = identities(signedBy("macos konteks team"), candidate);
      await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest, codeIdentity } }))
        .rejects.toThrow("The update is not signed by the same publisher as this connector, so it was not installed. Nothing changed.");
    }
    expect(await readdir(join(f.root, "releases"))).toEqual([f.installed.releaseId]);
    expect(await readNativeRecord(f.root)).toEqual(f.installed);
  });

  it("accepts the update of an unsigned connector and says the identity was not compared", async () => {
    const f = await fixture();
    const { lines, output } = capture(f);
    const codeIdentity = identities({ signed: false }, signedBy("macos konteks team"));
    await expect(stageNativeUpdate({ root: f.root, output, deps: { ...f.deps, manifest: f.manifest, codeIdentity } })).resolves.toMatchObject({ status: "staged" });
    expect(lines).toContain("This connector is not publisher-signed yet, so the update's signature was not compared.");
  });

  it("reads the installed identity from the service's stable executable once it exists", async () => {
    const f = await fixture();
    const installed = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: f.installed.releaseId, release: installed.release });
    const codeIdentity = identities({ signed: false }, { signed: false });
    await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest, codeIdentity } });
    expect(codeIdentity.mock.calls[0]![0]).toBe(nativeServiceExecutable(f.root, "macos"));
  });
});

describe("the one executable path the service runs", () => {
  const stable = (root: string) => nativeServiceExecutable(root, "macos");

  it("replaces and rolls back the stable connector while preserving a dirty worktree, index and retained private bytes", async () => {
    const f = await fixture();
    const retained = await retainedWorkspace(f.root);
    const before = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(stable(f.root)).toBe(join(f.root, "bin", "konteks-connector"));
    expect(await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: f.installed.releaseId, release: before.release })).toBe(true);
    expect(await readFile(stable(f.root))).toEqual(Buffer.from("test-native-executable-not-run-1.0.0"));
    // Already current: nothing is rewritten.
    expect(await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: f.installed.releaseId, release: before.release })).toBe(false);

    const unrelated = `${stable(f.root)}.keep`;
    const setAside = `${stable(f.root)}.old.replaced`;
    await writeFile(unrelated, "unrelated bin bytes\n");
    await writeFile(setAside, "inactive managed executable copy\n");

    const staged = await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } });
    if (staged.status !== "staged") throw new Error("unreachable");
    await retained.assertPreserved();
    const successor = await commitNativeUpdate({ root: f.root, releaseId: staged.releaseId, output: f.output, deps: f.deps });
    await retained.assertPreserved();
    const after = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: successor.releaseId, release: after.release })).toBe(true);
    expect(await readFile(stable(f.root))).toEqual(Buffer.from("test-native-executable-not-run-1.1.0"));
    await retained.assertPreserved();
    await expect(readFile(setAside)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("unrelated bin bytes\n");
    // The service definition names the same path on both releases.
    // The service definition is always rendered for the host it runs on, and names the same path on both releases.
    const host = nativePlatform().os;
    const definition = nativeServiceDefinition({ os: host, home: tmpdir(), root: f.root, executable: stable(f.root), uid: 501, userId: "S-1-5-21-1-2-3-1001" });
    expect(definition.contents).toContain(host === "windows" ? JSON.stringify(stable(f.root)).slice(1, -1) : stable(f.root));

    await restoreNativeRecord(f.root, successor.releaseId, f.installed, { roots: f.trust, platform: f.platform });
    const restored = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    expect(await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: restored.record.releaseId, release: restored.release })).toBe(true);
    expect(await readFile(stable(f.root))).toEqual(Buffer.from("test-native-executable-not-run-1.0.0"));
    await retained.assertPreserved();
    // Rollback copies stay in their release folders.
    expect(await readFile(join(f.root, "releases", successor.releaseId, "konteks-connector"))).toEqual(Buffer.from("test-native-executable-not-run-1.1.0"));
    expect((await readdir(join(f.root, "bin"))).sort()).toEqual([basename(stable(f.root)), basename(unrelated)].sort());
    expect(await readFile(unrelated, "utf8")).toBe("unrelated bin bytes\n");
  });

  it("refuses a release folder whose connector no longer matches its signed digest, leaving the stable executable as it was", async () => {
    const f = await fixture();
    const before = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: f.installed.releaseId, release: before.release });
    await writeFile(join(f.root, "releases", f.installed.releaseId, "konteks-connector"), "test-native-executable-not-run-9.9.9", { mode: 0o700 });
    await writeFile(stable(f.root), "something else", { mode: 0o700 });
    await expect(activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: f.installed.releaseId, release: before.release }))
      .rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(await readFile(stable(f.root), "utf8")).toBe("something else");
    expect((await readdir(join(f.root, "bin"))).sort()).toEqual(["konteks-connector"]);
  });

  it("keeps a Linux connector's detached signature beside the stable executable, and drops it when the release has none", async () => {
    const f = await fixture();
    const before = await loadNativeInstallation(f.root, { roots: f.trust, platform: f.platform });
    const release = join(f.root, "releases", f.installed.releaseId);
    await writeFile(join(release, "konteks-connector.sig"), "signature-document\n", { mode: 0o600 });
    await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: f.installed.releaseId, release: before.release });
    expect(await readFile(`${stable(f.root)}.sig`, "utf8")).toBe("signature-document\n");
    await rm(join(release, "konteks-connector.sig"));
    await activateServiceExecutable({ root: f.root, platform: f.platform, releaseId: f.installed.releaseId, release: before.release });
    expect(await readdir(join(f.root, "bin"))).toEqual(["konteks-connector"]);
  });

  it.runIf(process.platform === "win32")("on Windows renames the running executable aside instead of overwriting it, and deletes that copy once nothing runs it", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-stable-windows-")); roots.push(root);
    const platform = { os: "windows", architecture: "amd64" } as const;
    // A real program, so the stable executable can be running while it is replaced.
    const program = await readFile(process.execPath);
    const releases = { "release-old": program, "release-new": Buffer.concat([program, Buffer.from("konteks-next")]) };
    const verified: Record<string, ReturnType<typeof verifyNativeRelease>> = {};
    const keys = buildReleaseFixture();
    for (const [releaseId, bytes] of Object.entries(releases)) {
      await mkdir(join(root, "releases", releaseId), { recursive: true });
      await writeFile(join(root, "releases", releaseId, "konteks-connector.exe"), bytes);
      const artifact = { id: "connector", kind: "connector", format: "executable", ...platform, url: `https://releases.example/${releaseId}.exe`, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, sizeBytes: bytes.byteLength };
      const body = { protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], expiresAt: "2027-01-01T00:00:00Z", bundleVersion: releaseId === "release-old" ? "1.0.0" : "1.1.0", nativeArtifacts: [artifact] };
      const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
      const manifest = { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
      verified[releaseId] = verifyNativeRelease(manifest, [keys.root]);
    }
    const target = nativeServiceExecutable(root, "windows");
    await activateServiceExecutable({ root, platform, releaseId: "release-old", release: verified["release-old"]! });
    const running = spawn(target, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise(resolve => running.once("spawn", resolve));
    try {
      await activateServiceExecutable({ root, platform, releaseId: "release-new", release: verified["release-new"]! });
      expect(createHash("sha256").update(await readFile(target)).digest("hex")).toBe(createHash("sha256").update(releases["release-new"]).digest("hex"));
      expect((await readdir(join(root, "bin"))).filter(name => name.endsWith(".replaced"))).toHaveLength(1);
    } finally {
      running.kill();
      await new Promise(resolve => running.once("exit", resolve));
    }
    await activateServiceExecutable({ root, platform, releaseId: "release-new", release: verified["release-new"]! });
    expect(await readdir(join(root, "bin"))).toEqual(["konteks-connector.exe"]);
  });
});

describe("native update transaction", () => {
  function harness(input: { previous: NativeRuntimeRecord; running?: boolean; gate?: "pass" | "no_answer" | "wrong_version" | "new_failure"; restoreFails?: boolean }) {
    const running = input.running ?? true;
    const successor: NativeRuntimeRecord = { ...input.previous, releaseId: "release-next", bundleVersion: "1.1.0", manifestDigest: "sha256:next" };
    const calls: string[] = [];
    let serving: NativeRuntimeRecord | null = running ? input.previous : null;
    const ledger: unknown[] = [];
    const definition = { label: "svc", path: "/svc", contents: "", install: [], start: { command: "start", args: [] }, stop: { command: "stop", args: [] }, remove: [], status: { command: "status", args: [] }, requiresLinger: false };
    // What the release being served answers, per control op.
    const replies: Record<string, (served: NativeRuntimeRecord) => unknown> = {
      "codex.maintenance.preflight": () => ({ idle: true }),
      drain: () => ({ activeAssignments: 0 }),
      "drain.status": () => ({ draining: true, reason: "update", activeAssignments: 0, openSessions: 0 }),
      "drain.cancel": () => ({ draining: false, reason: null, activeAssignments: 0, openSessions: 0 }),
      status: served => ({
        instanceId: served.instanceId, workspaceId: served.workspaceId, administrativeStatus: "active",
        connectivity: { transport: "relay", relayConnected: true, lastConnectedAt: null, reconciliationComplete: true },
        lease: { mode: "active", expiresAt: null, drainDeadline: null },
        version: { bundle: input.gate === "wrong_version" ? "1.0.0" : served.bundleVersion, protocol: "1.0", manifestDigest: served.manifestDigest, updateAvailable: false, targetBundle: null },
        configRevision: 1,
        components: [{ kind: "agent_runner", version: served.bundleVersion, healthStatus: "healthy", capabilities: [], lastProbeAt: "2026-09-15T00:00:00Z" }],
        roles: [], roleBindings: [],
        utilization: { acceptingWork: true, activeSessions: 0, activeTurns: 0, utilizationRatio: 0 },
        pendingErase: 0, pendingRevocation: false, previewEnabled: false, previewExposure: null,
        journal: { assignments: 0, outboxDepth: 0, recoveryRequired: 0 },
      }),
      agents: served => ({ agents: served.agents.map(agentId => ({ agentId, readiness: "ready" })) }),
      doctor: served => ({ generatedAt: "2026-09-15T00:00:00Z", checks: [
        { id: "agent_login", title: "login", status: "fail", detail: "pre-existing", recoveryActions: [] },
        input.gate === "new_failure" && served.releaseId === "release-next" ? { id: "runner_spawn", title: "spawn", status: "fail", detail: "new", recoveryActions: [] } : { id: "runner_spawn", title: "spawn", status: "pass", detail: "ok", recoveryActions: [] },
      ] }),
    };
    const control: NativeUpdateTransactionDeps["control"] = (_root, record) => ({
      call: async (request, schema) => {
        calls.push(`control:${request.op}@${record.releaseId}`);
        if (!serving) throw new RemoteInstanceError("temporarily_unavailable", "socket closed");
        return schema.parse((replies[request.op] ?? (() => ({})))(serving));
      },
    });
    const deps: NativeUpdateTransactionDeps = {
      readRecord: async () => input.previous,
      serviceDefinition: async () => definition,
      execute: async command => { calls.push(command.command); if (command.command === "status") return serving ? 0 : 1; if (command.command === "stop") { serving = null; return 0; } return 0; },
      start: async () => { calls.push("start"); serving = current; if (input.gate === "no_answer" && current.releaseId === "release-next") serving = null; },
      control,
      stage: async () => ({ status: "staged", current: input.previous, release: { manifest: { bundleVersion: "1.1.0", digest: "sha256:next" } } as never, releaseId: "release-next", directory: "/releases/release-next" }),
      commit: async () => { calls.push("commit"); current = successor; return successor; },
      restore: async (_root, expected, previous) => { calls.push(`restore:${expected}`); if (input.restoreFails) throw new Error("restore refused"); current = previous; },
      recordAttempt: async (_root, attempt) => { ledger.push(attempt); },
      sleep: async () => {},
      now: () => { tick += 1_000; return tick; },
      healthDeadlineMs: 5_000,
      drainDeadlineMs: 60_000,
    };
    let current = input.previous;
    let tick = 0;
    return { deps, calls, ledger, output: createOutput({ json: true }), currentRecord: () => current };
  }
  const previous: NativeRuntimeRecord = { schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance", workspaceId: "tenant", releaseId: "release-prev", manifestDigest: "sha256:prev", bundleVersion: "1.0.0", coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", controlPort: 47_311, agents: ["claude-code"] };

  it("admits local progress after verified staging and before draining, then reports only after the applied health-gated attempt", async () => {
    const h = harness({ previous });
    const stage = h.deps.stage;
    h.deps.stage = async (input) => {
      h.calls.push("stage");
      return stage(input);
    };
    const finish = vi.fn(async (state: "succeeded" | "failed") => {
      expect(h.ledger.at(-1)).toMatchObject({ outcome: "applied" });
      expect(h.currentRecord().releaseId).toBe("release-next");
      h.calls.push(`progress:${state}`);
    });
    h.deps.beginProgress = vi.fn(async (input) => {
      h.calls.push("progress:begin");
      expect(input).toMatchObject({
        root: "/root",
        previous,
        attempt: { outcome: "in_progress", bundleVersion: "1.1.0", manifestDigest: "sha256:next" },
      });
      expect(h.calls).not.toContain("control:drain@release-prev");
      return { finish };
    });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
    expect(h.calls.indexOf("stage")).toBeLessThan(h.calls.indexOf("progress:begin"));
    expect(h.calls.indexOf("progress:begin")).toBeLessThan(
      h.calls.indexOf("control:drain@release-prev"),
    );
    expect(finish).toHaveBeenCalledWith("succeeded");
  });

  it("reports failed local progress after rollback without changing the transaction's original failure", async () => {
    const h = harness({ previous, gate: "no_answer" });
    const finish = vi.fn(async () => {
      expect(h.currentRecord()).toEqual(previous);
    });
    h.deps.beginProgress = vi.fn(async () => ({ finish }));
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow();
    expect(finish).toHaveBeenCalledWith("failed");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back" });
  });

  it("keeps trusted local recovery available when Core progress admission or its terminal report is unavailable", async () => {
    const h = harness({ previous });
    h.deps.beginProgress = vi.fn(async () => {
      throw new Error("private server diagnostic");
    });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated" });
    expect(h.deps.beginProgress).toHaveBeenCalledOnce();
    const again = harness({ previous });
    const finish = vi.fn(async () => {
      throw new Error("private report diagnostic");
    });
    again.deps.beginProgress = vi.fn(async () => ({ finish }));
    await expect(
      runNativeUpdate({ root: "/root", output: again.output }, again.deps),
    ).resolves.toMatchObject({ state: "updated" });
    expect(finish).toHaveBeenCalledWith("succeeded");
  });

  it("never announces local execution for a failed stage or a previously stopped service", async () => {
    const failed = harness({ previous });
    failed.deps.stage = async () => {
      throw new Error("not trusted");
    };
    failed.deps.beginProgress = vi.fn();
    await expect(
      runNativeUpdate({ root: "/root", output: failed.output }, failed.deps),
    ).rejects.toThrow("not trusted");
    expect(failed.deps.beginProgress).not.toHaveBeenCalled();
    const stopped = harness({ previous, running: false });
    stopped.deps.beginProgress = vi.fn();
    await expect(
      runNativeUpdate({ root: "/root", output: stopped.output }, stopped.deps),
    ).resolves.toMatchObject({ state: "updated", restarted: false });
    expect(stopped.deps.beginProgress).not.toHaveBeenCalled();
  });

  it.each([
    ["en", 180_000, "3 min", "s so far"],
    ["id", 180_000, "3 menit", "dtk"],
    ["en", 90_000, "90 s", "s so far"],
    ["id", 90_000, "90 dtk", "dtk"],
  ] as const)("presents %s human durations (%s ms) during an actual failed update and retains canonical ledger/JSON", async (locale, deadlineMs, duration, elapsed) => {
    const h = harness({ previous, gate: "no_answer" });
    h.deps.healthDeadlineMs = deadlineMs;
    vi.stubEnv("KONTEKS_SETUP_LOCALE", locale);
    const lines: string[] = [];
    const output = createOutput({ json: false, stdout: { write: (text: string) => { lines.push(text.trimEnd()); return true; } } as never });
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "en");
    const failure = await runNativeUpdate({ root: "/root", output }, h.deps).catch(error => error);
    expect(lines.some(line => line.includes(duration))).toBe(true);
    expect(lines.some(line => line.includes(elapsed))).toBe(true);
    expect(h.currentRecord().releaseId).toBe("release-prev");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back", detail: "The updated connector stopped making progress before it answered on its control socket." });
    const json: string[] = [];
    createOutput({ json: true, stderr: { write: (text: string) => { json.push(text); return true; } } as never }).error(failure);
    expect(JSON.parse(json.join(""))).toMatchObject({ error: { message: "The updated connector stopped making progress before it answered on its control socket." } });
  });

  it("drains, stops, commits, restarts and gates the successor, recording an applied attempt", async () => {
    const h = harness({ previous });
    const outcome = await runNativeUpdate({ root: "/root", output: h.output }, h.deps);
    expect(outcome).toEqual({ state: "updated", from: "1.0.0", to: "1.1.0", releaseId: "release-next", previousReleaseId: "release-prev", restarted: true });
    expect(h.calls).toEqual(["status", "control:doctor@release-prev", "control:drain@release-prev", "control:drain.status@release-prev", "stop", "status", "commit", "start", "control:status@release-next", "control:agents@release-next", "control:doctor@release-next", "control:agents@release-next"]);
    expect(h.ledger.map(attempt => (attempt as { outcome: string }).outcome)).toEqual(["in_progress", "applied"]);
    expect(h.currentRecord().releaseId).toBe("release-next");
  });
  it("waits for the connector's own bounded Codex preflight, not the default 30 s control wait (10-15)", async () => {
    const h = harness({ previous: { ...previous, agents: ["codex"] } });
    const originalControl = h.deps.control;
    const waits: Array<number | undefined> = [];
    h.deps.control = (root, record) => {
      const inner = originalControl(root, record);
      return { call: async (request: { op: string }, schema: unknown, options?: { timeoutMs?: number }) => {
        if (request.op === "codex.maintenance.preflight") waits.push(options?.timeoutMs);
        return (inner.call as (...args: unknown[]) => Promise<unknown>)(request, schema, options);
      } } as never;
    };
    await runNativeUpdate({ root: "/root", output: h.output }, h.deps);
    expect(waits).toEqual([300_000]);
  });
  it("cancels an update drain before service stop when Codex idle preflight cannot prove safety", async () => {
    const h = harness({ previous: { ...previous, agents: ["codex"] } });
    const originalControl = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = originalControl(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => {
        if (request.op === "codex.maintenance.preflight") {
          h.calls.push(`control:${request.op}@${record.releaseId}`);
          throw new RemoteInstanceError("active_work", "Codex has an active or unreadable loaded thread");
        }
        return (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest);
      } } as never;
    };

    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "active_work" });
    expect(h.calls).toContain("control:codex.maintenance.preflight@release-prev");
    expect(h.calls).toContain("control:drain.cancel@release-prev");
    expect(h.calls).not.toContain("stop");
    expect(h.calls).not.toContain("commit");
    expect(h.calls).not.toContain("start");
    expect(h.currentRecord().releaseId).toBe("release-prev");
    expect(h.ledger.map(attempt => (attempt as { outcome: string }).outcome)).toEqual(["in_progress", "failed"]);
    // The running release was never stopped: a deferral, which the supervisor does not count against the release.
    expect(h.ledger.at(-1)).toMatchObject({ detail: "deferred: Codex has an active or unreadable loaded thread" });
    expect(isDeferredUpdateAttempt(h.ledger.at(-1) as NativeUpdateAttempt)).toBe(true);
    expect(earlierFailure(h.ledger as NativeUpdateAttempt[], (h.ledger.at(-1) as NativeUpdateAttempt).manifestDigest)).toBeNull();
  });
  it.each([false, true])("uses a verified private-socket inventory when the previous connector lacks the new preflight op (idle=%s)", async idle => {
    const h = harness({ previous: { ...previous, agents: ["codex"] } });
    const originalControl = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = originalControl(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => {
        if (request.op === "codex.maintenance.preflight") {
          h.calls.push(`control:${request.op}@${record.releaseId}`);
          throw new RemoteInstanceError("temporarily_unavailable", "control_request_invalid: request does not match the closed control protocol");
        }
        return (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest);
      } } as never;
    };
    const legacyCodexPreflight = vi.fn(async () => {
      h.calls.push("legacy-codex-inventory");
      if (!idle) throw new RemoteInstanceError("active_work", "old owner has an active thread");
    });
    h.deps.legacyCodexPreflight = legacyCodexPreflight;
    if (idle) await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated" });
    else await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "active_work" });
    expect(legacyCodexPreflight).toHaveBeenCalledWith("/root", expect.objectContaining({ releaseId: "release-prev" }));
    expect(h.calls.indexOf("legacy-codex-inventory")).toBeLessThan(h.calls.indexOf(idle ? "stop" : "control:drain.cancel@release-prev"));
    if (!idle) {
      expect(h.calls).not.toContain("stop");
      expect(h.calls).not.toContain("commit");
      expect(h.currentRecord().releaseId).toBe("release-prev");
    }
  });
  it("waits for the old connector's new cleanup receipt before committing a signed update", async () => {
    const h = harness({ previous });
    let receipt = "prior-stop";
    let waits = 0;
    h.deps.readStopReceipt = async () => receipt;
    h.deps.sleep = async () => { waits += 1; if (waits === 2) receipt = "current-stop"; };

    await runNativeUpdate({ root: "/root", output: h.output }, h.deps);

    expect(waits).toBe(2);
    expect(h.calls.indexOf("commit")).toBeGreaterThan(h.calls.indexOf("stop"));
  });
  it("does not hold an update back for the person's own DeepSeek Harness when it is left out", async () => {
    const h = harness({ previous: { ...previous, agents: ["claude-code", "dsh"] } });
    const control = h.deps.control;
    // dsh could not start (say the person upgraded it out of range): it is parked, not probed.
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => request.op === "agents"
        ? { agents: record.agents.filter(agentId => agentId !== "dsh").map(agentId => ({ agentId, readiness: "ready" })) }
        : (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest) } as never;
    };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
  });
  it("does not hold an update back for the person's own OpenCode when it is left out, and restages only bundled agents", async () => {
    const h = harness({ previous: { ...previous, agents: ["claude-code", "dsh", "opencode"] } });
    const control = h.deps.control;
    // OpenCode could not start (OpenCode 1 installed over it, say) and dsh is probing: neither holds the update back.
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => request.op === "agents"
        ? { agents: [{ agentId: "claude-code", readiness: "ready" }, { agentId: "dsh", readiness: "probing" }] }
        : (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest) } as never;
    };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
  });
  it("does not hold an update back while Google Antigravity fetches the new pin in the background", async () => {
    const h = harness({ previous: { ...previous, agents: ["claude-code", "antigravity"] } });
    const control = h.deps.control;
    // The new connector's Antigravity is still downloading its new pin, so it reports nothing yet.
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => request.op === "agents"
        ? { agents: [{ agentId: "claude-code", readiness: "ready" }] }
        : (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest) } as never;
    };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
  });
  describe("on Windows, where the login shortcut persists after stopping", () => {
    const root = "C:\\Users\\a\\AppData\\Local\\konteks-remote";
    const connector = (releaseId: string) => `${root}\\releases\\${releaseId}\\konteks-connector.exe`;
    const definitionFor = (record: NativeRuntimeRecord) => nativeServiceDefinition({ os: "windows", home: "C:\\Users\\a", root, executable: connector(record.releaseId), userId: "S-1-5-21-1-2-3-1001" });
    /** The login shortcut persists while the hidden host starts and stops. */
    function windows(h: ReturnType<typeof harness>) {
      const task = { running: true, command: "%SystemRoot%\\System32\\wscript.exe", target: connector(previous.releaseId) };
      const written = new Map<string, string>();
      let registered = true;
      const harnessExecute = h.deps.execute, harnessStart = h.deps.start;
      const scheduler = async (command: NativeServiceCommand): Promise<number> => {
        const definition = definitionFor(h.currentRecord());
        const same = (expected: NativeServiceCommand) => JSON.stringify(command) === JSON.stringify(expected);
        if (same(definition.status)) return task.running ? 0 : 1;
        if (same(definition.registered!)) return registered ? 0 : 1;
        if (same(definition.install[0]!)) { registered = true; return 0; }
        if (same(definition.stop)) { task.running = false; await harnessExecute({ command: "stop", args: [] }); return 0; }
        if (same(definition.start)) {
          const manifest = JSON.parse(written.get(definition.path)!) as { executable: string };
          task.target = manifest.executable; task.running = true; return 0;
        }
        throw new Error(`unexpected Windows command ${command.command}`);
      };
      h.deps.serviceDefinition = async () => definitionFor(h.currentRecord());
      h.deps.execute = scheduler;
      h.deps.start = async input => { await startNativeServiceDefinition(definitionFor(h.currentRecord()), { execute: scheduler, write: async (path, contents) => { written.set(path, typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8")); } }); await harnessStart(input); };
      return task;
    }

    it("stops without waiting out the deadline and restarts the hidden host on the new release", async () => {
      const h = harness({ previous });
      const task = windows(h);
      await expect(runNativeUpdate({ root, output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
      expect(task).toEqual({ running: true, command: "%SystemRoot%\\System32\\wscript.exe", target: connector("release-next") });
    });

    it("rolls back to a hidden host running the previous release", async () => {
      const h = harness({ previous, gate: "new_failure" });
      const task = windows(h);
      await expect(runNativeUpdate({ root, output: h.output }, h.deps)).rejects.toThrow();
      expect(h.currentRecord().releaseId).toBe("release-prev");
      expect(task).toEqual({ running: true, command: "%SystemRoot%\\System32\\wscript.exe", target: connector("release-prev") });
    });
  });
  it("waits for a slow-stopping service to exit and release the runtime directory before committing", async () => {
    const h = harness({ previous });
    // The stop command acknowledges immediately, but the old process lingers for two polls and holds the runtime lock for one more.
    let lingering = 0, held = 1;
    const execute = h.deps.execute;
    h.deps.execute = async command => { if (command.command === "stop") { lingering = 2; return execute(command); } if (command.command === "status" && lingering > 0) { lingering -= 1; return 0; } return execute(command); };
    const commit = h.deps.commit;
    h.deps.commit = async options => { if (held > 0) { held -= 1; throw new RemoteInstanceError("temporarily_unavailable", "Another connector owns this native data directory."); } return commit(options); };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
    expect(h.calls.filter(call => call === "status").length).toBeGreaterThanOrEqual(2);
    expect(h.calls.indexOf("commit")).toBeGreaterThan(h.calls.indexOf("stop"));
  });
  it("tells the person once what a long stop is doing, then only every ten seconds, instead of a line per poll", async () => {
    const h = harness({ previous });
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    // The old process lingers for 25 polls (one second each on the harness clock).
    let lingering = 0;
    const execute = h.deps.execute;
    h.deps.execute = async command => { if (command.command === "stop") { lingering = 25; return execute(command); } if (command.command === "status" && lingering > 0) { lingering -= 1; return 0; } return execute(command); };
    h.deps.healthDeadlineMs = 180_000;
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).resolves.toMatchObject({ state: "updated" });
    const stopping = lines.filter(line => /stopping the connector/i.test(line));
    expect(stopping[0]).toMatch(/^Stopping the connector: .*usually takes under a minute/);
    // The harness clock moves a second per reading (two per poll): about 50 s, so one line then one per ten seconds, not 25.
    expect(stopping.length).toBeLessThanOrEqual(6);
    expect(stopping.slice(1).every(line => /still stopping the connector \(\d+ s so far\)/.test(line))).toBe(true);
    expect(lines).toContain("Starting 1.1.0 and checking it is healthy before keeping it (rolled back if it makes no progress for 3 min)…");
  });
  it("settles at once on a bundled agent the new release could not start, and names it when rolling back (RCA 2026-10-01)", async () => {
    const h = harness({ previous: { ...previous, agents: ["claude-code", "codex"] } });
    const control = h.deps.control;
    // The successor lists Codex as left out instead of leaving it missing, and doctor says why.
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => {
        const value = await (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest);
        if (record.releaseId !== "release-next") return value;
        if (request.op === "agents") return { agents: [{ agentId: "claude-code", readiness: "ready" }, { agentId: "codex", readiness: "unavailable", startFailure: "The signed Codex app-server did not become ready in time" }] };
        if (request.op === "doctor") (value as { checks: unknown[] }).checks.push({ id: "agent-codex", title: "Agent codex", status: "fail", detail: "could not start (The signed Codex app-server did not become ready in time); trying again in the background", recoveryActions: [] });
        return value;
      } } as never;
    };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow(/agent-codex \(could not start \(The signed Codex app-server did not become ready in time\)/);
    expect(h.calls.filter(call => call === "control:agents@release-next")).toHaveLength(1);
    expect(h.calls).toContain("restore:release-next");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back", detail: expect.stringContaining("agent-codex (could not start") });
  });
  it("names the agents that never settled when the probe deadline passes", async () => {
    const h = harness({ previous: { ...previous, agents: ["claude-code", "codex"] } });
    const control = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => request.op === "agents" && record.releaseId === "release-next"
        ? { agents: [{ agentId: "claude-code", readiness: "ready" }] }
        : (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest) } as never;
    };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow("The updated connector stopped making progress while probing its agents (codex).");
  });
  it("lets a connectivity doctor failure settle within the deadline instead of rolling back", async () => {
    const h = harness({ previous, gate: "new_failure" });
    // The successor's relay check fails on the first two doctor reads, then passes.
    let reads = 0;
    const control = h.deps.control;
    h.deps.control = (root, record) => { const client = control(root, record); return { call: async (request: { op: string }, schema: never, options?: never) => { const value = await client.call(request as never, schema, options); if (request.op === "doctor" && record.releaseId === "release-next") { reads += 1; if (reads > 2) (value as { checks: Array<{ id: string }> }).checks = (value as { checks: Array<{ id: string }> }).checks.filter(check => check.id !== "runner_spawn"); } return value as never; } }; };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated" });
    expect(h.calls.filter(call => call === "control:doctor@release-next").length).toBe(3);
    expect(h.calls).not.toContain("restore:release-next");
  });
  it("remembers a release that already rolled back here, so it is not offered as if new", () => {
    const attempt = (outcome: "applied" | "rolled_back" | "failed" | "in_progress", digest: string, finishedAt = "2026-09-19T11:58:31.000Z") => ({ id: `u-${outcome}-${digest}`, bundleVersion: "0.5.2", manifestDigest: digest, releaseId: "release-x", reason: "operator", startedAt: "2026-09-19T11:54:53.000Z", finishedAt, outcome, detail: outcome === "rolled_back" ? "The updated connector did not answer on its control socket in time." : null });
    expect(earlierFailure([attempt("applied", "sha256:a")], "sha256:b")).toBeNull();
    const failed = earlierFailure([attempt("rolled_back", "sha256:b"), attempt("applied", "sha256:a")], "sha256:b");
    expect(failed?.outcome).toBe("rolled_back");
    expect(earlierFailureNote(failed!)).toBe("0.5.2 already failed its health check here and was rolled back (2026-09-19T11:58:31.000Z: The updated connector did not answer on its control socket in time.). Installing it again installs the same release; it is usually better to wait for a newer one.");
    // A later success with the same bytes clears it.
    expect(earlierFailure([attempt("rolled_back", "sha256:b"), attempt("applied", "sha256:b")], "sha256:b")).toBeNull();
  });
  it("rolls back within seconds when the new release keeps exiting as it starts, instead of waiting out the deadline", async () => {
    const h = harness({ previous, gate: "no_answer" });
    h.deps.healthDeadlineMs = 180_000;
    let reads = 0;
    h.deps.serviceExits = async () => { reads += 1; return { runs: reads, lastExitCode: 1 }; };
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).rejects.toThrow("The updated connector stopped as soon as it started, 3 times (exit code 1).");
    expect(reads).toBe(3);
    expect(h.calls).toContain("restore:release-next");
    expect(lines).toContain("Rolled back: 1.0.0 is running and answering again. 1.1.0 was not kept.");
    expect((h.ledger.at(-1) as { outcome: string; detail: string }).detail).toMatch(/stopped as soon as it started/);
  });
  it("keeps waiting for a release that is slow to start but still making progress (X27)", async () => {
    const h = harness({ previous });
    // The successor logs for ten polls (twice the 5 s window) before it answers.
    let polls = 0;
    h.deps.startupProgress = async () => { polls += 1; return `log:${Math.min(polls, 10)}`; };
    const control = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => {
        if (record.releaseId === "release-next" && polls < 10) throw new RemoteInstanceError("temporarily_unavailable", "socket closed");
        return (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest);
      } } as never;
    };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated" });
    expect(h.calls).not.toContain("restore:release-next");
  });
  it("rolls back a starting release once it stops making progress (X27)", async () => {
    const h = harness({ previous, gate: "no_answer" });
    let polls = 0;
    h.deps.startupProgress = async () => { polls += 1; return `log:${Math.min(polls, 4)}`; };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow("stopped making progress before it answered on its control socket");
    expect(polls).toBeGreaterThan(4);
    expect(h.calls).toContain("restore:release-next");
  });
  it("does not count a service that is still starting as a crash", async () => {
    const h = harness({ previous, gate: "no_answer" });
    h.deps.serviceExits = async () => ({ runs: 1, lastExitCode: null });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow("stopped making progress before it answered on its control socket");
  });
  it("says when the installed release came from Konteks updating itself", () => {
    const attempt = (reason: "unattended" | "operator", outcome: "applied" | "rolled_back", bundleVersion = "0.5.1") => ({ id: `u-${reason}-${outcome}`, bundleVersion, manifestDigest: "sha256:a", releaseId: "release-x", reason, startedAt: "2026-09-21T23:10:09.083Z", finishedAt: "2026-09-21T23:11:27.626Z", outcome, detail: null });
    expect(selfUpdateNote([attempt("unattended", "rolled_back"), attempt("unattended", "applied")], "0.5.1")).toBe("Konteks updated itself to 0.5.1 at 2026-09-21T23:11:27.626Z.");
    // Installed by hand, or not this release: nothing to add.
    expect(selfUpdateNote([attempt("operator", "applied")], "0.5.1")).toBeNull();
    expect(selfUpdateNote([attempt("unattended", "applied", "0.5.0")], "0.5.1")).toBeNull();
    expect(selfUpdateNote([attempt("unattended", "rolled_back")], "0.5.1")).toBeNull();
  });
  it("after a rollback, says the previous release answers again before returning", async () => {
    const h = harness({ previous, gate: "no_answer" });
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(lines).toContain("Waiting for 1.1.0 to answer…");
    expect(lines).toContain("Rolled back: 1.0.0 is running and answering again. 1.1.0 was not kept.");
    expect(h.calls.at(-1)).toBe("control:status@release-prev");
  });
  it("waits for the failed successor to exit and release the runtime directory before restoring", async () => {
    const h = harness({ previous, gate: "wrong_version" });
    let held = 2;
    const restore = h.deps.restore;
    h.deps.restore = async (root, expected, prev) => { if (held > 0) { held -= 1; throw new RemoteInstanceError("temporarily_unavailable", "Another connector owns this native data directory."); } return restore(root, expected, prev); };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "update_required" });
    expect(h.calls.slice(-3)).toEqual(["restore:release-next", "start", "control:status@release-prev"]);
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back" });
  });
  it("gives up when the old service never exits, leaving the record unchanged", async () => {
    const h = harness({ previous });
    const execute = h.deps.execute;
    h.deps.execute = async (command) =>
      command.command === "stop" ? 0 : command.command === "status" ? 0 : execute(command);
    h.deps.stopDeadlineMs = 3_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(h.calls).not.toContain("commit");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
  });
  it("starts the unchanged release again when the service stopped but its exit was never confirmed (RCA 2026-09-30)", async () => {
    const h = harness({ previous });
    // The OS reports the service stopped, but the old connector never writes its stop receipt.
    h.deps.readStopReceipt = async () => "prior-stop";
    h.deps.stopDeadlineMs = 3_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(h.calls).not.toContain("commit");
    expect(h.calls.lastIndexOf("start")).toBeGreaterThan(h.calls.indexOf("stop"));
    expect(h.currentRecord().releaseId).toBe(previous.releaseId);
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
  });
  it("goes on once the old connector's process is gone, even when launchd ended it before it wrote its receipt", async () => {
    // Launchd SIGKILLs a booted-out job 5 s after SIGTERM;
    // the idle connector was still stopping its bridges, so no receipt came
    // and the update waited out 90 s for one, then gave up.
    const h = harness({ previous });
    h.deps.readStopReceipt = async () => "prior-stop";
    let pidAsked = 0;
    h.deps.servicePid = async () => { pidAsked += 1; return 4242; };
    h.deps.processAlive = pid => { expect(pid).toBe(4242); return false; };
    h.deps.stopDeadlineMs = 90_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", to: "1.1.0" });
    expect(pidAsked).toBe(1);
    expect(h.calls.indexOf("commit")).toBeGreaterThan(h.calls.indexOf("stop"));
  });
  it("ends the old connector's processes when it outlives the stop grace, then goes on", async () => {
    const h = harness({ previous });
    h.deps.readStopReceipt = async () => "prior-stop";
    let alive = true;
    const killed: number[] = [];
    h.deps.servicePid = async () => 4242;
    h.deps.processAlive = () => alive;
    h.deps.killProcessGroup = async pid => { killed.push(pid); alive = false; };
    h.deps.stopGraceMs = 5_000;
    h.deps.stopDeadlineMs = 90_000;
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).resolves.toMatchObject({ state: "updated" });
    expect(killed).toEqual([4242]);
    expect(lines).toContain("The connector did not stop within 5 s; ending its processes.");
  });
  it("starts the unchanged release again and waits until it answers before returning, when the stop is never confirmed", async () => {
    const h = harness({ previous });
    h.deps.readStopReceipt = async () => "prior-stop";
    h.deps.stopDeadlineMs = 3_000;
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(h.calls.slice(-2)).toEqual(["start", "control:status@release-prev"]);
    expect(lines).toContain("1.0.0 is running and answering again; nothing was changed.");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
  });
  it("starts the unchanged release again when the record cannot move after a confirmed stop, and says once it answers", async () => {
    const h = harness({ previous });
    h.deps.commit = async () => { h.calls.push("commit"); throw new Error("disk full"); };
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).rejects.toThrow("disk full");
    expect(h.calls.slice(-2)).toEqual(["start", "control:status@release-prev"]);
    expect(h.calls.lastIndexOf("commit")).toBeLessThan(h.calls.lastIndexOf("start"));
    expect(lines).toContain("1.0.0 is running and answering again; nothing was changed.");
  });

  it("does not drain or restart when the service is not running", async () => {
    const h = harness({ previous, running: false });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: false });
    expect(h.calls).toEqual(["status", "commit"]);
  });
  it("drains and stops a Windows connector left running after Task Scheduler reports Ready", async () => {
    const h = harness({ previous });
    const execute = h.deps.execute;
    h.deps.execute = async (command) => (command.command === "status" ? 1 : execute(command));
    let alive = true;
    h.deps.serviceOwner = async () => ({ pid: 4242, alive: async () => alive, terminate: async () => { alive = false; h.calls.push("terminate-owned"); } });
    h.deps.readStopReceipt = async () => "prior-stop";
    h.deps.stopGraceMs = 2_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
    expect(h.calls).toContain("control:drain@release-prev");
    expect(h.calls.indexOf("control:shutdown@release-prev")).toBeLessThan(h.calls.indexOf("terminate-owned"));
    expect(h.calls.indexOf("terminate-owned")).toBeLessThan(h.calls.indexOf("commit"));
  });
  it("captures a queued Windows connector that starts while the update drains", async () => {
    const h = harness({ previous });
    let captures = 0, alive = true;
    h.deps.serviceOwner = async () => {
      h.calls.push("capture-owner");
      if (++captures === 1) return null;
      return { pid: 42, alive: async () => alive, terminate: async () => { alive = false; h.calls.push("terminate-owned"); } };
    };
    h.deps.stopGraceMs = 2_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
    expect(captures).toBe(2);
    expect(h.calls.indexOf("control:drain.status@release-prev")).toBeLessThan(h.calls.lastIndexOf("capture-owner"));
    expect(h.calls.indexOf("control:shutdown@release-prev")).toBeLessThan(h.calls.indexOf("terminate-owned"));
    expect(h.calls.indexOf("terminate-owned")).toBeLessThan(h.calls.indexOf("commit"));
  });
  it("lets Windows shutdown finish before ending the scheduled task", async () => {
    const h = harness({ previous });
    let alive = true;
    const control = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request, schema, options) => {
        const result = await inner.call(request, schema, options);
        if (request.op === "shutdown") alive = false;
        return result;
      } };
    };
    const terminate = vi.fn(async () => undefined);
    h.deps.serviceOwner = async () => ({ pid: 4242, alive: async () => alive, terminate });
    await runNativeUpdate({ root: "/root", output: h.output }, h.deps);
    expect(h.calls.indexOf("control:shutdown@release-prev")).toBeLessThan(h.calls.indexOf("stop"));
    expect(terminate).not.toHaveBeenCalled();
  });
  it("bounds an unacknowledged Windows shutdown by the captured process owner", async () => {
    const h = harness({ previous });
    let alive = true;
    const control = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request, schema, options) => {
        if (request.op === "shutdown") throw new Error("socket closed before acknowledgement");
        return inner.call(request, schema, options);
      } };
    };
    h.deps.serviceOwner = async () => ({ pid: 42, alive: async () => alive, terminate: async () => { alive = false; h.calls.push("terminate-owned"); } });
    h.deps.stopGraceMs = 2_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated" });
    expect(h.calls.indexOf("terminate-owned")).toBeLessThan(h.calls.indexOf("commit"));
  });
  it("terminalizes an update whose Windows ownership query cannot prove safety", async () => {
    const h = harness({ previous });
    h.deps.serviceOwner = async () => { throw new Error("ownership query failed"); };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow("ownership query failed");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed", detail: "ownership query failed" });
    expect(h.calls).not.toContain("commit");
    expect(h.calls).not.toContain("control:drain@release-prev");
  });
  it("preserves Windows processes and resumes a drain when the task cannot be queried or ended", async () => {
    const h = harness({ previous });
    const terminate = vi.fn();
    h.deps.serviceOwner = async () => ({ pid: 42, alive: async () => true, terminate });
    h.deps.execute = async command => { h.calls.push(command.command); return command.command === "status" ? 2 : command.command === "stop" ? 1 : 0; };
    h.deps.stopGraceMs = 2_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(terminate).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("commit");
    expect(h.calls).toContain("control:drain.cancel@release-prev");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
  });
  it.each(["no_answer", "wrong_version", "new_failure"] as const)("rolls back to the previous release and restarts it when the gate fails (%s)", async gate => {
    const h = harness({ previous, gate });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: expect.stringMatching(/temporarily_unavailable|update_required/) });
    expect(h.calls.slice(-5)).toEqual(["stop", "status", "restore:release-next", "start", "control:status@release-prev"]);
    expect(h.currentRecord().releaseId).toBe("release-prev");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back", manifestDigest: "sha256:next", releaseId: "release-next" });
    expect((h.ledger.at(-1) as { detail: string }).detail).toMatch(/control socket|reports 1.0.0|doctor failure\(s\): runner_spawn/);
  });
  it("keeps the update when the successor fails a check the previous release never reported, such as an agent not added here", async () => {
    const h = harness({ previous: { ...previous, agents: ["claude-code", "codex", "dsh"] } });
    const control = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => {
        const value = await (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest);
        if (request.op === "doctor" && record.releaseId === "release-next") (value as { checks: unknown[] }).checks.push({ id: "agent-antigravity", title: "Agent antigravity", status: "fail", detail: "readiness unavailable", recoveryActions: [] });
        return value;
      } } as never;
    };
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).resolves.toMatchObject({ state: "updated", to: "1.1.0" });
    expect(h.calls).not.toContain("restore:release-next");
    expect(lines).toContain("1.1.0 reports a check 1.0.0 did not have: agent-antigravity (readiness unavailable). It is not held against the update.");
  });
  it("still counts a failing check for an agent the successor runs, even when the previous release never reported it", async () => {
    const h = harness({ previous: { ...previous, agents: ["claude-code", "codex"] } });
    const control = h.deps.control;
    h.deps.control = (root, record) => {
      const inner = control(root, record);
      return { call: async (request: { op: string }, ...rest: unknown[]) => {
        const value = await (inner.call as (...args: unknown[]) => Promise<unknown>)(request, ...rest);
        if (request.op === "doctor" && record.releaseId === "release-next") (value as { checks: unknown[] }).checks.push({ id: "agent-codex", title: "Agent codex", status: "fail", detail: "readiness unavailable", recoveryActions: [] });
        return value;
      } } as never;
    };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow(/introduced doctor failure\(s\): agent-codex/);
    expect(h.calls).toContain("restore:release-next");
  });
  it("rolls back and starts the previous release when the failed successor exits without its shutdown receipt", async () => {
    const h = harness({ previous, gate: "new_failure" });
    // The previous release stops cleanly and writes a fresh receipt; the
    // successor's shutdown step fails, so after the commit none is written.
    h.deps.stopDeadlineMs = 3_000;
    let committed = false, receipts = 0;
    const commit = h.deps.commit;
    h.deps.commit = async options => { committed = true; return commit(options); };
    h.deps.readStopReceipt = async () => (committed ? "stale" : `fresh-${receipts++}`);
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow(/doctor failure\(s\): runner_spawn/);
    expect(h.calls.slice(-3)).toEqual(["restore:release-next", "start", "control:status@release-prev"]);
    expect(h.currentRecord().releaseId).toBe("release-prev");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back" });
  });
  it("force-stops a failed successor that never exits, then starts the previous release", async () => {
    const h = harness({ previous, gate: "new_failure" });
    h.deps.stopDeadlineMs = 3_000;
    let stuck = false;
    const execute = h.deps.execute;
    h.deps.execute = async command => {
      if (command.command === "stop" && h.currentRecord().releaseId === "release-next") { h.calls.push("stop"); stuck = true; return 0; }
      if (command.command === "status" && stuck) { h.calls.push("status"); return 0; }
      return execute(command);
    };
    h.deps.forceStop = async () => { h.calls.push("force-stop"); stuck = false; await execute({ command: "stop", args: [] }); };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow(/doctor failure\(s\): runner_spawn/);
    expect(h.calls).toContain("force-stop");
    expect(h.calls.slice(-3)).toEqual(["restore:release-next", "start", "control:status@release-prev"]);
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back" });
  });
  it("never leaves the service unloaded: when the rollback cannot restore the record it still starts a release", async () => {
    const h = harness({ previous, gate: "new_failure", restoreFails: true });
    const lines: string[] = [];
    const output = { ...h.output, line: (text: string) => { lines.push(text); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(h.calls.lastIndexOf("start")).toBeGreaterThan(h.calls.lastIndexOf("restore:release-next"));
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
    expect(lines.some(line => /^Started 1\.1\.0 again so this computer stays connected/.test(line))).toBe(true);
  });
  it.each(["stage", "commit"] as const)("contains a rejected lifecycle observer without replacing the original %s failure", async phase => {
    const h = harness({ previous });
    const original = new RemoteInstanceError("temporarily_unavailable", `original ${phase} failure`);
    const observeFailure = vi.fn(async (_input: { root: string; capture: unknown }) => {
      throw new Error("private-lifecycle-observer-fault-do-not-copy");
    });
    Object.assign(h.deps, { observeFailure });
    h.deps[phase] = async () => { throw original; };
    const lines: string[] = [];
    const output = { ...h.output, line: (line: string) => { lines.push(line); } };
    await expect(runNativeUpdate({ root: "/root", output }, h.deps)).rejects.toBe(original);
    expect(h.currentRecord()).toEqual(previous);
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
    expect(observeFailure).toHaveBeenCalledOnce();
    expect(observeFailure.mock.calls[0]![0]).toMatchObject({
      root: "/root",
      capture: {
        workspaceId: previous.workspaceId,
        observation: { instanceId: previous.instanceId, scope: { kind: "runtime" } },
      },
    });
    expect(JSON.stringify(lines)).not.toContain("private-lifecycle-observer-fault-do-not-copy");
    if (phase === "stage") expect(h.calls).toEqual([]);
    else expect(h.calls).toContain("start");
  });

  it("refreshes the person's konteks-remote launcher to the release it kept, and only then", async () => {
    const refreshed: string[] = [];
    const applied = harness({ previous });
    applied.deps.refreshLauncher = async (_root, record) => { refreshed.push(record.releaseId); };
    await runNativeUpdate({ root: "/root", output: applied.output }, applied.deps);
    expect(refreshed).toEqual(["release-next"]);
    const rolledBack = harness({ previous, gate: "new_failure" });
    rolledBack.deps.refreshLauncher = async (_root, record) => { refreshed.push(record.releaseId); };
    await runNativeUpdate({ root: "/root", output: rolledBack.output }, rolledBack.deps).catch(() => undefined);
    expect(refreshed).toEqual(["release-next"]);
  });
  // Windows never copies a launcher: the MSI's command hands every call to the
  // installed release instead, so refreshInstalledLauncher skips there.
  it.skipIf(process.platform === "win32")("keeps the person's konteks-remote on the running release once its update kept it, whichever launcher drove the update", async () => {
    // The owner's launcher was 0.8.0's: it has no refresh, so every update it
    // drove (0.10.9, 0.10.10) ran 0.8.0's transaction. The release itself refreshes it.
    const attempt = (outcome: string, startedAt = new Date(500_000).toISOString()) => ({ schemaVersion: 1 as const, attempts: [{ id: "u1", bundleVersion: "1.1.0", manifestDigest: "d", releaseId: "release-next", reason: "operator", startedAt, finishedAt: null, outcome: outcome as "in_progress", detail: null }] });
    const refreshed: string[] = [];
    let outcome = "in_progress", waits = 0;
    const deps = {
      execPath: "/root/releases/release-next/konteks-connector",
      readRecord: async () => ({ ...previous, releaseId: "release-next" }),
      readLedger: async () => attempt(outcome),
      refresh: async (_root: string, record: NativeRuntimeRecord) => { refreshed.push(record.releaseId); return true; },
      sleep: async () => { waits += 1; if (waits === 2) outcome = "applied"; },
      now: () => 600_000,
    };
    await expect(keepLauncherCurrent("/root", deps)).resolves.toBe("refreshed");
    expect(waits).toBe(2);
    expect(refreshed).toEqual(["release-next"]);
    // Rolled back (the record names another release), or a development serve: never replaced.
    await expect(keepLauncherCurrent("/root", { ...deps, readLedger: async () => attempt("rolled_back"), readRecord: async () => previous })).resolves.toBe("skipped");
    await expect(keepLauncherCurrent("/root", { ...deps, execPath: "/usr/local/bin/node" })).resolves.toBe("skipped");
    // An attempt whose updater died is not waited for forever.
    await expect(keepLauncherCurrent("/root", { ...deps, readLedger: async () => attempt("in_progress", new Date(0).toISOString()), now: () => 60 * 60_000 })).resolves.toBe("refreshed");
    expect(refreshed).toHaveLength(2);
  });
  // Windows never copies a launcher: the MSI's command hands every call to the
  // installed release instead, so refreshInstalledLauncher skips there.
  it.skipIf(process.platform === "win32")("replaces konteks-remote only when it differs from the release's executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-launcher-refresh-")); roots.push(root);
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "releases", "release-next"), { recursive: true });
    await writeFile(join(root, "bin", "konteks-remote"), "old launcher", { mode: 0o755 });
    await writeFile(join(root, "releases", "release-next", "konteks-connector"), "new release", { mode: 0o755 });
    const record = { ...previous, releaseId: "release-next" };
    await expect(refreshInstalledLauncher(root, record)).resolves.toBe(true);
    expect(await readFile(join(root, "bin", "konteks-remote"), "utf8")).toBe("new release");
    await expect(refreshInstalledLauncher(root, record)).resolves.toBe(false);
  });
  it("reports a failed attempt when rollback itself refuses, preserving the previous record for the operator", async () => {
    const h = harness({ previous, gate: "new_failure", restoreFails: true });
    const failure = await runNativeUpdate({ root: "/root", output: h.output }, h.deps).catch(error => error);
    expect(failure).toMatchObject({ code: "temporarily_unavailable" });
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
    expect((h.ledger.at(-1) as { detail: string }).detail).toMatch(/rollback failed after/);
  });
  it("cancels its own drain and leaves the release unchanged when active work never finishes", async () => {
    const h = harness({ previous });
    h.deps.control = () => ({ call: async (request, schema) => {
      h.calls.push(`control:${request.op}`);
      return schema.parse(request.op === "drain.status" ? { draining: true, reason: "update", activeAssignments: 1, openSessions: 1 } : { checks: [], generatedAt: "x" });
    } });
    h.deps.drainDeadlineMs = 2_500;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "active_work" });
    expect(h.calls).toContain("control:drain.cancel");
    expect(h.calls).not.toContain("stop");
    expect(h.calls).not.toContain("commit");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
  });
  it("records a failed attempt when the channel cannot even be read, so a launched transaction never looks in flight", async () => {
    const h = harness({ previous });
    h.deps.stage = async () => { throw new RemoteInstanceError("temporarily_unavailable", "The native release channel could not be read; the installed release is unchanged."); };
    await expect(runNativeUpdate({ root: "/root", output: h.output, unattended: true }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ outcome: "failed", reason: "unattended", bundleVersion: "unknown", releaseId: null });
    expect((h.ledger[0] as { detail: string }).detail).toMatch(/channel could not be read/);
    expect(h.calls).toEqual([]);
  });
  // Observe the updater's local handoff without replacing its failure or recovery flow.
  function captureFailures(h: ReturnType<typeof harness>) {
    const captures: { root: string; capture: unknown }[] = [];
    Object.assign(h.deps, { observeFailure: async (input: { root: string; capture: unknown }) => { captures.push(input); } });
    return captures;
  }

  function expectedCapture(attempt: NativeUpdateAttempt, stage: string, code: string, phase = "supervisor") {
    const observation = {
      schemaVersion: 1, failureId: attempt.id, observedAt: attempt.finishedAt,
      instanceId: previous.instanceId, scope: { kind: "runtime" },
      phase, stage, code, evidence: { kind: "runtime_exception" },
    };
    return {
      root: "/root",
      capture: { schemaVersion: 1, workspaceId: previous.workspaceId, observation, failureDigest: jcsDigest(observation as unknown as JsonValue) },
    };
  }

  it("retains a bounded identity-bound stage failure even before Core progress can start", async () => {
    const h = harness({ previous });
    const captures = captureFailures(h);
    const original = new Error("private URL https://signed.invalid/path?secret=do-not-copy and /Users/private/install");
    h.deps.stage = async () => { throw original; };
    h.deps.beginProgress = vi.fn();
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toBe(original);
    expect(captures).toHaveLength(1);
    const attempt = h.ledger.at(-1) as NativeUpdateAttempt;
    expect(captures[0]).toEqual(expectedCapture(attempt, "native_update_stage", "native_update_stage_failed", "preparation"));
    expect(JSON.stringify(captures[0]!.capture)).not.toMatch(/private|secret|https:|Users|detail|assignmentId|claimId/);
    expect(Buffer.byteLength(JSON.stringify(captures[0]!.capture))).toBeLessThanOrEqual(4096);
    expect(h.deps.beginProgress).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it("captures failure to inspect the installed service against the original installation identity", async () => {
    const h = harness({ previous });
    const captures = captureFailures(h);
    const original = new Error("private service-manager diagnostic");
    h.deps.serviceOwner = async () => { throw original; };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toBe(original);
    const attempt = h.ledger.at(-1) as NativeUpdateAttempt;
    expect(attempt.outcome).toBe("failed");
    expect(captures[0]).toEqual(expectedCapture(attempt, "native_update_service", "native_update_service_failed"));
    expect(captures).toHaveLength(1);
    expect(h.currentRecord()).toEqual(previous);
    expect(h.calls).not.toContain("commit");
  });

  it("retains the failed successor health fact after rollback without replacing recovery or inventing a claim", async () => {
    const h = harness({ previous, gate: "no_answer" });
    const captures = captureFailures(h);
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow();
    expect(h.currentRecord()).toEqual(previous);
    const attempt = h.ledger.at(-1) as NativeUpdateAttempt;
    expect(attempt.outcome).toBe("rolled_back");
    expect(captures).toEqual([expectedCapture(attempt, "native_update_health", "native_update_rolled_back")]);
  });

  it("keeps successful replacement and active-work deferral out of failure capture", async () => {
    const applied = harness({ previous });
    const successfulCaptures = captureFailures(applied);
    await runNativeUpdate({ root: "/root", output: applied.output }, applied.deps);
    expect(applied.ledger.at(-1)).toMatchObject({ outcome: "applied" });
    expect(successfulCaptures).toEqual([]);
    const deferred = harness({ previous });
    const deferredCaptures = captureFailures(deferred);
    deferred.deps.control = () => ({ call: async (request, schema) => schema.parse(
      request.op === "drain.status" ? { draining: true, reason: "update", activeAssignments: 1, openSessions: 1 } : { checks: [], generatedAt: "x" },
    ) });
    deferred.deps.drainDeadlineMs = 2_500;
    await expect(runNativeUpdate({ root: "/root", output: deferred.output }, deferred.deps)).rejects.toMatchObject({ code: "active_work" });
    expect(deferred.ledger.at(-1)).toMatchObject({ detail: expect.stringMatching(/^deferred: /) });
    expect(deferredCaptures).toEqual([]);
    expect(deferred.calls).not.toContain("stop");
    expect(deferred.calls).not.toContain("commit");
  });

  it("does not mint an upload identity when installation identity cannot be loaded", async () => {
    const h = harness({ previous });
    const captures = captureFailures(h);
    const original = new Error("private identity cannot be read");
    h.deps.readRecord = async () => { throw original; };
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toBe(original);
    expect(captures).toEqual([]);
    expect(h.ledger).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("writes the durable ledger the supervisor reads back", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-update-ledger-")); roots.push(root);
    await mkdir(join(root, "supervisor"), { recursive: true });
    const h = harness({ previous, running: false });
    const { recordNativeUpdateAttempt } = await import("@konteks/remote-supervisor");
    h.deps.recordAttempt = recordNativeUpdateAttempt;
    await runNativeUpdate({ root, output: h.output, unattended: true }, h.deps);
    const ledger = await readNativeUpdateLedger(root);
    expect(ledger.attempts).toHaveLength(1);
    expect(ledger.attempts[0]).toMatchObject({ outcome: "applied", reason: "unattended", bundleVersion: "1.1.0", releaseId: "release-next" });
  });

  it("keeps the terminal update ledger readable by strict v1 rollback readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-update-v1-compat-")); roots.push(root);
    const h = harness({ previous });
    const { recordNativeUpdateAttempt } = await import("@konteks/remote-supervisor");
    h.deps.recordAttempt = recordNativeUpdateAttempt;
    const original = new RemoteInstanceError("temporarily_unavailable", "the signed channel could not be read");
    h.deps.stage = async () => { throw original; };
    await expect(runNativeUpdate({ root, output: h.output }, h.deps)).rejects.toBe(original);
    const raw = JSON.parse(await readFile(join(root, "update-ledger.json"), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["attempts", "schemaVersion"]);
    expect(raw.schemaVersion).toBe(1);
    expect(raw.attempts).toHaveLength(1);
    // Frozen v1 on-disk keys intentionally protect an older strict reader;
    // capture metadata must remain outside this rollback contract.
    expect(Object.keys(raw.attempts[0]).sort()).toEqual([
      "bundleVersion", "detail", "finishedAt", "id", "manifestDigest", "outcome", "reason", "releaseId", "startedAt",
    ]);
    expect(raw.attempts[0]).toMatchObject({ outcome: "failed", releaseId: null });
    await expect(readNativeUpdateLedger(root)).resolves.toEqual(raw);
  });
});
