import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { gzipSync } from "node:zlib";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  RemoteInstanceError,
  agentModelCapabilityMappingSigningBytes,
  computeAgentModelCapabilityMappingDigest,
  type AgentModelCapabilityMapping,
  type RemoteNativeArtifact,
} from "@konteks/remote-common";
import { EmbeddedReleaseRootSchema, HOST_AGENT_BRIDGES, installOfflineAgentPackage, reviewedNativeModelIdentities, NativeAgentPackageProfileSchema, OFFLINE_AGENT_LIMITS, signNativeReleaseManifest, verifyNativeRelease, type EmbeddedReleaseRoot, type NativeAgentPackageProfile } from "@konteks/remote-release";
import type { RemoteSignedBundleManifest } from "@konteks/remote-common";
import { insideE2EBoundary, plainLoopbackUrl } from "./boundary.js";

interface E2ESmokeReleaseOptions {
  gate: string | undefined;
  directory: string;
  origin: string;
  platform: { os: "macos" | "debian"; architecture: "amd64" | "arm64" };
}

interface E2ERealReleaseOptions extends Omit<E2ESmokeReleaseOptions, "gate"> {
  realAgentGate: string | undefined;
  bundleVersion?: string;
  packagePath: string | readonly string[];
  profilePath: string | readonly string[];
}

interface E2EAdditionalPlatformOptions extends E2ESmokeReleaseOptions {
  bundleVersion: string;
}

