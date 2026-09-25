import { sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, computeBundleManifestDigest, createLogger } from "@konteks/remote-common";
import { buildReleaseFixture } from "@konteks/remote-release";
import { NativeUpdateCoordinator } from "../native/update.js";
import { readNativeUpdateLedger, recordNativeUpdateAttempt, type NativeUpdateAttempt, type NativeUpdateLedger } from "../native/update-ledger.js";
import { launchNativeUpdater } from "../native/update-launch.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function manifests() {
  const keys = buildReleaseFixture();
  const artifact = { id: "connector", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: "https://releases.example/connector", digest: `sha256:${"a".repeat(64)}`, sizeBytes: 10 };
  const signed = (bundleVersion: string) => {
    const body = { protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], expiresAt: "2027-01-01T00:00:00Z", bundleVersion, nativeArtifacts: [artifact] };
    const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
    return { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
  };
  const trust = [{ ...keys.root, coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }] }];
  return { trust, same: signed("1.0.0"), newer: signed("1.1.0") };
}

function coordinator(input: { manifest?: "same" | "newer"; ledger?: NativeUpdateLedger; canApply?: boolean; trust?: unknown[]; now?: () => number; acceptedRelease?: () => Promise<{ bundleVersion: string } | null> }) {
  const m = manifests();
  const launch = vi.fn(async () => ({ pid: 4242 }));
  const fetchManifest = vi.fn(async () => input.manifest === "same" ? m.same : m.newer);
  const readLedger = vi.fn(async () => input.ledger ?? { schemaVersion: 1 as const, attempts: [] });
  const c = new NativeUpdateCoordinator({
    currentBundleVersion: "1.0.0", trustedRoots: (input.trust ?? m.trust) as never, fetchManifest, launch, readLedger,
    canApply: () => input.canApply === false ? { ok: false, reason: "draining (user)" } : { ok: true },
    logger: createLogger({ name: "test" }), now: input.now ?? (() => Date.parse("2026-09-15T12:00:00Z")),
    ...(input.acceptedRelease ? { acceptedRelease: input.acceptedRelease } : {}),
  });
  return { c, launch, fetchManifest, readLedger, m };
}

const attempt = (over: Partial<NativeUpdateAttempt>): NativeUpdateAttempt => ({ id: `a-${Math.random()}`, bundleVersion: "1.1.0", manifestDigest: "d", releaseId: "release-x", reason: "unattended", startedAt: "2026-09-15T11:00:00Z", finishedAt: "2026-09-15T11:05:00Z", outcome: "rolled_back", detail: null, ...over });

