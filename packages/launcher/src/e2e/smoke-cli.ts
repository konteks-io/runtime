#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { isAbsolute, resolve } from "node:path";
import { createNativeService } from "@konteks/remote-supervisor";
import { EMBEDDED_RELEASE_ROOTS } from "@konteks/remote-release";
import { createOutput } from "../output.js";
import { addNativeAgent, installNative, readNativeRecord } from "../native/install.js";
import { nativePlatform } from "../native/service.js";
import { loadE2EInstallAuthority } from "./authority.js";
import { prepareE2ERealRelease, prepareE2ESmokeRelease } from "./smoke-release.js";

const program = new Command("konteks-remote-e2e-smoke").description("E2E-only signed native connector smoke preparation");
const gated = () => {
  if (process.env.KONTEKS_E2E_NATIVE_CONNECTOR !== "1") throw new InvalidArgumentError("E2E native connector gate is required");
};
const realGated = () => {
  if (process.env.KONTEKS_E2E_NATIVE_REAL_AGENT !== "1") throw new InvalidArgumentError("E2E real native agent gate is required");
};
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
    const service = createNativeService({ root, roots: runtimeRoots, platform: nativePlatform(), exitProcess: code => process.exit(code) });
    await service.start();
    await service.waitUntilStopped();
  });

program.parseAsync(process.argv).catch((error: unknown) => { createOutput({ json: true }).error(error); process.exitCode = 1; });
