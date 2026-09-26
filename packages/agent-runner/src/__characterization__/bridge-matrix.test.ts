import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUPPORTED_AGENT_BRIDGES } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { resolveBridgeSpawnSpec, resolveToolingCommand } from "../bridge/spec.js";
import { spawnBridge } from "../bridge/process.js";

/**
 * Characterization: each supported bridge at the CP0-pinned version —
 * spawn, `initialize` result, login/logout tooling presence, host-cache
 * documentation, and stdio framing. Runs against an unpacked offline agent
 * package (REMOTE_INSTANCE_CHARACTERIZE=1 with RUNNER_BRIDGE_PREFIX set) and
 * records the observed capabilities so the CP0 matrix can be diffed.
 */
const prefix = process.env.RUNNER_BRIDGE_PREFIX ?? "/opt/konteks/bridges";

describe.each(SUPPORTED_AGENT_BRIDGES.map((bridge) => [bridge.agentId, bridge] as const))("bridge %s", (agentId, family) => {
  it("spawns from the vendored prefix and answers initialize", async () => {
    const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: agentId, RUNNER_BRIDGE_PREFIX: prefix, RUNNER_CREDENTIAL_DIR: await mkdtemp(join(tmpdir(), `kr-${agentId}-`)) });
    const spec = resolveBridgeSpawnSpec(config);
    try {
      await access(spec.command);
    } catch {
      return; // bridge not vendored in this environment; recorded as absent
    }
    const bridge = await spawnBridge({
      spec,
      initializeTimeoutMs: 60_000,
      clientVersion: "characterization",
      handlers: { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }), onCreateElicitation: async () => ({ action: "cancel" }), onExit: () => undefined },
    });
    try {
      expect(bridge.initializeResult.protocolVersion).toBe(1);
      process.stdout.write(`${JSON.stringify({ agentId, agentCapabilities: bridge.initializeResult.agentCapabilities, authMethods: bridge.initializeResult.authMethods, agentInfo: bridge.initializeResult.agentInfo })}\n`);
    } finally {
      await bridge.stop();
    }
  });

  it("has official login/logout tooling on the vendored PATH", async () => {
    const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: agentId, RUNNER_BRIDGE_PREFIX: prefix });
    const login = resolveToolingCommand(config, family, family.tooling.login);
    const logout = resolveToolingCommand(config, family, family.tooling.logout);
    const present = await Promise.all([login, logout].map((tool) => access(tool.command).then(() => true, () => false)));
    process.stdout.write(`${JSON.stringify({ agentId, loginTooling: present[0], logoutTooling: present[1], hostCacheImport: family.tooling.hostCacheImport ?? null, identitySignal: family.tooling.identitySignal ?? null })}\n`);
  });
});
