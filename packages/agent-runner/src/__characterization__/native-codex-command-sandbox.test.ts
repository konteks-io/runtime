import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { expect, it } from "vitest";
import { RemoteSignedBundleManifestSchema, spawnPiped, stopProcessGroupLeaderFirst, type PipedChildProcess } from "@konteks/remote-common";
import { verifyOfflineAgentPackage } from "@konteks/remote-release";
import { RunnerConfigSchema } from "../config.js";
import { bridgeEnvironment, resolveBridgeFamily, resolveToolingCommand } from "../bridge/spec.js";

const releaseRoot = process.env.NATIVE_CODEX_CHARACTERIZATION_RELEASE;
const enabled = process.platform === "linux" && !!releaseRoot && process.env.NATIVE_LINUX_CONTAINMENT_CHARACTERIZE === "1";

// A real command sandbox, not a model/ACP simulation. No account login, prompt,
// provider call, user credential HOME or production runtime configuration.
it.skipIf(!enabled)("denies an external host socket under explicit Codex workspace-write/no-network policy", async () => {
  expect(isAbsolute(releaseRoot!)).toBe(true);
  const manifest = RemoteSignedBundleManifestSchema.parse(JSON.parse(await readFile(join(releaseRoot!, "manifest.json"), "utf8")));
  const artifacts = manifest.nativeArtifacts?.filter(value => value.agentId === "codex" && value.kind === "agent_bridge") ?? [];
  expect(artifacts).toHaveLength(1);
  const prefix = join(releaseRoot!, "agents", "codex");
  const profile = await verifyOfflineAgentPackage(prefix, artifacts[0]!);
  const root = await mkdtemp("/var/tmp/native-codex-command-sandbox-");
  const workspace = join(root, "workspace"), credentialDir = join(root, "empty-credentials"), socketPath = join(root, "host.sock");
  const sockets = new Set<Socket>();
  let accepted = false;
  let child: PipedChildProcess | undefined;
  const server = createServer(socket => {
    accepted = true; sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.end();
  });
  try {
    await mkdir(workspace); await mkdir(credentialDir, { mode: 0o700 });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await new Promise<void>((resolve, reject) => {
      const control = createConnection(socketPath);
      control.once("error", reject); control.once("close", resolve);
    });
    expect(accepted).toBe(true); // Positive control: the host socket is reachable.
    accepted = false;
    const config = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: "codex", RUNNER_BRIDGE_PREFIX: prefix,
      RUNNER_CREDENTIAL_DIR: credentialDir, RUNNER_WORKSPACE_DIR: workspace,
      RUNNER_NATIVE_PACKAGE_PROFILE: profile, RUNNER_NATIVE_PACKAGE_ARTIFACT: artifacts[0] });
    const family = resolveBridgeFamily("codex");
    // Installed CLI help requires a named permission profile. Its documented
    // filesystem/network keys avoid relying on legacy mode translation.
    const command = resolveToolingCommand(config, family, ["codex", "sandbox", "-C", workspace, "-P", "native_probe",
      "-c", 'permissions.native_probe.filesystem={"/"="read",":workspace_roots"="write"}',
      "-c", "permissions.native_probe.network.enabled=false", "--",
      process.execPath, "-e", `const fs=require('node:fs');const marker=process.argv[2];fs.writeFileSync(marker,'started');
        const socket=require('node:net').connect(process.argv[1]);
        socket.on('connect',()=>{fs.writeFileSync(marker,'accepted');process.stdout.write('accepted');socket.end();});
        socket.on('error',error=>{fs.writeFileSync(marker,'denied:'+error.code);process.stdout.write('denied:'+error.code);});`, socketPath, join(workspace, "probe-result")]);
    child = spawnPiped({ ...command, cwd: workspace, env: bridgeEnvironment(config, family) });
    let stdout = "", stderrBytes = 0, stderr = "";
    child.stdout.on("data", data => { stdout = (stdout + data.toString()).slice(0, 1024); });
    child.stderr.on("data", data => { stderrBytes += data.length; stderr = (stderr + data.toString()).slice(0, 1024); });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sandbox probe timed out")), 15_000);
      child!.once("error", error => { clearTimeout(timer); reject(error); });
      child!.once("close", code => { clearTimeout(timer); resolve(code); });
    });
    const marker = await readFile(join(workspace, "probe-result"), "utf8").catch(() => "missing");
    process.stdout.write(`${JSON.stringify({ toolingVersion: profile.tooling.version, exitCode, hostAccepted: accepted, marker,
      commandReportedDenied: /^denied:(EACCES|EPERM|ENOENT)$/.test(marker), stdoutBytes: stdout.length, stderrBytes,
      // Fresh empty config only; no authenticated process/provider output.
      ...(exitCode ? { launcherDiagnostic: stderr.replaceAll(root, "[fixture]").replaceAll(prefix, "[package]") } : {}) })}\n`);
    expect(exitCode).toBe(0); // A broken launcher is not evidence of containment.
    // This pinned CLI does not forward sandbox command stdout. The synchronous
    // marker is produced by the actual child in its permitted workspace.
    expect(marker).toMatch(/^denied:(EACCES|EPERM|ENOENT)$/);
    expect(accepted).toBe(false);
  } finally {
    if (child) await stopProcessGroupLeaderFirst({ child, timeoutMs: 500, killGraceMs: 500 });
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); // Only this fresh test-owned tree.
  }
}, 30_000);
