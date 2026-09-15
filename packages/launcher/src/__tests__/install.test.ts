import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteInstanceError, type SupervisorStatus } from "@konteks/remote-common";
import { buildReleaseFixture, deriveExchangeManifest } from "@konteks/remote-release";
import { SupervisorStore } from "@konteks/remote-supervisor";
import { loadComposeTemplate, type ComposeRunner } from "../compose.js";
import { install, selectAgents } from "../commands/install.js";
import { InstallStateFile } from "../install-state.js";
import { createOutput } from "../output.js";
import { installPaths, type HostPlatform } from "../paths.js";


let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-install-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ACTIVATION_CODE = "kxac-super-secret-activation-code";
const platform: HostPlatform = { os: "macos", architecture: "arm64", containerBackend: "docker_compose" };

/** Files and directory walk under the install root, for "the code never lands on disk" assertions. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

function activeStatus(instanceId: string, administrativeStatus: SupervisorStatus["administrativeStatus"]): SupervisorStatus {
  return {
    instanceId,
    workspaceId: "ws-1",
    administrativeStatus,
    connectivity: { transport: "relay", relayConnected: true, lastConnectedAt: null, reconciliationComplete: true },
    lease: { mode: administrativeStatus === "active" ? "active" : "none", expiresAt: null, drainDeadline: null },
    version: { bundle: "1.0.0", protocol: "1", manifestDigest: null, updateAvailable: false, targetBundle: null },
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
}

interface Harness {
  fetchCalls: Array<{ path: string; body: Record<string, unknown> | null }>;
  composeCalls: string[][];
  compose: ComposeRunner;
  fetchFn: typeof fetch;
  fixture: ReturnType<typeof buildReleaseFixture>;
  failPullOn?: string;
  readinessAfterCalls: number;
  controlCalls: string[];
  control: { call: <T>(request: { op: string }, schema: { parse: (value: unknown) => T }) => Promise<T> };
}

async function harness(options: { tamperExchange?: boolean; failPullOn?: string; readinessAfterCalls?: number } = {}): Promise<Harness> {
  const { digest } = await loadComposeTemplate();
  const fixture = buildReleaseFixture({ compose: { templateDigest: digest, configSchemaVersion: 1 } });
  const exchange = deriveExchangeManifest(fixture.manifest, { keyId: fixture.keyId, privateKey: fixture.privateKey }, "2027-01-01T00:00:00Z");
  if (options.tamperExchange) exchange.images[0] = { ...exchange.images[0]!, digest: `sha256:${"f".repeat(64)}` };
  const h: Harness = {
    fetchCalls: [],
    composeCalls: [],
    fixture,
    readinessAfterCalls: options.readinessAfterCalls ?? 1,
    controlCalls: [],
    ...(options.failPullOn ? { failPullOn: options.failPullOn } : {}),
    compose: {
      run: async (args) => {
        h.composeCalls.push(args);
        if (args[0] === "pull" && h.failPullOn && args.includes(h.failPullOn)) return { code: 1, stdout: "", stderr: "network", signal: null, timedOut: false } as never;
        return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false } as never;
      },
    },
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      h.fetchCalls.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/activation-exchange")) {
        if (body?.activationCode !== ACTIVATION_CODE) return new Response(JSON.stringify({ code: "activation_invalid", message: "bad code" }), { status: 401 });
        return new Response(
          JSON.stringify({
            instanceId: "inst-42",
            workspaceId: "ws-42",
            administrativeStatus: "provisioning",
            provisioningCredential: "kxrp_test_credential",
            provisioningCredentialExpiresAt: "2026-09-07T00:00:00Z",
            provisioningWindowExpiresAt: "2026-09-13T00:00:00Z",
            bundleManifest: exchange,
          }),
          { status: 200, headers: { "content-type": "application/json", date: new Date().toUTCString() } },
        );
      }
      return new Response(JSON.stringify({ code: "not_found", message: "" }), { status: 404 });
    },
    control: {
      call: async (request, schema) => {
        h.controlCalls.push(request.op);
        const ready = h.controlCalls.length >= h.readinessAfterCalls;
        return schema.parse(activeStatus("inst-42", ready ? "active" : "provisioning"));
      },
    },
  };
  return h;
}

function run(h: Harness, extra: Partial<Parameters<typeof install>[0]> = {}, deps: Partial<NonNullable<Parameters<typeof install>[0]["deps"]>> = {}) {
  const lines: string[] = [];
  const output = createOutput({ json: false, stdout: { write: (chunk: string) => (lines.push(chunk), true) } as never, stderr: { write: () => true } as never });
  return {
    lines,
    promise: install({
      activationId: "act-0001",
      coreUrl: "https://core.example",
      relayUrl: null,
      root: join(dir, "root"),
      agents: ["codex", "pi"],
      gatewayKeyedAgents: ["pi"],
      output,
      ...extra,
      deps: {
        platform,
        release: h.fixture.manifest,
        roots: [h.fixture.root],
        compose: h.compose,
        control: h.control as never,
        fetchFn: h.fetchFn,
        readActivationCode: async () => ACTIVATION_CODE,
        preflight: {
          run: async (spec) => ({ code: 0, stdout: spec.args.includes("info") ? "Docker Desktop" : "27.1.1 2.29.0", stderr: "", signal: null, timedOut: false }) as never,
          fetchFn: async () => new Response("ok", { status: 200, headers: { date: new Date().toUTCString() } }),
          statfs: async () => ({ bavail: 64, bsize: 1024 ** 3 }),
        },
        sleepMs: async () => undefined,
        ...deps,
      },
    }),
  };
}

describe("install", () => {
  it("exchanges the activation before any pull, verifies the bundle, pulls by digest, starts, and reaches ready without persisting the code", async () => {
    const h = await harness();
    const { promise, lines } = run(h);
    const state = await promise;
    expect(state.phase).toBe("ready");
    expect(state.instanceId).toBe("inst-42");
    expect(state.agents).toEqual([
      { agentId: "codex", authMode: "agent_local_subscription" },
      { agentId: "pi", authMode: "gateway_keyed" },
    ]);
    // Exchange happened, and before the first pull.
    expect(h.fetchCalls[0]?.path).toBe("/api/remote-instances/internal/remote-instances/activation-exchange");
    expect(h.fetchCalls[0]?.body?.proof).toMatchObject({ algorithm: "ES256" });
    expect(h.composeCalls.findIndex((args) => args[0] === "pull")).toBeGreaterThanOrEqual(0);
    // Pulls target services, never a tag; keyed pi uses the keyed service.
    const pulled = h.composeCalls.filter((args) => args[0] === "pull").map((args) => args.at(-1));
    expect(pulled).toContain("runner-pi-keyed");
    expect(pulled).toContain("runner-codex");
    expect(pulled).not.toContain("runner-pi");
    // Up waits for health; readiness was submitted via the control socket.
    expect(h.composeCalls.some((args) => args[0] === "up" && args.includes("--wait"))).toBe(true);
    expect(h.controlCalls[0]).toBe("readiness.submit");
    // The supervisor store holds the identity + provisioning record, and no file anywhere holds the code.
    const paths = installPaths(join(dir, "root"));
    const store = new SupervisorStore(paths.supervisorData);
    await store.init();
    expect((await store.identity())?.instanceId).toBe("inst-42");
    expect((await store.provisioning())?.provisioningCredential).toBe("kxrp_test_credential");
    for (const file of await walk(paths.root)) {
      const text = await readFile(file, "utf8").catch(() => "");
      expect(text, file).not.toContain(ACTIVATION_CODE);
    }
    expect(lines.join("")).not.toContain(ACTIVATION_CODE);
    expect(await readFile(`${paths.gatewayConfig}/instance-id`, "utf8")).toBe("inst-42\n");
    if (process.platform !== "win32") expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
  });

  it("fails closed with bundle_untrusted when the exchange manifest disagrees with the release manifest, before any pull", async () => {
    const h = await harness({ tamperExchange: true });
    await expect(run(h).promise).rejects.toMatchObject({ code: "bundle_untrusted" });
    expect(h.composeCalls).toHaveLength(0);
    const state = await new InstallStateFile(installPaths(join(dir, "root")).installState).read();
    expect(state?.phase).toBe("failed");
    expect(state?.instanceId).toBeNull();
  });

  it("resumes an interrupted pull without a second exchange or duplicate identity", async () => {
    const h = await harness({ failPullOn: "browser-tool" });
    await expect(run(h).promise).rejects.toMatchObject({ code: "temporarily_unavailable" });
    const paths = installPaths(join(dir, "root"));
    const failed = await new InstallStateFile(paths.installState).read();
    expect(failed?.phase).toBe("failed");
    expect(failed?.instanceId).toBe("inst-42");
    expect(failed?.pulledImages.length).toBeGreaterThan(0);
    const exchanges = () => h.fetchCalls.filter((call) => call.path.endsWith("/activation-exchange")).length;
    expect(exchanges()).toBe(1);
    const store = new SupervisorStore(paths.supervisorData);
    await store.init();
    const keyBefore = JSON.stringify((await store.loadOrCreateInstanceKey()).publicKeyJwk);

    delete h.failPullOn;
    const state = await run(h).promise;
    expect(state.phase).toBe("ready");
    expect(exchanges()).toBe(1);
    const pulledAgain = h.composeCalls.filter((args) => args[0] === "pull").map((args) => args.at(-1));
    expect(pulledAgain.filter((service) => service === "harness-postgres")).toHaveLength(1);
    expect(JSON.stringify((await store.loadOrCreateInstanceKey()).publicKeyJwk)).toBe(keyBefore);
  });

  it("keeps the install non-routable until the supervisor reports active and rejects a different activation on the same root", async () => {
    const h = await harness({ readinessAfterCalls: 3 });
    const state = await run(h).promise;
    expect(state.phase).toBe("ready");
    expect(h.controlCalls).toEqual(["readiness.submit", "status", "status"]);
    await expect(run(h, { activationId: "act-other-1" }).promise).rejects.toMatchObject({ code: "registration_mismatch" });
  });

  it("refuses an invalid activation code without touching the bundle", async () => {
    const h = await harness();
    await expect(run(h, {}, { readActivationCode: async () => "wrong-code-value" }).promise).rejects.toBeInstanceOf(RemoteInstanceError);
    expect(h.composeCalls).toHaveLength(0);
  });

  it("validates the gateway-keyed agent set", () => {
    expect(() => selectAgents(["codex"], ["pi"])).toThrow(/gateway-keyed/);
    expect(selectAgents(undefined, undefined).map((agent) => agent.agentId)).toEqual(["claude-code", "codex", "opencode", "pi"]);
  });
});
