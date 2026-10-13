import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileSha256 } from "@konteks/remote-common";
import { nativeServiceExecutable, resolveNativeConnectorExecutable, selectNativeArtifacts, type VerifiedNativeRelease } from "@konteks/remote-release";
import { setupError } from "../setup-locale.js";
import type { NativePlatform } from "./service.js";

/** A connector set aside on Windows, where a running executable can be renamed but not replaced or deleted. */
const REPLACED_SUFFIX = ".replaced";

export interface ServiceExecutableActivation {
  root: string;
  platform: Pick<NativePlatform, "os" | "architecture">;
  /** The release whose connector the service must run. */
  releaseId: string;
  release: VerifiedNativeRelease;
}

/**
 * Puts the release's connector at the one path the service runs
 * (`nativeServiceExecutable`), replacing the file there atomically: a copy is
 * written beside it, checked against the release's signed digest and renamed
 * over it. On Windows the file in place is renamed aside first, since a
 * running executable (this updater, often) cannot be overwritten; an aside
 * copy left by a process that still ran is deleted on a later activation.
 * The release folder keeps its own copy, which is what a rollback activates
 * again; it is never run from there. True when the bytes were replaced.
 */
export async function activateServiceExecutable(input: ServiceExecutableActivation): Promise<boolean> {
  const { os } = input.platform;
  const target = nativeServiceExecutable(input.root, os);
  const source = await resolveNativeConnectorExecutable(join(input.root, "releases", input.releaseId), os);
  const digest = selectNativeArtifacts(input.release, { ...input.platform, agentIds: [] })[0]!.digest;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const replaced = (await fileSha256(target).catch(() => null)) !== digest;
  if (replaced) await replaceWithCheckedCopy(source, target, digest, os);
  await syncSignature(source, target);
  await sweepSetAside(target);
  return replaced;
}

async function replaceWithCheckedCopy(source: string, target: string, digest: string, os: NativePlatform["os"]): Promise<void> {
  const staged = partialPath(target);
  try {
    await copyFile(source, staged);
    await chmod(staged, 0o700);
    if ((await fileSha256(staged)) !== digest) throw setupError("bundle_untrusted", "serviceExecutableMismatch");
    await (os === "windows" ? replaceRunnable(staged, target) : rename(staged, target));
  } finally {
    await rm(staged, { force: true });
  }
}

/** Windows: set the file in place aside (renaming works while it runs), then move the copy in; put it back if that fails. */
async function replaceRunnable(staged: string, target: string): Promise<void> {
  const aside = `${target}.${randomUUID()}${REPLACED_SUFFIX}`;
  const moved = await rename(target, aside).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  try {
    await rename(staged, target);
  } catch (error) {
    if (moved) await rename(aside, target).catch(() => undefined);
    throw error;
  }
}

/**
 * A Linux release keeps the connector's detached signature beside it
 * (`<file>.sig`); the service's copy carries the same one, or none.
 */
async function syncSignature(source: string, target: string): Promise<void> {
  const staged = partialPath(`${target}.sig`);
  try {
    const copied = await copyFile(`${source}.sig`, staged).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (copied) await rename(staged, `${target}.sig`);
    else await rm(`${target}.sig`, { force: true });
  } finally {
    await rm(staged, { force: true });
  }
}

/** Copies set aside by an earlier activation; one whose process still runs stays until a later one. */
async function sweepSetAside(target: string): Promise<void> {
  const prefix = `${basename(target)}.`;
  for (const name of await readdir(dirname(target))) {
    if (name.startsWith(prefix) && name.endsWith(REPLACED_SUFFIX)) await rm(join(dirname(target), name), { force: true }).catch(() => undefined);
  }
}

function partialPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomUUID()}.partial`);
}
