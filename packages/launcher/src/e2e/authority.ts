import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, sep } from "node:path";
import { RemoteInstanceError, type RemoteSignedBundleManifest } from "@konteks/remote-common";
import { loadReleaseRootsFile, verifyNativeRelease, type EmbeddedReleaseRoot } from "@konteks/remote-release";

export interface E2EInstallAuthorityInput {
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
  const fail = (): never => { throw new RemoteInstanceError("bundle_untrusted", "E2E native install authority is invalid or unavailable."); };
  if (input.gate !== "1" || !isAbsolute(input.directory) || normalize(input.directory).split(sep).slice(-2).join("/") !== ".runtime/native-cloud") fail();
  const directory = await realpath(input.directory).catch(fail);
  const paths = await Promise.all([input.manifestFile, input.rootsFile, input.caFile].map(async path => {
    if (!isAbsolute(path)) fail();
    const resolved = await realpath(path).catch(fail);
    const info = await lstat(resolved).catch(fail);
    if (dirname(resolved) !== directory || !info.isFile() || info.nlink !== 1 || process.platform !== "win32" && (info.mode & 0o077) !== 0) fail();
    return resolved;
  }));
  const manifestFile = paths[0]!, rootsFile = paths[1]!, caFile = paths[2]!;
  if (!input.nodeExtraCaCerts || await realpath(input.nodeExtraCaCerts).catch(fail) !== caFile) fail();
  const core = loopback(input.coreUrl, "https:", "/");
  const relay = loopback(input.relayUrl, "wss:", "/relay/runtime");
  if (core.host !== relay.host) fail();
  const roots = await loadReleaseRootsFile(rootsFile).catch(fail);
  if (roots.length === 0 || roots.some(root => !/^e2e-local-[A-Za-z0-9._-]{1,96}$/.test(root.keyId))) fail();
  let payload: unknown;
  try { payload = JSON.parse(await readFile(manifestFile, "utf8")); } catch { fail(); }
  const release = (() => { try { return verifyNativeRelease(payload, roots); } catch { return fail(); } })();
  if (!release.manifest.signature.keyId.startsWith("e2e-local-") || !roots.some(root => root.keyId === release.manifest.signature.keyId)) fail();
  return { roots, manifest: release.manifest };
}

function loopback(raw: string, protocol: "https:" | "wss:", pathname: string): URL {
  const fail = (): never => { throw new RemoteInstanceError("bundle_untrusted", "E2E native install authority is restricted to the local TLS edge."); };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return fail(); }
  if (parsed.protocol !== protocol || parsed.pathname !== pathname || parsed.username || parsed.password || parsed.search || parsed.hash || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.port !== "7443") fail();
  return parsed;
}
