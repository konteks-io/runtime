import { createHash, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleManifestSigningBytes, canonicalize, computeBundleManifestDigest, jcsDigest, writeSecretFile, RemoteInstanceError, type RemoteWorkAssignment } from "@konteks/remote-common";
import { buildReleaseFixture, installOfflineAgentPackage } from "@konteks/remote-release";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { RunnerConfigSchema, type BridgeProcess } from "@konteks/remote-agent-runner";
import { Supervisor } from "../supervisor.js";
import { NativeInputClient } from "../native/input-client.js";
import { SupervisorConfigSchema } from "../config.js";
import { SupervisorStore } from "../state/store.js";
import { submitReadiness } from "../provisioning/activation.js";
import { REMOTE_INSTANCE_PROTOCOL_VERSION, SystemClock } from "@konteks/remote-common";
import { LEASE_AUDIENCE, type CoreClient } from "../core/client.js";
import { decodeLeaseClaims, leaseRecordFromClaims } from "../lease/lease.js";
import { BROWSER_NO_PACKAGE_MESSAGE } from "../native/browser-capability.js";
import { openCodeInstallAdapter } from "../native/host-agents.js";

let root: string;
const supervisors: Supervisor[] = [];
/** A complete manifest for the intent the supervisor actually signed. */
const manifestFor = (intent: Parameters<CoreClient["reconnect"]>[0], lease: string) => ({
  instanceId: intent.instanceId, runnerIncarnation: intent.runnerIncarnation, reconnectIntentId: intent.reconnectIntentId,
  ownerRevision: 1, manifestId: "manifest", lease, issuedAt: new Date().toISOString(),
  applyDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  acceptedHeartbeatSequence: intent.lastHeartbeatSequence, heartbeatSequenceFloor: intent.lastHeartbeatSequence,
  decisions: [], pendingClaimDecisions: [],
});
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-supervisor-")); vi.spyOn(Server.prototype, "listen").mockImplementation(() => { throw new Error("native supervisor must not open an appliance listener"); }); });
afterEach(async () => { for (const supervisor of supervisors.splice(0)) await supervisor.stop(); vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function heartbeatLease(mode: "active" | "drain_only" = "active", status: "active" | "draining" = "active", deadline = new Date(Date.now() + 30000).toISOString()) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "konteks:control-plane", aud: LEASE_AUDIENCE, sub: "instance", workspace_id: "tenant", jti: "renewed", iat: now, exp: now + 20, protocol: "1.0", bundle_version: "1.0.0", deployment_kind: "native_connector", components: ["agent_runner"], ownership_scope: "personal", lease_mode: mode, administrative_status: status, ...(mode === "drain_only" ? { drain_deadline: deadline } : {}) };
  return { instanceId: "instance", lease: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`, leaseExpiresAt: new Date(claims.exp * 1000).toISOString(), leaseMode: mode, roles: [], strippedRoles: [], configRevision: 0, heartbeatIntervalSeconds: 15, ...(mode === "drain_only" ? { drainDeadline: deadline } : {}) };
}

async function fixture() {
  const signing = buildReleaseFixture();
  const agent = offlineFixture();
  const bytes = "native-test-executable-not-spawned";
  const artifact = { id: "connector", kind: "connector", format: "executable", os: "macos", architecture: "arm64", url: "https://release.example/connector", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, sizeBytes: Buffer.byteLength(bytes) };
  const body = { bundleVersion: "1.0.0", protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], nativeArtifacts: [artifact, agent.artifact], expiresAt: "2027-09-01T00:00:00Z" };
  const unsigned = { ...body, digest: computeBundleManifestDigest(body as never) };
  const manifest = { ...unsigned, signature: { algorithm: "Ed25519", keyId: signing.keyId, value: sign(null, bundleManifestSigningBytes(unsigned as never), signing.privateKey).toString("base64url") } };
  const config = SupervisorConfigSchema.parse({ SUPERVISOR_DEPLOYMENT_KIND: "native_connector", SUPERVISOR_DATA_DIR: join(root, "state"), SUPERVISOR_CORE_URL: "https://core.example", SUPERVISOR_BUNDLE_VERSION: "1.0.0", SUPERVISOR_PLATFORM_OS: "macos", SUPERVISOR_PLATFORM_ARCH: "arm64", SUPERVISOR_RELEASE_MANIFEST_FILE: join(root, "manifest.json") });
  await writeSecretFile(config.SUPERVISOR_RELEASE_MANIFEST_FILE, JSON.stringify(manifest));
  const store = new SupervisorStore(config.SUPERVISOR_DATA_DIR);
  await store.init();
  // An activated machine has its key; enrollment writes it before the identity.
  await store.loadOrCreateInstanceKey();
  await store.saveIdentity({ instanceId: "instance", workspaceId: "tenant", activationId: "activation", activatedAt: new Date().toISOString(), administrativeStatus: "provisioning", exchangeNonce: "exchange" });
  await store.saveManifest(manifest as never, manifest.digest);
  const archive = join(root, "agent.tgz"); await writeFile(archive, agent.archive, { mode: 0o600 });
  await installOfflineAgentPackage(archive, join(root, "bridges"), agent.artifact as never);
  const runner = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: join(root, "auth"), RUNNER_WORKSPACE_DIR: join(root, "work"), RUNNER_BRIDGE_PREFIX: join(root, "bridges"), RUNNER_NATIVE_PACKAGE_ARTIFACT: agent.artifact, RUNNER_NATIVE_PACKAGE_PROFILE: agent.profile });
  const executable = join(root, "bridges", "bin", "node");
  const stop = vi.fn(async () => undefined);
  const spawn = vi.fn(async () => ({ initializeResult: { protocolVersion: 1 }, connection: {}, exited: false, stderrTail: () => [], stop }) as BridgeProcess);
  const options = { native: { trustedRoots: [{ ...signing.root, coreControlKeys: [{ keyId: signing.keyId, publicKeyJwk: signing.root.publicKeyJwk }] }], runners: [runner], prepareInputs: async () => { throw new Error("no assignment in startup test"); }, runtimeOptions: { spawn, probe: async () => ({ kind: "logged_out" as const }) } } };
  return { config, store, manifest, executable, options, spawn, stop, signing };
}

describe("native Supervisor composition", () => {
  it("shows a runner's changed readiness immediately in local auth status", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await supervisor.start();
    const control = supervisor.controlHandler();
    const emitter = { event: () => undefined } as never;
    const before = await control({ op: "auth.status", agentId: "codex" }, emitter) as { agents: Array<{ readiness: string }> };
    expect(before.agents[0]?.readiness).toBe("not_configured");
    await (supervisor as unknown as { onRunnerEvent(agentId: string, event: unknown): Promise<void> }).onRunnerEvent("codex", {
      kind: "readiness_changed", agent: { ...before.agents[0], readiness: "ready", connectionState: "ready", recoveryAction: undefined },
    });
    const after = await control({ op: "auth.status", agentId: "codex" }, emitter) as { agents: Array<{ readiness: string }> };
    expect(after.agents[0]?.readiness).toBe("ready");
    const roster = await control({ op: "agents" }, emitter) as { agents: Array<{ readiness: string }> };
    expect(roster.agents[0]?.readiness).toBe("ready");
    expect((supervisor as unknown as { lastSnapshot: { agents: Array<{ readiness: string }> } }).lastSnapshot.agents[0]?.readiness).toBe("ready");
  });
  it("starts Google Antigravity's Gemini Enterprise sign-in from the site with its project, and says no_license only to a 7.1.0 Core (antigravity CP3)", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await supervisor.start();
    type Report = Record<string, unknown>;
    const internals = supervisor as unknown as { runners: Map<string, unknown>; core: { reportAgentLogin: (instanceId: string, report: Report) => Promise<unknown> };
      hostSettings: { openCodeFreeModels: boolean; coreAcceptsRouteBilling: boolean }; activeLogins: Map<string, { emit(event: unknown): void }>;
      onAgentLogin(request: unknown, verifier: unknown): Promise<void> };
    const reports: Report[] = [];
    vi.spyOn(internals.core, "reportAgentLogin").mockImplementation(async (_instanceId, report) => { reports.push(report); return {}; });
    const login = vi.fn(async (_organization: boolean, loginId: string) => ({ loginId }));
    internals.runners.set("antigravity", { agentId: "antigravity", login, loginCancel: vi.fn(async () => ({})), siteLoginOptions: () => ["gemini-enterprise"], startEvents: vi.fn(), stopEvents: vi.fn() });
    const verifier = { verifyAgentLoginDelivery: () => true };
    const gcp = { project: "gemini-enterprise-qa-25d3", location: "global" };
    const intent = { loginId: "login-agy-1", tenantId: "tenant", instanceId: "instance", agentId: "antigravity", action: "start", loginOption: "gemini-enterprise", gcp };
    const google = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x.apps.googleusercontent.com";
    for (const [coreAccepts, loginId, failure] of [[true, "login-agy-1", "no_license"], [false, "login-agy-2", "login_failed"]] as const) {
      internals.hostSettings = { openCodeFreeModels: false, coreAcceptsRouteBilling: coreAccepts };
      await internals.onAgentLogin({ intent: { ...intent, loginId } }, verifier);
      expect(login).toHaveBeenLastCalledWith(false, loginId, true, { loginOption: "gemini-enterprise", gcp });
      expect(reports.at(-1)).toEqual({ loginId, agentId: "antigravity", loginOption: "gemini-enterprise", state: "awaiting_person" });
      internals.activeLogins.get(loginId)!.emit({ kind: "open_url", loginId, url: "http://127.0.0.1:50694/" });
      internals.activeLogins.get(loginId)!.emit({ kind: "open_url", loginId, url: google });
      expect(reports.at(-1)).toEqual({ loginId, agentId: "antigravity", loginOption: "gemini-enterprise", state: "awaiting_person", verificationUrl: google });
      internals.activeLogins.get(loginId)!.emit({ kind: "failed", loginId, code: "agent_auth_required", message: "Google Antigravity did not finish signing in", reason: "no_license" });
      expect(reports.at(-1)).toEqual({ loginId, agentId: "antigravity", loginOption: "gemini-enterprise", state: "failed", failure });
    }
    expect(JSON.stringify(reports)).not.toContain("gemini-enterprise-qa-25d3");
    // No project, or personal Google sign-in (held back, A10): refused, never started.
    const calls = login.mock.calls.length;
    await internals.onAgentLogin({ intent: { ...intent, loginId: "login-agy-3", gcp: undefined } }, verifier);
    await internals.onAgentLogin({ intent: { ...intent, loginId: "login-agy-4", loginOption: "google-account", gcp: undefined } }, verifier);
    expect(login.mock.calls.length).toBe(calls);
    expect(reports.slice(-2)).toEqual([
      { loginId: "login-agy-3", agentId: "antigravity", loginOption: "gemini-enterprise", state: "failed", failure: "unavailable" },
      { loginId: "login-agy-4", agentId: "antigravity", loginOption: "google-account", state: "failed", failure: "unavailable" },
    ]);
    internals.runners.delete("antigravity");
  });

  it("cancels a local login when its control caller disconnects", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await supervisor.start();
    const runner = (supervisor as unknown as { runners: Map<string, { login: (organization: boolean, loginId: string, personal?: boolean) => Promise<{ loginId: string }>; loginCancel: (loginId: string) => Promise<unknown> }> }).runners.get("codex")!;
    const login = vi.spyOn(runner, "login").mockImplementation(async (_organization, loginId) => ({ loginId }));
    const cancel = vi.spyOn(runner, "loginCancel").mockResolvedValue({ cancelled: true });
    const disconnect = new AbortController();
    const events = vi.fn();
    const started = await supervisor.controlHandler()({ op: "auth.login", agentId: "codex", organization: false }, { event: events, signal: disconnect.signal });
    expect(started).toMatchObject({ loginId: expect.any(String) });
    expect(login).toHaveBeenCalledWith(false, (started as { loginId: string }).loginId, true);
    disconnect.abort();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith((started as { loginId: string }).loginId));
    expect((supervisor as unknown as { activeLogins: Map<string, unknown> }).activeLogins.size).toBe(0);
    const next = await supervisor.controlHandler()({ op: "auth.login", agentId: "codex", organization: false }, { event: events, signal: new AbortController().signal }) as { loginId: string };
    await supervisor.controlHandler()({ op: "auth.cancel", loginId: next.loginId }, { event: () => undefined, signal: new AbortController().signal });
    expect(events).toHaveBeenCalledWith({ kind: "failed", loginId: next.loginId, code: "login_cancelled", message: "login cancelled" });
    expect((supervisor as unknown as { activeLogins: Map<string, unknown> }).activeLogins.size).toBe(0);
  });
  it.each(["mode", "expiresAt", "issuedAt", "drainDeadline"])("rejects stored lease %s metadata that disagrees with its canonical claims", async field => {
    const f = await fixture(), result = heartbeatLease();
    const claims = decodeLeaseClaims(result.lease, { instanceId: "instance", audience: LEASE_AUDIENCE });
    const record = leaseRecordFromClaims(result.lease, claims);
    await f.store.saveLease({ ...record, [field]: field === "mode" ? "drain_only" : new Date(Date.now() + 3600000).toISOString() });
    const supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("composes the assignment mux using the build protocol, not the presence of an empty cursor callback", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    const pull = () => supervisor.mux.send("assignment:i", "assignment", { instanceId: "i", maxItems: 1, acceptedKinds: ["delivery"] });
    if (String(REMOTE_INSTANCE_PROTOCOL_VERSION) === "2.0") expect(pull).toThrow("retained logical frame owner");
    else expect(pull()).toBe(1);
  });
  it("stops and says so when its key is gone, instead of making a new one Core would refuse (W1-L1)", async () => {
    const f = await fixture();
    const { rm } = await import("node:fs/promises");
    await rm(join(f.config.SUPERVISOR_DATA_DIR, "instance-key.jwk"));
    const supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "install_state_corrupt", message: expect.stringContaining("key is missing") });
    expect(await f.store.loadInstanceKey()).toBeNull();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("asks Konteks to remove it on uninstall, then ends the whole process once removed (W1-L2)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const f = await fixture();
      const onRetired = vi.fn();
      const supervisor = new Supervisor(f.config, { ...f.options, onRetired }); supervisors.push(supervisor);
      await supervisor.start();
      const retire = vi.spyOn(supervisor.core, "retire")
        .mockResolvedValueOnce({ outcome: "draining", activeAssignments: 1 })
        .mockResolvedValueOnce({ outcome: "removed", activeAssignments: 0 });
      const handle = supervisor.controlHandler();
      expect(await handle({ op: "instance.retire" }, { event: () => undefined } as never)).toEqual({ outcome: "draining", activeAssignments: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onRetired).not.toHaveBeenCalled();
      expect(await handle({ op: "instance.retire" }, { event: () => undefined } as never)).toEqual({ outcome: "removed", activeAssignments: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onRetired).toHaveBeenCalledOnce();
      expect(retire).toHaveBeenCalledWith("instance");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps bounded suspended heartbeats and restores only the new Core lease", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    const heartbeat = vi.spyOn(supervisor.core, "heartbeat").mockRejectedValueOnce(new RemoteInstanceError("instance_suspended", "suspended")).mockResolvedValue(heartbeatLease());
    await supervisor.heartbeat.start();
    await expect(supervisor.heartbeat.publish()).rejects.toMatchObject({ code: "instance_suspended" });
    expect(supervisor.status().administrativeStatus).toBe("suspended"); expect(supervisor.lease.current()).toBeNull();
    await supervisor.heartbeat.publish();
    expect(heartbeat).toHaveBeenCalledTimes(2); expect(supervisor.status().administrativeStatus).toBe("active"); expect(supervisor.lease.isValid()).toBe(true);
  });
  it("normalizes Core's RFC3339 drain deadline and cancels only a restored limit-loss timer", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    vi.useFakeTimers();
    const deadline = new Date(Date.now() + 30000).toISOString(), drain = vi.spyOn(supervisor.work, "drainSessions").mockResolvedValue(undefined);
    const heartbeat = vi.spyOn(supervisor.core, "heartbeat").mockResolvedValue(heartbeatLease("drain_only", "draining", deadline));
    await supervisor.heartbeat.start(); await supervisor.heartbeat.publish();
    expect(supervisor.lease.current()?.drainDeadline).toBe(deadline); expect(supervisor.status().utilization.acceptingWork).toBe(false);
    heartbeat.mockResolvedValue(heartbeatLease()); await supervisor.heartbeat.publish();
    expect(supervisor.status().administrativeStatus).toBe("active"); expect(supervisor.status().utilization.acceptingWork).toBe(true);
    supervisor.heartbeat.stop(); await vi.advanceTimersByTimeAsync(30001); expect(drain).not.toHaveBeenCalled();
  });
  it("does not let an older reconnect response undo a heartbeat suspension", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    const gate = Promise.withResolvers<Awaited<ReturnType<CoreClient["reconnect"]>>>();
    // prepareIntent resolves the current owner first; this fixture has no Core.
    vi.spyOn(supervisor.core, "resolveRuntimeOwner").mockImplementation(async id => ({ instanceId: id, ownerRevision: 0, currentIncarnation: null, acceptedHeartbeatSequence: 0, heartbeatSequenceFloor: 0 }));
    let intent: Parameters<CoreClient["reconnect"]>[0] | undefined;
    const reconnect = vi.spyOn(supervisor.core, "reconnect").mockImplementation(request => { intent = request; return gate.promise; });
    const pending = supervisor.reconciliation.run(); const refused = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledOnce());
    await (supervisor as unknown as { onHeartbeatFailure(error: unknown): Promise<void> }).onHeartbeatFailure(new RemoteInstanceError("instance_suspended", "suspended"));
    const result = heartbeatLease();
    gate.resolve({ lease: result.lease, leaseExpiresAt: result.leaseExpiresAt, manifest: manifestFor(intent!, result.lease) });
    await refused; expect(supervisor.lease.current()).toBeNull(); expect(await f.store.lease()).toBeNull(); expect(supervisor.reconciliation.isComplete).toBe(false);
  });
  it("serializes active reconnect adoption before a newer drain heartbeat, and refuses recovery that normal scheduling overtook", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    const reply = Promise.withResolvers<Awaited<ReturnType<CoreClient["reconnect"]>>>();
    // prepareIntent resolves the current owner first; this fixture has no Core.
    vi.spyOn(supervisor.core, "resolveRuntimeOwner").mockImplementation(async id => ({ instanceId: id, ownerRevision: 0, currentIncarnation: null, acceptedHeartbeatSequence: 0, heartbeatSequenceFloor: 0 }));
    let intent: Parameters<CoreClient["reconnect"]>[0] | undefined;
    const reconnect = vi.spyOn(supervisor.core, "reconnect").mockImplementation(request => { intent = request; return reply.promise; });
    const first = supervisor.reconciliation.run();
    const refused = expect(first).rejects.toMatchObject({ code: "recovery_required" });
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledOnce());
    const heartbeat = vi.spyOn(supervisor.core, "heartbeat").mockResolvedValue(heartbeatLease("drain_only", "draining"));
    await supervisor.heartbeat.start(); const second = supervisor.heartbeat.publish();
    // The drain heartbeat waits on the lease-acquisition lane recovery holds.
    await new Promise(resolve => setTimeout(resolve, 25)); expect(heartbeat).not.toHaveBeenCalled();
    const active = heartbeatLease(); reply.resolve({ lease: active.lease, leaseExpiresAt: active.leaseExpiresAt, manifest: manifestFor(intent!, active.lease) });
    await second; expect(supervisor.lease.mode()).toBe("drain_only");
    // Startup pending publication is refused once normal scheduling has begun,
    // so this generation fails closed instead of adopting under a newer lease.
    await refused;
    expect(supervisor.reconciliation.isComplete).toBe(false);
    expect(supervisor.lease.mode()).toBe("drain_only");
  });
  it("does not publish authority when suspension arrives during lease persistence", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    const persist = supervisor.store.saveLease.bind(supervisor.store), gate = Promise.withResolvers<void>();
    const write = vi.spyOn(supervisor.store, "saveLease").mockImplementation(async record => { await gate.promise; await persist(record); });
    vi.spyOn(supervisor.core, "heartbeat").mockResolvedValue(heartbeatLease());
    await supervisor.heartbeat.start(); const pending = supervisor.heartbeat.publish(); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const deny = (supervisor as unknown as { onHeartbeatFailure(error: unknown): Promise<void> }).onHeartbeatFailure(new RemoteInstanceError("instance_suspended", "suspended"));
    expect(supervisor.lease.current()).toBeNull(); gate.resolve(); await Promise.all([rejected, deny]);
    expect(supervisor.lease.current()).toBeNull(); expect(await f.store.lease()).toBeNull(); expect(supervisor.status().administrativeStatus).toBe("suspended");
  });
  it("renews during slow cancellation but does not admit new work before cleanup settles", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    const cleanup = Promise.withResolvers<void>();
    const drain = vi.spyOn(supervisor.work, "drainSessions").mockImplementationOnce(() => cleanup.promise);
    vi.spyOn(supervisor.core, "heartbeat").mockRejectedValueOnce(new RemoteInstanceError("instance_suspended", "suspended")).mockResolvedValue(heartbeatLease());
    await supervisor.heartbeat.start();
    const failed = supervisor.heartbeat.publish(); const rejected = expect(failed).rejects.toThrow();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    // The next caller must not join the suspended request's blocked cancellation.
    let completed = false;
    const renewed = rejected.then(() => supervisor.heartbeat.publish()).then(() => { completed = true; });
    try {
      await vi.waitFor(() => expect(completed).toBe(true));
      expect(supervisor.lease.isValid()).toBe(true); expect(supervisor.status().utilization.acceptingWork).toBe(false);
    } finally { cleanup.resolve(); await renewed; }
    await vi.waitFor(() => expect(supervisor.status().utilization.acceptingWork).toBe(true));
  });
  it.each(["user", "update", "remove"])("does not clear a %s drain when a fresh active lease arrives", async reason => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor); await supervisor.start();
    await (supervisor as unknown as { beginDrain(reason: string, deadline: string | null): Promise<number> }).beginDrain(reason, null);
    vi.spyOn(supervisor.core, "heartbeat").mockResolvedValue(heartbeatLease());
    await supervisor.heartbeat.start(); await supervisor.heartbeat.publish();
    expect(supervisor.lease.isValid()).toBe(true); expect(supervisor.status().utilization.acceptingWork).toBe(false);
  });
  it("adopts the HTTPS heartbeat lease, and revocation clears it without another renewal path", async () => {
    const f = await fixture(), supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor); await supervisor.start();
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "konteks:control-plane", aud: LEASE_AUDIENCE, sub: "instance", workspace_id: "tenant", jti: "renewed", iat: now, exp: now + 600, protocol: "1.0", bundle_version: "1.0.0", deployment_kind: "native_connector", components: ["agent_runner"], ownership_scope: "personal", administrative_status: "active", lease_mode: "active" };
    const lease = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const heartbeat = vi.spyOn(supervisor.core, "heartbeat").mockResolvedValue({ instanceId: "instance", lease, leaseExpiresAt: new Date(claims.exp * 1000).toISOString(), leaseMode: "active", roles: [], strippedRoles: [], configRevision: 0, heartbeatIntervalSeconds: 15 });
    const relay = vi.spyOn(supervisor.transport, "send");
    await supervisor.heartbeat.start(); await supervisor.heartbeat.publish();
    expect(supervisor.lease.current()?.lease).toBe(lease);
    expect((await f.store.lease())?.lease).toBe(lease);
    expect(relay).not.toHaveBeenCalled();
    heartbeat.mockRejectedValueOnce(new RemoteInstanceError("instance_revoked", "revoked"));
    await expect(supervisor.heartbeat.publish()).rejects.toMatchObject({ code: "instance_revoked" });
    expect(supervisor.lease.current()).toBeNull(); expect(await f.store.lease()).toBeNull();
    expect((await supervisor.status()).administrativeStatus).toBe("revoked");
    await expect(supervisor.heartbeat.publish()).rejects.toThrow();
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });
  it("wires the production input preparer by default and refuses an unclaimed assignment", async () => {
    const f = await fixture();
    const { prepareInputs: _, ...native } = f.options.native;
    const supervisor = new Supervisor(f.config, { native });
    supervisors.push(supervisor);
    await supervisor.start();
    const internal = supervisor as unknown as { work: { deps: { sessionDeps: (assignment: unknown, runner: unknown) => { prepareInputs?: (assignment: unknown) => Promise<unknown>; registerReady?: (assignment: unknown, binding: unknown, acpSessionRef: string) => Promise<unknown> } } } };
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    const target: RemoteWorkAssignment = {
      id: "unclaimed", attempt: 1, instanceId: "instance", workspaceId: "tenant", kind: "assistant_execution", placementId: "placement", taskId: "task", correlationId: "correlation",
      expiresAt: expiry, requiredCapabilities: [], agentRoute: { agentId: "codex", requiredRole: "assistant" },
      source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session", turnRef: "turn" },
      policy: { maxDurationSeconds: 600, maxArtifactBytes: 1024, evidenceUpload: "structured_only", allowedArtifactKinds: [], recoveryMode: "report_interrupted", latestResumeAt: expiry, permissionResponderDeadlineSeconds: 30, humanDeferralAllowed: false },
    };
    const deps = internal.work.deps.sessionDeps(target, { agentId: "codex" });
    expect(deps.prepareInputs).toBeTypeOf("function");
    expect(deps.registerReady).toBeTypeOf("function");
    const register = vi.spyOn(supervisor.core, "registerExecutionReady");
    await expect(deps.registerReady!(target, { workspaceId: "tenant", instanceId: "instance", assignmentId: target.id, attempt: 1, sessionId: "session" }, "acp")).rejects.toThrow();
    expect(register).not.toHaveBeenCalled();
    const prepare = vi.spyOn(NativeInputClient.prototype, "prepare").mockRejectedValue(new Error("owner unavailable"));
    supervisor.lease.set({ lease: "test-lease", mode: "active", expiresAt: expiry, issuedAt: new Date().toISOString(), drainDeadline: null, workspaceId: "tenant" });
    await expect(deps.prepareInputs!(target)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(prepare).not.toHaveBeenCalled();
    await supervisor.journal.assignments.put({
      assignmentId: target.id, attempt: 1, claimId: "claim", kind: target.kind, placementId: target.placementId, workspaceId: target.workspaceId, agentId: "codex", state: "claimed", recoveryEpoch: 0,
      reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only", expiresAt: expiry, latestResumeAt: expiry, updatedAt: new Date().toISOString(),
    });
    await expect(deps.prepareInputs!(target)).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(prepare).toHaveBeenCalledWith(target, "claim");
    prepare.mockClear();
    supervisor.lease.set({ ...supervisor.lease.current()!, mode: "drain_only", drainDeadline: expiry });
    await expect(deps.prepareInputs!(target)).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
  });
  it("uses explicitly supplied release trust (there is no writable roots file)", async () => {
    const f = await fixture();
    const supervisor = new Supervisor(f.config, { native: { ...f.options.native, trustedRoots: [f.signing.root] } });
    supervisors.push(supervisor);
    await supervisor.start();
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("self-heals an interrupted manifest projection only to the strictly newer verified installed release", async () => {
    const f = await fixture();
    const { digest: _digest, signature: _signature, ...body } = f.manifest;
    const olderBody = { ...body, bundleVersion: "0.9.0" };
    const olderUnsigned = { ...olderBody, digest: computeBundleManifestDigest(olderBody as never) };
    const older = { ...olderUnsigned, signature: { algorithm: "Ed25519", keyId: f.signing.keyId, value: sign(null, bundleManifestSigningBytes(olderUnsigned as never), f.signing.privateKey).toString("base64url") } };
    await f.store.saveManifest(older as never, older.digest);
    const supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor);
    await supervisor.start();
    expect(await f.store.manifest()).toEqual({ manifest: f.manifest, manifestDigest: f.manifest.digest });
  });
  it("refuses same-version manifest digest substitution during projection recovery", async () => {
    const f = await fixture();
    const { digest: _digest, signature: _signature, ...body } = f.manifest;
    const changedBody = { ...body, expiresAt: "2027-08-31T00:00:00Z" };
    const changedUnsigned = { ...changedBody, digest: computeBundleManifestDigest(changedBody as never) };
    const changed = { ...changedUnsigned, signature: { algorithm: "Ed25519", keyId: f.signing.keyId, value: sign(null, bundleManifestSigningBytes(changedUnsigned as never), f.signing.privateKey).toString("base64url") } };
    await f.store.saveManifest(changed as never, changed.digest);
    const supervisor = new Supervisor(f.config, f.options); supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect((await f.store.manifest())?.manifestDigest).toBe(changed.digest);
  });
  it("does not use a writable roots file to override an empty trusted bundle", async () => {
    const f = await fixture();
    const supervisor = new Supervisor(f.config, { native: { ...f.options.native, trustedRoots: [] } });
    supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("refuses a second native supervisor before reading journals or starting bridges, then permits a clean restart", async () => {
    const f = await fixture();
    const owner = new Supervisor(f.config, f.options);
    supervisors.push(owner);
    await owner.start();
    const contender = new Supervisor(f.config, f.options);
    supervisors.push(contender);
    const readJournal = vi.spyOn(contender.journal, "load");
    await expect(contender.start()).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(readJournal).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledOnce();
    await contender.stop();
    await owner.stop();
    await expect(owner.store.saveHeartbeatSequence(99)).rejects.toThrow();
    await expect(owner.journal.pendingRequests.clear()).rejects.toThrow();
    await expect(owner.outbox.clear()).rejects.toThrow();
    const next = new Supervisor(f.config, f.options);
    supervisors.push(next);
    await next.start();
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it("refreshes signed native roles into live state and restores them on restart", async () => {
    const f = await fixture();
    const supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await supervisor.start();
    const configuration = { deploymentKind: "native_connector", roleBindings: [{ role: "assistant", agentPreference: ["codex"] }], heartbeatIntervalSeconds: 30, logLevel: "info", updateChannel: "stable", evidenceUpload: "structured_only", permissionResponderDeadlineSeconds: 120, humanDeferralAllowed: false };
    const unsigned = { type: "desired_configuration", instanceId: "instance", revision: 1, issuedAt: new Date().toISOString(), expiresAt: "2027-09-01T00:00:00Z", digest: jcsDigest(configuration), configuration };
    const body = { ...unsigned, signature: sign(null, Buffer.from(canonicalize(unsigned)), f.signing.privateKey).toString("base64url") };
    const fetch = vi.spyOn(supervisor.core, "fetchDesiredConfiguration").mockResolvedValue(body as never);
    const delivery = vi.spyOn(supervisor.core, "controlAck").mockRejectedValueOnce(new Error("lost response"));
    await Promise.all([supervisor.refreshConfiguration(), supervisor.refreshConfiguration()]);
    expect(fetch).toHaveBeenCalledOnce();
    const status = await supervisor.controlHandler()({ op: "agents" }, { event: () => undefined } as never);
    expect(status).toMatchObject({ roleBindings: configuration.roleBindings });
    expect((await f.store.config())?.configuration).toEqual(configuration);
    expect(delivery).toHaveBeenCalledOnce();
    expect(supervisor.outbox.depth).toBe(1);
    await supervisor.stop();
    const restored = new Supervisor(f.config, f.options);
    supervisors.push(restored);
    await restored.start();
    expect(await restored.controlHandler()({ op: "agents" }, { event: () => undefined } as never)).toMatchObject({ roleBindings: configuration.roleBindings });
    vi.spyOn(restored.core, "fetchDesiredConfiguration").mockRejectedValue(new Error("fetch unavailable"));
    const replay = vi.spyOn(restored.core, "controlAck").mockResolvedValue(true);
    await restored.refreshConfiguration();
    expect(replay).toHaveBeenCalledOnce();
    expect(replay.mock.calls[0]?.[1]).toEqual(delivery.mock.calls[0]?.[1]);
    expect(restored.outbox.depth).toBe(0);
    await supervisor.refreshConfiguration();
    expect(fetch).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledOnce();
  });

  it("starts actual native inventory without component/gateway servers, and shuts down the owned runner", async () => {
    const f = await fixture();
    const listen = vi.mocked(Server.prototype.listen);
    const supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await supervisor.start();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();
    expect((supervisor as unknown as Record<string, unknown>).gateway).toBeUndefined();
    expect((supervisor as unknown as Record<string, unknown>).internal).toBeUndefined();
    expect((await supervisor.inventory.collect()).components.map(component => component.kind)).toEqual(["agent_runner"]);
    const doctor = await supervisor.controlHandler()({ op: "doctor" }, { event: () => undefined } as never) as { checks: Array<{ id: string }> };
    expect(doctor.checks.some(check => check.id === "gateway" || check.id === "component-harness")).toBe(false);
    await supervisor.stop();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("reports previews in status (old launchers too), preview.status and the doctor, and advertises no preview without a relay", async () => {
    const f = await fixture();
    const supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await supervisor.start();
    expect(supervisor.status()).toMatchObject({ previewEnabled: false, previewExposure: null });
    const running = { ...supervisor.previews.status("sess-1"), state: "running" as const, url: "http://127.0.0.1:43100", port: 43100, command: "npm run dev", source: "inferred" as const };
    vi.spyOn(supervisor.previews, "list").mockReturnValue([running]);
    expect(supervisor.status()).toMatchObject({ previewEnabled: true, previewExposure: { port: 43100, grantPresent: false } });
    const report = await supervisor.controlHandler()({ op: "preview.status" }, { event: () => undefined } as never);
    expect(report).toMatchObject({ capabilityAdvertised: false, idleStopMinutes: 30, maxRunning: 3, previews: [{ sessionId: "sess-1", state: "running", url: "http://127.0.0.1:43100", viewerConnected: false }] });
    // This fixture has no relay: a viewer could never reach a preview, so none is advertised.
    expect((await supervisor.inventory.collect()).components[0]?.capabilities).not.toContain("preview.dev_server");
    const doctor = await supervisor.controlHandler()({ op: "doctor" }, { event: () => undefined } as never) as { checks: Array<{ id: string; status: string }> };
    expect(doctor.checks.find(check => check.id === "preview")).toMatchObject({ status: "warn" });
  });

  it("offers the connector's QA browser to its agents and advertises browser_tool while previews can run (O8)", async () => {
    const f = await fixture();
    const browser = { version: "0.0.82", packageAgent: "claude-code" as const, nodeSource: "person" as const, node: "/usr/local/bin/node", launcher: "/pkg/konteks/browser-mcp.js", entrypoint: "/pkg/node_modules/@playwright/mcp/cli.js" };
    const supervisor = new Supervisor(f.config, { native: { ...f.options.native, browser: { available: true, browser } } });
    supervisors.push(supervisor);
    await supervisor.start();
    // The fixture's Codex package carries no browser: it gets the connector's.
    expect(supervisor.runners.get("codex")?.browserVersion?.()).toBe("0.0.82");
    expect((await supervisor.inventory.collect()).components[0]?.capabilities).not.toContain("browser_tool");
    (supervisor as unknown as { previewCapable: () => boolean }).previewCapable = () => true;
    expect((await supervisor.inventory.collect()).components[0]?.capabilities).toContain("browser_tool");
    const doctor = await supervisor.controlHandler()({ op: "doctor" }, { event: () => undefined } as never) as { checks: Array<{ id: string; status: string; detail: string }> };
    expect(doctor.checks.find(check => check.id === "browser")).toMatchObject({ status: "pass", detail: expect.stringMatching(/^Playwright MCP 0\.0\.82 for codex; runs on your own Node;/) });
  });

  it("has no QA browser without a package or Node that can run it, and says so in doctor (O8)", async () => {
    const none = await fixture();
    const without = new Supervisor(none.config, { native: { ...none.options.native, browser: { available: false, reason: "no_package", message: BROWSER_NO_PACKAGE_MESSAGE } } });
    supervisors.push(without);
    await without.start();
    (without as unknown as { previewCapable: () => boolean }).previewCapable = () => true;
    expect(without.runners.get("codex")?.browserVersion?.()).toBeNull();
    expect((await without.inventory.collect()).components[0]?.capabilities).not.toContain("browser_tool");
    const report = await without.controlHandler()({ op: "doctor" }, { event: () => undefined } as never) as { checks: Array<{ id: string; status: string; detail: string }> };
    expect(report.checks.find(check => check.id === "browser")).toMatchObject({ status: "warn", detail: BROWSER_NO_PACKAGE_MESSAGE });
  });

  describe("the person's own OpenCode (opencode-runtime-support CP6)", () => {
    const openCodeConfig = () => RunnerConfigSchema.parse({
      RUNNER_AGENT_ID: "opencode", RUNNER_CREDENTIAL_DIR: join(root, "opencode-credentials"), RUNNER_WORKSPACE_DIR: join(root, "opencode-work"),
      RUNNER_BRIDGE_PREFIX: "/Users/person/.nvm/versions/node/v22/lib/node_modules/@opencode/cli/bin",
      RUNNER_NATIVE_OPENCODE_BINARY: "/Users/person/.nvm/versions/node/v22/lib/node_modules/@opencode/cli/bin/opencode.exe", RUNNER_BRIDGE_VERSION: "2.0.18",
    });
    const browser = { version: "0.0.82", packageAgent: "claude-code" as const, nodeSource: "person" as const, node: "/usr/local/bin/node", launcher: "/pkg/konteks/browser-mcp.js", entrypoint: "/pkg/node_modules/@playwright/mcp/cli.js" };
    const doctorOf = async (supervisor: Supervisor) => (await supervisor.controlHandler()({ op: "doctor" }, { event: () => undefined } as never) as { checks: Array<{ id: string; status: string; detail: string; recoveryActions: unknown[] }> }).checks;

    it("runs beside Codex, and doctor names its version, install, settings check, sign-ins, free models and browser without a path", async () => {
      const f = await fixture();
      vi.spyOn(openCodeInstallAdapter, "selfCheck").mockResolvedValue(undefined);
      const supervisor = new Supervisor(f.config, { native: { ...f.options.native, runners: [...f.options.native.runners, openCodeConfig()], browser: { available: true, browser } } });
      supervisors.push(supervisor);
      await supervisor.start();
      expect([...supervisor.runners.keys()]).toEqual(["codex", "opencode"]);
      const check = (await doctorOf(supervisor)).find(entry => entry.id === "opencode");
      expect(check).toMatchObject({ title: "OpenCode", status: "warn", recoveryActions: [{ kind: "login_agent", agentId: "opencode" }] });
      expect(check!.detail).toBe("OpenCode 2.0.18, installed with npm; Konteks settings check passed; not signed in to any provider (konteks-remote auth login opencode); OpenCode Zen free models off; its sessions get the QA browser");
    });

    it("is left out and retried when its settings check fails, while Codex keeps running; doctor says why", async () => {
      const f = await fixture();
      vi.spyOn(openCodeInstallAdapter, "selfCheck").mockRejectedValue(new RemoteInstanceError("prerequisite_missing", "Unsupported OpenCode installation: OpenCode 2.0.18 does not keep the Konteks settings (x). Install a supported version with `curl -fsSL https://opencode.ai/v2/install | bash`, then retry.", { diagnostic: "opencode_unsupported_installation" }));
      const supervisor = new Supervisor(f.config, { native: { ...f.options.native, runners: [...f.options.native.runners, openCodeConfig()] } });
      supervisors.push(supervisor);
      await supervisor.start();
      expect([...supervisor.runners.keys()]).toEqual(["codex"]);
      expect((await supervisor.inventory.collect()).agents.map(agent => agent.agentId)).toEqual(["codex"]);
      const check = (await doctorOf(supervisor)).find(entry => entry.id === "opencode");
      expect(check).toMatchObject({ status: "fail", recoveryActions: [{ kind: "install_backend", agentId: "opencode" }] });
      expect(check!.detail).toBe("OpenCode 2.0.18, installed with npm is not running Konteks work: this OpenCode does not keep the Konteks settings; install a supported OpenCode 2 from opencode.ai; it is tried again in the background, and the other agents keep running");
    });

    it("is left out when the installation could not find it at load, and joins once a retry re-locates it", async () => {
      const f = await fixture();
      vi.spyOn(openCodeInstallAdapter, "selfCheck").mockResolvedValue(undefined);
      const relocate = vi.fn()
        .mockRejectedValueOnce(new RemoteInstanceError("prerequisite_missing", "OpenCode 1 is not supported (found 1.18.33)", { diagnostic: "opencode_unsupported_version" }))
        .mockResolvedValue(openCodeConfig());
      const unavailableAgents = [{ agentId: "opencode", error: new RemoteInstanceError("prerequisite_missing", "OpenCode 1 is not supported (found 1.18.33)", { diagnostic: "opencode_unsupported_version" }), relocate }];
      const supervisor = new Supervisor(f.config, { native: { ...f.options.native, unavailableAgents } });
      supervisors.push(supervisor);
      await supervisor.start();
      expect([...supervisor.runners.keys()]).toEqual(["codex"]);
      expect((await doctorOf(supervisor)).find(entry => entry.id === "opencode")).toMatchObject({ status: "fail", detail: "OpenCode is not running Konteks work: the installed OpenCode is a version Konteks does not support (OpenCode 1, for example); install OpenCode 2 from opencode.ai; it is tried again in the background, and the other agents keep running" });
      const retry = (supervisor as unknown as { nativeAgentRetry: { retry(agentId: string): Promise<void>; parked(): string[] } }).nativeAgentRetry;
      await retry.retry("opencode");
      expect(retry.parked()).toEqual(["opencode"]);
      await retry.retry("opencode");
      expect(relocate).toHaveBeenCalledTimes(2);
      expect(retry.parked()).toEqual([]);
      expect([...supervisor.runners.keys()]).toEqual(["codex", "opencode"]);
      expect((await doctorOf(supervisor)).find(entry => entry.id === "opencode")).toMatchObject({ status: "warn", detail: expect.stringMatching(/^OpenCode 2\.0\.18, installed with npm; Konteks settings check passed;/) });
    });
  });

  it("tells the local operator which release Konteks accepts for this machine (WS1-093)", async () => {
    const f = await fixture();
    const supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await supervisor.start();
    const asked = vi.spyOn(supervisor.core, "acceptedRelease").mockResolvedValueOnce({ bundleVersion: "0.6.6-e2e.1", manifestDigest: "d" }).mockResolvedValueOnce(null);
    expect(await supervisor.controlHandler()({ op: "release.accepted" }, { event: () => undefined } as never)).toEqual({ bundleVersion: "0.6.6-e2e.1" });
    expect(await supervisor.controlHandler()({ op: "release.accepted" }, { event: () => undefined } as never)).toEqual({ bundleVersion: null });
    expect(asked).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("refuses native startup without explicit native dependencies", async () => {
    const f = await fixture();
    const supervisor = new Supervisor(f.config);
    supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "protocol_incompatible" });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("submits native readiness with its explicit topology rather than an appliance-shaped body", async () => {
    const f = await fixture();
    const submit = vi.fn(async () => ({ lease: "issued", leaseExpiresAt: "2027-01-01T00:00:00Z" }));
    await submitReadiness({ store: f.store, core: { submitReadiness: submit } as unknown as CoreClient, clock: new SystemClock(), protocolVersion: "1.0", bundleVersion: "1.0.0", components: [{ kind: "agent_runner", version: "1.0.0", capabilities: [], health: "healthy" }] });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ deploymentKind: "native_connector", components: [{ kind: "agent_runner", version: "1.0.0", capabilities: [], health: "healthy" }] }));
  });

  it("rejects a stored appliance lease before starting native agents", async () => {
    const f = await fixture();
    const claims = { iss: "konteks:control-plane", aud: LEASE_AUDIENCE, sub: "instance", workspace_id: "tenant", jti: "jti", iat: 1, exp: 2_000_000_000, protocol: "1.0", bundle_version: "1.0.0", components: ["harness", "validation_runtime", "agent_runner", "gateway"], ownership_scope: "personal", administrative_status: "active", lease_mode: "active" };
    await f.store.saveLease({ lease: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`, mode: "active", expiresAt: new Date(claims.exp * 1000).toISOString(), drainDeadline: null, issuedAt: new Date(1000).toISOString(), workspaceId: "tenant" });
    const supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "registration_mismatch" });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["tamper", "wrong-platform", "wrong-manifest"])("rejects %s before spawning an agent", async failure => {
    const f = await fixture();
    if (failure === "tamper") await writeSecretFile(f.executable, "tampered");
    if (failure === "wrong-platform") f.config.SUPERVISOR_PLATFORM_ARCH = "amd64";
    if (failure === "wrong-manifest") await f.store.saveManifest(f.manifest as never, "different-digest");
    const supervisor = new Supervisor(f.config, f.options);
    supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
