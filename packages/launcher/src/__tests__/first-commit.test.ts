import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitFirstFiles, initializeRepository, inspectRepository, planFirstCommit, pushToManagedRemote } from "../native/repository-inspect.js";

/**
 * A folder with files but no git becomes a repository on managed git with
 * the person's files in it, and nothing they were told is left out (W1-B2,
 * WS1-084). A bare repository with Konteks's own first commit stands in for
 * the managed one.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

describe("first commit of a folder with files", () => {
  let dir: string;
  let folder: string;
  let remote: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "konteks-first-commit-"));
    remote = join(dir, "managed.git");
    git(dir, "init", "-q", "--bare", "--initial-branch", "main", remote);
    const seed = join(dir, "seed");
    git(dir, "clone", "-q", remote, seed);
    await writeFile(join(seed, "README.md"), "# made by Konteks\n");
    await writeFile(join(seed, "LICENSE"), "Konteks seed licence\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "Initial commit");
    git(seed, "push", "-q", "origin", "main");

    folder = join(dir, "table-booking");
    await mkdir(join(folder, "src"), { recursive: true });
    await mkdir(join(folder, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(folder, "src", "app.js"), "console.log('book a table')\n");
    await writeFile(join(folder, "package.json"), '{"name":"table-booking"}\n');
    await writeFile(join(folder, "README.md"), "# my restaurant\n");
    await writeFile(join(folder, ".env"), "STRIPE_SECRET=sk_test_fake\n");
    await writeFile(join(folder, ".env.example"), "STRIPE_SECRET=\n");
    await writeFile(join(folder, "server.key"), "fake key\n");
    await writeFile(join(folder, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("plans every file but secrets, installed packages and keys, and says why each is left out", async () => {
    const plan = await planFirstCommit(folder);
    expect(plan.include).toEqual([".env.example", "package.json", "README.md", "src/app.js"]);
    expect(plan.leftOut).toEqual([
      { path: ".env", why: "it can hold secrets" },
      { path: "node_modules/", why: "installed packages" },
      { path: "server.key", why: "a key file" },
    ]);
  });

  it("joins Konteks's history without touching the files, commits only the planned ones, and pushes them", async () => {
    const plan = await planFirstCommit(folder);
    const initialized = await initializeRepository({
      path: folder, branch: "main", authorName: "hello", authorEmail: "hello@konteks.io",
      remote: { url: remote }, keepFiles: true,
    });
    expect(initialized).toMatchObject({ ok: true, adopted: true });
    // The person's README won over Konteks's; the file only Konteks had came back.
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe("# my restaurant\n");
    expect(await readFile(join(folder, "LICENSE"), "utf8")).toBe("Konteks seed licence\n");

    const committed = await commitFirstFiles({ path: folder, plan, authorName: "hello", authorEmail: "hello@konteks.io", message: "Add table-booking" });
    expect(committed).toEqual({ ok: true, message: 'Committed 4 files as "Add table-booking".' });
    const pushed = await pushToManagedRemote({ repositoryPath: folder, remoteUrl: remote, branch: "main" });
    expect(pushed.pushed).toBe(true);

    const onRemote = git(dir, "--git-dir", remote, "ls-tree", "-r", "--name-only", "main").trim().split("\n");
    expect(onRemote.sort()).toEqual([".env.example", ".gitignore", "LICENSE", "README.md", "package.json", "src/app.js"]);
    expect(git(dir, "--git-dir", remote, "log", "--format=%an <%ae> %s", "main")).toBe("hello <hello@konteks.io> Add table-booking\nt <t@t> Initial commit\n");
    const ignore = git(dir, "--git-dir", remote, "show", "main:.gitignore");
    expect(ignore).toContain("/.env\n");
    expect(ignore).toContain("/node_modules/\n");
    expect(ignore).toContain("/server.key\n");
    // What was left out is still there, and still not tracked.
    expect(await readFile(join(folder, ".env"), "utf8")).toContain("sk_test_fake");
    expect(git(folder, "status", "--porcelain")).toBe("");
    // A later look at the folder knows it is on Konteks managed git (pass 6).
    expect(await inspectRepository(folder)).toMatchObject({ onManagedGit: true, remoteUrl: null, unpushedCommits: 0 });
  });
});
