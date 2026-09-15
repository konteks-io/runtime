import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlRequest, DoctorReport, SupervisorStatus } from "@konteks/remote-common";
import { buildReleaseFixture, signReleaseManifest, buildUnsignedReleaseManifest } from "@konteks/remote-release";
import { loadComposeTemplate, renderCompose, type ComposeRunner } from "../compose.js";
import { authLogin, backup, gatewayKeySet, logs, status, uninstall, update, type LifecycleContext } from "../commands/lifecycle.js";
import { InstallStateFile, initialInstallState, advance } from "../install-state.js";
import { createOutput } from "../output.js";
import { installPaths, volumeDirectories, type InstallPaths } from "../paths.js";
import { persistReleaseArtifacts } from "../release-fetch.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-lifecycle-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const agents = [
  { agentId: "codex", authMode: "agent_local_subscription" as const },
  { agentId: "pi", authMode: "gateway_keyed" as const },
];
const platform = { os: "macos" as const, architecture: "arm64" as const, containerBackend: "docker_compose" as const };

it("exposes only the public lease summary in machine-readable status", async () => {
  const f = await installed(await fixture());
  let text = "";
  f.context.output = createOutput({ json: true, stdout: new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } }) });
  await status(f.context);
  const result = JSON.parse(text);
  expect(result.leaseStatus).toEqual({ mode: "active", expiresAt: null, drainDeadline: null });
  expect(typeof result.lease).toBe("string"); // generic bearer redaction remains intact
});

interface Fake {
  context: LifecycleContext;
  paths: InstallPaths;
  composeCalls: string[][];
  controlCalls: ControlRequest[];
  lines: string[];
  doctorFails: boolean;
  drainRounds: number;
  confirmAnswer: boolean;
}

