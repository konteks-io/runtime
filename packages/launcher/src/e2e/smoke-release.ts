import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { gzipSync } from "node:zlib";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import {
  RemoteInstanceError,
  agentModelCapabilityMappingSigningBytes,
  computeAgentModelCapabilityMappingDigest,
  type AgentModelCapabilityMapping,
  type RemoteNativeArtifact,
} from "@konteks/remote-common";
import { EmbeddedReleaseRootSchema, HOST_AGENT_BRIDGES, installOfflineAgentPackage, reviewedNativeModelIdentities, NativeAgentPackageProfileSchema, OFFLINE_AGENT_LIMITS, signNativeReleaseManifest, verifyNativeRelease, type EmbeddedReleaseRoot, type NativeAgentPackageProfile } from "@konteks/remote-release";
import type { RemoteSignedBundleManifest } from "@konteks/remote-common";

export interface E2ESmokeReleaseOptions {
  gate: string | undefined;
  directory: string;
  origin: string;
  platform: { os: "macos" | "debian"; architecture: "amd64" | "arm64" };
}

export interface E2ERealReleaseOptions extends Omit<E2ESmokeReleaseOptions, "gate"> {
  realAgentGate: string | undefined;
  bundleVersion?: string;
  packagePath: string | readonly string[];
  profilePath: string | readonly string[];
}

export interface E2EAdditionalPlatformOptions extends E2ESmokeReleaseOptions {
  bundleVersion: string;
}

export interface E2ERealAdditionalPlatformOptions extends Omit<E2EAdditionalPlatformOptions, "platform"> {
  realAgentGate: string | undefined;
  platform: { os: "windows"; architecture: "amd64" | "arm64" };
  connectorPath: string;
  packagePath: string;
  profilePath: string;
}

function fakeCodexArchive(platform: E2ESmokeReleaseOptions["platform"]): { archive: Buffer; profileBytes: Buffer } {
  const tooling = Buffer.from(fakeTooling(), "utf8"), bridge = Buffer.from(fakeBridge(), "utf8");
  const files = [
    { path: "bin/codex", bytes: tooling, executable: true },
    { path: "bridge/fake-codex-acp", bytes: bridge, executable: true },
  ];
  const profile: NativeAgentPackageProfile = NativeAgentPackageProfileSchema.parse({
    schemaVersion: 1, agentId: "codex", os: platform.os, architecture: platform.architecture,
    bridge: { package: "@agentclientprotocol/codex-acp", version: "1.10.0", entrypoint: "bridge/fake-codex-acp", runtime: "native" },
    tooling: { package: "@openai/codex", version: "0.153.3", entrypoint: "bin/codex", runtime: "native" },
    files: files.map(file => ({ path: file.path, digest: sha(file.bytes), sizeBytes: file.bytes.length, executable: file.executable })),
  });
  const profileBytes = Buffer.from(JSON.stringify(profile));
  return { profileBytes, archive: gzipSync(tar([{ path: "konteks-agent.json", bytes: profileBytes }, ...files]), { level: 9 }) };
}

/** Prepare one host-only, signed fake-Codex release for local E2E. */
export async function prepareE2ESmokeRelease(options: E2ESmokeReleaseOptions) {
  releaseBoundary(options);
  const origin = localOrigin(options.origin);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const { archive, profileBytes } = fakeCodexArchive(options.platform);
  const connector = Buffer.from("KONTEKS_E2E_SOURCE_CONNECTOR_ONLY\n");
  const connectorPath = join(options.directory, "connector"), codexPath = join(options.directory, "codex.tgz");
  await writeFile(connectorPath, connector, { mode: 0o700 });
  await writeFile(codexPath, archive, { mode: 0o600 });
  const codexArtifact: RemoteNativeArtifact = { id: "e2e-fake-codex-acp", kind: "agent_bridge", format: "offline_agent_tgz", agentId: "codex", ...options.platform, url: `${origin}/__e2e/native/codex.tgz`, digest: sha(archive), profileDigest: sha(profileBytes), sizeBytes: archive.length };
  return writeSignedRelease(options, origin, connector, [codexArtifact], connectorPath, { codex: codexPath });
}

