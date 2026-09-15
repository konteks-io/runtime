import type { FetchFn } from "@konteks/remote-common";
import { gitGap, gitOk, type GitAccess, type GitResult } from "./git.js";

/**
 * The fallback single-file read (OB6 gotcha): `git archive --remote` is disabled
 * on GitHub and on plenty of self-hosted installs, so a ref that the archive
 * path cannot produce is read through the provider's raw-file API instead —
 * still with **the machine's own credential**, obtained through `git credential
 * fill` rather than by reading any helper's private store.
 *
 * Which of the two paths produced a ref is recorded on the evidence, because a
 * portfolio that was read entirely through one path and one that fell back for
 * half its repositories are different facts about the run.
 */
export const EVIDENCE_READ_PATHS = ["git_archive", "raw_file_api"] as const;
export type EvidenceReadPath = (typeof EVIDENCE_READ_PATHS)[number];

export interface RawFileRequest {
  provider: string;
  /** The repository's browse URL, as the inventory carries it. */
  url: string;
  repoOwner: string;
  repoName: string;
  ref: string;
  path: string;
}

/** Maximum bytes a single evidence read may pull; facts are small by design. */
export const MAX_EVIDENCE_FILE_BYTES = 512 * 1024;

export interface RawFileApiOptions {
  git: Pick<GitAccess, "credential">;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export class RawFileApi {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly options: RawFileApiOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async read(request: RawFileRequest): Promise<GitResult<Buffer>> {
    const endpoint = rawFileUrl(request);
    if (!endpoint) return gitGap("unavailable", `no raw-file API is known for provider ${request.provider}`);
    const credential = await this.options.git.credential(request.url);
    if (!credential.ok) return credential;
    let response: Response;
    try {
      response = await this.fetchFn(endpoint.url, {
        method: "GET",
        headers: {
          ...authorization(request.provider, credential.value),
          ...(endpoint.accept ? { accept: endpoint.accept } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return gitGap("unavailable", "retry when this machine can reach the provider");
    }
    if (response.status === 401 || response.status === 403) {
      return gitGap("credential_unavailable", "sign in to this provider with git on the machine running this Konteks runtime");
    }
    if (response.status === 404) return gitGap("not_found", "the repository does not carry this file at its default branch");
    if (!response.ok) return gitGap("unavailable", "retry when this machine can reach the provider");
    const body = Buffer.from(await response.arrayBuffer());
    // Truncating rather than refusing keeps a huge lockfile from losing a
    // repository its whole evidence row; the facts we extract sit at the top.
    return gitOk(body.byteLength > MAX_EVIDENCE_FILE_BYTES ? body.subarray(0, MAX_EVIDENCE_FILE_BYTES) : body);
  }
}

/**
 * Provider raw-file endpoints. Only the four providers the catalog's repository
 * vocabulary already names are built; anything else reports an evidence gap
 * rather than guessing a URL shape.
 */
export function rawFileUrl(request: RawFileRequest): { url: string; accept?: string } | null {
  const base = originOf(request.url);
  if (!base) return null;
  const owner = encodeURIComponent(request.repoOwner);
  const name = encodeURIComponent(request.repoName);
  const path = request.path.split("/").map(encodeURIComponent).join("/");
  const ref = encodeURIComponent(request.ref);
  switch (request.provider) {
    case "github":
      // github.com browses on one host and serves its API on another.
      return {
        url: base === "https://github.com"
          ? `https://api.github.com/repos/${owner}/${name}/contents/${path}?ref=${ref}`
          : `${base}/api/v3/repos/${owner}/${name}/contents/${path}?ref=${ref}`,
        accept: "application/vnd.github.raw",
      };
    case "gitea":
      return { url: `${base}/api/v1/repos/${owner}/${name}/raw/${path}?ref=${ref}` };
    case "gitlab":
      return {
        url: `${base}/api/v4/projects/${encodeURIComponent(`${request.repoOwner}/${request.repoName}`)}/repository/files/${encodeURIComponent(request.path)}/raw?ref=${ref}`,
      };
    case "azure-devops":
      return {
        url: `${base}/${owner}/_apis/git/items?path=${encodeURIComponent(`/${request.path}`)}&versionDescriptor.version=${ref}&api-version=7.0`,
      };
    default:
      return null;
  }
}

/**
 * GitHub documents bearer tokens and refuses a Basic header from a fine-grained
 * token; every other provider here accepts the username/password pair the
 * credential helper handed back, which is also how git itself would send it.
 */
function authorization(provider: string, credential: { username: string; password: string }): Record<string, string> {
  if (provider === "github") return { authorization: `Bearer ${credential.password}` };
  const basic = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64");
  return { authorization: `Basic ${basic}` };
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
