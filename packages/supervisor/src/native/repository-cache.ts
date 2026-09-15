import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { RemoteInstanceError, canonicalize, sha256Hex } from "@konteks/remote-common";
import { verifyNativeGitTool, type NativeGitTool } from "./git-workspace.js";

const COMMIT = /^[a-f0-9]{40}$/;
const LOCK_RETRY_MS = 20;
const LOCK_DEADLINE_MS = 60_000;
const RECEIPT_SUFFIX = ".konteks-worktree.json";
const LEGACY_RECEIPT_FILE = ".konteks-worktree.json";
const INTENT_SUFFIX = ".konteks-worktree-intent.json";

const unavailable = () =>
  new RemoteInstanceError(
    "capability_unavailable",
    "Private Git repository cache or worktree is unavailable.",
  );

export interface NativeRepositoryFetchContext {
  /** Private bare repository path. It has no configured remote or credentials. */
  gitDir: string;
  /** Exact signed revision that the authority owner must fetch. */
  revision: string;
  /** Bounded local commits the authority may use as bundle prerequisites. */
  haveRevisions: string[];
}

export interface NativeRepositoryCacheOptions {
  /** Shared by every local agent, but never used as an agent working directory. */
  root: string;
  tool: NativeGitTool;
  /**
   * Authority-owned network seam. The implementation may use an ephemeral
   * credential helper, but must not persist a URL, remote, or credential in gitDir.
   */
  fetchRevision(context: NativeRepositoryFetchContext): Promise<void>;
}

export interface NativeRepositoryWorktree {
  cwd: string;
  baselineCommit: string;
  verify(): Promise<void>;
}

interface WorktreeReceipt {
  format: "konteks-native-worktree-v1";
  repositoryDigest: string;
  baselineCommit: string;
  worktreePathDigest: string;
  commonDirectoryDigest: string;
}

function safeId(value: string): string {
  if (!value || value.length > 4096 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw unavailable();
  return value;
}

async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
  )
    throw unavailable();
}

async function privateRoot(value: string): Promise<string> {
  if (!isAbsolute(value) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw unavailable();
  const path = resolve(value);
  if (path === parse(path).root) throw unavailable();
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await privateDirectory(path);
  return realpath(path);
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivate(path: string, value: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(value);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > 16 * 1024 ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  )
    throw unavailable();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size)
      throw unavailable();
    return JSON.parse((await handle.readFile("utf8")).toString());
  } finally {
    await handle.close();
  }
}

function receipt(value: unknown): WorktreeReceipt {
  if (!value || typeof value !== "object") throw unavailable();
  const candidate = value as Partial<WorktreeReceipt>;
  if (
    candidate.format !== "konteks-native-worktree-v1" ||
    typeof candidate.repositoryDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(candidate.repositoryDigest) ||
    typeof candidate.baselineCommit !== "string" ||
    !COMMIT.test(candidate.baselineCommit) ||
    typeof candidate.worktreePathDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(candidate.worktreePathDigest) ||
    typeof candidate.commonDirectoryDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(candidate.commonDirectoryDigest) ||
    Object.keys(candidate).some(
      (key) => !["format", "repositoryDigest", "baselineCommit", "worktreePathDigest", "commonDirectoryDigest"].includes(key),
    )
  )
    throw unavailable();
  return candidate as WorktreeReceipt;
}

function sameReceipt(left: WorktreeReceipt, right: WorktreeReceipt): boolean {
  return (
    left.format === right.format &&
    left.repositoryDigest === right.repositoryDigest &&
    left.baselineCommit === right.baselineCommit &&
    left.worktreePathDigest === right.worktreePathDigest &&
    left.commonDirectoryDigest === right.commonDirectoryDigest
  );
}

async function ownerAlive(pid: unknown): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function withRepositoryLock<T>(root: string, digest: string, operation: () => Promise<T>) {
  const lock = join(root, `.lock-${digest.slice(7)}`);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeExclusive(join(lock, "owner.json"), { pid: process.pid, token });
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw unavailable();
      let stale = false;
      try {
        const current = (await readJson(join(lock, "owner.json"))) as { pid?: unknown };
        stale = !(await ownerAlive(current.pid));
      } catch {
        let stat;
        try {
          stat = await lstat(lock);
        } catch (statError) {
          // The holder released between our EEXIST and this read: contend again.
          if (statError && typeof statError === "object" && "code" in statError && statError.code === "ENOENT") continue;
          throw unavailable();
        }
        stale = Date.now() - stat.mtimeMs > LOCK_DEADLINE_MS;
      }
      if (stale) {
        const quarantine = `${lock}.stale-${token}`;
        try {
          await rename(lock, quarantine);
          await rm(quarantine, { recursive: true, force: true });
          continue;
        } catch {
          // Another contender recovered it first.
        }
      }
      if (Date.now() >= deadline) throw unavailable();
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    try {
      const current = (await readJson(join(lock, "owner.json"))) as { token?: unknown };
      if (current.token === token) await rm(lock, { recursive: true, force: true });
    } catch {
      // Never delete a lock whose ownership can no longer be proved.
    }
  }
}