async function installed(current: ReturnType<typeof buildReleaseFixture>): Promise<Fake> {
  const paths = installPaths(join(dir, "root"));
  for (const volume of volumeDirectories(paths, agents.map((agent) => agent.agentId))) await mkdir(volume.path, { recursive: true, mode: 0o700 });
  await mkdir(paths.backups, { recursive: true });
  await mkdir(paths.stores, { recursive: true });
  await persistReleaseArtifacts(paths, current.manifest, [current.root]);
  await renderCompose({ release: current.manifest, paths, coreUrl: "https://core.example", relayUrl: null, agents, platform, bundleVersion: current.manifest.bundleVersion });
  await new InstallStateFile(paths.installState).write(advance(initialInstallState("act-1", "t0", agents), "ready", "t1", { instanceId: "inst-1", bundleVersion: current.manifest.bundleVersion }));
  // Agent credential volumes with content that must survive update/backup untouched.
  await writeFile(join(paths.credentials("codex"), "auth.json"), "{\"do-not-touch\":true}", { mode: 0o600 });
  await writeFile(join(paths.supervisorData, "instance-key.jwk"), "{\"kty\":\"EC\"}", { mode: 0o600 });
  await writeFile(join(paths.supervisorData, "lease.json"), "{\"lease\":\"x\"}", { mode: 0o600 });
  await writeFile(join(paths.supervisorData, "identity.json"), "{\"instanceId\":\"inst-1\"}", { mode: 0o600 });

  const fake: Fake = { paths, composeCalls: [], controlCalls: [], lines: [], doctorFails: false, drainRounds: 0, confirmAnswer: true, context: null as never };
  const compose: ComposeRunner = {
    run: async (args) => {
      fake.composeCalls.push(args);
      return { code: 0, stdout: args[0] === "logs" ? "supervisor | started\n" : "", stderr: "", signal: null, timedOut: false } as never;
    },
  };
  const status: SupervisorStatus = {
    instanceId: "inst-1",
    workspaceId: "ws",
    administrativeStatus: "active",
    connectivity: { transport: "relay", relayConnected: true, lastConnectedAt: null, reconciliationComplete: true },
    lease: { mode: "active", expiresAt: null, drainDeadline: null },
    version: { bundle: current.manifest.bundleVersion, protocol: "1", manifestDigest: null, updateAvailable: false, targetBundle: null },
    configRevision: 1,
    components: [],
    roles: [],
    roleBindings: [],
    utilization: { acceptingWork: true, activeSessions: 0, activeTurns: 0, utilizationRatio: 0 },
    previewEnabled: false,
    previewExposure: null,
    pendingErase: 0,
    pendingRevocation: false,
    journal: { assignments: 0, outboxDepth: 0, recoveryRequired: 0 },
  };
  const doctorReport = (): DoctorReport => ({ generatedAt: "2026-09-06T00:00:00Z", checks: [{ id: "lease", title: "Work lease", status: fake.doctorFails ? "fail" : "pass", detail: "x", recoveryActions: [] }] });
  const control = {
    call: async <T,>(request: ControlRequest, schema: { parse: (value: unknown) => T }, options?: { onEvent?: (event: unknown) => void }): Promise<T> => {
      fake.controlCalls.push(request);
      switch (request.op) {
        case "status":
          return schema.parse(status);
        case "drain":
          return schema.parse({ activeAssignments: fake.drainRounds });
        case "drain.status": {
          const remaining = Math.max(0, fake.drainRounds--);
          return schema.parse({ draining: true, reason: "update", activeAssignments: remaining, openSessions: 0 });
        }
        case "doctor":
          return schema.parse(doctorReport());
        case "agents":
          return schema.parse({ agents: [{ agentId: "codex", readiness: "reconnect_required", authMode: "agent_local_subscription", accountScope: "personal" }], roles: [], roleBindings: [] });
        case "auth.login":
          options?.onEvent?.({ kind: "started", loginId: "l1", agentId: request.agentId });
          options?.onEvent?.({ kind: "open_url", loginId: "l1", url: "https://login.example/device", userCode: "ABCD-1234" });
          options?.onEvent?.({ kind: "prompt", loginId: "l1", label: "Paste the code", secret: true });
          options?.onEvent?.({ kind: "completed", loginId: "l1", readiness: "ready" });
          return schema.parse({ loginId: "l1" });
        default:
          return schema.parse({});
      }
    },
  };
  const output = createOutput({ json: false, stdout: { write: (chunk: string) => (fake.lines.push(chunk), true) } as never, stderr: { write: (chunk: string) => (fake.lines.push(chunk), true) } as never });
  fake.context = { paths, output, control: control as never, compose, confirm: async () => fake.confirmAnswer, promptSecret: async () => "pasted-secret-value", sleepMs: async () => undefined, platform, roots: [current.root] };
  return fake;
}

async function nextRelease(current: ReturnType<typeof buildReleaseFixture>, overrides: Partial<Omit<ReturnType<typeof buildUnsignedReleaseManifest>, "digest" | "signature">> = {}) {
  const { digest } = await loadComposeTemplate();
  return signReleaseManifest(buildUnsignedReleaseManifest({ bundleVersion: "1.1.0", compose: { templateDigest: digest, configSchemaVersion: 1 }, rollback: { previousBundleVersion: "1.0.0", compatibleDataFrom: "1.0.0" }, ...overrides }), { keyId: current.keyId, privateKey: current.privateKey });
}

async function fixture() {
  const { digest } = await loadComposeTemplate();
  return buildReleaseFixture({ compose: { templateDigest: digest, configSchemaVersion: 1 } });
}