/** Add an isolated second-machine target to the existing local release. */
export async function extendE2ESmokeRelease(options: E2EAdditionalPlatformOptions) {
  releaseBoundary(options);
  const origin = localOrigin(options.origin);
  const roots = EmbeddedReleaseRootSchema.array().parse(JSON.parse(await readFile(join(options.directory, "release-roots.json"), "utf8")).roots);
  const previous = verifyNativeRelease(JSON.parse(await readFile(join(options.directory, "native-manifest.json"), "utf8")), roots).manifest;
  if (previous.nativeArtifacts?.some(artifact => artifact.os === options.platform.os && artifact.architecture === options.platform.architecture)
    || previous.nativeArtifacts?.some(artifact => new URL(artifact.url).origin !== origin)
    || options.bundleVersion === previous.bundleVersion) fail();
  const privateKey = await e2eSigningKey(options.directory);
  const root = roots.find(candidate => candidate.keyId === "e2e-local-native-release-1");
  if (!root || createPublicKey(privateKey).export({ format: "jwk" }).x !== root.publicKeyJwk.x) fail();

  const suffix = `${options.platform.os}-${options.platform.architecture}`;
  const connector = Buffer.from("KONTEKS_E2E_SOURCE_CONNECTOR_ONLY\n");
  const { archive, profileBytes } = fakeCodexArchive(options.platform);
  const connectorName = `connector-${suffix}`, agentName = `codex-${suffix}.tgz`;
  const connectorArtifact: RemoteNativeArtifact = {
    id: `e2e-source-connector-${suffix}`, kind: "connector", format: "executable", ...options.platform,
    url: `${origin}/__e2e/native/${connectorName}`, digest: sha(connector), sizeBytes: connector.length,
  };
  const agentArtifact: RemoteNativeArtifact = {
    id: `e2e-fake-codex-acp-${suffix}`, kind: "agent_bridge", format: "offline_agent_tgz", agentId: "codex", ...options.platform,
    url: `${origin}/__e2e/native/${agentName}`, digest: sha(archive), profileDigest: sha(profileBytes), sizeBytes: archive.length,
  };
  const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 370 * 24 * 60 * 60 * 1000);
  const mappingBody = {
    version: 1 as const, mappingId: `e2e-codex-${suffix}-model`, mappingRevision: 1,
    bridgeProfileRef: agentArtifact.id, bridgeArtifactDigest: agentArtifact.digest,
    configId: "model", optionType: "select" as const,
    modelIdentities: [{ value: "e2e-model", canonicalProviderId: "e2e", canonicalModelId: "e2e-model" }],
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(),
  };
  const mappingUnsigned = { ...mappingBody, mappingDigest: computeAgentModelCapabilityMappingDigest(mappingBody) };
  const mappingPlaceholder: AgentModelCapabilityMapping = {
    ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId: root.keyId, value: "AA" },
  };
  const mapping: AgentModelCapabilityMapping = {
    ...mappingUnsigned,
    signature: { algorithm: "Ed25519", keyId: root.keyId, value: sign(null, agentModelCapabilityMappingSigningBytes(mappingPlaceholder), privateKey).toString("base64url") },
  };
  const { digest: _digest, signature: _signature, ...unsigned } = previous;
  const manifest = signNativeReleaseManifest({
    ...unsigned, bundleVersion: options.bundleVersion,
    nativeArtifacts: [...(previous.nativeArtifacts ?? []), connectorArtifact, agentArtifact],
    modelCapabilityMappings: [...(previous.modelCapabilityMappings ?? []), mapping],
  }, { keyId: root.keyId, privateKey });
  await writeFile(join(options.directory, connectorName), connector, { flag: "wx", mode: 0o700 });
  await writeFile(join(options.directory, agentName), archive, { flag: "wx", mode: 0o600 });
  const scratch = await mkdtemp(join(options.directory, ".manifest-"));
  try {
    await writeFile(join(scratch, "native-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    await rename(join(scratch, "native-manifest.json"), join(options.directory, "native-manifest.json"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { root, manifest, artifactFiles: { connector: join(options.directory, connectorName), agent: join(options.directory, agentName) } };
}

/** Add a separately built Windows connector and complete Codex package to the private local release. */
export async function extendE2ERealRelease(options: E2ERealAdditionalPlatformOptions) {
  releaseBoundary(options);
  if (options.realAgentGate !== "1" || ![options.connectorPath, options.packagePath, options.profilePath].every(isAbsolute)) fail();
  const origin = localOrigin(options.origin);
  const roots = EmbeddedReleaseRootSchema.array().parse(JSON.parse(await readFile(join(options.directory, "release-roots.json"), "utf8")).roots);
  const previous = verifyNativeRelease(JSON.parse(await readFile(join(options.directory, "native-manifest.json"), "utf8")), roots).manifest;
  if (previous.nativeArtifacts?.some(artifact => artifact.os === options.platform.os && artifact.architecture === options.platform.architecture)
    || previous.nativeArtifacts?.some(artifact => new URL(artifact.url).origin !== origin)
    || options.bundleVersion === previous.bundleVersion) fail();
  const privateKey = await e2eSigningKey(options.directory);
  const root = roots.find(candidate => candidate.keyId === "e2e-local-native-release-1");
  if (!root || createPublicKey(privateKey).export({ format: "jwk" }).x !== root.publicKeyJwk.x) fail();
  const suffix = `${options.platform.os}-${options.platform.architecture}`;
  const connectorName = `connector-${suffix}.exe`, agentName = `codex-${suffix}.tgz`;
  const validationRoot = await mkdtemp(join(options.directory, ".real-package-validation-"));
  try {
    const [connectorInfo, packageInfo, profileInfo] = await Promise.all([
      lstat(options.connectorPath).catch(fail),
      lstat(options.packagePath).catch(fail),
      lstat(options.profilePath).catch(fail),
    ]);
    if (!connectorInfo.isFile() || connectorInfo.nlink !== 1 || connectorInfo.size < 1
      || !packageInfo.isFile() || packageInfo.nlink !== 1 || packageInfo.size < 1
      || !profileInfo.isFile() || profileInfo.nlink !== 1 || profileInfo.size > OFFLINE_AGENT_LIMITS.profileBytes) fail();
    const profileBytes = await readFile(options.profilePath);
    const profile = (() => { try { return NativeAgentPackageProfileSchema.parse(JSON.parse(profileBytes.toString("utf8"))); } catch { return fail(); } })();
    if (profile.agentId !== "codex" || profile.os !== options.platform.os || profile.architecture !== options.platform.architecture
      || profile.bridge.entrypoint.endsWith("/fake-codex-acp")) fail();
    const stagedConnector = join(validationRoot, connectorName), stagedArchive = join(validationRoot, agentName);
    await Promise.all([copyFile(options.connectorPath, stagedConnector), copyFile(options.packagePath, stagedArchive)]);
    await Promise.all([chmod(stagedConnector, 0o700), chmod(stagedArchive, 0o600)]);
    const stagedConnectorInfo = await lstat(stagedConnector), stagedPackageInfo = await lstat(stagedArchive);
    if (stagedConnectorInfo.size !== connectorInfo.size || stagedPackageInfo.size !== packageInfo.size) fail();
    const connectorArtifact: RemoteNativeArtifact = {
      id: `e2e-real-connector-${suffix}`, kind: "connector", format: "executable", ...options.platform,
      url: `${origin}/__e2e/native/${connectorName}`, digest: await shaFile(stagedConnector), sizeBytes: stagedConnectorInfo.size,
    };
    const agentArtifact: RemoteNativeArtifact = {
      id: `e2e-real-codex-acp-${suffix}`, kind: "agent_bridge", format: "offline_agent_tgz", agentId: "codex", ...options.platform,
      url: `${origin}/__e2e/native/${agentName}`, digest: await shaFile(stagedArchive), profileDigest: sha(profileBytes), sizeBytes: stagedPackageInfo.size,
    };
    await installOfflineAgentPackage(stagedArchive, join(validationRoot, "installed-agent"), agentArtifact);
    const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 370 * 24 * 60 * 60 * 1000);
    const mappingBody = {
      version: 1 as const, mappingId: `e2e-codex-${suffix}-model`, mappingRevision: 1,
      bridgeProfileRef: agentArtifact.id, bridgeArtifactDigest: agentArtifact.digest,
      configId: "model", optionType: "select" as const,
      modelIdentities: [{ value: "gpt-5.6-sol", canonicalProviderId: "openai", canonicalModelId: "gpt-5.6-sol" }],
      issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(),
    };
    const mappingUnsigned = { ...mappingBody, mappingDigest: computeAgentModelCapabilityMappingDigest(mappingBody) };
    const mappingPlaceholder: AgentModelCapabilityMapping = { ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId: root.keyId, value: "AA" } };
    const mapping: AgentModelCapabilityMapping = {
      ...mappingUnsigned,
      signature: { algorithm: "Ed25519", keyId: root.keyId, value: sign(null, agentModelCapabilityMappingSigningBytes(mappingPlaceholder), privateKey).toString("base64url") },
    };
    const { digest: _digest, signature: _signature, ...unsigned } = previous;
    const manifest = signNativeReleaseManifest({
      ...unsigned, bundleVersion: options.bundleVersion,
      nativeArtifacts: [...(previous.nativeArtifacts ?? []), connectorArtifact, agentArtifact],
      modelCapabilityMappings: [...(previous.modelCapabilityMappings ?? []), mapping],
    }, { keyId: root.keyId, privateKey });
    const connectorDestination = join(options.directory, connectorName), agentDestination = join(options.directory, agentName);
    if (await lstat(connectorDestination).then(() => true, () => false) || await lstat(agentDestination).then(() => true, () => false)) fail();
    await rename(stagedConnector, connectorDestination);
    await rename(stagedArchive, agentDestination);
    await writeFile(join(validationRoot, "native-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    await rename(join(validationRoot, "native-manifest.json"), join(options.directory, "native-manifest.json"));
    return { root, manifest, artifactFiles: { connector: connectorDestination, agent: agentDestination } };
  } finally { await rm(validationRoot, { recursive: true, force: true }); }
}

/** Prepare a signed local release from a separately built, complete Codex or Claude Code package. */
export async function prepareE2ERealRelease(options: E2ERealReleaseOptions) {
  const packagePaths = typeof options.packagePath === "string" ? [options.packagePath] : [...options.packagePath];
  const profilePaths = typeof options.profilePath === "string" ? [options.profilePath] : [...options.profilePath];
  if (options.realAgentGate !== "1" || packagePaths.length < 1 || packagePaths.length > 4 || packagePaths.length !== profilePaths.length
    || packagePaths.some(path => !isAbsolute(path)) || profilePaths.some(path => !isAbsolute(path))) fail();
  releaseBoundary({ gate: options.realAgentGate, directory: options.directory });
  const origin = localOrigin(options.origin);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const connector = Buffer.from("KONTEKS_E2E_SOURCE_CONNECTOR_ONLY\n");
  const connectorPath = join(options.directory, "connector");
  const validationRoot = await mkdtemp(join(options.directory, ".real-package-validation-"));
  const artifacts: RemoteNativeArtifact[] = [];
  const artifactFiles: Record<string, string> = {};
  try {
    for (const [index, packagePath] of packagePaths.entries()) {
      const profilePath = profilePaths[index]!;
      const [packageInfo, profileInfo] = await Promise.all([lstat(packagePath).catch(fail), lstat(profilePath).catch(fail)]);
      if (!packageInfo.isFile() || packageInfo.nlink !== 1 || packageInfo.size < 1 || !profileInfo.isFile() || profileInfo.nlink !== 1 || profileInfo.size > OFFLINE_AGENT_LIMITS.profileBytes) fail();
      const profileBytes = await readFile(profilePath);
      const profile = (() => { try { return NativeAgentPackageProfileSchema.parse(JSON.parse(profileBytes.toString("utf8"))); } catch { return fail(); } })();
      if ((profile.agentId !== "codex" && profile.agentId !== "claude-code") || artifacts.some(artifact => artifact.agentId === profile.agentId)
        || profile.os !== options.platform.os || profile.architecture !== options.platform.architecture || profile.bridge.entrypoint.endsWith("/fake-codex-acp")) fail();
      const agentFile = `${profile.agentId}.tgz`;
      const stagedArchive = join(validationRoot, agentFile);
      await copyFile(packagePath, stagedArchive);
      await chmod(stagedArchive, 0o600);
      const stagedPackageInfo = await lstat(stagedArchive).catch(fail);
      if (!stagedPackageInfo.isFile() || stagedPackageInfo.nlink !== 1 || stagedPackageInfo.size !== packageInfo.size) fail();
      const artifact: RemoteNativeArtifact = {
        id: `e2e-real-${profile.agentId}-acp`, kind: "agent_bridge", format: "offline_agent_tgz", agentId: profile.agentId, ...options.platform,
        url: `${origin}/__e2e/native/${agentFile}`, digest: await shaFile(stagedArchive), profileDigest: sha(profileBytes), sizeBytes: stagedPackageInfo.size,
      };
      await installOfflineAgentPackage(stagedArchive, join(validationRoot, `agent-${profile.agentId}`), artifact);
      const destination = join(options.directory, agentFile);
      await rename(stagedArchive, destination);
      artifacts.push(artifact);
      artifactFiles[profile.agentId] = destination;
    }
  }
  catch { return fail(); }
  finally { await rm(validationRoot, { recursive: true, force: true }); }
  await writeFile(connectorPath, connector, { mode: 0o700 });
  return writeSignedRelease(options, origin, connector, artifacts, connectorPath, artifactFiles, options.bundleVersion);
}

async function writeSignedRelease(options: Pick<E2ESmokeReleaseOptions, "directory" | "platform">, origin: string, connector: Buffer, agentArtifacts: RemoteNativeArtifact[], connectorPath: string, agentFiles: Record<string, string>, bundleVersion = "0.1.0-e2e") {
  const connectorArtifact: RemoteNativeArtifact = { id: "e2e-source-connector", kind: "connector", format: "executable", ...options.platform, url: `${origin}/__e2e/native/connector`, digest: sha(connector), sizeBytes: connector.length };
  const privateKey = await e2eSigningKey(options.directory);
  const keyId = "e2e-local-native-release-1";
  // The local stack may deliberately lengthen Core's seven-day default while
  // exercising interrupted provisioning. Its checked-in development manifest
  // uses a one-year envelope, so match that boundary plus preparation headroom;
  // otherwise pairing fails closed before any release is installed.
  const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime()+370*24*60*60*1000);
  const mappingFor = (artifact: RemoteNativeArtifact): AgentModelCapabilityMapping => {
    const mappingBody = {
    version: 1 as const,
    mappingId: `e2e-${artifact.agentId}-model`,
    mappingRevision: 1,
    bridgeProfileRef: artifact.id,
    bridgeArtifactDigest: artifact.digest,
    configId: "model",
    optionType: "select" as const,
    // Claude Code advertises short, moving selectors over ACP. Keep those
    // transport values local to the bridge while giving Core the reviewed,
    // canonical identities it needs for route and distinct-model authority.
    modelIdentities: artifact.agentId === "claude-code" ? [
      { value: "default", canonicalProviderId: "anthropic", canonicalModelId: "claude-opus-5[1m]" },
      { value: "opus[1m]", canonicalProviderId: "anthropic", canonicalModelId: "claude-opus-5[1m]" },
      { value: "claude-fable-5-1[1m]", canonicalProviderId: "anthropic", canonicalModelId: "claude-fable-5-1" },
      { value: "sonnet", canonicalProviderId: "anthropic", canonicalModelId: "claude-sonnet-5" },
      { value: "haiku", canonicalProviderId: "anthropic", canonicalModelId: "claude-haiku-4-5-20251001" },
    ] : artifact.id.startsWith("e2e-fake-") ? [
      { value: "e2e-model", canonicalProviderId: "e2e", canonicalModelId: "e2e-model" },
    ] : [
      { value: "gpt-5.6-sol", canonicalProviderId: "openai", canonicalModelId: "gpt-5.6-sol" },
    ],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
    const mappingUnsigned = { ...mappingBody, mappingDigest: computeAgentModelCapabilityMappingDigest(mappingBody) };
    const mappingPlaceholder: AgentModelCapabilityMapping = { ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId, value: "AA" } };
    return { ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId, value: sign(null, agentModelCapabilityMappingSigningBytes(mappingPlaceholder), privateKey).toString("base64url") } };
  };
  // A host-installed agent (the person's own DeepSeek Harness) ships no
  // artifact; its reviewed mapping names the agent and the versions this
  // runtime supports, with the same canonical identities Core routes on. An
  // agent with no reviewed identities (OpenCode) reports under its catalogue
  // authority instead, as in a production release (release/src/native.ts).
  const hostMappingFor = (family: (typeof HOST_AGENT_BRIDGES)[number]): AgentModelCapabilityMapping => {
    const mappingBody = {
      version: 1 as const,
      mappingId: `e2e-${family.agentId}-model`,
      mappingRevision: 1,
      hostAgent: { agentId: family.agentId, versions: { ...family.hostInstall!.versions } },
      configId: "model",
      optionType: "select" as const,
      modelIdentities: (reviewedNativeModelIdentities(family.agentId) ?? []).map(identity => ({ ...identity })),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const mappingUnsigned = { ...mappingBody, mappingDigest: computeAgentModelCapabilityMappingDigest(mappingBody) };
    const mappingPlaceholder: AgentModelCapabilityMapping = { ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId, value: "AA" } };
    return { ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId, value: sign(null, agentModelCapabilityMappingSigningBytes(mappingPlaceholder), privateKey).toString("base64url") } };
  };
  const mappings = [...agentArtifacts.map(mappingFor), ...HOST_AGENT_BRIDGES.filter(family => family.hostInstall && reviewedNativeModelIdentities(family.agentId)).map(hostMappingFor)];
  const manifest = signNativeReleaseManifest({
    bundleVersion, protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], nativeArtifacts: [connectorArtifact, ...agentArtifacts], modelCapabilityMappings: mappings, expiresAt: expiresAt.toISOString(),
  }, { keyId, privateKey });
  const control = await localControlAuthority(options.directory);
  const root: EmbeddedReleaseRoot = EmbeddedReleaseRootSchema.parse({
    keyId, publicKeyJwk: createPublicKey(privateKey).export({ format: "jwk" }),
    ...(control ? { coreControlKeys: [control] } : {}),
  });
  await writeFile(join(options.directory, "release-roots.json"), JSON.stringify({ roots: [root] }), { mode: 0o600 });
  await writeFile(join(options.directory, "native-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { root, manifest, artifactFiles: { connector: connectorPath, agent: agentFiles[agentArtifacts[0]!.agentId!]!, agents: agentFiles } };
}

async function localControlAuthority(
  directory: string,
): Promise<{ keyId: string; publicKeyJwk: EmbeddedReleaseRoot["publicKeyJwk"] } | null> {
  const path = join(dirname(directory), "private", "native-control-public.json");
  const info = await lstat(path).catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!info) return null;
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size > 4096 ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    fail();
  try {
    const key = EmbeddedReleaseRootSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (key.keyId !== "e2e-local-native-control-1" || key.coreControlKeys !== undefined) fail();
    return { keyId: key.keyId, publicKeyJwk: key.publicKeyJwk };
  } catch {
    return fail();
  }
}

