#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import { createNativeService } from "@konteks/remote-supervisor";
import { EMBEDDED_RELEASE_ROOTS, verifyNativeRelease } from "@konteks/remote-release";
import { loadNativeInstallation, NativeRuntimeRecordSchema, SupervisorStore } from "@konteks/remote-supervisor";
import { z } from "zod";
import { SupervisorControl } from "../control.js";
import { createOutput } from "../output.js";
import { addNativeAgent, installNative, readNativeRecord, restoreNativeRecord } from "../native/install.js";
import { nativePlatform } from "../native/service.js";
import { commitNativeUpdate, stageNativeUpdate } from "../native/update.js";
import { prepareDeliveryGraft } from "../native/graft.js";
import { loadE2EInstallAuthority } from "./authority.js";
import { prepareE2ERealRelease, prepareE2ESmokeRelease, reissueE2ERelease } from "./smoke-release.js";

const program = new Command("konteks-remote-e2e-smoke").description("E2E-only signed native connector smoke preparation");
const gated = () => {
  if (process.env.KONTEKS_E2E_NATIVE_CONNECTOR !== "1") throw new InvalidArgumentError("E2E native connector gate is required");
};
const realGated = () => {
  if (process.env.KONTEKS_E2E_NATIVE_REAL_AGENT !== "1") throw new InvalidArgumentError("E2E real native agent gate is required");
};
const DrainStatusSchema = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number().int().min(0), openSessions: z.number().int().min(0) }).strict();
const MAX_DRAIN_MS = 15 * 60_000;
program.command("prepare")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .option("--origin <url>", "fixed local TLS edge", "https://127.0.0.1:7443")
  .action(async ({ directory, origin }: { directory: string; origin: string }) => {
    gated();
    const platform = nativePlatform();
    if (platform.os === "windows") throw new InvalidArgumentError("the source-driven E2E smoke currently runs on macOS or Debian; Windows uses the signed matrix proof");
    const prepared = await prepareE2ESmokeRelease({ gate: process.env.KONTEKS_E2E_NATIVE_CONNECTOR, directory: resolve(directory), origin, platform: { os: platform.os, architecture: platform.architecture } });
    createOutput({ json: true }).result({ manifestDigest: prepared.manifest.digest, signer: prepared.root.keyId, directory: resolve(directory) });
  });
program.command("reissue")
  .description("re-sign the local release at another version, optionally with a runnable connector (W1-L4)")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--bundle-version <version>", "the version to publish")
  .option("--connector <path>", "a runnable connector to publish in place of the placeholder")
  .action(async (options: { directory: string; bundleVersion: string; connector?: string }) => {
    gated();
    const manifest = await reissueE2ERelease({ directory: resolve(options.directory), bundleVersion: options.bundleVersion, ...(options.connector ? { connectorPath: resolve(options.connector) } : {}) });
    createOutput({ json: true }).result({ bundleVersion: manifest.bundleVersion, manifestDigest: manifest.digest });
  });
program.command("prepare-real")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--package <paths...>", "absolute paths to complete offline Claude Code/Codex packages")
  .requiredOption("--profile <paths...>", "matching absolute paths to their konteks-agent.json profiles")
  .option("--bundle-version <version>", "monotonically newer native release version", "0.1.0-e2e")
  .option("--origin <url>", "fixed local TLS edge", "https://127.0.0.1:7443")
  .action(async (options: { directory: string; package: string[]; profile: string[]; origin: string; bundleVersion: string }) => {
    realGated();
    if (options.package.some(path => !isAbsolute(path)) || options.profile.some(path => !isAbsolute(path))) throw new InvalidArgumentError("real agent package and profile paths must be absolute");
    const platform = nativePlatform();
    if (platform.os === "windows") throw new InvalidArgumentError("the real Codex E2E fixture currently runs on macOS or Debian");
    const directory = resolve(options.directory);
    const prepared = await prepareE2ERealRelease({ realAgentGate: process.env.KONTEKS_E2E_NATIVE_REAL_AGENT, directory, origin: options.origin, bundleVersion: options.bundleVersion, packagePath: options.package, profilePath: options.profile, platform: { os: platform.os, architecture: platform.architecture } });
    createOutput({ json: true }).result({ manifestDigest: prepared.manifest.digest, signer: prepared.root.keyId, directory });
  });
