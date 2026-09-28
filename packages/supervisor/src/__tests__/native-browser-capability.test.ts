import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_MCP_PACKAGE, NativeAgentPackageProfileSchema } from "@konteks/remote-release";
import { RunnerConfigSchema, browserMcpServer, type RunnerConfig } from "@konteks/remote-agent-runner";
import { offlineFixture } from "../../../release/src/__tests__/offline-agent-fixture.js";
import { BROWSER_NO_NODE_MESSAGE, BROWSER_NO_PACKAGE_MESSAGE, browserNodeSupported, resolveConnectorBrowser, withConnectorBrowser } from "../native/browser-capability.js";
import { assertDoctorHasNoSecrets, runDoctor } from "../support/doctor.js";

const digest = `sha256:${"a".repeat(64)}`;
function profileWithBrowser(agentId: "claude-code" | "codex") {
  const profile = offlineFixture("macos", "arm64", agentId).profile;
  const files = [...profile.files,
    { path: "konteks/browser-mcp.js", digest, sizeBytes: 1, executable: false },
    { path: "node_modules/@playwright/mcp/cli.js", digest, sizeBytes: 1, executable: false },
  ].sort((a, b) => a.path < b.path ? -1 : 1);
  return NativeAgentPackageProfileSchema.parse({ ...profile, files,
    browser: { package: BROWSER_MCP_PACKAGE.package, version: BROWSER_MCP_PACKAGE.version, entrypoint: "node_modules/@playwright/mcp/cli.js", launcher: "konteks/browser-mcp.js", runtime: "node" } });
}

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "konteks-browser-capability-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function executable(path: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
  return path;
}
function bundled(agentId: "claude-code" | "codex", prefix: string): RunnerConfig {
  return { ...RunnerConfigSchema.parse({ RUNNER_AGENT_ID: agentId, RUNNER_BRIDGE_PREFIX: prefix }), RUNNER_NATIVE_PACKAGE_PROFILE: profileWithBrowser(agentId) };
}
const host = (agentId: "dsh" | "opencode", extra: Record<string, unknown> = {}) => RunnerConfigSchema.parse({ RUNNER_AGENT_ID: agentId, ...extra });
const request = { proxyUrl: "http://127.0.0.1:50123", outputDir: "/tmp/konteks-browser-x", browsersPath: "/state/browsers" };