/**
 * One object store per canonical repository, many agent-owned worktrees.
 * Network authority stays outside this class and nothing secret is durable here.
 */
export class NativeRepositoryCache {
  private readonly verifiedTool: Promise<NativeGitTool>;

  constructor(private readonly options: NativeRepositoryCacheOptions) {
    this.verifiedTool = verifyNativeGitTool(options.tool);
  }

  async prepare(input: {
    repositoryId: string;
    revision: string;
    agentWorkspaceRoot: string;
    worktreeId: string;
    mode?: "preserve" | "reset_to_revision";
  }): Promise<NativeRepositoryWorktree> {
    const tool = await this.verifiedTool;
    const root = await privateRoot(this.options.root);
    const agentRoot = await privateRoot(input.agentWorkspaceRoot);
    const repositoryId = safeId(input.repositoryId),
      worktreeId = safeId(input.worktreeId);
    if (!COMMIT.test(input.revision)) throw unavailable();
    const repositoryDigest = `sha256:${sha256Hex(canonicalize({ repositoryId }))}`;
    const worktreeDigest = sha256Hex(canonicalize({ repositoryDigest, worktreeId }));
    const gitDir = join(root, repositoryDigest.slice(7) + ".git");
    const cwd = join(agentRoot, "worktree-" + worktreeDigest);
    const intent = join(agentRoot, `.worktree-${worktreeDigest}${INTENT_SUFFIX}`);
    // The same durable worktree identity can exist under different agent
    // boundaries. Include the verified agent root in the connector-owned
    // receipt name so those worktrees never contend for one receipt.
    const receiptDigest = sha256Hex(canonicalize({ worktreeDigest, agentRoot }));
    const receiptPath = join(root, `.worktree-${receiptDigest}${RECEIPT_SUFFIX}`);
    const legacyReceiptPath = join(cwd, LEGACY_RECEIPT_FILE);
    const expected: WorktreeReceipt = {
      format: "konteks-native-worktree-v1",
      repositoryDigest,
      baselineCommit: input.revision,
      worktreePathDigest: `sha256:${sha256Hex(canonicalize({ path: cwd }))}`,
      commonDirectoryDigest: `sha256:${sha256Hex(canonicalize({ path: gitDir }))}`,
    };
    const repositoryConfig =
      "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\thooksPath = hooks-disabled\n" +
      "[gc]\n\tauto = 0\n[fetch]\n\tfsckObjects = true\n[transfer]\n\tfsckObjects = true\n";
    const env: NodeJS.ProcessEnv = {
      PATH: dirname(tool.executable),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file:https:ssh",
      ...(process.platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    };
    const git = (args: string[], timeout = 30_000) =>
      new Promise<string>((resolvePromise, rejectPromise) => {
        execFile(
          tool.executable,
          args,
          { env, timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true },
          (error, stdout) => (error ? rejectPromise(unavailable()) : resolvePromise(stdout)),
        );
      });
    const exists = async (path: string) => {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return false;
        throw error;
      }
    };
    const verifyRepository = async () => {
      await privateDirectory(gitDir);
      await privateDirectory(join(gitDir, "hooks-disabled"));
      if ((await readFile(join(gitDir, "config"), "utf8")) !== repositoryConfig)
        throw unavailable();
      if ((await git(["--git-dir", gitDir, "remote"])).trim() !== "") throw unavailable();
    };
    const verify = async (receiptExpected = expected) => {
      await privateDirectory(root);
      await privateDirectory(agentRoot);
      await verifyRepository();
      await privateDirectory(cwd);
      if (await exists(legacyReceiptPath)) throw unavailable();
      const actual = receipt(await readJson(receiptPath));
      if (!sameReceipt(actual, receiptExpected)) throw unavailable();
      const common = (
        await git(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])
      ).trim();
      if ((await realpath(common)) !== (await realpath(gitDir))) throw unavailable();
      if (`sha256:${sha256Hex(canonicalize({ path: await realpath(common) }))}` !== receiptExpected.commonDirectoryDigest)
        throw unavailable();
      await git(["--git-dir", gitDir, "cat-file", "-e", `${receiptExpected.baselineCommit}^{commit}`]);
    };