program.command("install")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "private native connector install root")
  .requiredOption("--activation-id <id>", "browser-created activation id")
  .option("--core-url <url>", "fixed local TLS edge", "https://127.0.0.1:7443")
  .option("--relay-url <url>", "fixed local TLS relay path", "wss://127.0.0.1:7443/relay/runtime")
  .option("--agent <id>", "the single agent family the prepared release packages", (value: string) => {
    if (value !== "codex" && value !== "claude-code") throw new InvalidArgumentError("the E2E release packages codex or claude-code");
    return value;
  }, "codex")
  .action(async (options: { directory: string; root: string; activationId: string; coreUrl: string; relayUrl: string; agent: string }) => {
    gated();
    const directory = resolve(options.directory);
    const authority = await loadE2EInstallAuthority({
      gate: process.env.KONTEKS_E2E_NATIVE_CONNECTOR, directory,
      manifestFile: resolve(directory, "native-manifest.json"), rootsFile: resolve(directory, "release-roots.json"), caFile: resolve(directory, "ca.pem"),
      nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS, coreUrl: options.coreUrl, relayUrl: options.relayUrl,
    });
    // Revalidate immediately before activation so replacing either private
    // file cannot silently change authority between validation and install.
    const confirmed = await loadE2EInstallAuthority({
      gate: process.env.KONTEKS_E2E_NATIVE_CONNECTOR, directory,
      manifestFile: resolve(directory, "native-manifest.json"), rootsFile: resolve(directory, "release-roots.json"), caFile: resolve(directory, "ca.pem"),
      nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS, coreUrl: options.coreUrl, relayUrl: options.relayUrl,
    });
    if (confirmed.manifest.digest !== authority.manifest.digest) throw new InvalidArgumentError("E2E manifest changed during validation");
    const output = createOutput({ json: true });
    const record = await installNative({ root: resolve(options.root), activationId: options.activationId, coreUrl: options.coreUrl, relayUrl: options.relayUrl, agents: [options.agent], output, deps: { roots: confirmed.roots, manifest: confirmed.manifest } });
    output.result({ instanceId: record.instanceId, deploymentKind: record.deploymentKind, state: "installed_for_e2e" });
  });

program.command("add-agent")
  .description("adopt a newer private signed E2E release and add its agent; the connector must be stopped")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "private native connector install root")
  .requiredOption("--agent <id>", "new agent family", (value: string) => {
    if (value !== "codex" && value !== "claude-code") throw new InvalidArgumentError("the E2E release packages codex or claude-code");
    return value as "codex" | "claude-code";
  })
  .action(async (options: { directory: string; root: string; agent: "codex" | "claude-code" }) => {
    gated(); realGated();
    const directory = resolve(options.directory), root = resolve(options.root);
    const record = await readNativeRecord(root);
    const authority = await loadE2EInstallAuthority({
      gate: process.env.KONTEKS_E2E_NATIVE_CONNECTOR, directory,
      manifestFile: resolve(directory, "native-manifest.json"), rootsFile: resolve(directory, "release-roots.json"), caFile: resolve(directory, "ca.pem"),
      nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS, coreUrl: record.coreUrl, relayUrl: record.relayUrl,
    });
    const output = createOutput({ json: true });
    const successor = await addNativeAgent({ root, agentId: options.agent, output, deps: { roots: authority.roots, manifest: authority.manifest } });
    output.result({ instanceId: successor.instanceId, manifestDigest: successor.manifestDigest, agents: successor.agents, state: "installed_for_e2e" });
  });

