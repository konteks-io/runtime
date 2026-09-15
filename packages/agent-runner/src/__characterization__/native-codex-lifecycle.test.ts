import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, it } from "vitest";
import { RemoteSignedBundleManifestSchema, createLinuxExecutionSpawner } from "@konteks/remote-common";
import { verifyOfflineAgentPackage } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { resolveBridgeSpawnSpec } from "../bridge/spec.js";
import { spawnBridge, type BridgeStopOwner } from "../bridge/process.js";

/** Real installed bytes, no mocked ACP, no login or prompt. Manifest inventory
 * matching here is not independent release-root trust or D142 qualification.
 * Explicit opt-in avoids reporting an absent installation as a passed probe. */
const releaseRoot = process.env.NATIVE_CODEX_CHARACTERIZATION_RELEASE;
const modes = ["direct", ...(process.platform === "linux" && process.env.NATIVE_LINUX_CONTAINMENT_CHARACTERIZE === "1" ? ["linux-owned"] : [])];
it.skipIf(!releaseRoot).each(modes)("characterizes the installed native Codex lifecycle handshake without user credentials (%s)", async mode => {
  expect(isAbsolute(releaseRoot!)).toBe(true);
  const manifest = RemoteSignedBundleManifestSchema.parse(JSON.parse(await readFile(join(releaseRoot!, "manifest.json"), "utf8")));
  const artifacts = manifest.nativeArtifacts?.filter(artifact => artifact.agentId === "codex" && artifact.kind === "agent_bridge") ?? [];
  expect(artifacts).toHaveLength(1);
  const prefix = join(releaseRoot!, "agents", "codex");
  const profile = await verifyOfflineAgentPackage(prefix, artifacts[0]!);
  expect(profile.bridge.version).toBe("1.10.0");
  expect(profile.tooling.version).toBe("0.153.4");
  const root = await mkdtemp(join(tmpdir(), "native-codex-lifecycle-"));
  try {
    const credentialDir = join(root, "empty-credentials"), workspace = join(root, "empty-workspace");
    await mkdir(credentialDir, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_BRIDGE_PREFIX: prefix,
      RUNNER_CREDENTIAL_DIR: credentialDir, RUNNER_WORKSPACE_DIR: workspace,
      RUNNER_NATIVE_PACKAGE_PROFILE: profile, RUNNER_NATIVE_PACKAGE_ARTIFACT: artifacts[0] });
    let callbacks = 0;
    const resolved = resolveBridgeSpawnSpec(config);
    // Compatibility probe only: the read-only host mount is not a production
    // filesystem/network policy. Only this generated empty root is writable.
    const spawnProcess = mode === "linux-owned" ? createLinuxExecutionSpawner({ executable: "/usr/bin/bwrap", writableRoots: [root] }) : undefined;
    const captured: BridgeStopOwner[] = [];
    const bridge = await spawnBridge({ spec: resolved, ...(spawnProcess ? { spawnProcess } : {}), initializeTimeoutMs: 15_000, clientVersion: "native-lifecycle-characterization",
      onProcessOwner: owner => { captured.push(owner); },
      handlers: {
        onSessionUpdate: () => { callbacks++; },
        onRequestPermission: async () => { callbacks++; return { outcome: { outcome: "cancelled" } }; },
        onCreateElicitation: async () => { callbacks++; return { action: "cancel" }; },
        onExit: () => undefined,
      } });
    try {
      expect(captured).toHaveLength(1);
      expect(captured[0]!.stop).toBe(bridge.stop);
      const caps = bridge.initializeResult.agentCapabilities;
      const sessions = caps?.sessionCapabilities;
      const observed = { mode, bridgeVersion: profile.bridge.version, toolingVersion: profile.tooling.version,
        protocolVersion: bridge.initializeResult.protocolVersion, load: caps?.loadSession === true,
        resume: sessions?.resume !== undefined, close: sessions?.close !== undefined };
      process.stdout.write(`${JSON.stringify(observed)}\n`);
      expect(observed).toMatchObject({ protocolVersion: 1, load: true, resume: true, close: true });
      expect(callbacks).toBe(0);
    } finally {
      await bridge.stop();
    }
    expect(bridge.exited).toBe(true);
    expect(captured[0]!.exited).toBe(true);
  } finally {
    // Only this test's fresh empty-home tree; never the installed package or
    // the user's actual credential, session history or workspace directories.
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
