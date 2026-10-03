import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { runCommand, sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";

/**
 * What the machine can see about the repository the person's agent is in.
 *
 * Deliberately shallow. It asks git four questions and looks at nothing else:
 * no file bodies, no history, no scan of the tree. The first System is a
 * proposal the person confirms, not a discovery run, so the only facts needed
 * are what to call it and where, if anywhere, it already lives.
 */

interface RepositoryFacts {
  /** The repository root, or null when the directory is not a repository. */
  path: string | null;
  name: string;
  remoteUrl: string | null;
  /** Whether the machine's own git can actually reach that remote. */
  remoteReachable: boolean;
  /** The remote is a folder on this machine (a path or file:// URL): Konteks itself cannot reach it. */
  remoteLocal?: boolean;
  currentBranch: string | null;
  defaultBranch: string;
  /** The repository already has Konteks managed git as its "konteks" remote. */
  onManagedGit?: boolean;
  /** Commits on the current branch that its "konteks" remote does not have yet, when it tracks one. */
  unpushedCommits?: number;
}

const env = () => sanitizeInheritedChildProcessEnv({ env: process.env });

async function git(cwd: string, args: string[], timeoutMs = 10_000) {
  return runCommand({ command: "git", args, cwd, env: env(), timeoutMs });
}

/** Git's trimmed output when the command succeeded; null when it failed or could not run. */
async function gitOutput(cwd: string, args: string[], timeoutMs?: number): Promise<string | null> {
  const result = await git(cwd, args, timeoutMs).catch(() => null);
  return result && result.code === 0 ? result.stdout.trim() : null;
}

/**
 * A remote Konteks can register as the System's repository: a network URL
 * (https, http, ssh, git) or git's scp form (`git@host:owner/repo.git`). A
 * path or file:// URL only this machine can open is not one.
 */
export function remoteIsLocal(url: string): boolean {
  if (/^(https?|ssh|git):\/\//i.test(url)) return false;
  if (/^[\w.-]+@[\w.-]+:(?!\/\/)/.test(url)) return false;
  return true;
}

export async function inspectRepository(cwd: string): Promise<RepositoryFacts> {
  const directory = resolve(cwd);
  const path = await gitOutput(directory, ["rev-parse", "--show-toplevel"]);
  if (path === null) {
    return {
      path: null,
      name: basename(directory),
      remoteUrl: null,
      remoteReachable: false,
      currentBranch: null,
      defaultBranch: "main",
    };
  }
  const remoteUrl = await gitOutput(path, ["remote", "get-url", "origin"]);
  const currentBranch = await namedBranch(path);
  const remoteReachable = remoteUrl ? await remoteReadable(path, remoteUrl) : false;
  return {
    path,
    name: basename(path),
    remoteUrl,
    remoteReachable,
    ...(remoteUrl && remoteIsLocal(remoteUrl) ? { remoteLocal: true } : {}),
    currentBranch,
    defaultBranch: currentBranch ?? "main",
    ...await managedGitFacts(path, currentBranch),
  };
}

/** The checked-out branch; null on a detached HEAD or when git cannot say. */
async function namedBranch(path: string): Promise<string | null> {
  const branch = await gitOutput(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch !== null && branch !== "HEAD" ? branch : null;
}

/** Whether the repository has the managed `konteks` remote, and how many commits it has not been sent. */
async function managedGitFacts(path: string, currentBranch: string | null): Promise<{ onManagedGit?: true; unpushedCommits?: number }> {
  if (await gitOutput(path, ["remote", "get-url", "konteks"]) === null) return {};
  const unpushedCommits = currentBranch ? await unpushedCount(path, currentBranch) : undefined;
  return { onManagedGit: true, ...(unpushedCommits !== undefined ? { unpushedCommits } : {}) };
}

/**
 * Reachability is asked of git itself, with whatever credential this machine
 * already has. A remote we cannot read is not a remote we can push to, and
 * the person is offered managed git instead of a broken registration.
 */
async function remoteReadable(path: string, remoteUrl: string): Promise<boolean> {
  return await gitOutput(path, ["ls-remote", "--exit-code", "--heads", remoteUrl], 20_000) !== null;
}

/** Commits on the branch that the managed remote does not have yet; undefined when git cannot say. */
async function unpushedCount(path: string, branch: string): Promise<number | undefined> {
  const ahead = await gitOutput(path, ["rev-list", "--count", `konteks/${branch}..HEAD`]);
  const count = ahead === null ? Number.NaN : Number.parseInt(ahead, 10);
  return Number.isFinite(count) ? count : undefined;
}

/**
 * Make a plain project folder a git repository the push can carry.
 *
 * The person agreed to this folder becoming their first System, so it gets
 * exactly what a push needs and nothing more: `git init` on the branch they
 * were told about, and one empty first commit. No file is added, changed or
 * staged. A folder that is already a repository with a commit is left as it is.
 */
export async function initializeRepository(input: InitializeInput): Promise<{ ok: boolean; message: string; adopted?: boolean }> {
  const created = await ensureRepository(input.path, input.branch);
  if (created) return created;
  if (await gitOutput(input.path, ["rev-parse", "--verify", "--quiet", "HEAD"]) !== null) return { ok: true, message: "" };
  if (input.remote) {
    const joined = await joinManagedHistory(input, input.remote);
    if (joined) return joined;
  }
  return firstEmptyCommit(input);
}

interface InitializeInput {
  path: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  /**
   * The managed repository to join, when there is one. Konteks creates it with
   * its own first commit, so an unrelated commit pushed from here could never
   * fast-forward: the folder joins that history instead, which is what the
   * person asked for and costs them nothing in an empty folder.
   */
  remote?: { url: string; sshCommand?: string };
  /**
   * The folder already has the person's files. Joining Konteks's history then
   * must not touch them: a checkout would refuse over a file both have, so
   * the branch is moved onto that history with the working tree left as it is.
   */
  keepFiles?: boolean;
}

/** `git init` on the branch, unless the folder already is a repository; a failure answers. */
async function ensureRepository(path: string, branch: string): Promise<{ ok: false; message: string } | null> {
  if (await gitOutput(path, ["rev-parse", "--show-toplevel"]) !== null) return null;
  const created = await git(path, ["init", "--initial-branch", branch]).catch(() => null);
  return !created || created.code !== 0 ? { ok: false, message: `This folder could not be made a git repository${reason(created)}.` } : null;
}

/** The folder joins the managed repository's first commit; null when that history could not be fetched. */
async function joinManagedHistory(input: InitializeInput, remote: { url: string; sshCommand?: string }): Promise<{ ok: boolean; message: string; adopted?: boolean } | null> {
  const attached = await attachManagedRemote(input.path, remote);
  if (attached) return { ok: false, message: attached };
  const fetched = await git(input.path, ["fetch", "--quiet", "konteks", input.branch], 120_000).catch(() => null);
  if (!fetched || fetched.code !== 0) return null;
  return input.keepFiles ? adoptKeepingFiles(input) : checkoutManaged(input);
}

async function adoptKeepingFiles(input: InitializeInput): Promise<{ ok: boolean; message: string; adopted?: boolean }> {
  const moved = await git(input.path, ["reset", "--quiet", `konteks/${input.branch}`]);
  if (moved.code !== 0) return { ok: false, message: `This folder could not be joined to the Konteks repository${reason(moved)}.` };
  await git(input.path, ["branch", "--set-upstream-to", `konteks/${input.branch}`]);
  // A file Konteks's first commit has and the folder does not (its
  // README) is restored; the person's own files win everywhere else.
  const tracked = (await git(input.path, ["ls-files", "--deleted"])).stdout.split("\n").filter(Boolean);
  if (tracked.length > 0) await git(input.path, ["checkout", "HEAD", "--", ...tracked]);
  return {
    ok: true,
    adopted: true,
    message: `${basename(resolve(input.path))} is now a git repository on ${input.branch}, joined to the Konteks repository's first commit.`,
  };
}

async function checkoutManaged(input: InitializeInput): Promise<{ ok: boolean; message: string; adopted?: boolean }> {
  const checkedOut = await git(input.path, ["checkout", "-B", input.branch, "--track", `konteks/${input.branch}`]);
  if (checkedOut.code !== 0) {
    return { ok: false, message: `This folder could not be put on ${input.branch}${reason(checkedOut)}.` };
  }
  return {
    ok: true,
    adopted: true,
    message: `${basename(resolve(input.path))} is now a git repository on ${input.branch}, tracking the Konteks repository, which already had its first commit.`,
  };
}

/**
 * The laptop may have no git identity yet; the commit is the person's own,
 * so it carries their name and address for this one commit only.
 */
async function firstEmptyCommit(input: InitializeInput): Promise<{ ok: boolean; message: string }> {
  const committed = await git(input.path, [
    "-c", `user.name=${input.authorName}`,
    "-c", `user.email=${input.authorEmail}`,
    "commit", "--allow-empty", "--quiet", "-m", "Start on Konteks",
  ]).catch(() => null);
  if (!committed || committed.code !== 0) {
    return { ok: false, message: `The first commit could not be made${reason(committed)}.` };
  }
  return { ok: true, message: `${basename(resolve(input.path))} is now a git repository on ${input.branch}.` };
}

function reason(result: { stderr?: string } | null): string {
  const line = result?.stderr?.trim().split("\n").filter(Boolean).pop();
  return line ? ` (git said: ${line})` : "";
}

/**
 * Point `konteks` at the managed repository, and keep the key this runtime
 * pushes with in the repository's own config so the person's later pushes work
 * too. Answers a message when something went wrong, nothing when it is set.
 */
async function attachManagedRemote(
  repositoryPath: string,
  remote: { url: string; sshCommand?: string },
): Promise<string | null> {
  if (remote.sshCommand) {
    const configured = await git(repositoryPath, ["config", "core.sshCommand", remote.sshCommand]);
    if (configured.code !== 0) {
      return `The repository could not be set up for Konteks managed git${reason(configured)}.`;
    }
  }
  const existing = await git(repositoryPath, ["remote", "get-url", "konteks"]).catch(() => null);
  if (!existing || existing.code !== 0) {
    const added = await git(repositoryPath, ["remote", "add", "konteks", remote.url]);
    if (added.code !== 0) return "The konteks remote could not be added.";
    return null;
  }
  if (existing.stdout.trim() !== remote.url) {
    const updated = await git(repositoryPath, ["remote", "set-url", "konteks", remote.url]);
    if (updated.code !== 0) return "The konteks remote could not be repointed.";
  }
  return null;
}

/** Add the managed remote and push the current branch. */
export async function pushToManagedRemote(input: {
  repositoryPath: string;
  remoteUrl: string;
  branch: string;
  /** How git reaches managed git with the runtime's key; kept in the repository's own config. */
  sshCommand?: string;
}): Promise<{ pushed: boolean; message: string }> {
  // Only this repository: the person's later pushes use the same key, and
  // nothing outside the folder they agreed to is touched.
  const attached = await attachManagedRemote(input.repositoryPath, {
    url: input.remoteUrl,
    ...(input.sshCommand ? { sshCommand: input.sshCommand } : {}),
  });
  if (attached) return { pushed: false, message: attached };
  // Only the branch the person is on; the rest follow through ordinary
  // git use, and pushing a whole history of branches is not what they agreed to.
  const pushed = await git(
    input.repositoryPath,
    ["push", "--set-upstream", "konteks", input.branch],
    120_000,
  );
  return pushed.code === 0
    ? { pushed: true, message: `Pushed ${input.branch} to Konteks managed git.` }
    : {
        pushed: false,
        message: `The push to Konteks managed git did not go through${reason(pushed)}.`,
      };
}

/** Why a file is left out of the first commit unless the person asks for it. */
const LEFT_OUT: Array<{ test: (name: string, isDirectory: boolean) => boolean; why: string }> = [
  { test: (name, dir) => dir && name === "node_modules", why: "installed packages" },
  { test: (name, dir) => !dir && /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name), why: "it can hold secrets" },
  { test: (name, dir) => !dir && (/\.(pem|key|p12|pfx)$/.test(name) || /^id_(rsa|ed25519|ecdsa)(\.pub)?$/.test(name)), why: "a key file" },
  { test: (name, dir) => !dir && name === ".DS_Store", why: "a Finder file" },
];

export interface FirstCommitPlan {
  /** Paths relative to the folder, committed on a yes. */
  include: string[];
  /** What is left out, and why, as the person is told. */
  leftOut: Array<{ path: string; why: string }>;
}

/**
 * What a folder that is not a repository yet would put in its first commit:
 * everything but secrets, installed packages and keys, which are left out by
 * default and named so the person knows.
 */
export async function planFirstCommit(folder: string): Promise<FirstCommitPlan> {
  const root = resolve(folder);
  const include: string[] = [];
  const leftOut: Array<{ path: string; why: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      const rule = LEFT_OUT.find(candidate => candidate.test(entry.name, isDirectory));
      const shown = relative(root, path) + (isDirectory ? "/" : "");
      if (rule) leftOut.push({ path: shown, why: rule.why });
      else if (isDirectory) await walk(path);
      else if (entry.isFile()) include.push(relative(root, path));
    }
  };
  await walk(root);
  return { include, leftOut };
}

/** Adds what was left out to `.gitignore`; whether the folder has one afterwards. */
async function ignoreLeftOut(path: string, plan: FirstCommitPlan): Promise<boolean> {
  const ignore = join(path, ".gitignore");
  const current = await readFile(ignore, "utf8").catch(() => "");
  const listed = new Set(current.split("\n").map(line => line.trim()));
  const missing = plan.leftOut.map(entry => `/${entry.path}`).filter(line => !listed.has(line) && !listed.has(line.slice(1)));
  if (missing.length > 0) {
    const block = ["# Left out of the first commit by Konteks onboarding", ...missing].join("\n");
    await writeFile(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}\n`);
  }
  return missing.length > 0 || current !== "";
}

/**
 * Commit exactly the planned files as the person's first commit, with a
 * .gitignore that keeps what was left out out of later commits too.
 */
export async function commitFirstFiles(input: {
  path: string;
  plan: FirstCommitPlan;
  authorName: string;
  authorEmail: string;
  message: string;
}): Promise<{ ok: boolean; message: string }> {
  // A folder with nothing left out may have no .gitignore at all: naming it
  // anyway fails the whole push with "pathspec '.gitignore' did not match
  // any files" (a folder holding only a README).
  const hasIgnore = await ignoreLeftOut(input.path, input.plan);
  const paths = [...new Set([...input.plan.include, ...(hasIgnore ? [".gitignore"] : [])])];
  const added = await git(input.path, ["add", "--", ...paths], 60_000);
  if (added.code !== 0) return { ok: false, message: `Your files could not be added${reason(added)}.` };
  const committed = await git(input.path, [
    "-c", `user.name=${input.authorName}`,
    "-c", `user.email=${input.authorEmail}`,
    "commit", "--quiet", "-m", input.message,
  ]);
  if (committed.code !== 0) return { ok: false, message: `The first commit could not be made${reason(committed)}.` };
  return { ok: true, message: `Committed ${input.plan.include.length} file${input.plan.include.length === 1 ? "" : "s"} as "${input.message}".` };
}