interface E2ERealAdditionalPlatformOptions extends Omit<E2EAdditionalPlatformOptions, "platform"> {
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
  const { previous, root, privateKey } = await extendableRelease(options, origin);
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
  const manifest = extendedManifest(previous, options.bundleVersion, [connectorArtifact, agentArtifact],
    signedMapping(bridgeMappingBody(`e2e-codex-${suffix}-model`, agentArtifact, [{ value: "e2e-model", canonicalProviderId: "e2e", canonicalModelId: "e2e-model" }]), root.keyId, privateKey), { keyId: root.keyId, privateKey });
  await writeFile(join(options.directory, connectorName), connector, { flag: "wx", mode: 0o700 });
  await writeFile(join(options.directory, agentName), archive, { flag: "wx", mode: 0o600 });
  const scratch = await mkdtemp(join(options.directory, ".manifest-"));
  try {
    await replaceManifest(options.directory, scratch, manifest);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { root, manifest, artifactFiles: { connector: join(options.directory, connectorName), agent: join(options.directory, agentName) } };
}

/** Add a separately built Windows connector and complete Codex package to the private local release. */
export async function extendE2ERealRelease(options: E2ERealAdditionalPlatformOptions) {
  releaseBoundary(options);
  if (options.realAgentGate !== "1" || ![options.connectorPath, options.packagePath, options.profilePath].every(isAbsolute)) fail();
  const origin = localOrigin(options.origin);
  const { previous, root, privateKey } = await extendableRelease(options, origin);
  const suffix = `${options.platform.os}-${options.platform.architecture}`;
  const connectorName = `connector-${suffix}.exe`, agentName = `codex-${suffix}.tgz`;
  const validationRoot = await mkdtemp(join(options.directory, ".real-package-validation-"));
  try {
    const staged = await stageRealWindowsPackage(options, validationRoot, connectorName, agentName);
    const connectorArtifact: RemoteNativeArtifact = {
      id: `e2e-real-connector-${suffix}`, kind: "connector", format: "executable", ...options.platform,
      url: `${origin}/__e2e/native/${connectorName}`, digest: await shaFile(staged.connector), sizeBytes: staged.connectorSize,
    };
    const agentArtifact: RemoteNativeArtifact = {
      id: `e2e-real-codex-acp-${suffix}`, kind: "agent_bridge", format: "offline_agent_tgz", agentId: "codex", ...options.platform,
      url: `${origin}/__e2e/native/${agentName}`, digest: await shaFile(staged.archive), profileDigest: sha(staged.profileBytes), sizeBytes: staged.archiveSize,
    };
    await installOfflineAgentPackage(staged.archive, join(validationRoot, "installed-agent"), agentArtifact);
    const manifest = extendedManifest(previous, options.bundleVersion, [connectorArtifact, agentArtifact],
      signedMapping(bridgeMappingBody(`e2e-codex-${suffix}-model`, agentArtifact, [{ value: "gpt-5.6-sol", canonicalProviderId: "openai", canonicalModelId: "gpt-5.6-sol" }]), root.keyId, privateKey), { keyId: root.keyId, privateKey });
    const connectorDestination = join(options.directory, connectorName), agentDestination = join(options.directory, agentName);
    if (await exists(connectorDestination) || await exists(agentDestination)) fail();
    await rename(staged.connector, connectorDestination);
    await rename(staged.archive, agentDestination);
    await replaceManifest(options.directory, validationRoot, manifest);
    return { root, manifest, artifactFiles: { connector: connectorDestination, agent: agentDestination } };
  } finally { await rm(validationRoot, { recursive: true, force: true }); }
}

/** The local release, verified, with no artifact yet for this platform, and the local key it is signed with. */
async function extendableRelease(options: { directory: string; platform: { os: string; architecture: string }; bundleVersion: string }, origin: string) {
  const { roots, manifest: previous } = await currentRelease(options.directory);
  if (previous.nativeArtifacts?.some(artifact => artifact.os === options.platform.os && artifact.architecture === options.platform.architecture)
    || previous.nativeArtifacts?.some(artifact => new URL(artifact.url).origin !== origin)
    || options.bundleVersion === previous.bundleVersion) fail();
  return { previous, ...await localSigningRoot(options.directory, roots) };
}

async function currentRelease(directory: string): Promise<{ roots: EmbeddedReleaseRoot[]; manifest: RemoteSignedBundleManifest }> {
  const roots = EmbeddedReleaseRootSchema.array().parse(JSON.parse(await readFile(join(directory, "release-roots.json"), "utf8")).roots);
  return { roots, manifest: verifyNativeRelease(JSON.parse(await readFile(join(directory, "native-manifest.json"), "utf8")), roots).manifest };
}

/** The local release root and its private key, which must be the root's own. */
async function localSigningRoot(directory: string, roots: readonly EmbeddedReleaseRoot[]): Promise<{ root: EmbeddedReleaseRoot; privateKey: KeyObject }> {
  const privateKey = await e2eSigningKey(directory);
  const root = roots.find(candidate => candidate.keyId === "e2e-local-native-release-1");
  if (!root || createPublicKey(privateKey).export({ format: "jwk" }).x !== root.publicKeyJwk.x) fail();
  return { root, privateKey };
}

/** Copies of the built connector and package (and the package's profile), each a single, non-empty regular file. */
async function stageRealWindowsPackage(options: E2ERealAdditionalPlatformOptions, validationRoot: string, connectorName: string, agentName: string) {
  const [connectorInfo, packageInfo, profileInfo] = await Promise.all([
    lstat(options.connectorPath).catch(fail),
    lstat(options.packagePath).catch(fail),
    lstat(options.profilePath).catch(fail),
  ]);
  if (!nonEmptyFile(connectorInfo) || !nonEmptyFile(packageInfo) || !profileFile(profileInfo)) fail();
  const profileBytes = await readFile(options.profilePath);
  const profile = parsePackageProfile(profileBytes);
  if (profile.agentId !== "codex" || !profileFor(profile, options.platform)) fail();
  const connector = join(validationRoot, connectorName), archive = join(validationRoot, agentName);
  await Promise.all([copyFile(options.connectorPath, connector), copyFile(options.packagePath, archive)]);
  await Promise.all([chmod(connector, 0o700), chmod(archive, 0o600)]);
  const stagedConnectorInfo = await lstat(connector), stagedPackageInfo = await lstat(archive);
  if (stagedConnectorInfo.size !== connectorInfo.size || stagedPackageInfo.size !== packageInfo.size) fail();
  return { connector, archive, profileBytes, connectorSize: stagedConnectorInfo.size, archiveSize: stagedPackageInfo.size };
}

function nonEmptyFile(info: Stats): boolean {
  return info.isFile() && info.nlink === 1 && info.size >= 1;
}

function profileFile(info: Stats): boolean {
  return info.isFile() && info.nlink === 1 && info.size <= OFFLINE_AGENT_LIMITS.profileBytes;
}

function parsePackageProfile(profileBytes: Buffer): NativeAgentPackageProfile {
  try { return NativeAgentPackageProfileSchema.parse(JSON.parse(profileBytes.toString("utf8"))); } catch { return fail(); }
}

/** A real package for this platform, never the fake bridge. */
function profileFor(profile: NativeAgentPackageProfile, platform: { os: string; architecture: string }): boolean {
  return profile.os === platform.os && profile.architecture === platform.architecture && !profile.bridge.entrypoint.endsWith("/fake-codex-acp");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

/** The previous manifest with the new artifacts and mapping, re-signed at another version. */
function extendedManifest(previous: RemoteSignedBundleManifest, bundleVersion: string, artifacts: RemoteNativeArtifact[], mapping: AgentModelCapabilityMapping, key: { keyId: string; privateKey: KeyObject }) {
  const { digest: _digest, signature: _signature, ...unsigned } = previous;
  return signNativeReleaseManifest({
    ...unsigned, bundleVersion,
    nativeArtifacts: [...(previous.nativeArtifacts ?? []), ...artifacts],
    modelCapabilityMappings: [...(previous.modelCapabilityMappings ?? []), mapping],
  }, key);
}

/** Written in `scratch`, then renamed over the served manifest. */
async function replaceManifest(directory: string, scratch: string, manifest: RemoteSignedBundleManifest): Promise<void> {
  await writeFile(join(scratch, "native-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  await rename(join(scratch, "native-manifest.json"), join(directory, "native-manifest.json"));
}

type MappingBody = Omit<AgentModelCapabilityMapping, "mappingDigest" | "signature">;

/**
 * The local stack may deliberately lengthen Core's seven-day default while
 * exercising interrupted provisioning. Its checked-in development manifest
 * uses a one-year envelope, so match that boundary plus preparation headroom;
 * otherwise pairing fails closed before any release is installed.
 */
function mappingEnvelope(): { issuedAt: string; expiresAt: string } {
  const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 370 * 24 * 60 * 60 * 1000);
  return { issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

function bridgeMappingBody(mappingId: string, artifact: RemoteNativeArtifact, modelIdentities: MappingBody["modelIdentities"], envelope = mappingEnvelope()): MappingBody {
  return {
    version: 1, mappingId, mappingRevision: 1,
    bridgeProfileRef: artifact.id, bridgeArtifactDigest: artifact.digest,
    configId: "model", optionType: "select",
    modelIdentities,
    ...envelope,
  };
}

/** The mapping with its digest, signed by the local release key. */
function signedMapping(body: MappingBody, keyId: string, privateKey: KeyObject): AgentModelCapabilityMapping {
  const mappingUnsigned = { ...body, mappingDigest: computeAgentModelCapabilityMappingDigest(body) };
  const mappingPlaceholder: AgentModelCapabilityMapping = { ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId, value: "AA" } };
  return { ...mappingUnsigned, signature: { algorithm: "Ed25519", keyId, value: sign(null, agentModelCapabilityMappingSigningBytes(mappingPlaceholder), privateKey).toString("base64url") } };
}

/** Prepare a signed local release from a separately built, complete Codex or Claude Code package. */
export async function prepareE2ERealRelease(options: E2ERealReleaseOptions) {
  const packagePaths = typeof options.packagePath === "string" ? [options.packagePath] : [...options.packagePath];
  const profilePaths = typeof options.profilePath === "string" ? [options.profilePath] : [...options.profilePath];
  if (options.realAgentGate !== "1" || !realPackagePaths(packagePaths, profilePaths)) fail();
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
      const { artifact, destination } = await addRealPackage(options, origin, validationRoot, { packagePath, profilePath: profilePaths[index]! }, artifacts);
      artifacts.push(artifact);
      artifactFiles[artifact.agentId!] = destination;
    }
  }
  catch { return fail(); }
  finally { await rm(validationRoot, { recursive: true, force: true }); }
  await writeFile(connectorPath, connector, { mode: 0o700 });
  return writeSignedRelease(options, origin, connector, artifacts, connectorPath, artifactFiles, options.bundleVersion);
}

/** One to four absolute package and profile paths, in pairs. */
function realPackagePaths(packagePaths: readonly string[], profilePaths: readonly string[]): boolean {
  return packagePaths.length >= 1 && packagePaths.length <= 4 && packagePaths.length === profilePaths.length
    && packagePaths.every(path => isAbsolute(path)) && profilePaths.every(path => isAbsolute(path));
}

/** One real Codex or Claude Code package, verified by installing it, then moved beside the release. */
async function addRealPackage(options: E2ERealReleaseOptions, origin: string, validationRoot: string, paths: { packagePath: string; profilePath: string }, added: readonly RemoteNativeArtifact[]) {
  const [packageInfo, profileInfo] = await Promise.all([lstat(paths.packagePath).catch(fail), lstat(paths.profilePath).catch(fail)]);
  if (!nonEmptyFile(packageInfo) || !profileFile(profileInfo)) fail();
  const profileBytes = await readFile(paths.profilePath);
  const profile = parsePackageProfile(profileBytes);
  if (!realAgent(profile.agentId) || added.some(artifact => artifact.agentId === profile.agentId) || !profileFor(profile, options.platform)) fail();
  const agentFile = `${profile.agentId}.tgz`;
  const stagedArchive = join(validationRoot, agentFile);
  await copyFile(paths.packagePath, stagedArchive);
  await chmod(stagedArchive, 0o600);
  const stagedPackageInfo = await lstat(stagedArchive).catch(fail);
  if (!nonEmptyFile(stagedPackageInfo) || stagedPackageInfo.size !== packageInfo.size) fail();
  const artifact: RemoteNativeArtifact = {
    id: `e2e-real-${profile.agentId}-acp`, kind: "agent_bridge", format: "offline_agent_tgz", agentId: profile.agentId, ...options.platform,
    url: `${origin}/__e2e/native/${agentFile}`, digest: await shaFile(stagedArchive), profileDigest: sha(profileBytes), sizeBytes: stagedPackageInfo.size,
  };
  await installOfflineAgentPackage(stagedArchive, join(validationRoot, `agent-${profile.agentId}`), artifact);
  const destination = join(options.directory, agentFile);
  await rename(stagedArchive, destination);
  return { artifact, destination };
}

function realAgent(agentId: string): boolean {
  return agentId === "codex" || agentId === "claude-code";
}

async function writeSignedRelease(options: Pick<E2ESmokeReleaseOptions, "directory" | "platform">, origin: string, connector: Buffer, agentArtifacts: RemoteNativeArtifact[], connectorPath: string, agentFiles: Record<string, string>, bundleVersion = "0.1.0-e2e") {
  const connectorArtifact: RemoteNativeArtifact = { id: "e2e-source-connector", kind: "connector", format: "executable", ...options.platform, url: `${origin}/__e2e/native/connector`, digest: sha(connector), sizeBytes: connector.length };
  const privateKey = await e2eSigningKey(options.directory);
  const keyId = "e2e-local-native-release-1";
  const envelope = mappingEnvelope();
  const mappings = [
    ...agentArtifacts.map(artifact => signedMapping(bridgeMappingBody(`e2e-${artifact.agentId}-model`, artifact, e2eModelIdentities(artifact), envelope), keyId, privateKey)),
    ...HOST_AGENT_BRIDGES.filter(family => family.hostInstall && reviewedNativeModelIdentities(family.agentId)).map(family => signedMapping(hostMappingBody(family, envelope), keyId, privateKey)),
  ];
  const manifest = signNativeReleaseManifest({
    bundleVersion, protocol: { min: "1.0", max: "1.0" }, deploymentKind: "native_connector", components: ["agent_runner"], images: [], agentBridges: [], nativeArtifacts: [connectorArtifact, ...agentArtifacts], modelCapabilityMappings: mappings, expiresAt: envelope.expiresAt,
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

/**
 * Claude Code advertises short, moving selectors over ACP. Keep those
 * transport values local to the bridge while giving Core the reviewed,
 * canonical identities it needs for route and distinct-model authority.
 */
function e2eModelIdentities(artifact: RemoteNativeArtifact): MappingBody["modelIdentities"] {
  if (artifact.agentId === "claude-code") {
    return [
      { value: "default", canonicalProviderId: "anthropic", canonicalModelId: "claude-opus-5[1m]" },
      { value: "opus[1m]", canonicalProviderId: "anthropic", canonicalModelId: "claude-opus-5[1m]" },
      { value: "claude-fable-5-1[1m]", canonicalProviderId: "anthropic", canonicalModelId: "claude-fable-5-1" },
      { value: "sonnet", canonicalProviderId: "anthropic", canonicalModelId: "claude-sonnet-5" },
      { value: "haiku", canonicalProviderId: "anthropic", canonicalModelId: "claude-haiku-4-5-20251001" },
    ];
  }
  return artifact.id.startsWith("e2e-fake-")
    ? [{ value: "e2e-model", canonicalProviderId: "e2e", canonicalModelId: "e2e-model" }]
    : [{ value: "gpt-5.6-sol", canonicalProviderId: "openai", canonicalModelId: "gpt-5.6-sol" }];
}

/**
 * A host-installed agent (the person's own DeepSeek Harness) ships no
 * artifact; its reviewed mapping names the agent and the versions this
 * runtime supports, with the same canonical identities Core routes on. An
 * agent with no reviewed identities (OpenCode) reports under its catalogue
 * authority instead, as in a production release (release/src/native.ts).
 */
function hostMappingBody(family: (typeof HOST_AGENT_BRIDGES)[number], envelope: { issuedAt: string; expiresAt: string }): MappingBody {
  return {
    version: 1,
    mappingId: `e2e-${family.agentId}-model`,
    mappingRevision: 1,
    hostAgent: { agentId: family.agentId, versions: { ...family.hostInstall!.versions } },
    configId: "model",
    optionType: "select",
    modelIdentities: (reviewedNativeModelIdentities(family.agentId) ?? []).map(identity => ({ ...identity })),
    ...envelope,
  };
}

async function localControlAuthority(
  directory: string,
): Promise<{ keyId: string; publicKeyJwk: EmbeddedReleaseRoot["publicKeyJwk"] } | null> {
  const path = join(dirname(directory), "private", "native-control-public.json");
  const info = await lstat(path).catch((error) => {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!info) return null;
  if (!privateSmallFile(info)) fail();
  try {
    const key = EmbeddedReleaseRootSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (key.keyId !== "e2e-local-native-control-1" || key.coreControlKeys !== undefined) fail();
    return { keyId: key.keyId, publicKeyJwk: key.publicKeyJwk };
  } catch {
    return fail();
  }
}

/** A single regular file of at most 4 KiB, readable by its owner only (where the OS has modes). */
function privateSmallFile(info: Stats): boolean {
  return info.isFile() && info.nlink === 1 && info.size <= 4096 && (process.platform === "win32" || (info.mode & 0o077) === 0);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Re-sign the local release at another version, keeping its agent
 * packages and model mappings, and optionally replacing the connector with a
 * runnable one so the connector can run as a real OS service. The update path
 * — stage, drain, swap, health gate, roll back — only runs for a connector the
 * OS service manager owns. E2E-only: signed by the stack's own local key.
 */
export async function reissueE2ERelease(options: { directory: string; bundleVersion: string; connectorPath?: string; platform?: { os: "windows"; architecture: "amd64" | "arm64" } }) {
  const manifestPath = join(options.directory, "native-manifest.json");
  const { roots, manifest: current } = await currentRelease(options.directory);
  if (options.bundleVersion === current.bundleVersion || options.platform && !options.connectorPath) fail();
  const { digest: _digest, signature: _signature, ...unsigned } = current;
  const { connectorName, target } = reissuedConnector(current, options);
  const scratch = await mkdtemp(join(options.directory, ".reissue-"));
  try {
    const nativeArtifacts = options.connectorPath
      ? await withReplacedConnector(current.nativeArtifacts, target!, options.connectorPath, join(scratch, connectorName))
      : current.nativeArtifacts;
    const { root, privateKey } = await localSigningRoot(options.directory, roots);
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

/** The connector artifact a runnable connector replaces (the platform's own, or the source one). */
function reissuedConnector(current: RemoteSignedBundleManifest, options: { connectorPath?: string; platform?: { os: string; architecture: string } }) {
  const connectorName = options.platform ? `connector-${options.platform.os}-${options.platform.architecture}.exe` : "connector";
  const target = current.nativeArtifacts?.find(artifact => artifact.kind === "connector" && new URL(artifact.url).pathname === `/__e2e/native/${connectorName}`);
  if (options.connectorPath && !target) fail();
  return { connectorName, target };
}

/** The artifacts with `target` pointing at a staged copy of the runnable connector. */
async function withReplacedConnector(artifacts: RemoteSignedBundleManifest["nativeArtifacts"], target: RemoteNativeArtifact, connectorPath: string, staged: string): Promise<RemoteSignedBundleManifest["nativeArtifacts"]> {
  if (!isAbsolute(connectorPath)) fail();
  const info = await lstat(connectorPath).catch(fail);
  if (!nonEmptyFile(info)) fail();
  await copyFile(connectorPath, staged);
  await chmod(staged, 0o700);
  const digest = await shaFile(staged);
  return artifacts?.map(artifact => artifact.id === target.id ? { ...artifact, digest, sizeBytes: info.size } : artifact);
}

/** Stable private test authority lives outside the directory served by TLS. */
async function e2eSigningKey(publicDirectory: string): Promise<KeyObject> {
  const path = join(dirname(publicDirectory), "private", "native-release-signing-key.pk8");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return await readSigningKey(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
  const generated = generateKeyPairSync("ed25519").privateKey;
  const bytes = generated.export({ format: "der", type: "pkcs8" });
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    return generated;
  } catch (error) {
    // Another preparation wrote it first: use that one.
    if (!isErrorCode(error, "EEXIST")) throw error;
    return readSigningKey(path);
  }
}

async function readSigningKey(path: string): Promise<KeyObject> {
  const info = await lstat(path);
  if (!privateSmallFile(info)) fail();
  return createPrivateKey({ key: await readFile(path), format: "der", type: "pkcs8" });
}

function releaseBoundary(options: Pick<E2ESmokeReleaseOptions, "gate" | "directory">): void {
  if (!insideE2EBoundary(options.gate, options.directory)) fail();
}

function localOrigin(raw: string): string {
  try {
    const value = new URL(raw);
    if (value.protocol === "https:" && value.port === "7443" && plainLoopbackUrl(value, "/")) return value.origin;
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
