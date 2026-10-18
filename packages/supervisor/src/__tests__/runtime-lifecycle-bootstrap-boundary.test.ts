import { EventEmitter } from "node:events";
import { createHash, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, computeBundleManifestDigest, listRuntimeFailureCaptures, readRuntimeFailureCapture, RuntimeFailureObservationSchema, writeSecretFile } from "@konteks/remote-common";
import { buildReleaseFixture } from "@konteks/remote-release";
import { createNativeService } from "../native/service.js";
import { CoreClient } from "../core/client.js";
import { SupervisorStore } from "../state/store.js";
import { Supervisor } from "../supervisor.js";
import { DurableOutbox } from "../state/outbox.js";
import { acquireNativeRootLock } from "../native/root-lock.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-bootstrap-unbound-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function installedIdentity() {
  const keys = buildReleaseFixture();
  const platform = { os: "macos", architecture: "arm64" } as const;
  const bytes = "verified-bootstrap-fixture-not-executed";
  const artifact = { id: "connector", kind: "connector", format: "executable", ...platform,
    url: "https://release.example/connector", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, sizeBytes: Buffer.byteLength(bytes) };
  const body = { bundleVersion: "1.0.0", protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector",
    components: ["agent_runner"], images: [], agentBridges: [], nativeArtifacts: [artifact], expiresAt: "2027-01-01T00:00:00Z" };
  const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
  const manifest = { ...unsigned, signature: { algorithm: "Ed25519", keyId: keys.keyId,
    value: sign(null, bundleManifestSigningBytes(unsigned as never), keys.privateKey).toString("base64url") } };
  const record = { schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance", workspaceId: "tenant",
    releaseId: "release-1", manifestDigest: manifest.digest, bundleVersion: "1.0.0", coreUrl: "https://core.example",
    relayUrl: "wss://relay.example/runtime", controlPort: 41800, agents: [] };
  const dataDir = join(root, "supervisor");
  const releaseDir = join(root, "releases", record.releaseId);
  for (const directory of [dataDir, join(releaseDir, "agents"), join(root, "credentials"), join(root, "workspaces")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await new SupervisorStore(dataDir).loadOrCreateInstanceKey();
  await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify(record));
  await writeSecretFile(join(dataDir, "identity.json"), JSON.stringify({ instanceId: "instance", workspaceId: "tenant",
    activationId: "activation", activatedAt: "2026-09-06T00:00:00Z", administrativeStatus: "provisioning", exchangeNonce: "nonce" }));
  await writeSecretFile(join(dataDir, "manifest.json"), JSON.stringify({ manifest, manifestDigest: manifest.digest }));
  await writeSecretFile(join(releaseDir, "manifest.json"), JSON.stringify(manifest));
  return { roots: [{ ...keys.root, coreControlKeys: [{ keyId: keys.keyId, publicKeyJwk: keys.root.publicKeyJwk }] }], platform };
}

async function retainedBootstrapObservations() {
  const dataDir = join(root, "supervisor");
  const outbox = new DurableOutbox(join(dataDir, "runtime-failures"));
  await outbox.load();
  const retained = outbox.all().map(item => RuntimeFailureObservationSchema.parse(item.body));
  for (const path of await listRuntimeFailureCaptures(dataDir)) {
    const source = await readRuntimeFailureCapture(path);
    expect(source?.capture.workspaceId).toBe("tenant");
    if (source) retained.push(source.capture.observation);
  }
  return retained;
}

it("keeps a bootstrap failure before loaded installation identity local and releases service listeners", async () => {
  const signals = new EventEmitter();
  const submit = vi.spyOn(CoreClient.prototype, "submitRuntimeFailure").mockRejectedValue(new Error("no remote call is allowed"));
  const daemon = createNativeService({ root, roots: [], platform: { os: "macos", architecture: "arm64" }, update: false, signalSource: signals });
  try {
    await expect(daemon.start()).rejects.toMatchObject({ code: "install_state_corrupt" });
    await daemon.waitUntilStopped();
    await expect(new SupervisorStore(join(root, "supervisor")).identity()).resolves.toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  } finally {
    await daemon.shutdown("test-cleanup", 0).catch(() => undefined);
  }
});

interface BootstrapStages {
  chooseGit(...args: unknown[]): Promise<void>;
  composeLocalAgents(...args: unknown[]): Promise<void>;
}

it.each(["chooseGit", "composeLocalAgents"] as const)("retains an owned bootstrap failure at %s before shutdown releases the original identity", async stage => {
  const installation = await installedIdentity();
  const original = new Error("private-bootstrap-canary https://provider.invalid/?private /Users/private/work");
  const failure = vi.spyOn(Supervisor.prototype as unknown as BootstrapStages, stage).mockRejectedValueOnce(original);
  const submit = vi.spyOn(CoreClient.prototype, "submitRuntimeFailure").mockRejectedValue(new Error("offline bootstrap must not send"));
  const signals = new EventEmitter();
  const daemon = createNativeService({ root, ...installation, update: false, signalSource: signals });
  try {
    await expect(daemon.start()).rejects.toBe(original);
    await daemon.waitUntilStopped();
    expect(failure).toHaveBeenCalledOnce();
    const store = new SupervisorStore(join(root, "supervisor"));
    expect(await store.identity()).toMatchObject({ instanceId: "instance", workspaceId: "tenant" });
    expect(await store.loadInstanceKey()).not.toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    const nextOwner = acquireNativeRootLock(join(root, "supervisor"));
    nextOwner.release();
    const retained = await retainedBootstrapObservations();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ instanceId: "instance", scope: { kind: "runtime" }, phase: "supervisor",
      stage: "runtime_start", code: "runtime_start_failed", evidence: { kind: "runtime_exception" } });
    expect(JSON.stringify(retained)).not.toMatch(/private-bootstrap-canary|provider\.invalid|Users|"message"|"stack"|"cause"|"assignmentId"|"claimId"/);
  } finally {
    await daemon.shutdown("test-cleanup", 0).catch(() => undefined);
  }
});