describe("update", () => {
  it("drains to zero, backs up, pulls by digest, stops in declared order, restarts, re-probes agents, commits, and leaves credential volumes untouched", async () => {
    const current = await fixture();
    const fake = await installed(current);
    fake.drainRounds = 2;
    const next = await nextRelease(current);
    const before = await readFile(join(fake.paths.credentials("codex"), "auth.json"), "utf8");
    const result = await update(fake.context, { coreUrl: "https://core.example", relayUrl: null, release: next });
    expect(result).toBe("updated");
    const ops = fake.controlCalls.map((call) => call.op);
    expect(ops[0]).toBe("drain");
    expect(ops.filter((op) => op === "drain.status").length).toBeGreaterThanOrEqual(3);
    const kinds = fake.composeCalls.map((args) => args[0]);
    // Pull happens before stop (healthy stack keeps running while the candidate downloads).
    expect(kinds.indexOf("pull")).toBeLessThan(kinds.indexOf("stop"));
    expect(kinds.indexOf("stop")).toBeLessThan(kinds.indexOf("up"));
    const stop = fake.composeCalls.find((args) => args[0] === "stop");
    expect(stop?.slice(1, 3)).toEqual(["preview-forwarder", "validation-runtime"]);
    expect(stop).toContain("runner-pi-keyed");
    expect(ops).toContain("agents");
    expect(fake.lines.join("")).toContain("reconnect_required");
    expect(await readFile(join(fake.paths.credentials("codex"), "auth.json"), "utf8")).toBe(before);
    // Committed: the release manifest on disk is now the new one and .env names the new version.
    expect(JSON.parse(await readFile(fake.paths.releaseManifest, "utf8")).bundleVersion).toBe("1.1.0");
    expect(await readFile(fake.paths.envFile, "utf8")).toContain("KONTEKS_BUNDLE_VERSION=1.1.0");
    // A dated backup exists and excludes the key and lease.
    const backups = await readdir(fake.paths.backups);
    expect(backups).toHaveLength(1);
    const files = await readdir(join(fake.paths.backups, backups[0]!, "supervisor"));
    expect(files).toContain("identity.json");
    expect(files).not.toContain("instance-key.jwk");
    expect(files).not.toContain("lease.json");
  });

  it("rolls back and stays drained when the health gate fails, without touching credential volumes", async () => {
    const current = await fixture();
    const fake = await installed(current);
    fake.doctorFails = true;
    const next = await nextRelease(current);
    await expect(update(fake.context, { coreUrl: "https://core.example", relayUrl: null, release: next })).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(JSON.parse(await readFile(fake.paths.releaseManifest, "utf8")).bundleVersion).toBe("1.0.0");
    expect(await readFile(fake.paths.envFile, "utf8")).toContain("KONTEKS_BUNDLE_VERSION=1.0.0");
    const kinds = fake.composeCalls.map((args) => args[0]);
    expect(kinds.filter((kind) => kind === "up")).toHaveLength(2);
    // No resume/undrain op was sent: the runtime stays drained after rollback.
    expect(fake.controlCalls.map((call) => call.op)).not.toContain("resume");
    expect(await readFile(join(fake.paths.credentials("codex"), "auth.json"), "utf8")).toContain("do-not-touch");
  });

  it("is a no-op on the current version and refuses an incompatible data window or a declined forward-only migration", async () => {
    const current = await fixture();
    const fake = await installed(current);
    expect(await update(fake.context, { coreUrl: "https://core.example", relayUrl: null, release: current.manifest })).toBe("current");
    expect(fake.composeCalls).toHaveLength(0);
    const incompatible = await nextRelease(current, { rollback: { compatibleDataFrom: "1.1.0" } });
    await expect(update(fake.context, { coreUrl: "https://core.example", relayUrl: null, release: incompatible })).rejects.toMatchObject({ code: "update_required" });
    const forwardOnly = await nextRelease(current, { migrations: [{ component: "harness", order: 0, backwardCompatible: false, forwardRecoveryRef: "docs/forward-1.1.0" }] });
    fake.confirmAnswer = false;
    await expect(update(fake.context, { coreUrl: "https://core.example", relayUrl: null, release: forwardOnly })).rejects.toMatchObject({ code: "update_required" });
    expect(fake.lines.join("")).toContain("NOT available");
    expect(fake.composeCalls).toHaveLength(0);
  });

  it("refuses a candidate whose signature is not from the embedded root", async () => {
    const current = await fixture();
    const fake = await installed(current);
    const rogue = buildReleaseFixture({ bundleVersion: "1.1.0" });
    fake.context.roots = [current.root];
    await expect(update(fake.context, { coreUrl: "https://core.example", relayUrl: null, fetchFn: async () => new Response(JSON.stringify(rogue.manifest), { status: 200 }) })).rejects.toMatchObject({ code: "bundle_untrusted" });
  });
});