    if ((await exists(receiptPath)) && !(await exists(legacyReceiptPath))) {
      const current = receipt(await readJson(receiptPath));
      if (sameReceipt(current, expected)) {
        await verify();
        return { cwd, baselineCommit: input.revision, verify };
      }
      if (input.mode !== "reset_to_revision" ||
          current.repositoryDigest !== expected.repositoryDigest ||
          current.worktreePathDigest !== expected.worktreePathDigest ||
          current.commonDirectoryDigest !== expected.commonDirectoryDigest) throw unavailable();
      await verify(current);
    }

    await withRepositoryLock(root, repositoryDigest, async () => {
      if ((await exists(receiptPath)) && !(await exists(legacyReceiptPath))) {
        const current = receipt(await readJson(receiptPath));
        if (sameReceipt(current, expected)) return;
        if (input.mode !== "reset_to_revision" ||
            current.repositoryDigest !== expected.repositoryDigest ||
            current.worktreePathDigest !== expected.worktreePathDigest ||
            current.commonDirectoryDigest !== expected.commonDirectoryDigest) throw unavailable();
      }
      if (!(await exists(gitDir))) {
        const temporary = `${gitDir}.new-${randomUUID()}`;
        try {
          await git(["init", "--bare", "--object-format=sha1", "--template=", temporary]);
          await chmod(temporary, 0o700);
          await mkdir(join(temporary, "hooks-disabled"), { mode: 0o700 });
          await writePrivate(join(temporary, "config"), repositoryConfig);
          await rename(temporary, gitDir);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
      await verifyRepository();
      // One-time migration from the first cache format. Move only an exact
      // connector receipt after proving that this checkout is still attached
      // to the expected common store. Dirty user work is never reset.
      if (await exists(legacyReceiptPath)) {
        const raw = (await readJson(legacyReceiptPath)) as Partial<WorktreeReceipt>;
        if (raw.format !== expected.format || raw.repositoryDigest !== expected.repositoryDigest ||
            raw.baselineCommit !== expected.baselineCommit ||
            Object.keys(raw).some(key => !["format", "repositoryDigest", "baselineCommit"].includes(key))) throw unavailable();
        const common = (await git(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
        if ((await realpath(common)) !== (await realpath(gitDir))) throw unavailable();
        if (await exists(receiptPath)) {
          if (!sameReceipt(receipt(await readJson(receiptPath)), expected)) throw unavailable();
        } else await writeExclusive(receiptPath, expected);
        await rm(legacyReceiptPath, { force: true });
        return;
      }
      // Existing objects are the fast path. Fetch exactly once under the repo lock.
      try {
        await git(["--git-dir", gitDir, "cat-file", "-e", `${input.revision}^{commit}`]);
      } catch {
        const haveRevisions = (await git([
          "--git-dir",
          gitDir,
          "for-each-ref",
          "--format=%(objectname)",
          "refs/konteks/fetched",
        ]))
          .split(/\r?\n/u)
          .filter((value) => COMMIT.test(value))
          .slice(0, 64);
        await this.options.fetchRevision({ gitDir, revision: input.revision, haveRevisions });
        await verifyRepository();
        await git(["--git-dir", gitDir, "cat-file", "-e", `${input.revision}^{commit}`]);
      }
      if ((await exists(receiptPath)) && (await exists(cwd)) && !(await exists(legacyReceiptPath))) {
        // QA owns no generated bytes. Refresh its isolated connector worktree
        // to exactly the signed PR head; a crash is repaired by replaying this
        // idempotent reset before any prompt is allowed.
        if (input.mode !== "reset_to_revision") throw unavailable();
        await git(["-C", cwd, "reset", "--hard", input.revision]);
        await git(["-C", cwd, "clean", "-ffdx"]);
        const temporaryReceipt = `${receiptPath}.new-${randomUUID()}`;
        try {
          await writeExclusive(temporaryReceipt, expected);
          await rename(temporaryReceipt, receiptPath);
        } finally {
          await rm(temporaryReceipt, { force: true });
        }
        return;
      }
      if (await exists(intent)) {
        const previous = receipt(await readJson(intent));
        if (!sameReceipt(previous, expected)) throw unavailable();
        await git(["--git-dir", gitDir, "worktree", "remove", "--force", cwd]).catch(
          () => undefined,
        );
        await rm(cwd, { recursive: true, force: true });
        await rm(intent, { force: true });
      }
      if (await exists(cwd)) throw unavailable();
      await writeExclusive(intent, expected);
      // If any following operation fails, leave the exact intent behind. A
      // restart can distinguish and remove this unpublished directory from a
      // completed agent worktree.
      await git(["--git-dir", gitDir, "worktree", "prune"]);
      await git(["--git-dir", gitDir, "worktree", "add", "--detach", cwd, input.revision]);
      await chmod(cwd, 0o700);
      await writeExclusive(receiptPath, expected);
      await rm(intent, { force: true });
    });
    await verify();
    return { cwd, baselineCommit: input.revision, verify };
  }
}
