import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isFsErrorWithCode, sanitizeInheritedChildProcessEnv, writeSecretFile } from "@konteks/remote-common";
import { z } from "zod";

/**
 * The agent packages an enrollment install unpacks (WS1-012).
 *
 * A release carries an offline package per agent family, each with its own
 * Node and dependency tree: hundreds of megabytes and thousands of files. The
 * person's first question (their email) needs none of it, only the verified
 * manifest, so `install --enroll` records the release and unpacks the
 * packages in a background process while the person reads their mail. The
 * `start` step of `onboard` waits for it and says how far it has got.
 *
 * The progress file is the only channel between the two processes. It holds
 * no secret.
 */

export const StagingProgressSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["running", "done", "failed"]),
    pid: z.number().int().positive().optional(),
    /** The family being unpacked, and how many of how many. */
    agent: z.string().optional(),
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    message: z.string().optional(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type StagingProgress = z.infer<typeof StagingProgressSchema>;

export type StagingStatus =
  | { state: "done" }
  | { state: "running"; agent?: string; done: number; total: number }
  | { state: "failed"; message: string }
  | { state: "not_started" };

const FILE = "staging.json";

export function stagingProgressPath(root: string): string {
  return join(resolve(root), "installer", FILE);
}

export async function writeStagingProgress(root: string, progress: Omit<StagingProgress, "schemaVersion" | "updatedAt">): Promise<void> {
  await mkdir(join(resolve(root), "installer"), { recursive: true, mode: 0o700 });
  await writeSecretFile(
    stagingProgressPath(root),
    JSON.stringify(StagingProgressSchema.parse({ ...progress, schemaVersion: 1, updatedAt: new Date().toISOString() })),
  );
}

async function readStagingProgress(root: string): Promise<StagingProgress | null> {
  const raw = await readFile(stagingProgressPath(root), "utf8").catch(error => {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  if (raw === null) return null;
  const parsed = StagingProgressSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Where the unpacking is. `done` is decided by the enrollment record naming a
 * staged release, never by the progress file alone; a `running` file whose
 * process has gone is a failure, so nobody waits on a dead unpack.
 */
export async function enrollmentStagingStatus(
  root: string,
  isStaged: (root: string) => Promise<boolean>,
): Promise<StagingStatus> {
  if (await isStaged(root)) return { state: "done" };
  const progress = await readStagingProgress(root);
  if (!progress) return { state: "not_started" };
  if (progress.state === "failed") return { state: "failed", message: progress.message ?? "Unpacking the agent packages stopped." };
  if (progress.state === "running" && progress.pid !== undefined && !alive(progress.pid)) {
    return { state: "failed", message: "Unpacking the agent packages stopped before it finished." };
  }
  if (progress.state === "done") return { state: "failed", message: "The agent packages were unpacked but not recorded." };
  return { state: "running", ...(progress.agent ? { agent: progress.agent } : {}), done: progress.done, total: progress.total };
}

/**
 * Start the unpacking in its own process, detached from the agent's command so
 * that command returns at once. The same executable runs it: a packaged
 * connector is its own entry point, and a source run passes its script.
 */
export async function spawnEnrollmentStaging(root: string): Promise<number | undefined> {
  const logs = join(resolve(root), "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const log = openSync(join(logs, "enrollment-staging.log"), "a", 0o600);
  const script = process.argv[1];
  const packaged = !script || resolve(script) === resolve(process.execPath);
  try {
    const child = spawn(
      process.execPath,
      [...(packaged ? [] : [script!]), "--root", resolve(root), "stage-enrollment"],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: sanitizeInheritedChildProcessEnv({ env: process.env }),
      },
    );
    child.unref();
    if (child.pid !== undefined) {
      await writeStagingProgress(root, { state: "running", pid: child.pid, done: 0, total: 0 });
    }
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/** True once the enrollment record names a release whose manifest is on disk. */
export async function releaseStaged(root: string, releaseId: string | undefined): Promise<boolean> {
  if (!releaseId) return false;
  return lstat(join(resolve(root), "releases", releaseId, "manifest.json"))
    .then(info => info.isFile())
    .catch(() => false);
}