describe("the QA browser as a connector capability (O8)", () => {
  it("runs from an installed Claude Code package first, on that package's own Node", async () => {
    const claude = join(root, "claude-code"), codex = join(root, "codex");
    const node = await executable(join(claude, "bin", "node"));
    await executable(join(codex, "bin", "node"));
    const status = await resolveConnectorBrowser([host("opencode"), bundled("codex", codex), bundled("claude-code", claude)], { version: async () => { throw new Error("the person's Node is never asked"); } });
    expect(status).toEqual({ available: true, browser: { version: "0.0.82", packageAgent: "claude-code", nodeSource: "agent_package", node,
      launcher: join(claude, "konteks", "browser-mcp.js"), entrypoint: join(claude, "node_modules", "@playwright", "mcp", "cli.js") } });
    // Codex alone is enough.
    const codexOnly = await resolveConnectorBrowser([bundled("codex", codex), host("dsh")]);
    expect(codexOnly).toMatchObject({ available: true, browser: { packageAgent: "codex", node: join(codex, "bin", "node") } });
  });

  it("falls back to the other package's Node, then the person's own (dsh's Node first, then PATH), version-checked", async () => {
    const claude = join(root, "claude-code"), codex = join(root, "codex");
    // Claude Code's bundled Node is missing: Codex's runs Claude Code's copy.
    const codexNode = await executable(join(codex, "bin", "node"));
    const second = await resolveConnectorBrowser([bundled("claude-code", claude), bundled("codex", codex)]);
    expect(second).toMatchObject({ available: true, browser: { packageAgent: "claude-code", nodeSource: "agent_package", node: codexNode, launcher: join(claude, "konteks", "browser-mcp.js") } });

    // No bundled Node anywhere: the person's Node. The one dsh runs on comes first.
    const dshNode = await executable(join(root, "nvm", "v22", "bin", "node"));
    const pathOld = await executable(join(root, "old", "node"));
    const pathNew = await executable(join(root, "new", "node"));
    const versions: Record<string, string> = { [dshNode]: "v22.23.2", [pathOld]: "v18.20.4", [pathNew]: "v24.1.0" };
    const asked: string[] = [];
    const version = async (candidate: string) => { asked.push(candidate); return versions[candidate] ?? null; };
    const env = { PATH: [join(root, "old"), join(root, "new")].join(":") };
    const viaDsh = await resolveConnectorBrowser([bundled("claude-code", claude), host("dsh", { RUNNER_NATIVE_DSH_NODE: dshNode })], { env, platform: "darwin", version });
    expect(viaDsh).toMatchObject({ available: true, browser: { packageAgent: "claude-code", nodeSource: "person", node: dshNode } });
    expect(asked).toEqual([dshNode]);
    // Without dsh: PATH in order, a Node below 20 skipped.
    asked.length = 0;
    const viaPath = await resolveConnectorBrowser([bundled("claude-code", claude), host("opencode")], { env, platform: "darwin", version });
    expect(viaPath).toMatchObject({ available: true, browser: { nodeSource: "person", node: pathNew } });
    expect(asked.slice(0, 2)).toEqual([pathOld, pathNew]);
    expect([browserNodeSupported("v20.0.0"), browserNodeSupported("v19.9.0"), browserNodeSupported("junk")]).toEqual([true, false, false]);
  });

  it("has no browser without a package that carries it, or without any usable Node, and says so plainly", async () => {
    const none = await resolveConnectorBrowser([host("dsh"), host("opencode")], { version: async () => { throw new Error("nothing to run: no Node is looked for"); } });
    expect(none).toEqual({ available: false, reason: "no_package", message: BROWSER_NO_PACKAGE_MESSAGE });
    const noNode = await resolveConnectorBrowser([bundled("claude-code", join(root, "claude-code")), host("opencode")], { env: { PATH: "" }, platform: "darwin", version: async () => "v18.0.0",
      executable: async () => false });
    expect(noNode).toEqual({ available: false, reason: "no_node", message: BROWSER_NO_NODE_MESSAGE });
    expect(BROWSER_NO_NODE_MESSAGE).toMatch(/Node 20 or newer/);
    expect(BROWSER_NO_PACKAGE_MESSAGE).toMatch(/Claude Code or Codex/);
    for (const message of [BROWSER_NO_NODE_MESSAGE, BROWSER_NO_PACKAGE_MESSAGE]) expect(message).not.toMatch(/—/);
    // Doctor shows the reason, never a path.
    const base = { now: () => "2026-09-28T00:00:00.000Z", dataDir: root, identity: { instanceId: "i", administrativeStatus: "active" as const }, lease: { mode: "active" as const, expiresAt: null },
      relay: { state: "connected" as const, lastError: null, consecutiveFailures: 0 }, transport: "relay" as const, reconciliationComplete: true, components: [], agents: [], configRevision: 1,
      diskFreeBytes: 1, minimumDiskBytes: 0, outboxDepth: 0, recoveryRequired: 0, coreSignatureConfigured: true };
    const report = await runDoctor({ ...base, browser: { version: null, agents: [], chrome: true, unavailable: BROWSER_NO_NODE_MESSAGE } } as never);
    expect(report.checks.find(check => check.id === "browser")).toMatchObject({ status: "warn", detail: BROWSER_NO_NODE_MESSAGE });
    expect(assertDoctorHasNoSecrets(report)).toBeUndefined();
    const noPackage = await runDoctor({ ...base, browser: { version: null, agents: [], chrome: true, unavailable: BROWSER_NO_PACKAGE_MESSAGE } } as never);
    expect(assertDoctorHasNoSecrets(noPackage)).toBeUndefined();
    const person = await runDoctor({ ...base, browser: { version: "0.0.82", agents: ["claude-code", "codex", "dsh", "opencode"], chrome: false, packageAgent: "claude-code", nodeSource: "person" } } as never);
    expect(person.checks.find(check => check.id === "browser")?.detail).toMatch(/^Playwright MCP 0\.0\.82 for claude-code, codex, dsh, opencode; runs on your own Node; no Google Chrome/);
    const bundledNode = await runDoctor({ ...base, browser: { version: "0.0.82", agents: ["codex", "opencode"], chrome: true, packageAgent: "codex", nodeSource: "agent_package" } } as never);
    expect(bundledNode.checks.find(check => check.id === "browser")?.detail).toContain("runs on the Node in the Codex package");
  });

  it("is handed to every agent without its own, and Claude Code and Codex keep theirs unchanged", async () => {
    const claude = join(root, "claude-code"), codex = join(root, "codex");
    await executable(join(claude, "bin", "node"));
    await executable(join(codex, "bin", "node"));
    const runners = [bundled("claude-code", claude), bundled("codex", codex), host("dsh"), host("opencode")];
    const status = await resolveConnectorBrowser(runners);
    const handed = withConnectorBrowser(runners, status);
    expect(handed.map(runner => runner.RUNNER_BROWSER?.packageAgent ?? null)).toEqual([null, null, "claude-code", "claude-code"]);
    // Each agent's session gets the browser; Codex from its own package, as before.
    const servers = handed.map(runner => browserMcpServer(runner, request, { chrome: () => true }));
    expect(servers.map(server => server?.command)).toEqual([join(claude, "bin", "node"), join(codex, "bin", "node"), join(claude, "bin", "node"), join(claude, "bin", "node")]);
    expect(new Set(servers.map(server => server?.name))).toEqual(new Set(["konteks-browser"]));
    // No connector browser: a stale one is dropped, host agents get none.
    const gone = withConnectorBrowser(handed, { available: false, reason: "no_node", message: BROWSER_NO_NODE_MESSAGE });
    expect(gone.map(runner => browserMcpServer(runner, request) === null)).toEqual([false, false, true, true]);
  });
});