describe("backup and uninstall", () => {
  it("backup excludes the instance key, lease, provisioning material, and credential volumes unless asked", async () => {
    const current = await fixture();
    const fake = await installed(current);
    const target = await backup(fake.context, { includeCredentials: false });
    expect(await readdir(target)).not.toContain("credentials");
    const withCreds = await backup(fake.context, { includeCredentials: true, includeInstanceKey: true });
    expect(await readdir(withCreds)).toContain("credentials");
    expect(await readdir(join(withCreds, "supervisor"))).toContain("instance-key.jwk");
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it("uninstall drains, records revocation, stops, preserves data; --purge shows exact paths and needs an explicit yes", async () => {
    const current = await fixture();
    const fake = await installed(current);
    await uninstall(fake.context, { purge: false });
    expect(fake.controlCalls.map((call) => call.op)).toEqual(expect.arrayContaining(["drain", "revoke.pending"]));
    expect(fake.composeCalls.at(-1)).toEqual(["down", "--remove-orphans"]);
    await expect(stat(fake.paths.credentials("codex"))).resolves.toBeTruthy();

    fake.confirmAnswer = false;
    await uninstall(fake.context, { purge: true });
    expect(fake.lines.join("")).toContain(fake.paths.credentials("codex"));
    await expect(stat(fake.paths.credentials("codex"))).resolves.toBeTruthy();

    fake.confirmAnswer = true;
    await uninstall(fake.context, { purge: true });
    expect(fake.composeCalls.at(-1)).toEqual(["down", "--volumes", "--remove-orphans"]);
    await expect(stat(fake.paths.credentials("codex"))).rejects.toThrow();
    await expect(stat(fake.paths.supervisorData)).rejects.toThrow();
    await expect(stat(fake.paths.installState)).rejects.toThrow();
  });
});

describe("agent login, gateway key, logs", () => {
  it("relays the official tooling's URL/code, answers a secret prompt without echo, and records the organization attestation only after consent", async () => {
    const current = await fixture();
    const fake = await installed(current);
    await authLogin(fake.context, "codex", true);
    const text = fake.lines.join("");
    expect(text).toContain("https://login.example/device");
    expect(text).toContain("ABCD-1234");
    expect(text).not.toContain("pasted-secret-value");
    expect(fake.controlCalls.find((call) => call.op === "auth.login")).toMatchObject({ agentId: "codex", organization: true });
    expect(fake.controlCalls.find((call) => call.op === "auth.input")).toMatchObject({ loginId: "l1", text: "pasted-secret-value" });
    fake.confirmAnswer = false;
    await expect(authLogin(fake.context, "codex", true)).rejects.toMatchObject({ code: "ownership_promotion_denied" });
  });

  it("sends a gateway key over the loopback socket only and never prints it", async () => {
    const current = await fixture();
    const fake = await installed(current);
    await gatewayKeySet(fake.context, "pi");
    expect(fake.controlCalls.find((call) => call.op === "gateway.key.set")).toMatchObject({ agentId: "pi", key: "pasted-secret-value" });
    expect(fake.lines.join("")).not.toContain("pasted-secret-value");
    expect(fake.lines.join("")).toContain("memory only");
  });

  it("logs only the appliance services with a validated --since", async () => {
    const current = await fixture();
    const fake = await installed(current);
    await logs(fake.context, "15m");
    const call = fake.composeCalls.find((args) => args[0] === "logs");
    expect(call).toContain("supervisor");
    expect(call).not.toContain("runner-codex");
    await expect(logs(fake.context, "15m; rm -rf /")).rejects.toBeTruthy();
  });
});