/**
 * Re-sign the local release at another version (W1-L4), keeping its agent
 * packages and model mappings, and optionally replacing the connector with a
 * runnable one so the connector can run as a real OS service. The update path
 * — stage, drain, swap, health gate, roll back — only runs for a connector the
 * OS service manager owns. E2E-only: signed by the stack's own local key.
 */
export async function reissueE2ERelease(options: { directory: string; bundleVersion: string; connectorPath?: string; platform?: { os: "windows"; architecture: "amd64" | "arm64" } }) {
  const manifestPath = join(options.directory, "native-manifest.json");
  const roots = EmbeddedReleaseRootSchema.array().parse(JSON.parse(await readFile(join(options.directory, "release-roots.json"), "utf8")).roots);
  const current = verifyNativeRelease(JSON.parse(await readFile(manifestPath, "utf8")), roots).manifest;
  if (options.bundleVersion === current.bundleVersion || options.platform && !options.connectorPath) fail();
  const { digest: _digest, signature: _signature, ...unsigned } = current;
  const connectorName = options.platform ? `connector-${options.platform.os}-${options.platform.architecture}.exe` : "connector";
  const target = current.nativeArtifacts?.find(artifact => artifact.kind === "connector" && new URL(artifact.url).pathname === `/__e2e/native/${connectorName}`);
  if (options.connectorPath && !target) fail();
  const scratch = await mkdtemp(join(options.directory, ".reissue-"));
  try {
    let nativeArtifacts = current.nativeArtifacts;
    if (options.connectorPath) {
      if (!isAbsolute(options.connectorPath)) fail();
      const info = await lstat(options.connectorPath).catch(fail);
      if (!info.isFile() || info.nlink !== 1 || info.size < 1) fail();
      const staged = join(scratch, connectorName);
      await copyFile(options.connectorPath, staged);
      await chmod(staged, 0o700);
      const awaitDigest = await shaFile(staged);
      nativeArtifacts = nativeArtifacts?.map(artifact => artifact.id === target!.id
        ? { ...artifact, digest: awaitDigest, sizeBytes: info.size } : artifact);
    }
    const privateKey = await e2eSigningKey(options.directory);
    const root = roots.find(candidate => candidate.keyId === "e2e-local-native-release-1");
    if (!root || createPublicKey(privateKey).export({ format: "jwk" }).x !== root.publicKeyJwk.x) fail();
    const manifest = signNativeReleaseManifest(
      { ...(unsigned as Omit<RemoteSignedBundleManifest, "digest" | "signature">), bundleVersion: options.bundleVersion, nativeArtifacts },
      { keyId: root.keyId, privateKey },
    );
    await writeFile(join(scratch, "native-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    if (options.connectorPath) await rename(join(scratch, connectorName), join(options.directory, connectorName));
    await rename(join(scratch, "native-manifest.json"), manifestPath);
    return manifest;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Stable private test authority lives outside the directory served by TLS. */
async function e2eSigningKey(publicDirectory: string): Promise<KeyObject> {
  const path = join(dirname(publicDirectory), "private", "native-release-signing-key.pk8");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || process.platform !== "win32" && (info.mode & 0o077) !== 0) fail();
    return createPrivateKey({ key: await readFile(path), format: "der", type: "pkcs8" });
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const generated = generateKeyPairSync("ed25519").privateKey;
  const bytes = generated.export({ format: "der", type: "pkcs8" });
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    return generated;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || process.platform !== "win32" && (info.mode & 0o077) !== 0) fail();
    return createPrivateKey({ key: await readFile(path), format: "der", type: "pkcs8" });
  }
}

function releaseBoundary(options: Pick<E2ESmokeReleaseOptions, "gate" | "directory">): void {
  if (options.gate !== "1" || !isAbsolute(options.directory) || normalize(options.directory).split(sep).slice(-2).join("/") !== ".runtime/native-cloud") fail();
}

function localOrigin(raw: string): string {
  try {
    const value = new URL(raw);
    if (value.protocol === "https:" && value.port === "7443" && value.pathname === "/" && !value.search && !value.hash && !value.username && !value.password && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname)) return value.origin;
  } catch { /* closed below */ }
  return fail();
}
function fail(): never { throw new RemoteInstanceError("bundle_untrusted", "E2E smoke release is restricted to the explicit loopback test boundary."); }
function sha(bytes: Buffer): `sha256:${string}` { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
async function shaFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function fakeTooling(): string {
  return `#!/usr/bin/env node
const command = process.argv.slice(2).join(" ");
if (command === "app-server") {
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", line => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id === 1 && request.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: 1, result: { protocolVersion: "e2e" } }) + "\\n");
    } else if (request.id === 2 && request.method === "account/read") {
      process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: "chatgpt", email: "codex@e2e.konteks.test" } } }) + "\\n");
    }
  });
} else if (command === "login status") {
  process.stdout.write(JSON.stringify({ account: "konteks-e2e-fake-official-codex" }) + "\\n");
} else {
  process.exitCode = 2;
}
`;
}
function fakeBridge(): string { return `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
let sessions = 0;
const output = value => process.stdout.write(JSON.stringify(value) + "\\n");
const modelOptions = currentValue => [{ id: "model", name: "Model", category: "model", type: "select", currentValue, options: [{ value: "e2e-model", name: "E2E deterministic model" }] }];
const planningProposal = request => {
  const text = Array.isArray(request.params && request.params.prompt)
    ? request.params.prompt.filter(part => part && part.type === "text").map(part => part.text).join("\\n")
    : "";
  const start = "Planning input:\\n", end = "\\n\\nFrozen assignment inputs:";
  const startAt = text.indexOf(start), endAt = startAt < 0 ? -1 : text.indexOf(end, startAt + start.length);
  let repositoryUrl = "https://example.invalid/konteks/native-smoke.git";
  if (startAt >= 0 && endAt > startAt) {
    try {
      const input = JSON.parse(text.slice(startAt + start.length, endAt));
      const candidate = input && Array.isArray(input.repositories) && input.repositories[0] && input.repositories[0].url;
      if (typeof candidate === "string" && candidate.length > 0) repositoryUrl = candidate;
    } catch { /* deterministic fallback remains schema-valid */ }
  }
  let skillValidation = "";
  for (const line of text.split("\\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const record = JSON.parse(line);
      const skillFile = record && record.skillFile;
      if (typeof record.name !== "string" || !record.name.startsWith("org-") || typeof skillFile !== "string"
        || !skillFile.includes("/workspaces/codex/skills/skills-") || !skillFile.includes("/org-")
        || !skillFile.endsWith("/SKILL.md")) continue;
      const body = fs.readFileSync(skillFile, "utf8");
      if (body.includes("name: native-runtime-skill-probe-20260928") && body.includes("NATIVE_SKILL_RUNTIME_20260928_OK")) {
        skillValidation = " NATIVE_SKILL_RUNTIME_20260928_OK";
      }
    } catch { /* a missing or invalid skill cannot satisfy the probe */ }
  }
  return JSON.stringify({ tasks: [{
    name: "native-smoke",
    repositoryUrl,
    goal: "test: prove native ACP planning transport",
    validation: "The native planning smoke reaches terminal settlement." + skillValidation,
    dependsOn: [],
    acceptanceCriteria: [{
      id: "AC-1",
      description: "The native planning assignment settles successfully.",
      evidenceExpectation: "The terminal settlement records an accepted candidate."
    }]
  }] });
};
readline.createInterface({ input: process.stdin }).on("line", line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  if (request.method === "session/prompt") output({
    jsonrpc: "2.0", method: "session/update", params: {
      sessionId: request.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: planningProposal(request) } }
    }
  });
  const result = request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Konteks E2E Fake Codex ACP", version: "1.0.0" }, authMethods: [] }
    : request.method === "session/new" ? { sessionId: "e2e-session-" + (++sessions), configOptions: modelOptions("e2e-model") }
    : request.method === "session/prompt" ? { stopReason: "end_turn", usage: { totalTokens: 2, inputTokens: 1, outputTokens: 1 } }
    : request.method === "session/load" || request.method === "session/cancel" || request.method === "session/set_mode" ? {}
    : request.method === "session/set_config_option" && request.params.configId === "model" && request.params.value === "e2e-model" ? { configOptions: modelOptions(request.params.value) }
    : null;
  if (result === null) output({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
  else output({ jsonrpc: "2.0", id: request.id, result });
});
`; }

function tar(entries: { path: string; bytes: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512); header.write(entry.path, 0, 100); header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116); header.write(`${entry.bytes.length.toString(8).padStart(11,"0")}\0`,124); header.write("00000000000\0",136); header.fill(32,148,156); header.write("0",156); header.write("ustar\0",257); header.write("00",263); header.write(`${header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,"0")}\0 `,148);
    chunks.push(header, entry.bytes, Buffer.alloc((512-entry.bytes.length%512)%512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
