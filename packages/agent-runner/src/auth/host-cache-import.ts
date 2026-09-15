import { copyFile, lstat, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";

/**
 * One-time consented host-cache import, allowed only where the pinned
 * bridge's official tooling documents a file-backed cache (Codex today). The
 * launcher mounts the host file read-only at `sourcePath` for this single
 * operation; the runner validates ownership/type/size/permissions WITHOUT
 * parsing the token, copies (never bind-mounts) into the restricted volume,
 * never mutates or deletes the host cache, and the caller immediately runs the
 * official readiness probe.
 */
const MAX_IMPORT_BYTES = 256 * 1024;

export interface HostCacheImportPlan {
  agentId: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  documentedBy: string;
  purpose: string;
}

export function planHostCacheImport(family: AgentBridgeFamily): HostCacheImportPlan {
  const doc = family.tooling.hostCacheImport;
  if (!doc) {
    throw new RemoteInstanceError("capability_unavailable", `${family.displayName} documents no safe host-cache import; run a fresh official login instead`, {
      recoveryActions: [{ kind: "login_agent", agentId: family.agentId }],
    });
  }
  return {
    agentId: family.agentId,
    sourceRelativePath: doc.relativePath,
    destinationRelativePath: doc.relativePath,
    documentedBy: doc.documentedBy,
    purpose: `copy the ${family.displayName} login cache into this runtime's private credential volume (one time, read-only source)`,
  };
}

export async function importHostCache(args: { plan: HostCacheImportPlan; sourcePath: string; credentialDir: string; expectedUid?: number }): Promise<void> {
  const info = await lstat(args.sourcePath).catch(() => null);
  if (!info) throw new RemoteInstanceError("prerequisite_missing", "host cache file is not present");
  if (info.isSymbolicLink()) throw new RemoteInstanceError("prerequisite_missing", "host cache path is a symlink; refusing");
  if (!info.isFile()) throw new RemoteInstanceError("prerequisite_missing", "host cache path is not a regular file");
  if (info.size > MAX_IMPORT_BYTES) throw new RemoteInstanceError("prerequisite_missing", "host cache file is larger than the import limit");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new RemoteInstanceError("prerequisite_missing", "host cache file is readable by other users; refusing to import");
  }
  if (args.expectedUid !== undefined && info.uid !== args.expectedUid) {
    throw new RemoteInstanceError("prerequisite_missing", "host cache file is not owned by the invoking user");
  }
  const destination = join(args.credentialDir, args.plan.destinationRelativePath);
  const existing = await stat(destination).catch(() => null);
  if (existing) throw new RemoteInstanceError("prerequisite_missing", "credential volume already holds a login; log out first");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(args.sourcePath, destination);
}
