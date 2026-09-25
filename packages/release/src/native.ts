import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  RemoteInstanceError, RemoteSignedBundleManifestSchema, bundleManifestSigningBytes,
  agentModelCapabilityMappingSigningBytes, computeAgentModelCapabilityMappingDigest,
  computeBundleManifestDigest, ed25519Sign, ed25519Verify,
  parseRfc3339, verifyBundleManifestTrust,
  type AgentModelCapabilityMapping, type RemoteNativeArtifact, type RemoteSignedBundleManifest,
} from "@konteks/remote-common";
import type { EmbeddedReleaseRoot } from "./manifest.js";
import { reviewedNativeModelIdentities } from "./reviewed-model-capabilities.js";

const verified = Symbol("verified-native-release");
export interface VerifiedNativeRelease {
  readonly manifest: RemoteSignedBundleManifest;
  readonly [verified]: true;
}

/** Release-CI signer for the exact manifest consumed by native installation. */
export function signNativeReleaseManifest(
  unsigned: Omit<RemoteSignedBundleManifest, "digest" | "signature">,
  key: { keyId: string; privateKey: KeyObject },
): RemoteSignedBundleManifest {
  const digest = computeBundleManifestDigest(unsigned);
  const withDigest = { ...unsigned, digest } as Omit<RemoteSignedBundleManifest, "signature">;
  return RemoteSignedBundleManifestSchema.parse({
    ...withDigest,
    signature: { algorithm: "Ed25519", keyId: key.keyId, value: ed25519Sign(key.privateKey, bundleManifestSigningBytes(withDigest)) },
  });
}

/**
 * Production release signer. Every reviewed selector mapping is bound to one
 * exact bridge artifact and signed independently before the surrounding
 * manifest is signed. The runtime can therefore publish only model authority
 * that travelled with the installed, verified artifact.
 */
export function signNativeProductionReleaseManifest(
  unsigned: Omit<RemoteSignedBundleManifest, "digest" | "signature">,
  key: { keyId: string; privateKey: KeyObject },
  now = new Date(),
): RemoteSignedBundleManifest {
  const issuedAt = now.toISOString();
  const mappings = (unsigned.nativeArtifacts ?? []).flatMap(artifact => {
    if (artifact.kind !== "agent_bridge" || !artifact.agentId) return [];
    const modelIdentities = reviewedNativeModelIdentities(artifact.agentId);
    if (!modelIdentities) return [];
    const body = {
      version: 1 as const,
      mappingId: `${artifact.id}-models`,
      mappingRevision: 1,
      bridgeProfileRef: artifact.id,
      bridgeArtifactDigest: artifact.digest,
      configId: "model",
      optionType: "select" as const,
      modelIdentities: modelIdentities.map(identity => ({ ...identity })),
      issuedAt,
      expiresAt: unsigned.expiresAt,
    };
    const withDigest = {
      ...body,
      mappingDigest: computeAgentModelCapabilityMappingDigest(body),
    };
    const placeholder: AgentModelCapabilityMapping = {
      ...withDigest,
      signature: { algorithm: "Ed25519", keyId: key.keyId, value: "AA" },
    };
    return [{
      ...withDigest,
      signature: {
        algorithm: "Ed25519" as const,
        keyId: key.keyId,
        value: ed25519Sign(
          key.privateKey,
          agentModelCapabilityMappingSigningBytes(placeholder),
        ),
      },
    }];
  });
  return signNativeReleaseManifest({ ...unsigned, modelCapabilityMappings: mappings }, key);
}

/** Adapted from bb's host-only update pipeline; Konteks additionally requires release-root signatures. */
export function verifyNativeRelease(payload: unknown, roots: readonly EmbeddedReleaseRoot[], nowMs = Date.now()): VerifiedNativeRelease {
  const manifest = RemoteSignedBundleManifestSchema.parse(payload);
  if (manifest.deploymentKind !== "native_connector") throw new RemoteInstanceError("bundle_untrusted", "a native connector requires a native release");
  const keys = new Map(roots.map(root => [root.keyId, createPublicKey({ key: { ...root.publicKeyJwk }, format: "jwk" })]));
  const verdict = verifyBundleManifestTrust({ manifest, independentManifest: manifest, releaseRoots: keys, now: new Date(nowMs).toISOString(), supportedProtocol: { min: "1.0", max: "1.0" } });
  if (!verdict.trusted) throw new RemoteInstanceError("bundle_untrusted", `native release verification failed (${verdict.reason})`);
  for (const mapping of manifest.modelCapabilityMappings ?? []) {
    const key = keys.get(mapping.signature.keyId);
    if (!key || !ed25519Verify(key, agentModelCapabilityMappingSigningBytes(mapping), mapping.signature.value)
      || parseRfc3339(mapping.expiresAt) <= nowMs || parseRfc3339(mapping.issuedAt) > nowMs + 5 * 60_000) {
      throw new RemoteInstanceError("bundle_untrusted", "native model capability mapping is not trusted by the accepted release root");
    }
  }
  freezeJson(manifest);
  return Object.freeze({ manifest, [verified]: true as const });
}

export interface VerifiedNativeModelCapabilityMapping {
  agentId: string;
  mapping: AgentModelCapabilityMapping;
}

