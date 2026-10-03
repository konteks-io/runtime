import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
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

interface NativeRepositoryFetchContext {
  /** Private bare repository path. It has no configured remote or credentials. */
  gitDir: string;
  /** Exact signed revision that the authority owner must fetch. */
  revision: string;
  /** Bounded local commits the authority may use as bundle prerequisites. */
  haveRevisions: string[];
}

interface NativeRepositoryCacheOptions {
  /** Shared by every local agent, but never used as an agent working directory. */
  root: string;
  tool: NativeGitTool;
  /**
   * Authority-owned network seam. The implementation may use an ephemeral
   * credential helper, but must not persist a URL, remote, or credential in gitDir.
   */
  fetchRevision(context: NativeRepositoryFetchContext): Promise<void>;
}

interface NativeRepositoryWorktree {
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
  if (!privateJsonFile(before)) throw unavailable();
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

/** A private, singly linked regular file of at most 16 KiB. */
function privateJsonFile(info: Stats): boolean {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024) return false;
  return process.platform === "win32" || (info.mode & 0o077) === 0;
}

function fsCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}
function receipt(value: unknown): WorktreeReceipt {
  if (!value || typeof value !== "object") throw unavailable();
  const candidate = value as Partial<WorktreeReceipt>;
  if (!wellFormedReceipt(candidate)) throw unavailable();
  return candidate as WorktreeReceipt;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_KEYS = ["format", "repositoryDigest", "baselineCommit", "worktreePathDigest", "commonDirectoryDigest"];

/** Exactly the receipt's fields, each in its own form. */
function wellFormedReceipt(candidate: Partial<WorktreeReceipt>): boolean {
  return candidate.format === "konteks-native-worktree-v1" &&
    matches(candidate.repositoryDigest, DIGEST) &&
    matches(candidate.baselineCommit, COMMIT) &&
    matches(candidate.worktreePathDigest, DIGEST) &&
    matches(candidate.commonDirectoryDigest, DIGEST) &&
    Object.keys(candidate).every((key) => RECEIPT_KEYS.includes(key));
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
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
  await acquireRepositoryLock(lock, token, Date.now() + LOCK_DEADLINE_MS);
  try {
    return await operation();
  } finally {
    await releaseRepositoryLock(lock, token);
  }
}

async function acquireRepositoryLock(lock: string, token: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeExclusive(join(lock, "owner.json"), { pid: process.pid, token });
      return;
    } catch (error) {
      if (fsCode(error) !== "EEXIST") throw unavailable();
      const stale = await staleLock(lock);
      if (stale === "released") continue;
      if (stale && (await recoverStaleLock(lock, token))) continue;
      if (Date.now() >= deadline) throw unavailable();
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Whether the lock's owner is gone (or, when its record cannot be read, the lock has outlived the deadline). */
async function staleLock(lock: string): Promise<boolean | "released"> {
  try {
    const current = (await readJson(join(lock, "owner.json"))) as { pid?: unknown };
    return !(await ownerAlive(current.pid));
  } catch {
    return staleByAge(lock);
  }
}

async function staleByAge(lock: string): Promise<boolean | "released"> {
  let stat;
  try {
    stat = await lstat(lock);
  } catch (statError) {
    // The holder released between our EEXIST and this read: contend again.
    if (fsCode(statError) === "ENOENT") return "released";
    throw unavailable();
  }
  return Date.now() - stat.mtimeMs > LOCK_DEADLINE_MS;
}

/** Move a stale lock aside and remove it; false when another contender recovered it first. */
async function recoverStaleLock(lock: string, token: string): Promise<boolean> {
  const quarantine = `${lock}.stale-${token}`;
  try {
    await rename(lock, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function releaseRepositoryLock(lock: string, token: string): Promise<void> {
  try {
    const current = (await readJson(join(lock, "owner.json"))) as { token?: unknown };
    if (current.token === token) await rm(lock, { recursive: true, force: true });
  } catch {
    // Never delete a lock whose ownership can no longer be proved.
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

  async prepare(input: WorktreeRequest): Promise<NativeRepositoryWorktree> {
    const tool = await this.verifiedTool;
    const root = await privateRoot(this.options.root);
    const agentRoot = await privateRoot(input.agentWorkspaceRoot);
    const repositoryId = safeId(input.repositoryId),
      worktreeId = safeId(input.worktreeId);
    if (!COMMIT.test(input.revision)) throw unavailable();
    const preparation = new WorktreePreparation({ tool, root, agentRoot, repositoryId, worktreeId, input, fetchRevision: this.options.fetchRevision });
    return preparation.prepare();
  }
}

interface WorktreeRequest {
  repositoryId: string;
  revision: string;
  agentWorkspaceRoot: string;
  worktreeId: string;
  mode?: "preserve" | "reset_to_revision";
}

const REPOSITORY_CONFIG =
  "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\thooksPath = hooks-disabled\n" +
  "[gc]\n\tauto = 0\n[fetch]\n\tfsckObjects = true\n[transfer]\n\tfsckObjects = true\n";

/** The cache's Git with no system or global configuration, no prompt, and only the transports a fetch may use. */
function gitEnvironment(tool: NativeGitTool): NodeJS.ProcessEnv {
  return {
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
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (fsCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** One worktree's preparation: its paths, the receipt it must carry, and the steps that make or repair it. */
class WorktreePreparation {
  private readonly gitDir: string;
  private readonly cwd: string;
  private readonly intent: string;
  private readonly receiptPath: string;
  private readonly legacyReceiptPath: string;
  private readonly expected: WorktreeReceipt;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly setup: {
    tool: NativeGitTool;
    root: string;
    agentRoot: string;
    repositoryId: string;
    worktreeId: string;
    input: WorktreeRequest;
    fetchRevision: NativeRepositoryCacheOptions["fetchRevision"];
  }) {
    const { root, agentRoot, repositoryId, worktreeId, input } = setup;
    const repositoryDigest = `sha256:${sha256Hex(canonicalize({ repositoryId }))}`;
    const worktreeDigest = sha256Hex(canonicalize({ repositoryDigest, worktreeId }));
    this.gitDir = join(root, repositoryDigest.slice(7) + ".git");
    this.cwd = join(agentRoot, "worktree-" + worktreeDigest);
    this.intent = join(agentRoot, `.worktree-${worktreeDigest}${INTENT_SUFFIX}`);
    // The same durable worktree identity can exist under different agent
    // boundaries. Include the verified agent root in the connector-owned
    // receipt name so those worktrees never contend for one receipt.
    const receiptDigest = sha256Hex(canonicalize({ worktreeDigest, agentRoot }));
    this.receiptPath = join(root, `.worktree-${receiptDigest}${RECEIPT_SUFFIX}`);
    this.legacyReceiptPath = join(this.cwd, LEGACY_RECEIPT_FILE);
    this.expected = {
      format: "konteks-native-worktree-v1",
      repositoryDigest,
      baselineCommit: input.revision,
      worktreePathDigest: `sha256:${sha256Hex(canonicalize({ path: this.cwd }))}`,
      commonDirectoryDigest: `sha256:${sha256Hex(canonicalize({ path: this.gitDir }))}`,
    };
    this.env = gitEnvironment(setup.tool);
  }

  async prepare(): Promise<NativeRepositoryWorktree> {
    const verify = (receiptExpected?: WorktreeReceipt) => this.verify(receiptExpected);
    const current = await this.currentReceipt();
    if (current && sameReceipt(current, this.expected)) {
      await this.verify();
      return { cwd: this.cwd, baselineCommit: this.setup.input.revision, verify };
    }
    if (current) {
      this.assertResettable(current);
      await this.verify(current);
    }
    await withRepositoryLock(this.setup.root, this.expected.repositoryDigest, () => this.prepareLocked());
    await this.verify();
    return { cwd: this.cwd, baselineCommit: this.setup.input.revision, verify };
  }

  private git(args: string[], timeout = 30_000): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        this.setup.tool.executable,
        args,
        { env: this.env, timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true },
        (error, stdout) => (error ? rejectPromise(unavailable()) : resolvePromise(stdout)),
      );
    });
  }

  /** The current connector receipt, unless there is none or a first-format receipt still sits in the checkout. */
  private async currentReceipt(): Promise<WorktreeReceipt | null> {
    if (!(await exists(this.receiptPath)) || (await exists(this.legacyReceiptPath))) return null;
    return receipt(await readJson(this.receiptPath));
  }

  /** A receipt for another revision is replaced only by a reset of the same worktree and store. */
  private assertResettable(current: WorktreeReceipt): void {
    const expected = this.expected;
    if (this.setup.input.mode !== "reset_to_revision" ||
        current.repositoryDigest !== expected.repositoryDigest ||
        current.worktreePathDigest !== expected.worktreePathDigest ||
        current.commonDirectoryDigest !== expected.commonDirectoryDigest) throw unavailable();
  }

  private async verifyRepository(): Promise<void> {
    await privateDirectory(this.gitDir);
    await privateDirectory(join(this.gitDir, "hooks-disabled"));
    if ((await readFile(join(this.gitDir, "config"), "utf8")) !== REPOSITORY_CONFIG)
      throw unavailable();
    if ((await this.git(["--git-dir", this.gitDir, "remote"])).trim() !== "") throw unavailable();
  }

  private async verify(receiptExpected = this.expected): Promise<void> {
    await privateDirectory(this.setup.root);
    await privateDirectory(this.setup.agentRoot);
    await this.verifyRepository();
    await privateDirectory(this.cwd);
    if (await exists(this.legacyReceiptPath)) throw unavailable();
    const actual = receipt(await readJson(this.receiptPath));
    if (!sameReceipt(actual, receiptExpected)) throw unavailable();
    const common = await realpath(await this.commonDirectory());
    if (common !== (await realpath(this.gitDir))) throw unavailable();
    if (`sha256:${sha256Hex(canonicalize({ path: common }))}` !== receiptExpected.commonDirectoryDigest)
      throw unavailable();
    await this.git(["--git-dir", this.gitDir, "cat-file", "-e", `${receiptExpected.baselineCommit}^{commit}`]);
  }

  private async commonDirectory(): Promise<string> {
    return (await this.git(["-C", this.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  }

  private async prepareLocked(): Promise<void> {
    const current = await this.currentReceipt();
    if (current && sameReceipt(current, this.expected)) return;
    if (current) this.assertResettable(current);
    await this.ensureRepository();
    await this.verifyRepository();
    if (await exists(this.legacyReceiptPath)) return this.migrateLegacyReceipt();
    await this.ensureRevision();
    if ((await exists(this.receiptPath)) && (await exists(this.cwd)) && !(await exists(this.legacyReceiptPath))) return this.resetWorktree();
    await this.addWorktree();
  }

  private async ensureRepository(): Promise<void> {
    if (await exists(this.gitDir)) return;
    const temporary = `${this.gitDir}.new-${randomUUID()}`;
    try {
      await this.git(["init", "--bare", "--object-format=sha1", "--template=", temporary]);
      await chmod(temporary, 0o700);
      await mkdir(join(temporary, "hooks-disabled"), { mode: 0o700 });
      await writePrivate(join(temporary, "config"), REPOSITORY_CONFIG);
      await rename(temporary, this.gitDir);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  /**
   * One-time migration from the first cache format. Move only an exact
   * connector receipt after proving that this checkout is still attached to
   * the expected common store. Dirty user work is never reset.
   */
  private async migrateLegacyReceipt(): Promise<void> {
    const raw = (await readJson(this.legacyReceiptPath)) as Partial<WorktreeReceipt>;
    if (!legacyReceiptMatches(raw, this.expected)) throw unavailable();
    if ((await realpath(await this.commonDirectory())) !== (await realpath(this.gitDir))) throw unavailable();
    if (await exists(this.receiptPath)) {
      if (!sameReceipt(receipt(await readJson(this.receiptPath)), this.expected)) throw unavailable();
    } else await writeExclusive(this.receiptPath, this.expected);
    await rm(this.legacyReceiptPath, { force: true });
  }

  /** Existing objects are the fast path. Fetch exactly once under the repository lock. */
  private async ensureRevision(): Promise<void> {
    const revision = this.setup.input.revision;
    try {
      await this.git(["--git-dir", this.gitDir, "cat-file", "-e", `${revision}^{commit}`]);
    } catch {
      const haveRevisions = (await this.git([
        "--git-dir",
        this.gitDir,
        "for-each-ref",
        "--format=%(objectname)",
        "refs/konteks/fetched",
      ]))
        .split(/\r?\n/u)
        .filter((value) => COMMIT.test(value))
        .slice(0, 64);
      await this.setup.fetchRevision({ gitDir: this.gitDir, revision, haveRevisions });
      await this.verifyRepository();
      await this.git(["--git-dir", this.gitDir, "cat-file", "-e", `${revision}^{commit}`]);
    }
  }

  /**
   * QA owns no generated bytes. Refresh its isolated connector worktree to
   * exactly the signed PR head; a crash is repaired by replaying this
   * idempotent reset before any prompt is allowed.
   */
  private async resetWorktree(): Promise<void> {
    if (this.setup.input.mode !== "reset_to_revision") throw unavailable();
    await this.git(["-C", this.cwd, "reset", "--hard", this.setup.input.revision]);
    await this.git(["-C", this.cwd, "clean", "-ffdx"]);
    const temporaryReceipt = `${this.receiptPath}.new-${randomUUID()}`;
    try {
      await writeExclusive(temporaryReceipt, this.expected);
      await rename(temporaryReceipt, this.receiptPath);
    } finally {
      await rm(temporaryReceipt, { force: true });
    }
  }

  /**
   * A fresh detached worktree at the revision. An unpublished directory left
   * by an earlier failure is recognized by its exact intent and removed
   * first; if any step fails, the intent stays behind so a restart can tell
   * it from a completed agent worktree.
   */
  private async addWorktree(): Promise<void> {
    if (await exists(this.intent)) {
      const previous = receipt(await readJson(this.intent));
      if (!sameReceipt(previous, this.expected)) throw unavailable();
      await this.git(["--git-dir", this.gitDir, "worktree", "remove", "--force", this.cwd]).catch(
        () => undefined,
      );
      await rm(this.cwd, { recursive: true, force: true });
      await rm(this.intent, { force: true });
    }
    if (await exists(this.cwd)) throw unavailable();
    await writeExclusive(this.intent, this.expected);
    await this.git(["--git-dir", this.gitDir, "worktree", "prune"]);
    await this.git(["--git-dir", this.gitDir, "worktree", "add", "--detach", this.cwd, this.setup.input.revision]);
    await chmod(this.cwd, 0o700);
    await writeExclusive(this.receiptPath, this.expected);
    await rm(this.intent, { force: true });
  }
}

/** A first-format receipt holds only the format, repository and baseline, each the expected one. */
function legacyReceiptMatches(raw: Partial<WorktreeReceipt>, expected: WorktreeReceipt): boolean {
  return raw.format === expected.format && raw.repositoryDigest === expected.repositoryDigest &&
    raw.baselineCommit === expected.baselineCommit &&
    Object.keys(raw).every(key => ["format", "repositoryDigest", "baselineCommit"].includes(key));
}
