import { createHash, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, computeBundleManifestDigest, RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { buildReleaseFixture, resolveNativeConnectorExecutable } from "@konteks/remote-release";
import { loadNativeInstallation, readNativeUpdateLedger, SupervisorStore, verifyInstalledNativeConnector, type NativeRuntimeRecord } from "@konteks/remote-supervisor";
import { installNative, readNativeRecord, restoreNativeRecord } from "../native/install.js";
import { checkNativeUpdate, commitNativeUpdate, stageNativeUpdate } from "../native/update.js";
import { earlierFailure, earlierFailureNote, runNativeUpdate, selfUpdateNote, type NativeUpdateTransactionDeps } from "../native/update-transaction.js";
import { createOutput } from "../output.js";
import { nativeServiceDefinition, startNativeServiceDefinition, type NativeServiceCommand } from "../native/service.js";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-cli-update-")); roots.push(root);
  const claudeTool = join(root, "operator-claude");
  await writeFile(claudeTool, "claude-not-executed", { mode: 0o700 });
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", claudeTool);
  const keys = buildReleaseFixture();
  const claude = offlineFixture("macos", "arm64", "claude-code");
  const connector = (version: string) => {
    const bytes = Buffer.from(`test-native-executable-not-run-${version}`);
    return { bytes, artifact: { id: "connector", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: `https://releases.example/connector-${version}`, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, sizeBytes: bytes.byteLength } };
  };
  const old = connector("1.0.0"), next = connector("1.1.0");
  const signed = (body: Record<string, unknown>) => {
    const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
    return { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
  };
  const base = { protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], expiresAt: "2027-01-01T00:00:00Z" };
  const oldManifest = signed({ ...base, bundleVersion: "1.0.0", nativeArtifacts: [old.artifact, claude.artifact] });
  const manifest = signed({ ...base, bundleVersion: "1.1.0", nativeArtifacts: [next.artifact, claude.artifact] });
  const trust = [{ ...keys.root, coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }] }];
  const platform = { os: "macos", architecture: "arm64", deploymentKind: "native_connector", containerBackend: "none" } as const;
  const activate = vi.fn(async ({ release }: { release: { manifest: typeof manifest } }) => {
    await writeSecretFile(join(root, "supervisor", "identity.json"), JSON.stringify({ instanceId: "instance", workspaceId: "tenant", activationId: "activation-123", activatedAt: new Date().toISOString(), administrativeStatus: "provisioning", exchangeNonce: "nonce" }));
    await writeSecretFile(join(root, "supervisor", "manifest.json"), JSON.stringify({ manifest: release.manifest, manifestDigest: release.manifest.digest }));
    return { instanceId: "instance", manifest: release.manifest, manifestDigest: release.manifest.digest, provisioningWindowExpiresAt: "2026-10-01T00:00:00Z" };
  });
  const fetchFn = vi.fn(async (url: string) => new Response(url === claude.artifact.url ? claude.archive : url === next.artifact.url ? next.bytes : old.bytes));
  const output = createOutput({ json: true });
  const installed = await installNative({ root, activationId: "activation-123", coreUrl: "https://core.example", relayUrl: "wss://relay.example/runtime", agents: ["claude-code"], output, deps: { roots: trust, platform, manifest: oldManifest, activate, fetchFn, git: null } } as never);
  await writeFile(join(root, "credentials", "claude-code", "keep"), "credential-owned-by-agent");
  const deps = { roots: trust, platform, fetchFn };
  return { root, output, trust, platform, manifest, oldManifest, fetchFn, installed, deps };
}