/** Derives agent identity only from the exact artifact already bound by the strict manifest. */
export function selectNativeModelCapabilityMappings(release: VerifiedNativeRelease): VerifiedNativeModelCapabilityMapping[] {
  if (release[verified] !== true) throw new RemoteInstanceError("bundle_untrusted", "native release has not been verified");
  return (release.manifest.modelCapabilityMappings ?? []).map(mapping => {
    const artifact = release.manifest.nativeArtifacts?.find(candidate => candidate.kind === "agent_bridge"
      && candidate.id === mapping.bridgeProfileRef && candidate.digest === mapping.bridgeArtifactDigest);
    if (!artifact?.agentId) throw new RemoteInstanceError("bundle_untrusted", "native model mapping lost its exact bridge binding");
    return { agentId: artifact.agentId, mapping };
  });
}

export interface NativeArtifactTarget {
  os: "macos" | "windows" | "debian";
  architecture: "amd64" | "arm64";
  agentIds: readonly string[];
}

export function selectNativeArtifacts(release: VerifiedNativeRelease, target: NativeArtifactTarget): RemoteNativeArtifact[] {
  if (release[verified] !== true) throw new RemoteInstanceError("bundle_untrusted", "native release has not been verified");
  const available = (release.manifest.nativeArtifacts ?? []).filter(artifact => artifact.os === target.os && artifact.architecture === target.architecture);
  const select = (kind: RemoteNativeArtifact["kind"], agentId?: string): RemoteNativeArtifact => {
    const found = available.filter(artifact => artifact.kind === kind && artifact.agentId === agentId);
    if (found.length !== 1) throw new RemoteInstanceError("bundle_untrusted", `release must contain exactly one ${agentId ?? "connector"} artifact for ${target.os}/${target.architecture}`);
    return found[0]!;
  };
  if (new Set(target.agentIds).size !== target.agentIds.length) throw new RemoteInstanceError("bundle_untrusted", "duplicate requested agents");
  return [select("connector"), ...target.agentIds.map(agent => select("agent_bridge", agent))];
}

function freezeJson(value: object): void {
  for (const child of Object.values(value)) if (child !== null && typeof child === "object") freezeJson(child);
  Object.freeze(value);
}

/**
 * Stage immutable candidates without changing the running installation. As in
 * bb's updater, failed downloads leave the existing host running. Unlike its
 * optional response-header digest, every byte here must match signed metadata.
 * Package installation, service restart, health gating, and pointer commit are
 * deliberately separate operations; downloading does not execute a package.
 */
export async function stageNativeRelease(args: {
  release: VerifiedNativeRelease;
  target: NativeArtifactTarget;
  releasesDir: string;
  fetchFn?: typeof fetch;
}): Promise<{ directory: string; connector: string; bridges: Record<string, string> }> {
  if (!isAbsolute(args.releasesDir)) throw new Error("native release directory must be absolute");
  const artifacts = selectNativeArtifacts(args.release, args.target);
  await mkdir(args.releasesDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(args.releasesDir, ".candidate-"));
  const fetchFn = args.fetchFn ?? fetch;
  const result = { directory, connector: "", bridges: {} as Record<string, string> };
  try {
    for (const [index, artifact] of artifacts.entries()) {
      const extension = artifact.format !== "executable" ? ".tgz" : args.target.os === "windows" ? ".exe" : "";
      // File names never come from untrusted URL paths or manifest identifiers.
      const file = join(directory, `${index === 0 ? "connector" : `bridge-${index}`}${extension}`);
      // Release hosts redirect to an asset store; every byte is still pinned by
      // the signed digest and size, so only the final scheme is constrained.
      const response = await fetchFn(artifact.url, { redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body || (response.url && !response.url.startsWith("https://"))) throw new Error("native artifact download failed");
      const handle = await open(file, "wx", 0o600);
      let size = 0;
      const hash = createHash("sha256");
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > artifact.sizeBytes) throw new Error("native artifact exceeds its signed size");
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        if (size !== artifact.sizeBytes || `sha256:${hash.digest("hex")}` !== artifact.digest) throw new Error("native artifact size or digest mismatch");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (artifact.format === "executable") await chmod(file, 0o700);
      if (artifact.kind === "connector") result.connector = file;
      else result.bridges[artifact.agentId!] = file;
    }
    return result;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new RemoteInstanceError("bundle_untrusted", "native artifacts were not staged; the existing install was not changed", { cause: error });
  }
}

/** Stable channel: the newest non-prerelease GitHub release of konteks-io/runtime. */
export const NATIVE_MANIFEST_URL = "https://github.com/konteks-io/runtime/releases/latest/download/native-manifest.json";

/** Developer/e2e override; the embedded default is the public stable channel. */
export function nativeManifestUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KONTEKS_RELEASE_MANIFEST_URL;
  if (!override) return NATIVE_MANIFEST_URL;
  const url = new URL(override);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("KONTEKS_RELEASE_MANIFEST_URL must be a plain https URL");
  return url.toString();
}

/**
 * Fetch one bounded native manifest document. Release hosts answer with a
 * redirect to their asset store, so redirects are followed but must stay on
 * https; integrity never depends on the host because the document is signed.
 * Verification is separate (`verifyNativeRelease`) so callers decide which
 * embedded roots apply.
 */
export async function fetchNativeReleaseManifest(fetchFn: typeof fetch = fetch, url: string = nativeManifestUrl()): Promise<unknown> {
  const response = await fetchFn(url, { redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body || (response.url && !response.url.startsWith("https://"))) throw new Error("native manifest download failed");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error("native manifest exceeds its size bound");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
