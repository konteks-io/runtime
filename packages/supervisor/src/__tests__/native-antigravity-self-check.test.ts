import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { RemoteInstanceError } from "@konteks/remote-common";
import { fetchedAgentPlatformPin } from "@konteks/remote-release";
import { RunnerConfigSchema, antigravityRuntimePaths, type BridgeProcess, type SpawnBridgeOptions } from "@konteks/remote-agent-runner";
import { ANTIGRAVITY_AUTH_METHODS, antigravityInitializeDrift, checkAntigravityServer } from "../native/antigravity-self-check.js";

/**
 * The Google Antigravity start check (CP2): one `initialize` of the fetched
 * server in the connector's private home proves it answers as the server
 * Konteks governs. The fixture is antigravity-acp 1.2.1's own answer
 * (agy-runtime-feasibility proof/transcripts/acp-init.jsonl; the same shape
 * came back live in CP2).
 */
const pin = fetchedAgentPlatformPin("antigravity");
const INITIALIZE = JSON.parse(await readFile(new URL("./fixtures/antigravity-1.2.1-initialize.json", import.meta.url), "utf8")) as InitializeResponse;

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(answer: (options: SpawnBridgeOptions) => Promise<InitializeResponse> = async () => structuredClone(INITIALIZE)) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agy-self-check-"))); roots.push(root);
  const folder = join(root, "agents", "antigravity", "1.2.1-darwin-arm64");
  await mkdir(folder, { recursive: true });
  for (const file of pin!.files) await writeFile(join(folder, file.path), file.path);
  const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: join(root, "credentials", "antigravity"), RUNNER_WORKSPACE_DIR: join(root, "workspace"),
    RUNNER_BRIDGE_PREFIX: folder, RUNNER_BRIDGE_VERSION: "1.2.1", RUNNER_NATIVE_ANTIGRAVITY_ROOT: folder });
  const stops: string[] = [];
  const spawn = vi.fn(async (options: SpawnBridgeOptions): Promise<BridgeProcess> => {
    const initializeResult = await answer(options);
    return { connection: {} as never, initializeResult, exited: false, stderrTail: () => [], stop: vi.fn(async () => { stops.push("server"); }) };
  });
  const sweep = vi.fn(async () => { stops.push("sweep"); return 0; });
  const cache = new Map<string, true>();
  const check = () => checkAntigravityServer({ config, spawn, sweep, cache });
  return { root, folder, config, spawn, sweep, stops, cache, check, paths: antigravityRuntimePaths(config.RUNNER_CREDENTIAL_DIR) };
}

