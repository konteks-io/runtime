import { describe, expect, it, vi } from "vitest";
import { IntegrationSetupResultSchema, officialConnectionSetup, setupCommandDigest, type IntegrationSetupTaskSpec } from "@konteks/backstage-plugin-common";
import { OfficialSetupRunner, spawnSetupCommand, type SetupCommandRunner } from "../integration/setup.js";

const ATLASSIAN = "https://mcp.atlassian.com/v2/mcp?tools=all";
const codexJira = officialConnectionSetup("codex", "jira")!;
const spec = (overrides: Partial<IntegrationSetupTaskSpec> = {}): IntegrationSetupTaskSpec => ({
  schemaVersion: 1, taskId: "xi-setup-1", kind: "setup", setupId: "setup-1", agentId: "codex", provider: "jira", change: "add",
  serverName: "atlassian", officialEndpoint: ATLASSIAN, commandDigest: setupCommandDigest(codexJira), ...overrides,
});
const launch = { command: "/opt/konteks/agents/codex/bin/node", args: ["/opt/konteks/agents/codex/node_modules/@openai/codex/bin/codex.js"], env: { CODEX_HOME: "/Users/p/.codex" } };

function runner(exits: Array<number | null>) {
  const calls: string[][] = [];
  const run: SetupCommandRunner = vi.fn(async (_command, args) => { calls.push(args.slice(1)); return { exitCode: exits.shift() ?? 1 }; });
  return { calls, setup: new OfficialSetupRunner({ codex: () => launch, run, timeoutMs: 1_000 }) };
}

describe("confirmed official setup (P08, D29)", () => {
  it("adds the pinned Atlassian server to Codex with the reviewed command, after checking it is not there", async () => {
    const { calls, setup } = runner([1, 0, 0]);
    const result = await setup.run(spec(), () => undefined);
    expect(result).toEqual({ schemaVersion: 1, taskId: "xi-setup-1", kind: "setup", setupId: "setup-1", outcome: "added" });
    expect(calls).toEqual([["mcp", "get", "atlassian"], ["mcp", "add", "atlassian", "--url", ATLASSIAN], ["mcp", "get", "atlassian"]]);
    IntegrationSetupResultSchema.parse(result);
  });

  it("never overwrites a connection the person already has under that name", async () => {
    const { calls, setup } = runner([0]);
    expect((await setup.run(spec(), () => undefined)).outcome).toBe("already_present");
    expect(calls).toEqual([["mcp", "get", "atlassian"]]);
  });

  it("reports a failed add with a stable error and no command output", async () => {
    const { setup } = runner([1, 2, 1]);
    const result = await setup.run(spec(), () => undefined);
    expect(result).toMatchObject({ outcome: "failed", error: { code: "capability_unknown" } });
    expect(Object.keys(result).sort()).toEqual(["error", "kind", "outcome", "schemaVersion", "setupId", "taskId"]);
  });

  it("refuses anything that is not exactly the reviewed catalogue entry, and runs nothing", async () => {
    for (const bad of [
      spec({ commandDigest: "a".repeat(64) }),
      spec({ officialEndpoint: "https://evil.example/mcp" }),
      spec({ serverName: "jira" }),
      spec({ provider: "slack" }),
      spec({ agentId: "opencode" }),
    ]) {
      const { calls, setup } = runner([0, 0, 0]);
      expect(await setup.run(bad, () => undefined)).toMatchObject({ outcome: "failed", error: { code: "operation_unsupported" } });
      expect(calls).toEqual([]);
    }
  });

  it("hands Claude account connectors to the official page instead of running anything", async () => {
    const claude = officialConnectionSetup("claude-code", "jira")!;
    const { calls, setup } = runner([]);
    const result = await setup.run(spec({ agentId: "claude-code", serverName: "claude_ai_Atlassian", officialEndpoint: "https://claude.ai/settings/connectors", commandDigest: setupCommandDigest(claude) }), () => undefined);
    expect(result).toEqual({ schemaVersion: 1, taskId: "xi-setup-1", kind: "setup", setupId: "setup-1", outcome: "handoff", handoffUrl: "https://claude.ai/settings/connectors" });
    expect(calls).toEqual([]);
  });

  it("signs in with the reviewed login only when the connection exists", async () => {
    const signIn = spec({ change: "sign_in", commandDigest: setupCommandDigest(codexJira, "sign_in") });
    let { calls, setup } = runner([0, 0]);
    expect(await setup.run(signIn, () => undefined)).toMatchObject({ outcome: "signed_in" });
    expect(calls).toEqual([["mcp", "get", "atlassian"], ["mcp", "login", "atlassian"]]);
    ({ calls, setup } = runner([1]));
    expect(await setup.run(signIn, () => undefined)).toMatchObject({ outcome: "absent" });
    expect(calls).toEqual([["mcp", "get", "atlassian"]]);
    ({ calls, setup } = runner([0, 1]));
    expect(await setup.run(signIn, () => undefined)).toMatchObject({ outcome: "failed", error: { code: "needs_auth" } });
    // The add digest is not a sign-in digest.
    ({ calls, setup } = runner([0, 0]));
    expect(await setup.run({ ...signIn, commandDigest: setupCommandDigest(codexJira) }, () => undefined)).toMatchObject({ outcome: "failed", error: { code: "operation_unsupported" } });
    expect(calls).toEqual([]);
  });

  it("removes with the reviewed command and checks it is gone; nothing there is absent", async () => {
    const remove = spec({ change: "remove", commandDigest: setupCommandDigest(codexJira, "remove"), addedByKonteks: true });
    let { calls, setup } = runner([0, 0, 1]);
    expect(await setup.run(remove, () => undefined)).toMatchObject({ outcome: "removed" });
    expect(calls).toEqual([["mcp", "get", "atlassian"], ["mcp", "remove", "atlassian"], ["mcp", "get", "atlassian"]]);
    ({ calls, setup } = runner([1]));
    expect(await setup.run(remove, () => undefined)).toMatchObject({ outcome: "absent" });
    ({ calls, setup } = runner([0, 1, 0]));
    expect(await setup.run(remove, () => undefined)).toMatchObject({ outcome: "failed", error: { code: "capability_unknown", params: { reason: "remove_failed" } } });
  });

  it("answers runtime_offline when this computer has no Codex to run it with", async () => {
    const setup = new OfficialSetupRunner({ codex: () => null, run: vi.fn(), timeoutMs: 1_000 });
    expect(await setup.run(spec(), () => undefined)).toMatchObject({ outcome: "failed", error: { code: "runtime_offline" } });
  });
});

describe("setup command runner", () => {
  it("returns the exit code only: output is never read, input is closed", async () => {
    const result = await spawnSetupCommand(process.execPath, ["-e", "process.stdout.write('token=sk-canary'); process.stderr.write('secret'); process.exit(3)"], { PATH: process.env.PATH ?? "" }, 5_000);
    expect(result).toEqual({ exitCode: 3 });
  });

  it("stops a command that outlives its bound", async () => {
    expect(await spawnSetupCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { PATH: process.env.PATH ?? "" }, 300)).toEqual({ exitCode: null });
  });
});