program.command("serve")
  .description("run an installed E2E connector with the same private release authority used at install time")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "private native connector install root")
  .action(async (options: { directory: string; root: string }) => {
    gated();
    const directory = resolve(options.directory), root = resolve(options.root);
    const record = await readNativeRecord(root);
    const authority = await loadE2EInstallAuthority({
      gate: process.env.KONTEKS_E2E_NATIVE_CONNECTOR, directory,
      manifestFile: resolve(directory, "native-manifest.json"), rootsFile: resolve(directory, "release-roots.json"), caFile: resolve(directory, "ca.pem"),
      nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS, coreUrl: record.coreUrl, relayUrl: record.relayUrl,
    });
    if (authority.manifest.digest !== record.manifestDigest) throw new InvalidArgumentError("installed E2E connector and private release authority do not match");
    // The controller injects Core's public control descriptor beside the same
    // private release root. Bind it back to the file-verified release identity:
    // this preserves signature verification across restarts without making
    // writable install metadata a trust source.
    const runtimeRoots = EMBEDDED_RELEASE_ROOTS;
    if (runtimeRoots.length !== authority.roots.length || authority.roots.some(expected => {
      const actual = runtimeRoots.find(candidate => candidate.keyId === expected.keyId);
      return !actual || actual.publicKeyJwk.x !== expected.publicKeyJwk.x;
    }) || runtimeRoots.some(root => !(root.coreControlKeys?.length))) {
      throw new InvalidArgumentError("E2E runtime control authority is unavailable or does not match the verified release root");
    }
    const service = createNativeService({ root, roots: runtimeRoots, platform: nativePlatform(),
      prepareRepositoryWorktree: (cwd, agentId) => prepareDeliveryGraft(root, cwd, agentId),
      exitProcess: code => process.exit(code) });
    await service.start();
    await service.waitUntilStopped();
  });

program.command("update-stage")
  .description("stage the verified local E2E release without changing the running connector")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "controller-owned native-connector sibling under the same .runtime")
  .action(async (options: { directory: string; root: string }) => {
    gated();
    const context = await loadUpdateContext(options);
    const staged = await stageNativeUpdate({ root: context.root, output: createOutput({ json: true }), deps: { roots: context.authority.roots, platform: context.platform, manifest: context.authority.manifest } });
    if (staged.current.instanceId !== context.current.instanceId || staged.current.workspaceId !== context.current.workspaceId || staged.current.releaseId !== context.current.releaseId || staged.current.manifestDigest !== context.current.manifestDigest) throw invalidUpdateState();
    if (staged.status === "current") {
      createOutput({ json: true }).result({ status: "current", releaseId: null, currentReleaseId: staged.current.releaseId, currentBundleVersion: staged.current.bundleVersion, currentManifestDigest: staged.current.manifestDigest, bundleVersion: null, manifestDigest: null, instanceId: staged.current.instanceId, workspaceId: staged.current.workspaceId });
      return;
    }
    createOutput({ json: true }).result({ status: "staged", releaseId: staged.releaseId, currentReleaseId: staged.current.releaseId, currentBundleVersion: staged.current.bundleVersion, currentManifestDigest: staged.current.manifestDigest, bundleVersion: staged.release.manifest.bundleVersion, manifestDigest: staged.release.manifest.digest, instanceId: staged.current.instanceId, workspaceId: staged.current.workspaceId });
  });

program.command("update-commit")
  .description("commit one staged E2E release after the controller has stopped the connector")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "controller-owned native-connector sibling under the same .runtime")
  .requiredOption("--release-id <id>", "exact release id returned by update-stage", parseReleaseId)
  .action(async (options: { directory: string; root: string; releaseId: string }) => {
    gated();
    const context = await loadUpdateContext(options);
    const staged = await readVerifiedRelease(context.root, options.releaseId, context.authority.roots);
    if (staged.manifest.digest !== context.authority.manifest.digest || staged.manifest.bundleVersion !== context.authority.manifest.bundleVersion) throw invalidUpdateState();
    const record = await commitNativeUpdate({ root: context.root, releaseId: options.releaseId, output: createOutput({ json: true }), deps: { roots: context.authority.roots, platform: context.platform } });
    if (record.instanceId !== context.current.instanceId || record.workspaceId !== context.current.workspaceId || record.releaseId !== options.releaseId || record.manifestDigest !== context.authority.manifest.digest) throw invalidUpdateState();
    createOutput({ json: true }).result({ status: "committed", releaseId: record.releaseId, bundleVersion: record.bundleVersion, manifestDigest: record.manifestDigest, instanceId: record.instanceId, workspaceId: record.workspaceId });
  });

