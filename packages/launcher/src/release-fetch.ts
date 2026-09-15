import { dirname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { RemoteInstanceError } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, verifyReleaseManifest, type EmbeddedReleaseRoot, type ReleaseManifest } from "@konteks/remote-release";

/**
 * Independently fetch the signed release manifest for the stable channel.
 * The URL is embedded in the launcher (never taken from Core), the result is
 * verified against the embedded release root, and only then is it written
 * next to the Compose file for the supervisor/gateway to read.
 */
export const DEFAULT_RELEASE_MANIFEST_URL = "https://releases.konteks.example/remote-instance/stable/release-manifest.json";

export async function fetchReleaseManifest(args: { url?: string; roots?: readonly EmbeddedReleaseRoot[]; fetchFn?: typeof fetch; now?: () => number }): Promise<ReleaseManifest> {
  const url = args.url ?? process.env.KONTEKS_RELEASE_MANIFEST_URL ?? DEFAULT_RELEASE_MANIFEST_URL;
  const roots = args.roots ?? EMBEDDED_RELEASE_ROOTS;
  if (roots.length === 0) {
    throw new RemoteInstanceError("bundle_untrusted", "this launcher build embeds no release root; it cannot verify any bundle", { recoveryActions: [{ kind: "update" }] });
  }
  const fetchFn = args.fetchFn ?? fetch;
  let payload: unknown;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    throw new RemoteInstanceError("temporarily_unavailable", "the release manifest could not be fetched", { cause: error, retryable: true, recoveryActions: [{ kind: "retry" }] });
  }
  return verifyReleaseManifest(payload, roots, args.now?.() ?? Date.now());
}

export async function loadVerifiedReleaseManifest(path: string, roots: readonly EmbeddedReleaseRoot[] = EMBEDDED_RELEASE_ROOTS, now: number = Date.now()): Promise<ReleaseManifest> {
  return verifyReleaseManifest(JSON.parse(await readFile(path, "utf8")), roots, now);
}

export async function persistReleaseArtifacts(paths: { releaseManifest: string; releaseRoots: string }, release: ReleaseManifest, roots: readonly EmbeddedReleaseRoot[]): Promise<void> {
  await mkdir(dirname(paths.releaseManifest), { recursive: true });
  await writeFile(paths.releaseManifest, `${JSON.stringify(release)}\n`, { mode: 0o600 });
  await writeFile(paths.releaseRoots, `${JSON.stringify({ roots })}\n`, { mode: 0o600 });
}
