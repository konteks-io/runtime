import { sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedClock, bundleManifestSigningBytes, computeBundleManifestDigest, type RemoteInstanceActivationExchangeRequest } from "@konteks/remote-common";
import { buildReleaseFixture, verifyNativeRelease } from "@konteks/remote-release";
import { runNativeActivationExchange } from "../native/activation.js";
import { SupervisorStore } from "../state/store.js";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "native-activation-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const code = "test-only-activation-code-never-saved";
const platform = { os: "macos" as const, architecture: "arm64" as const, containerBackend: "none" as const, deploymentKind: "native_connector" as const };
function fixture() {
  const keys = buildReleaseFixture();
  const body = { bundleVersion: "1.0.0", protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], nativeArtifacts: [{ id: "connector", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: "https://release.example/connector", digest: `sha256:${"a".repeat(64)}`, sizeBytes: 4 }], expiresAt: "2027-01-01T00:00:00Z" };
  const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
  const manifest = { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
  const release = verifyNativeRelease(manifest, [keys.root], Date.parse("2026-09-06T00:00:00Z"));
  const readActivationCode = vi.fn(async () => code);
  const requests: RemoteInstanceActivationExchangeRequest[] = [];
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ instanceId: "instance-native", workspaceId: "tenant-native", administrativeStatus: "provisioning", provisioningCredential: "test-only-provisioning", provisioningCredentialExpiresAt: "2026-09-06T01:00:00Z", provisioningWindowExpiresAt: "2026-09-13T00:00:00Z", bundleManifest: manifest }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const args = { dataDir: dir, coreUrl: "https://core.example", activationId: "activation-native", platform, release, roots: [keys.root], clock: new FixedClock(Date.parse("2026-09-06T00:00:00Z")), readActivationCode, fetchFn };
  return { args, requests, keys, manifest };
}