program.command("update-restore")
  .description("restore the previous verified E2E release after the controller has stopped the connector")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "controller-owned native-connector sibling under the same .runtime")
  .requiredOption("--expected-release-id <id>", "exact currently committed release id", parseReleaseId)
  .requiredOption("--previous-release-id <id>", "exact prior release id to restore", parseReleaseId)
  .action(async (options: { directory: string; root: string; expectedReleaseId: string; previousReleaseId: string }) => {
    gated();
    if (options.expectedReleaseId === options.previousReleaseId) throw invalidUpdateState();
    const context = await loadUpdateContext(options);
    const previousManifest = await readVerifiedRelease(context.root, options.previousReleaseId, context.authority.roots);
    if (context.current.releaseId === options.previousReleaseId && context.current.manifestDigest === previousManifest.manifest.digest && context.current.bundleVersion === previousManifest.manifest.bundleVersion) {
      const supervisorManifest = await new SupervisorStore(join(context.root, "supervisor")).manifest();
      if (!supervisorManifest || supervisorManifest.manifestDigest !== previousManifest.manifest.digest) throw invalidUpdateState();
      createOutput({ json: true }).result({ status: "already_previous", releaseId: context.current.releaseId, bundleVersion: context.current.bundleVersion, manifestDigest: context.current.manifestDigest, instanceId: context.current.instanceId, workspaceId: context.current.workspaceId });
      return;
    }
    if (context.current.releaseId !== options.expectedReleaseId || context.current.manifestDigest !== context.authority.manifest.digest) throw invalidUpdateState();
    const previous = NativeRuntimeRecordSchema.parse({ ...context.current, releaseId: options.previousReleaseId, bundleVersion: previousManifest.manifest.bundleVersion, manifestDigest: previousManifest.manifest.digest });
    await restoreNativeRecord(context.root, options.expectedReleaseId, previous, { roots: context.authority.roots, platform: context.platform });
    const restored = await loadNativeInstallation(context.root, { roots: context.authority.roots, platform: context.platform });
    if (restored.record.instanceId !== context.current.instanceId || restored.record.workspaceId !== context.current.workspaceId || restored.record.releaseId !== options.previousReleaseId || restored.record.manifestDigest !== previousManifest.manifest.digest) throw invalidUpdateState();
    createOutput({ json: true }).result({ status: "restored", releaseId: restored.record.releaseId, bundleVersion: restored.record.bundleVersion, manifestDigest: restored.record.manifestDigest, instanceId: restored.record.instanceId, workspaceId: restored.record.workspaceId });
  });

program.command("update-drain")
  .description("ask the supervisor to drain and wait for active assignments to finish")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "controller-owned native-connector sibling under the same .runtime")
  .option("--timeout-ms <milliseconds>", "bounded drain wait (1000-900000 ms)", parseDrainTimeout, MAX_DRAIN_MS)
  .action(async (options: { directory: string; root: string; timeoutMs: number }) => {
    gated();
    const context = await loadUpdateContext(options);
    const control = new SupervisorControl({ supervisorData: join(context.root, "supervisor") }, context.current.controlPort);
    await control.call({ op: "drain", reason: "update" }, z.unknown());
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const state = await control.call({ op: "drain.status" }, DrainStatusSchema, { timeoutMs: 5_000 });
      if (state.activeAssignments === 0) {
        createOutput({ json: true }).result({ status: "drained", activeAssignments: 0, instanceId: context.current.instanceId, workspaceId: context.current.workspaceId });
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RemoteInstanceError("active_work", "E2E update drain timed out with active assignments; call update-drain-cancel before abandoning the update.");
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(5_000, remaining)));
    }
  });