describe("native update coordinator", () => {
  it("installs unattended only the release Core accepts (WS1-093)", async () => {
    const ahead = coordinator({ acceptedRelease: async () => ({ bundleVersion: "1.0.0" }) });
    expect(await ahead.c.apply("periodic")).toMatchObject({ started: false, reason: "Konteks accepts 1.0.0, not 1.1.0 yet; staying on this one until it does" });
    expect(ahead.launch).not.toHaveBeenCalled();

    const silent = coordinator({ acceptedRelease: async () => null });
    expect((await silent.c.apply("periodic")).reason).toMatch(/does not say which release it accepts/);
    const unreachable = coordinator({ acceptedRelease: async () => { throw new Error("offline"); } });
    expect((await unreachable.c.apply("periodic")).reason).toMatch(/could not be asked/);
    expect(silent.launch).not.toHaveBeenCalled();
    expect(unreachable.launch).not.toHaveBeenCalled();

    const accepted = coordinator({ acceptedRelease: async () => ({ bundleVersion: "1.1.0" }) });
    expect(await accepted.c.apply("periodic")).toMatchObject({ started: true });
    expect(accepted.launch).toHaveBeenCalledTimes(1);
  });


  it("reports a newer verified release and launches exactly one transaction for it", async () => {
    const { c, launch, m } = coordinator({});
    expect(await c.check()).toMatchObject({ current: { bundleVersion: "1.0.0" }, available: { bundleVersion: "1.1.0", manifestDigest: m.newer.digest }, lastError: null, inFlight: null });
    const first = await c.apply("periodic");
    expect(first).toMatchObject({ started: true, pid: 4242, status: { inFlight: { bundleVersion: "1.1.0", reason: "periodic", pid: 4242 } } });
    expect(launch).toHaveBeenCalledWith({ bundleVersion: "1.1.0", manifestDigest: m.newer.digest, reason: "periodic" });
    const second = await c.apply("operator");
    expect(second).toMatchObject({ started: false, reason: expect.stringMatching(/already launched/) });
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("does nothing for a same-version or untrusted manifest and surfaces the check error", async () => {
    const same = coordinator({ manifest: "same" });
    expect(await same.c.apply("periodic")).toMatchObject({ started: false, reason: "no newer signed release", status: { available: null } });
    const untrusted = coordinator({ trust: [] });
    const result = await untrusted.c.apply("core_minimum");
    expect(result.started).toBe(false);
    expect(result.status.lastError).toBeTruthy();
    expect(untrusted.launch).not.toHaveBeenCalled();
  });
  it("respects the owner's veto and refuses while another transaction is recorded in progress", async () => {
    const vetoed = coordinator({ canApply: false });
    expect(await vetoed.c.apply("periodic")).toMatchObject({ started: false, reason: "draining (user)" });
    const { m } = coordinator({});
    const busy = coordinator({ ledger: { schemaVersion: 1, attempts: [attempt({ manifestDigest: m.newer.digest, outcome: "in_progress", finishedAt: null, startedAt: "2026-09-15T11:50:00Z" })] } });
    expect(await busy.c.apply("periodic")).toMatchObject({ started: false, reason: expect.stringMatching(/still in progress/) });
    // A stale in-progress record (abandoned transaction) no longer blocks.
    const stale = coordinator({ ledger: { schemaVersion: 1, attempts: [attempt({ manifestDigest: m.newer.digest, outcome: "in_progress", finishedAt: null, startedAt: "2026-09-15T09:00:00Z" })] } });
    expect(await stale.c.apply("periodic")).toMatchObject({ started: true });
  });
  it("stops retrying a release that keeps rolling back until a newer one or an operator appears", async () => {
    const { m } = coordinator({});
    const digest = m.newer.digest;
    const looping = coordinator({ ledger: { schemaVersion: 1, attempts: [attempt({ manifestDigest: digest }), attempt({ manifestDigest: digest, outcome: "failed" }), attempt({ manifestDigest: digest })] } });
    const refused = await looping.c.apply("periodic");
    expect(refused).toMatchObject({ started: false, reason: expect.stringMatching(/rolled_back 3 time\(s\)/) });
    expect(refused.status.lastAttempt).toMatchObject({ outcome: "rolled_back", manifestDigest: digest });
    // Two failures is still within budget; failures on another digest do not count.
    const under = coordinator({ ledger: { schemaVersion: 1, attempts: [attempt({ manifestDigest: digest }), attempt({ manifestDigest: digest }), attempt({ manifestDigest: "other" })] } });
    expect(await under.c.apply("periodic")).toMatchObject({ started: true });
    // Failures outside the window are forgotten.
    const old = coordinator({ ledger: { schemaVersion: 1, attempts: [1, 2, 3].map(() => attempt({ manifestDigest: digest, startedAt: "2026-09-13T11:00:00Z" })) } });
    expect(await old.c.apply("periodic")).toMatchObject({ started: true });
  });
  it("acts on Core's update_required immediately and reports a launch failure without pretending", async () => {
    const { c, launch } = coordinator({});
    c.onUpdateRequired({ minimumSupportedBundle: "1.1.0" });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const broken = coordinator({});
    broken.launch.mockRejectedValueOnce(new Error("spawn EACCES"));
    await expect(broken.c.apply("operator")).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(broken.c.status().lastError).toBe("spawn EACCES");
  });
  it("clears its in-flight view when the launched transaction exits without replacing this process", async () => {
    let exit: ((code: number | null) => void) | undefined;
    const { c, launch } = coordinator({});
    launch.mockImplementationOnce(async () => ({ pid: 99, onExit: (listener: (code: number | null) => void) => { exit = listener; } }));
    await c.apply("periodic");
    expect(c.status().inFlight?.pid).toBe(99);
    exit!(1);
    expect(c.status().inFlight).toBeNull();
    expect(c.status().lastError).toMatch(/exited with code 1/);
    expect(await c.apply("periodic")).toMatchObject({ started: true });
  });
  it("clears its in-flight view once the ledger shows the transaction ended without replacing this process", async () => {
    let ledger: NativeUpdateLedger = { schemaVersion: 1, attempts: [] };
    const { c, launch, m } = coordinator({ ledger });
    await c.apply("periodic");
    expect(c.status().inFlight).not.toBeNull();
    ledger = { schemaVersion: 1, attempts: [attempt({ manifestDigest: m.newer.digest, outcome: "failed", startedAt: "2026-09-15T12:00:30Z" })] };
    // The coordinator re-reads the ledger on every check.
    (c as unknown as { options: { readLedger: () => Promise<NativeUpdateLedger> } }).options.readLedger = async () => ledger;
    expect((await c.check()).inFlight).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("native update ledger", () => {
  it("round-trips attempts by id and keeps only the most recent fifty", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-update-ledger-")); roots.push(root);
    expect(await readNativeUpdateLedger(root)).toEqual({ schemaVersion: 1, attempts: [] });
    await recordNativeUpdateAttempt(root, attempt({ id: "one", outcome: "in_progress", finishedAt: null }));
    await recordNativeUpdateAttempt(root, attempt({ id: "one", outcome: "applied" }));
    expect((await readNativeUpdateLedger(root)).attempts).toEqual([expect.objectContaining({ id: "one", outcome: "applied" })]);
    for (let index = 0; index < 60; index += 1) await recordNativeUpdateAttempt(root, attempt({ id: `bulk-${index}` }));
    const ledger = await readNativeUpdateLedger(root);
    expect(ledger.attempts).toHaveLength(50);
    expect(ledger.attempts.some(entry => entry.id === "one")).toBe(false);
  });
});

describe("native updater launch", () => {
  it("runs the installer transaction detached from the service process group, as a transient unit on systemd", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-update-launch-")); roots.push(root);
    const children: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/corp/ca.pem");
    vi.stubEnv("KONTEKS_RELEASE_MANIFEST_URL", "https://channel.example/latest/native-manifest.json");
    const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => { children.push({ command, args, options }); return { pid: 77, unref: () => {}, once: () => {} }; }) as never;
    await launchNativeUpdater({ root, executable: join(root, "releases", "release-a", "connector"), os: "macos", logPath: join(root, "update.log"), spawnFn });
    expect(children[0]).toMatchObject({ command: join(root, "releases", "release-a", "connector"), args: ["--root", root, "--json", "update", "--unattended"], options: { detached: true } });
    expect((children[0]!.options.env as Record<string, string>)).not.toHaveProperty("KONTEKS_ACTIVATION_CODE");
    expect((children[0]!.options.env as Record<string, string>).NODE_EXTRA_CA_CERTS).toBe("/corp/ca.pem");
    expect((children[0]!.options.env as Record<string, string>).KONTEKS_RELEASE_MANIFEST_URL).toBe("https://channel.example/latest/native-manifest.json");
    await launchNativeUpdater({ root, executable: join(root, "releases", "release-a", "connector"), os: "debian", spawnFn });
    expect(children[1]!.command).toBe("systemd-run");
    expect(children[1]!.args).toEqual(expect.arrayContaining(["--user", "--collect", "--property=KillMode=process", join(root, "releases", "release-a", "connector"), "update", "--unattended"]));
    await expect(launchNativeUpdater({ root: "relative", executable: "/x", os: "macos", spawnFn })).rejects.toThrow(/absolute/);
  });
});