describe("native update staging and commit", () => {
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
    expect(await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.oldManifest } })).toMatchObject({ status: "current" });
    await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, roots: [], manifest: f.manifest } })).rejects.toMatchObject({ code: "bundle_untrusted" });
    // A digest mismatch during download leaves no candidate behind.
    const corrupt = vi.fn(async (url: string) => url.endsWith("connector-1.1.0") ? new Response(Buffer.from("tampered-bytes-of-the-same-length")) : f.fetchFn(url));
    await expect(stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, fetchFn: corrupt, manifest: f.manifest } })).rejects.toThrow();
    expect((await readdir(join(f.root, "releases"))).filter(name => name.startsWith(".candidate-"))).toEqual([]);
    expect(await readNativeRecord(f.root)).toEqual(f.installed);
    // A staged release whose connector bytes change before commit is refused.
    const staged = await stageNativeUpdate({ root: f.root, output: f.output, deps: { ...f.deps, manifest: f.manifest } });
    if (staged.status !== "staged") throw new Error("unreachable");
    await writeFile(join(staged.directory, "connector"), "test-native-executable-not-run-1.1.X", { mode: 0o700 });
    await expect(commitNativeUpdate({ root: f.root, releaseId: staged.releaseId, output: f.output, deps: f.deps })).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(await readNativeRecord(f.root)).toEqual(f.installed);
    await expect(commitNativeUpdate({ root: f.root, releaseId: "../escape", output: f.output, deps: f.deps })).rejects.toMatchObject({ code: "install_state_corrupt" });
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
    const control = (_root: string, record: NativeRuntimeRecord) => ({
      call: async (request: { op: string }) => {
        calls.push(`control:${request.op}@${record.releaseId}`);
        if (!serving) throw new RemoteInstanceError("temporarily_unavailable", "socket closed");
        switch (request.op) {
          case "drain": return { activeAssignments: 0 };
          case "drain.status": return { draining: true, reason: "update", activeAssignments: 0, openSessions: 0 };
          case "drain.cancel": return { draining: false, reason: null, activeAssignments: 0, openSessions: 0 };
          case "status": return { version: { bundle: input.gate === "wrong_version" ? "1.0.0" : serving.bundleVersion } };
          case "agents": return { agents: serving.agents.map(agentId => ({ agentId, readiness: "ready" })) };
          case "doctor": return { generatedAt: "2026-09-15T00:00:00Z", checks: [
            { id: "agent_login", title: "login", status: "fail", detail: "pre-existing", recoveryActions: [] },
            ...(input.gate === "new_failure" && serving.releaseId === "release-next" ? [{ id: "runner_spawn", title: "spawn", status: "fail", detail: "new", recoveryActions: [] }] : []),
          ] };
          default: return {};
        }
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

  it("drains, stops, commits, restarts and gates the successor, recording an applied attempt", async () => {
    const h = harness({ previous });
    const outcome = await runNativeUpdate({ root: "/root", output: h.output }, h.deps);
    expect(outcome).toEqual({ state: "updated", from: "1.0.0", to: "1.1.0", releaseId: "release-next", previousReleaseId: "release-prev", restarted: true });
    expect(h.calls).toEqual(["status", "control:doctor@release-prev", "control:drain@release-prev", "control:drain.status@release-prev", "stop", "status", "commit", "start", "control:status@release-next", "control:agents@release-next", "control:doctor@release-next", "control:agents@release-next"]);
    expect(h.ledger.map(attempt => (attempt as { outcome: string }).outcome)).toEqual(["in_progress", "applied"]);
    expect(h.currentRecord().releaseId).toBe("release-next");
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
  describe("on Windows, where a stopped scheduled task still exists", () => {
    const root = "C:\\Users\\a\\AppData\\Local\\konteks-remote";
    const connector = (releaseId: string) => `${root}\\releases\\${releaseId}\\konteks-connector.exe`;
    const definitionFor = (record: NativeRuntimeRecord) => nativeServiceDefinition({ os: "windows", home: "C:\\Users\\a", root, executable: connector(record.releaseId), userId: "S-1-5-21-1-2-3-1001" });
    /** Task Scheduler as far as the connector sees it: the task exists throughout, running or not, and runs the <Command> it was last registered with. */
    function windows(h: ReturnType<typeof harness>) {
      const task = { running: true, command: connector(previous.releaseId) };
      const written = new Map<string, string>();
      const scheduler = async (command: NativeServiceCommand): Promise<number> => {
        if (command.command === "powershell.exe") return task.running ? 0 : 1;
        if (command.command !== "schtasks.exe") throw new Error(`unexpected ${command.command}`);
        switch (command.args[0]) {
          case "/Query": return 0; // exists, whether or not it runs
          case "/Create": task.command = /<Command>(.*?)<\/Command>/.exec(written.get(command.args[4]!)!)![1]!; return 0;
          case "/Run": task.running = true; return 0;
          case "/End": task.running = false; return 0;
          default: return 1;
        }
      };
      const harnessExecute = h.deps.execute, harnessStart = h.deps.start;
      h.deps.serviceDefinition = async () => definitionFor(h.currentRecord());
      // The harness's control socket follows the task: /End stops what serves, a start serves the record.
      h.deps.execute = async command => { const code = await scheduler(command); if (command.args[0] === "/End") await harnessExecute({ command: "stop", args: [] }); return code; };
      h.deps.start = async input => { await startNativeServiceDefinition(definitionFor(h.currentRecord()), { execute: scheduler, write: async (path, contents) => { written.set(path, contents); } }); await harnessStart(input); };
      return task;
    }

    it("stops without waiting out the deadline and restarts the task on the new release", async () => {
      const h = harness({ previous });
      const task = windows(h);
      await expect(runNativeUpdate({ root, output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: true });
      expect(task).toEqual({ running: true, command: connector("release-next") });
    });

    it("rolls back to a task that runs the previous release again", async () => {
      const h = harness({ previous, gate: "new_failure" });
      const task = windows(h);
      await expect(runNativeUpdate({ root, output: h.output }, h.deps)).rejects.toThrow();
      expect(h.currentRecord().releaseId).toBe("release-prev");
      expect(task).toEqual({ running: true, command: connector("release-prev") });
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
    expect(lines).toContain("Starting 1.1.0 and checking it is healthy before keeping it (up to 3 min)…");
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
  it("remembers a release that already rolled back here, so it is not offered as if new (W1-L4)", () => {
    const attempt = (outcome: "applied" | "rolled_back" | "failed" | "in_progress", digest: string, finishedAt = "2026-09-19T11:58:31.000Z") => ({ id: `u-${outcome}-${digest}`, bundleVersion: "0.5.2", manifestDigest: digest, releaseId: "release-x", reason: "operator", startedAt: "2026-09-19T11:54:53.000Z", finishedAt, outcome, detail: outcome === "rolled_back" ? "The updated connector did not answer on its control socket in time." : null });
    expect(earlierFailure([attempt("applied", "sha256:a")], "sha256:b")).toBeNull();
    const failed = earlierFailure([attempt("rolled_back", "sha256:b"), attempt("applied", "sha256:a")], "sha256:b");
    expect(failed?.outcome).toBe("rolled_back");
    expect(earlierFailureNote(failed!)).toBe("0.5.2 already failed its health check here and was rolled back (2026-09-19T11:58:31.000Z: The updated connector did not answer on its control socket in time.). Installing it again installs the same release; it is usually better to wait for a newer one.");
    // A later success with the same bytes clears it.
    expect(earlierFailure([attempt("rolled_back", "sha256:b"), attempt("applied", "sha256:b")], "sha256:b")).toBeNull();
  });
  it("rolls back within seconds when the new release keeps exiting as it starts, instead of waiting out the deadline (W1-Z7)", async () => {
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
  it("does not count a service that is still starting as a crash", async () => {
    const h = harness({ previous, gate: "no_answer" });
    h.deps.serviceExits = async () => ({ runs: 1, lastExitCode: null });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toThrow("did not answer on its control socket in time");
  });
  it("says when the installed release came from Konteks updating itself (W1-Z7)", () => {
    const attempt = (reason: "unattended" | "operator", outcome: "applied" | "rolled_back", bundleVersion = "0.5.1") => ({ id: `u-${reason}-${outcome}`, bundleVersion, manifestDigest: "sha256:a", releaseId: "release-x", reason, startedAt: "2026-09-21T23:10:09.083Z", finishedAt: "2026-09-21T23:11:27.626Z", outcome, detail: null });
    expect(selfUpdateNote([attempt("unattended", "rolled_back"), attempt("unattended", "applied")], "0.5.1")).toBe("Konteks updated itself to 0.5.1 at 2026-09-21T23:11:27.626Z.");
    // Installed by hand, or not this release: nothing to add.
    expect(selfUpdateNote([attempt("operator", "applied")], "0.5.1")).toBeNull();
    expect(selfUpdateNote([attempt("unattended", "applied", "0.5.0")], "0.5.1")).toBeNull();
    expect(selfUpdateNote([attempt("unattended", "rolled_back")], "0.5.1")).toBeNull();
  });
  it("after a rollback, says the previous release answers again before returning (W1-L4)", async () => {
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
    h.deps.execute = async command => (command.command === "stop" ? 0 : command.command === "status" ? 0 : execute(command));
    h.deps.stopDeadlineMs = 3_000;
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(h.calls).not.toContain("commit");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "failed" });
  });
  it("does not drain or restart when the service is not running", async () => {
    const h = harness({ previous, running: false });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).resolves.toMatchObject({ state: "updated", restarted: false });
    expect(h.calls).toEqual(["status", "commit"]);
  });
  it.each(["no_answer", "wrong_version", "new_failure"] as const)("rolls back to the previous release and restarts it when the gate fails (%s)", async gate => {
    const h = harness({ previous, gate });
    await expect(runNativeUpdate({ root: "/root", output: h.output }, h.deps)).rejects.toMatchObject({ code: expect.stringMatching(/temporarily_unavailable|update_required/) });
    expect(h.calls.slice(-5)).toEqual(["stop", "status", "restore:release-next", "start", "control:status@release-prev"]);
    expect(h.currentRecord().releaseId).toBe("release-prev");
    expect(h.ledger.at(-1)).toMatchObject({ outcome: "rolled_back", manifestDigest: "sha256:next", releaseId: "release-next" });
    expect((h.ledger.at(-1) as { detail: string }).detail).toMatch(/control socket|reports 1.0.0|doctor failure\(s\): runner_spawn/);
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
    h.deps.control = () => ({ call: async (request: { op: string }) => { h.calls.push(`control:${request.op}`); return request.op === "drain.status" ? { draining: true, reason: "update", activeAssignments: 1, openSessions: 1 } : { checks: [], generatedAt: "x" }; } });
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
});