describe.runIf(pin !== undefined)("the Google Antigravity start check", () => {
  it("passes on antigravity-acp 1.2.1's own answer, in the private home, with none of the owner's secrets, and stops everything after", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_owner_must_not_reach");
    vi.stubEnv("GEMINI_API_KEY", "gemini-owner");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "owner-project");
    const f = await fixture();
    await mkdir(join(f.paths.geminiHome, "antigravity-acp"), { recursive: true });
    await writeFile(f.paths.trustFile, "{\"trusted\":[\"/\"]}");
    await f.check();
    const spec = f.spawn.mock.calls[0]![0].spec;
    expect(spec.command).toBe(join(f.folder, "agy_acp_server.par"));
    expect(spec.cwd).toBe(f.paths.home);
    expect(spec.env).toMatchObject({ HOME: f.paths.home, GEMINI_HOME: f.paths.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: "1" });
    for (const name of ["GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"]) expect(spec.env[name], name).toBeUndefined();
    // Prepared like every spawn: nothing trusted, settings written.
    await expect(stat(f.paths.trustFile)).rejects.toThrow();
    expect(await readFile(f.paths.settingsFile, "utf8")).toBe("{}\n");
    expect(f.stops).toEqual(["sweep", "server", "sweep"]);
  });

  it("is remembered per file identity: a changed file runs it again, a failure is never remembered", async () => {
    const f = await fixture();
    await f.check();
    await f.check();
    expect(f.spawn).toHaveBeenCalledOnce();
    const harness = join(f.folder, "localharness_external");
    const before = await stat(harness);
    await utimes(harness, before.atime, new Date(before.mtime.getTime() + 5_000));
    await f.check();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    let version = "1.2.2";
    const drifting = await fixture(async () => ({ ...structuredClone(INITIALIZE), agentInfo: { ...INITIALIZE.agentInfo!, version } }));
    await expect(drifting.check()).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_unsupported_version" });
    version = "1.2.1";
    await drifting.check();
    expect(drifting.spawn).toHaveBeenCalledTimes(2);
  });

  it("reads drift as an unsupported version the person fixes by updating the connector", async () => {
    const f = await fixture(async () => ({ ...structuredClone(INITIALIZE), authMethods: INITIALIZE.authMethods!.filter(method => method.id !== "oauth-business") }));
    await expect(f.check()).rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "antigravity_unsupported_version", recoveryActions: [{ kind: "update" }],
      message: "Unsupported Google Antigravity version: 1.2.1 does not answer as Konteks expects (the oauth-business sign-in is missing). Update the connector." });
  });

  it("names each thing that drifted", () => {
    expect(antigravityInitializeDrift(INITIALIZE, "1.2.1")).toEqual([]);
    expect(ANTIGRAVITY_AUTH_METHODS).toEqual(["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]);
    const caps = INITIALIZE.agentCapabilities!;
    const cases: Array<[Partial<InitializeResponse>, RegExp]> = [
      [{ agentInfo: { name: "gemini-cli", version: "1.2.1" } }, /not Google's antigravity-acp/],
      [{ agentInfo: { name: "antigravity-acp", version: "1.2.0" } }, /reports version 1\.2\.0, not the pinned 1\.2\.1/],
      [{ authMethods: [...INITIALIZE.authMethods!, { id: "gateway", name: "Gateway" }] }, /gateway sign-in/],
      [{ authMethods: INITIALIZE.authMethods!.filter(method => method.id !== "gemini-api-key") }, /gemini-api-key sign-in is missing/],
      [{ agentCapabilities: { ...caps, mcpCapabilities: { http: false, sse: true } } }, /MCP servers over http/],
      [{ agentCapabilities: { ...caps, loadSession: false } }, /cannot load a session/],
      [{ agentCapabilities: { ...caps, sessionCapabilities: { list: {} } } }, /cannot resume/],
      [{ agentCapabilities: { ...caps, promptCapabilities: { image: true, audio: true, embeddedContext: false } } }, /embedded context/],
    ];
    for (const [change, drift] of cases) expect(antigravityInitializeDrift({ ...structuredClone(INITIALIZE), ...change } as InitializeResponse, "1.2.1").join("; "), String(drift)).toMatch(drift);
    // A pinned version outside the family's range never passes either.
    expect(antigravityInitializeDrift({ ...INITIALIZE, agentInfo: { name: "antigravity-acp", version: "1.3.0" } }, "1.3.0")).toEqual(["version 1.3.0 is outside the supported range"]);
  });

  it("a server that cannot start is a retryable failure, still followed by the sweep", async () => {
    const f = await fixture(async () => { throw new RemoteInstanceError("agent_unavailable", "bridge did not answer initialize within 60000ms"); });
    await expect(f.check()).rejects.toMatchObject({ code: "agent_unavailable", diagnostic: "antigravity_self_check_failed", retryable: true,
      message: "Google Antigravity could not start on this computer. Try again in a moment." });
    expect(f.stops).toEqual(["sweep", "sweep"]);
    const other = await fixture(async () => { throw new RemoteInstanceError("protocol_incompatible", "bridge speaks ACP protocol 2"); });
    await expect(other.check()).rejects.toMatchObject({ diagnostic: "antigravity_unsupported_version", message: expect.stringContaining("another ACP protocol version") });
  });

  it("refuses without the fetched folder", async () => {
    await expect(checkAntigravityServer({ config: RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "antigravity" }) })).rejects.toMatchObject({ diagnostic: "antigravity_not_fetched" });
  });
});