program.command("update-drain-cancel")
  .description("cancel an E2E update drain before the controller stops the connector")
  .requiredOption("--directory <path>", "controller-owned .runtime/native-cloud directory")
  .requiredOption("--root <path>", "controller-owned native-connector sibling under the same .runtime")
  .action(async (options: { directory: string; root: string }) => {
    gated();
    const context = await loadUpdateContext(options);
    const control = new SupervisorControl({ supervisorData: join(context.root, "supervisor") }, context.current.controlPort);
    await control.call({ op: "drain.cancel" }, z.unknown());
    createOutput({ json: true }).result({ status: "drain_cancelled", instanceId: context.current.instanceId, workspaceId: context.current.workspaceId });
  });

async function loadUpdateContext(options: { directory: string; root: string }) {
  const directory = resolve(options.directory), root = resolve(options.root), runtimeDirectory = dirname(directory);
  if (!isAbsolute(options.directory) || !isAbsolute(options.root) || basename(directory) !== "native-cloud" || basename(runtimeDirectory) !== ".runtime"
    || dirname(root) !== runtimeDirectory || !/^native-connector(?:-[A-Za-z0-9_-]+)?$/.test(basename(root))) {
    throw new InvalidArgumentError("E2E native update root must be a fixed .runtime sibling named native-connector or native-connector-<id>");
  }
  const [runtimeInfo, directoryInfo, rootInfo] = await Promise.all([lstat(runtimeDirectory), lstat(directory), lstat(root)]);
  if (!runtimeInfo.isDirectory() || !directoryInfo.isDirectory() || !rootInfo.isDirectory()
    || process.platform !== "win32" && [runtimeInfo, directoryInfo, rootInfo].some(info => (info.mode & 0o077) !== 0)) throw invalidUpdateState();
  const [runtimeReal, directoryReal, rootReal] = await Promise.all([realpath(runtimeDirectory), realpath(directory), realpath(root)]);
  if (runtimeReal !== runtimeDirectory || directoryReal !== directory || rootReal !== root) throw new InvalidArgumentError("E2E native update paths cannot contain symlinks");

  const before = await readNativeRecord(root);
  const authority = await loadE2EInstallAuthority({
    gate: process.env.KONTEKS_E2E_NATIVE_CONNECTOR, directory,
    manifestFile: join(directory, "native-manifest.json"), rootsFile: join(directory, "release-roots.json"), caFile: join(directory, "ca.pem"),
    nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS, coreUrl: before.coreUrl, relayUrl: before.relayUrl,
  });
  const platform = nativePlatform();
  if (platform.os === "windows") throw new InvalidArgumentError("E2E native update phases currently support macOS or Debian");
  const installed = await loadNativeInstallation(root, { roots: authority.roots, platform });
  const current = installed.record;
  if (current.instanceId !== before.instanceId || current.workspaceId !== before.workspaceId || current.releaseId !== before.releaseId || current.manifestDigest !== before.manifestDigest
    || !current.releaseId || !current.manifestDigest || !/^e2e-local-native-release-/.test(installed.release.manifest.signature.keyId)) throw invalidUpdateState();
  return { directory, root, current, authority, platform };
}

async function readVerifiedRelease(root: string, releaseId: string, roots: Parameters<typeof verifyNativeRelease>[1]) {
  const path = join(root, "releases", releaseId, "manifest.json"), info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || process.platform !== "win32" && (info.mode & 0o077) !== 0) throw invalidUpdateState();
  let payload: unknown;
  try { payload = JSON.parse(await readFile(path, "utf8")); } catch { throw invalidUpdateState(); }
  const release = verifyNativeRelease(payload, roots);
  if (!/^e2e-local-native-release-/.test(release.manifest.signature.keyId)) throw invalidUpdateState();
  return release;
}

function parseReleaseId(value: string): string {
  if (!/^release-[A-Za-z0-9_-]+$/.test(value)) throw new InvalidArgumentError("release id must be an opaque staged release identifier");
  return value;
}
function parseDrainTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_DRAIN_MS) throw new InvalidArgumentError("E2E drain timeout must be between 1000 and 900000 milliseconds");
  return timeout;
}
function invalidUpdateState(): RemoteInstanceError {
  return new RemoteInstanceError("install_state_corrupt", "E2E native update state or release identity is invalid.");
}

program.parseAsync(process.argv).catch((error: unknown) => { createOutput({ json: true }).error(error); process.exitCode = 1; });
