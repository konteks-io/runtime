import { randomUUID, createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalize, RemoteInstanceError, type JsonValue } from "@konteks/remote-common";

interface MigrationInput {
  source: string;
  target: string;
  cwd: string;
  receiptPath: string;
  before: Record<string, string>;
  after: Record<string, string>;
  git(args: string[]): Promise<string>;
  verifyRepository(path: string): Promise<void>;
  readRecord(path: string): Promise<JsonValue>;
  writeExclusive(path: string, value: unknown): Promise<void>;
  writePrivate(path: string, value: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const unavailable = () => new RemoteInstanceError("capability_unavailable", "Existing Git workspace cannot be safely isolated.");

function assertOwned(info: Stats): void {
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw unavailable();
  assertOwnerPermissions(info);
  if (info.isFile() && info.nlink !== 1) throw unavailable();
}

function assertOwnerPermissions(info: Stats): void {
  if (process.platform === "win32") return;
  if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw unavailable();
}

async function fileDigest(path: string): Promise<string> {
  const digest = createHash("sha256");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

/** Stream metadata files; reject symlinks, foreign writers and active Git locks before copying. */
async function administrationSnapshot(root: string, relative = ""): Promise<string[]> {
  const path = join(root, relative);
  const info = await lstat(path);
  assertOwned(info);
  if (basename(path).endsWith(".lock") || basename(path) === "locked") throw unavailable();
  if (info.isFile()) return [JSON.stringify([relative, await fileDigest(path)])];
  const records = [JSON.stringify([relative, "directory"])];
  for (const name of (await readdir(path)).sort()) records.push(...await administrationSnapshot(root, join(relative, name)));
  return records;
}

/** A linked checkout's private .git pointer, never a symlink or a relative path. */
async function readGitPointer(cwd: string): Promise<string> {
  const file = join(cwd, ".git");
  assertOwned(await lstat(file));
  const text = await readFile(file, "utf8");
  if (text.length > 4096) throw unavailable();
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(text);
  if (!match || !isAbsolute(match[1]!)) throw unavailable();
  return resolve(match[1]!);
}

/** The original source store stays intact; publication switches only this checkout and its receipt. */
export async function migrateRepositoryWorkspace(input: MigrationInput): Promise<void> {
  await new RepositoryIsolationMigration(input).run();
}

class RepositoryIsolationMigration {
  private readonly marker: string;
  private sourceAdmin = "";
  private targetAdmin = "";
  private adminName = "";

  constructor(private readonly input: MigrationInput) {
    this.marker = `${input.receiptPath}.isolation-migration.json`;
  }

  async run(): Promise<void> {
    const { input } = this;
    await input.verifyRepository(input.source);
    assertOwned(await lstat(join(input.source, "config")));
    if (await input.exists(join(input.source, "objects", "info", "alternates"))) throw unavailable();
    await this.resolveAdministration();
    const actual = await input.readRecord(input.receiptPath);
    const pending = await input.exists(this.marker);
    if (!pending && canonicalize(actual) === canonicalize(input.after)) {
      await input.verifyRepository(input.target);
      return;
    }
    if (canonicalize(actual) !== canonicalize(input.before) && canonicalize(actual) !== canonicalize(input.after)) throw unavailable();
    await this.assertSourceAdministration();
    const snapshot = await administrationSnapshot(this.sourceAdmin);
    await this.prepareTarget(snapshot, pending);
    await this.publish(snapshot, pending);
  }

  private async resolveAdministration(): Promise<void> {
    const { input } = this;
    const pointer = await readGitPointer(input.cwd);
    this.adminName = basename(pointer);
    if (!/^worktree-[a-f0-9]{64}[0-9]*$/u.test(this.adminName)) throw unavailable();
    this.sourceAdmin = join(input.source, "worktrees", this.adminName);
    this.targetAdmin = join(input.target, "worktrees", this.adminName);
    if (pointer !== this.sourceAdmin && pointer !== this.targetAdmin) throw unavailable();
    if (pointer === this.targetAdmin && !(await input.exists(this.marker))) {
      if (canonicalize(await input.readRecord(input.receiptPath)) !== canonicalize(input.after)) throw unavailable();
    }
  }

  private async assertSourceAdministration(): Promise<void> {
    const { input } = this;
    if (await realpath(this.sourceAdmin) !== this.sourceAdmin) throw unavailable();
    if (resolve(this.sourceAdmin, (await readFile(join(this.sourceAdmin, "commondir"), "utf8")).trim()) !== input.source) throw unavailable();
    if (resolve((await readFile(join(this.sourceAdmin, "gitdir"), "utf8")).trim()) !== join(input.cwd, ".git")) throw unavailable();
  }

  private journal() {
    return { version: 1, before: this.input.before, after: this.input.after, adminName: this.adminName };
  }

  private async prepareTarget(snapshot: string[], pending: boolean): Promise<void> {
    const { input } = this;
    if (pending && canonicalize(await input.readRecord(this.marker)) !== canonicalize(this.journal())) throw unavailable();
    if (!(await input.exists(input.target))) {
      if (pending) throw unavailable();
      await this.cloneTarget(snapshot);
    }
    await input.verifyRepository(input.target);
    if (await input.exists(join(input.target, "objects", "info", "alternates"))) throw unavailable();
    await this.assertCopiesMatch(snapshot);
    const sourceHead = (await input.git(["--git-dir", this.sourceAdmin, "rev-parse", "HEAD"])).trim();
    const targetHead = (await input.git(["--git-dir", this.targetAdmin, "rev-parse", "HEAD"])).trim();
    if (sourceHead !== targetHead) throw unavailable();
  }

  private async cloneTarget(snapshot: string[]): Promise<void> {
    const { input } = this;
    const temporary = `${input.target}.migration-${randomUUID()}`;
    // A partial clone is never published. The original checkout/admin remain the recovery source.
    try {
      await input.git(["clone", "--bare", "--local", "--no-hardlinks", "--template=", input.source, temporary]);
      await chmod(temporary, 0o700);
      await mkdir(join(temporary, "hooks-disabled"), { mode: 0o700 });
      await input.writePrivate(join(temporary, "config"), await readFile(join(input.source, "config"), "utf8"));
      const admin = join(temporary, "worktrees", this.adminName);
      await mkdir(dirname(admin), { recursive: true, mode: 0o700 });
      await cp(this.sourceAdmin, admin, { recursive: true, dereference: false, errorOnExist: true, force: false });
      await chmod(admin, 0o700);
      if (canonicalize(await administrationSnapshot(admin)) !== canonicalize(snapshot)) throw unavailable();
      await this.validateCopiedIndex(admin);
      await input.verifyRepository(temporary);
      await rename(temporary, input.target);
    } finally {
      // Only the unpublished copy is disposable; no agent ever received this path.
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async validateCopiedIndex(admin: string): Promise<void> {
    const index = join(this.sourceAdmin, "index");
    if (!(await this.input.exists(index))) return;
    await this.input.git(["--git-dir", admin, "write-tree"]);
    // write-tree validates every staged blob but may refresh cache-tree metadata.
    await copyFile(index, join(admin, "index"));
  }

  private async assertCopiesMatch(snapshot: string[]): Promise<void> {
    const expected = canonicalize(snapshot);
    if (canonicalize(await administrationSnapshot(this.sourceAdmin)) !== expected) throw unavailable();
    if (canonicalize(await administrationSnapshot(this.targetAdmin)) !== expected) throw unavailable();
  }

  private async publish(snapshot: string[], pending: boolean): Promise<void> {
    const { input } = this;
    if (!pending) await input.writeExclusive(this.marker, this.journal());
    await this.assertCopiesMatch(snapshot);
    // Keep interrupted temporary metadata outside the agent's captured source tree.
    const pointer = join(dirname(input.cwd), `.worktree-pointer-${randomUUID()}`);
    try {
      await input.writePrivate(pointer, `gitdir: ${this.targetAdmin}\n`);
      await rename(pointer, join(input.cwd, ".git"));
    } finally {
      await rm(pointer, { force: true });
    }
    const receipt = `${input.receiptPath}.isolation-${randomUUID()}`;
    await input.writeExclusive(receipt, input.after);
    await rename(receipt, input.receiptPath);
    await rm(this.marker);
  }
}
