import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
interface Internals {
  rememberAcceptedRelease(): Promise<void>;
  instanceId: string;
  workspaceId: string;
  manifestDigest: string;
  nativeOwnership: { assertOwned(): void };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "serving-authority-")); roots.push(root);
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({ SUPERVISOR_DATA_DIR: root, SUPERVISOR_CORE_URL: "https://core.example", SUPERVISOR_BUNDLE_VERSION: "1.0.0" }), {
    native: { trustedRoots: [], runners: [], servingRelease: { releaseId: "release-first", bundleVersion: "1.0.0", manifestDigest: "digest" } },
  });
  const internal = supervisor as unknown as Internals;
  Object.assign(internal, { instanceId: "instance", workspaceId: "tenant", manifestDigest: "digest", nativeOwnership: { assertOwned() {} } });
  await supervisor.store.init();
  await supervisor.store.saveIdentity({ instanceId: "instance", workspaceId: "tenant", activationId: "activation", activatedAt: new Date().toISOString(), administrativeStatus: "active", exchangeNonce: "nonce" });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "konteks:control-plane", aud: "konteks:remote-instance:lease", sub: "instance", workspace_id: "tenant", jti: "lease", iat: now, exp: now + 60, protocol: "1.0", bundle_version: "1.0.0", deployment_kind: "native_connector", components: ["agent_runner"], ownership_scope: "personal", administrative_status: "active", lease_mode: "active" };
  const setLease = (version: string) => supervisor.lease.set({ lease: `fixture.${Buffer.from(JSON.stringify({ ...claims, bundle_version: version })).toString("base64url")}.fixture`, workspaceId: "tenant", issuedAt: new Date(now * 1000).toISOString(), expiresAt: new Date((now + 60) * 1000).toISOString(), drainDeadline: null, mode: "active" });
  setLease("1.0.0");
  supervisor.reconciliation = { isComplete: true } as never;
  const recovery = { state: "applied", manifest: { manifestId: "manifest", ownerRevision: 1 }, receipt: { digest: "receipt" }, acceptedAt: new Date().toISOString() };
  const accepted = vi.spyOn(supervisor.journal.recovery, "current").mockReturnValue(recovery as never);
  vi.spyOn(supervisor.logger, "warn").mockImplementation(() => undefined);
  return { supervisor, internal, accepted, recovery, setLease };
}

it("records the verified installation only after accepted recovery under a matching Core lease", async () => {
  const f = await fixture(); await f.internal.rememberAcceptedRelease();
  expect(await f.supervisor.store.servingReleaseHistory()).toMatchObject({ current: { releaseId: "release-first" }, previous: null });
});
it("does not record an unreconciled installation", async () => {
  const f = await fixture(); f.supervisor.reconciliation = { isComplete: false } as never;
  await f.internal.rememberAcceptedRelease(); expect(await f.supervisor.store.servingReleaseHistory()).toBeNull();
});
it("does not record a release Core has not accepted", async () => {
  const f = await fixture(); f.setLease("2.0.0");
  await f.internal.rememberAcceptedRelease(); expect(await f.supervisor.store.servingReleaseHistory()).toBeNull();
});
it("does not record installation metadata with a different manifest digest", async () => {
  const f = await fixture(); f.internal.manifestDigest = "other";
  await f.internal.rememberAcceptedRelease(); expect(await f.supervisor.store.servingReleaseHistory()).toBeNull();
});
it("does not carry an earlier recovery confirmation across a generation change during disk reads", async () => {
  const f = await fixture();
  const identity = await f.supervisor.store.identity();
  vi.spyOn(f.supervisor.store, "identity").mockImplementation(async () => { f.recovery.manifest.ownerRevision++; return identity; });
  await f.internal.rememberAcceptedRelease(); expect(await f.supervisor.store.servingReleaseHistory()).toBeNull();
});
