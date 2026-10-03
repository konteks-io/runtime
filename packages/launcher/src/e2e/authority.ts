import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { RemoteInstanceError, type RemoteSignedBundleManifest } from "@konteks/remote-common";
import { loadReleaseRootsFile, verifyNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import { insideE2EBoundary, plainLoopbackUrl } from "./boundary.js";

interface E2EInstallAuthorityInput {
  gate: string | undefined;
  directory: string;
  manifestFile: string;
  rootsFile: string;
  caFile: string;
  nodeExtraCaCerts: string | undefined;
  coreUrl: string;
  relayUrl: string;
}

/**
 * Development-only authority used by the sibling E2E controller. This module
 * is never imported by the shipped launcher entrypoint. It cannot introduce
 * an unsigned mode: its private manifest must verify under a separately named
 * E2E public root and both network endpoints must be the one loopback TLS edge.
 */
export async function loadE2EInstallAuthority(input: E2EInstallAuthorityInput): Promise<{
  roots: EmbeddedReleaseRoot[];
  manifest: RemoteSignedBundleManifest;
}> {
  if (!insideE2EBoundary(input.gate, input.directory)) fail();
  const directory = await realpath(input.directory).catch(fail);
  const [manifestFile, rootsFile, caFile] = await Promise.all([input.manifestFile, input.rootsFile, input.caFile].map(path => privateFileIn(directory, path)));
  if (!input.nodeExtraCaCerts || await realpath(input.nodeExtraCaCerts).catch(fail) !== caFile) fail();
  const core = loopback(input.coreUrl, "https:", "/");
  const relay = loopback(input.relayUrl, "wss:", "/relay/runtime");
  if (core.host !== relay.host) fail();
  const roots = await loadReleaseRootsFile(rootsFile!).catch(fail);
  if (roots.length === 0 || roots.some(root => !/^e2e-local-[A-Za-z0-9._-]{1,96}$/.test(root.keyId))) fail();
  const manifest = await localSignedManifest(manifestFile!, roots);
  return { roots, manifest };
}

function fail(): never {
  throw new RemoteInstanceError("bundle_untrusted", "E2E native install authority is invalid or unavailable.");
}

/** The file's real path, which must be a private regular file directly in `directory`. */
async function privateFileIn(directory: string, path: string): Promise<string> {
  if (!isAbsolute(path)) fail();
  const resolved = await realpath(path).catch(fail);
  const info = await lstat(resolved).catch(fail);
  if (dirname(resolved) !== directory || !info.isFile() || info.nlink !== 1 || process.platform !== "win32" && (info.mode & 0o077) !== 0) fail();
  return resolved;
}

/** The manifest, verified and signed by one of the local E2E roots. */
async function localSignedManifest(manifestFile: string, roots: EmbeddedReleaseRoot[]): Promise<RemoteSignedBundleManifest> {
  let payload: unknown;
  try { payload = JSON.parse(await readFile(manifestFile, "utf8")); } catch { fail(); }
  const release = (() => { try { return verifyNativeRelease(payload, roots); } catch { return fail(); } })();
  const keyId = release.manifest.signature.keyId;
  if (!keyId.startsWith("e2e-local-") || !roots.some(root => root.keyId === keyId)) fail();
  return release.manifest;
}

function loopback(raw: string, protocol: "https:" | "wss:", pathname: string): URL {
  const outside = (): never => { throw new RemoteInstanceError("bundle_untrusted", "E2E native install authority is restricted to the local TLS edge."); };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return outside(); }
  if (parsed.protocol !== protocol || parsed.port !== "7443" || !plainLoopbackUrl(parsed, pathname)) outside();
  return parsed;
}