describe("native activation and resumable exchange", () => {
  it("seeds complete ownership only at exclusive new enrollment before exchange", async () => {
    const f = fixture(); f.args.dataDir = join(dir, "fresh");
    const exchange = f.args.fetchFn.getMockImplementation()!;
    f.args.fetchFn.mockImplementation(async (...args) => {
      const journal = new SupervisorJournal(join(f.args.dataDir, "journal")); await journal.load();
      expect(journal.execution.enrollment()).toMatchObject({ activationId: f.args.activationId });
      expect(journal.execution.coverage("instance-native", "tenant-native")).toBe("legacy_unknown");
      return exchange(...args);
    });
    await runNativeActivationExchange(f.args);
    const journal = new SupervisorJournal(join(f.args.dataDir, "journal")); await journal.load();
    expect(journal.execution.coverage("instance-native", "tenant-native")).toBe("complete_from_enrollment");
    const enrolled = journal.execution.enrollment();
    await runNativeActivationExchange(f.args);
    const reloaded = new SupervisorJournal(join(f.args.dataDir, "journal")); await reloaded.load();
    expect(reloaded.execution.enrollment()).toEqual(enrolled);
  });

  it("never upgrades an existing empty directory into complete admission history", async () => {
    const f = fixture(); await runNativeActivationExchange(f.args);
    const journal = new SupervisorJournal(join(dir, "journal")); await journal.load();
    expect(journal.execution.coverage("instance-native", "tenant-native")).toBe("legacy_unknown");
  });

  it("retains the same enrollment seed through an uncertain fresh activation response", async () => {
    const f = fixture(); f.args.dataDir = join(dir, "fresh");
    f.args.fetchFn.mockRejectedValueOnce(new Error("lost response"));
    await expect(runNativeActivationExchange(f.args)).rejects.toThrow();
    const pending = new SupervisorJournal(join(f.args.dataDir, "journal")); await pending.load();
    const seed = pending.execution.enrollment();
    expect(seed).toBeDefined(); expect(pending.execution.coverage("instance-native", "tenant-native")).toBe("legacy_unknown");
    await runNativeActivationExchange(f.args);
    const resumed = new SupervisorJournal(join(f.args.dataDir, "journal")); await resumed.load();
    expect(resumed.execution.enrollment()).toMatchObject(seed!);
    expect(resumed.execution.coverage("instance-native", "tenant-native")).toBe("complete_from_enrollment");
  });

  it("a fresh mkdir cannot seed history after another enrollment wrote identity/key before lock acquisition", async () => {
    const f = fixture(); f.args.dataDir = join(dir, "fresh");
    const initialize = SupervisorStore.prototype.init;
    vi.spyOn(SupervisorStore.prototype, "init").mockImplementationOnce(async function () {
      await initialize.call(this);
      await this.loadOrCreateInstanceKey();
    });
    await runNativeActivationExchange(f.args);
    const journal = new SupervisorJournal(join(f.args.dataDir, "journal")); await journal.load();
    expect(journal.execution.coverage("instance-native", "tenant-native")).toBe("legacy_unknown");
  });

  it("exchanges the explicit native profile and persists provisioning only, with no Docker or secret code in state", async () => {
    const f = fixture();
    const result = await runNativeActivationExchange(f.args);
    expect(result.instanceId).toBe("instance-native");
    expect(f.requests[0]?.platform).toEqual(platform);
    const store = new SupervisorStore(dir);
    expect(await store.identity()).toMatchObject({ administrativeStatus: "provisioning", instanceId: "instance-native", workspaceId: "tenant-native" });
    expect(await store.lease()).toBeNull();
    expect((await store.manifest())?.manifestDigest).toBe(f.manifest.digest);
    for (const name of await readdir(dir)) {
      if (name.endsWith(".json") || name.endsWith(".jwk")) expect(await readFile(join(dir, name), "utf8")).not.toContain(code);
    }
    await runNativeActivationExchange(f.args);
    expect(f.args.fetchFn).toHaveBeenCalledOnce();
    expect(f.args.readActivationCode).toHaveBeenCalledOnce();
  });

  it("persists nonce and key before the first request, then reuses them after a lost response", async () => {
    const f = fixture();
    let first: RemoteInstanceActivationExchangeRequest | undefined;
    f.args.fetchFn.mockImplementationOnce(async (_url, init) => {
      first = JSON.parse(String(init?.body));
      const attempt = JSON.parse(await readFile(join(dir, "activation-attempt.json"), "utf8"));
      expect(attempt).toMatchObject({ activationId: f.args.activationId, nonce: first?.proof.nonce, manifestDigest: f.manifest.digest });
      throw new Error("response lost after Core commit");
    });
    await expect(runNativeActivationExchange(f.args)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(await new SupervisorStore(dir).identity()).toBeNull();
    await runNativeActivationExchange(f.args);
    expect(f.requests[0]?.proof.nonce).toBe(first?.proof.nonce);
    expect(f.requests[0]?.publicKeyJwk).toEqual(first?.publicKeyJwk);
  });

  it("repairs partial local response persistence by replaying the same exchange", async () => {
    const f = fixture();
    vi.spyOn(SupervisorStore.prototype, "saveProvisioning").mockRejectedValueOnce(new Error("disk full"));
    await expect(runNativeActivationExchange(f.args)).rejects.toThrow("disk full");
    await runNativeActivationExchange(f.args);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]?.proof.nonce).toBe(f.requests[1]?.proof.nonce);
    expect(await new SupervisorStore(dir).provisioning()).not.toBeNull();
  });

  it("does not prompt or exchange when the native root is already owned", async () => {
    const f = fixture();
    const owner = acquireNativeRootLock(dir);
    try { await expect(runNativeActivationExchange(f.args)).rejects.toMatchObject({ code: "temporarily_unavailable" }); }
    finally { owner.release(); }
    expect(f.args.readActivationCode).not.toHaveBeenCalled();
    expect(f.args.fetchFn).not.toHaveBeenCalled();
  });

  it("does not consume the code if the retry record cannot be persisted", async () => {
    const f = fixture();
    vi.spyOn(SupervisorStore.prototype, "saveActivationAttempt").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(runNativeActivationExchange(f.args)).rejects.toThrow("disk unavailable");
    expect(f.args.readActivationCode).not.toHaveBeenCalled();
    expect(f.args.fetchFn).not.toHaveBeenCalled();
  });

  it("refuses an unsupported native artifact target before creating private state", async () => {
    const f = fixture();
    await expect(runNativeActivationExchange({ ...f.args, platform: { ...platform, architecture: "amd64" } })).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(await readdir(dir)).toEqual([]);
    expect(f.args.readActivationCode).not.toHaveBeenCalled();
  });

  it("does not extend an expired provisioning window on install resume", async () => {
    const f = fixture();
    await runNativeActivationExchange(f.args);
    await expect(runNativeActivationExchange({ ...f.args, clock: new FixedClock(Date.parse("2026-09-14T00:00:00Z")) })).rejects.toMatchObject({ code: "provisioning_window_expired" });
    expect(f.args.fetchFn).toHaveBeenCalledOnce();
    expect(f.args.readActivationCode).toHaveBeenCalledOnce();
  });

  it("refuses a changed activation after an uncertain exchange", async () => {
    const f = fixture();
    f.args.fetchFn.mockRejectedValueOnce(new Error("lost"));
    await expect(runNativeActivationExchange(f.args)).rejects.toThrow();
    f.args.readActivationCode.mockClear();
    await expect(runNativeActivationExchange({ ...f.args, activationId: "different" })).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.args.readActivationCode).not.toHaveBeenCalled();
  });

  it("does not silently generate a new key when the retry identity was lost", async () => {
    const f = fixture();
    f.args.fetchFn.mockRejectedValueOnce(new Error("lost"));
    await expect(runNativeActivationExchange(f.args)).rejects.toThrow();
    await rm(join(dir, "instance-key.jwk"));
    await expect(runNativeActivationExchange(f.args)).rejects.toMatchObject({ code: "install_state_corrupt" });
    expect(await readdir(dir)).not.toContain("instance-key.jwk");
  });

  it("does not persist a native identity for a mismatched or forged exchange manifest", async () => {
    const f = fixture();
    f.args.fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ instanceId: "instance-native", workspaceId: "tenant-native", administrativeStatus: "provisioning", provisioningCredential: "test-only-provisioning", provisioningCredentialExpiresAt: "2026-09-06T01:00:00Z", provisioningWindowExpiresAt: "2026-09-13T00:00:00Z", bundleManifest: { ...f.manifest, signature: { ...f.manifest.signature, value: "A".repeat(86) } } }), { status: 200 }));
    await expect(runNativeActivationExchange(f.args)).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(await new SupervisorStore(dir).identity()).toBeNull();
    expect(await new SupervisorStore(dir).provisioning()).toBeNull();
  });
});
