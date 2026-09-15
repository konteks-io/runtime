import type { GitRemote } from "./git.js";

/**
 * Which credential reaches which repository (OB6 §5, A10).
 *
 * There are exactly two answers and no third:
 *
 * - **managed git** — the SSH URL, with the key this runtime registered through
 *   `konteks-remote git key add`. Managed git is the one place the runtime's own
 *   key is the person's credential.
 * - **a customer connector** — whatever `git` on this machine already
 *   authenticates with, over the URL the inventory gave us. Nothing is
 *   configured, nothing is injected, and Core's connector credential is never
 *   asked for.
 *
 * CONTRACT-GAP: neither `DiscoveryInventoryItem` nor a relocation endpoint
 * carries a `managed` flag, so managed-ness is decided by HOST: a repository on
 * the host this runtime registered a key for is managed, everything else is
 * not. That is also the honest test — a key we hold for that host is exactly
 * what "we can authenticate as ourselves here" means.
 */
export interface ManagedGitBinding {
  /** The managed git host, as the registered SSH config stanza names it. */
  host: string;
  /** The private half. It never leaves this machine and is never logged. */
  identityFile: string;
  /** The SSH user managed git serves (Gitea serves every repository as `git`). */
  user?: string;
}

export interface RepositoryLocation {
  /** Browse URL or base URL; only its host is read. */
  url: string;
  repoOwner: string;
  repoName: string;
}

export type ManagedBindingSource = () => ManagedGitBinding | null;

export function createRemoteResolver(managed: ManagedBindingSource): (location: RepositoryLocation) => GitRemote {
  return location => resolveRemote(location, managed());
}

export function resolveRemote(location: RepositoryLocation, binding: ManagedGitBinding | null): GitRemote {
  const host = hostOf(location.url);
  if (binding && host !== null && host === binding.host) {
    return {
      url: `${binding.user ?? "git"}@${binding.host}:${location.repoOwner}/${location.repoName}.git`,
      identityFile: binding.identityFile,
    };
  }
  return { url: cloneUrl(location) };
}

/**
 * The inventory carries a repository's browse URL, which is already its clone
 * URL on every provider here; a relocation endpoint carries only the
 * connector's base URL, so the repository is appended. The distinction is made
 * by looking at the URL rather than by a flag, because Azure DevOps lays its
 * repository paths out as `/<org>/<project>/_git/<repo>` and no `<owner>/<name>`
 * reconstruction would produce it.
 */
export function cloneUrl(location: RepositoryLocation): string {
  let url: URL;
  try {
    url = new URL(location.url);
  } catch {
    return location.url;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.replace(/\.git$/, "");
  if (last && last.toLowerCase() === location.repoName.toLowerCase()) {
    url.pathname = `/${segments.slice(0, -1).concat(`${last}.git`).join("/")}`;
    return url.toString();
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${location.repoOwner}/${location.repoName}.git`;
  return url.toString();
}

function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}
