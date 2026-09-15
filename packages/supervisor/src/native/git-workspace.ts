import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { RemoteFileTreeSchema, RemoteInstanceError, sha256Hex } from "@konteks/remote-common";

/** Installer-selected local tool, never a field in a cloud assignment. */
export const NativeGitToolSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => isAbsolute(path) && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(path)),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type NativeGitTool = z.infer<typeof NativeGitToolSchema>;
export const NativeGitReceiptSchema = z
  .object({
    format: z.literal("konteks-local-git-v1"),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    baseTree: z.string().regex(/^[a-f0-9]{40}$/),
    configDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type NativeGitReceipt = z.infer<typeof NativeGitReceiptSchema>;
const pointer = "gitdir: ../git\n";
const attributes = "* -filter -text -ident -working-tree-encoding\n";
const config =
  "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nlogallrefupdates = true\nworktree = ../source\nhooksPath = ../hooks-disabled\nautocrlf = false\n[commit]\ngpgsign = false\n[tag]\ngpgsign = false\n";
const unavailable = () =>
  new RemoteInstanceError(
    "capability_unavailable",
    "Private Git workspace or installer-selected Git tool is unavailable.",
  );

async function directory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw unavailable();
}
async function boundedFile(path: string, limit: number, tool = false): Promise<Buffer> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (!tool && before.nlink !== 1) ||
    before.size > limit ||
    (process.platform !== "win32" &&
      (tool ? (before.mode & 0o022) !== 0 : (before.mode & 0o077) !== 0))
  )
    throw unavailable();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size)
      throw unavailable();
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (
      count !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw unavailable();
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}
export async function verifyNativeGitTool(value: unknown): Promise<NativeGitTool> {
  try {
    const tool = NativeGitToolSchema.parse(value);
    const bytes = await boundedFile(tool.executable, 64 * 1024 * 1024, true);
    if ("sha256:" + createHash("sha256").update(bytes).digest("hex") !== tool.digest)
      throw unavailable();
    return tool;
  } catch {
    throw unavailable();
  }
}
async function write(path: string, bytes: string, exclusive = true) {
  const handle = await open(path, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function oid(value: string): string {
  const parsed = value.trim();
  if (!/^[a-f0-9]{40}$/.test(parsed)) throw unavailable();
  return parsed;
}

/** Initial source only. Never runs checkout/add/filters/hooks, fetch, push or a shell. */
export async function initializeNativeGitWorkspace(options: {
  container: string;
  tool: unknown;
  tree: unknown;
}): Promise<NativeGitReceipt> {
  try {
    if (!isAbsolute(options.container)) throw unavailable();
    await directory(options.container);
    await directory(join(options.container, "source"));
    const tree = RemoteFileTreeSchema.parse(options.tree);
    if (
      tree.entries.some((entry) =>
        entry.path.split("/").some((part) => /^(?:\.git|git~[0-9]+)$/i.test(part)),
      )
    )
      throw unavailable();
    for (const name of ["git", "hooks-disabled", "source/.git"]) {
      try {
        await lstat(join(options.container, name));
        throw unavailable();
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
          throw error;
      }
    }
    const tool = await verifyNativeGitTool(options.tool);
    const deadline = Date.now() + 60_000;
    const env: NodeJS.ProcessEnv = {
      PATH: dirname(tool.executable),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "",
      GIT_AUTHOR_NAME: "Konteks local baseline",
      GIT_AUTHOR_EMAIL: "local@invalid",
      GIT_COMMITTER_NAME: "Konteks local baseline",
      GIT_COMMITTER_EMAIL: "local@invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      ...(process.platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    };
    const run = (args: string[], input: Buffer | string = ""): Promise<string> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(unavailable());
      return new Promise((resolve, reject) => {
        const child = execFile(
          tool.executable,
          args,
          {
            cwd: options.container,
            env,
            timeout: Math.min(10_000, remaining),
            killSignal: "SIGKILL",
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
          (error, stdout) => (error ? reject(unavailable()) : resolve(stdout)),
        );
        child.stdin?.on("error", () => {
          /* Process exit is settled by execFile's callback. */
        });
        child.stdin?.end(input);
      });
    };
    await run(["init", "--bare", "--object-format=sha1", "--template=", "git"]);
    await chmod(join(options.container, "git"), 0o700);
    await mkdir(join(options.container, "hooks-disabled"), { mode: 0o700 });
    await write(join(options.container, "git", "config"), config, false);
    await mkdir(join(options.container, "git", "info"), { mode: 0o700 });
    await write(join(options.container, "git", "info", "attributes"), attributes);
    const git = (args: string[], input?: Buffer | string) =>
      run(["--git-dir=git", "--work-tree=source", ...args], input);
    const index: string[] = [];
    for (const entry of tree.entries) {
      const hash = oid(
        await git(
          ["hash-object", "-w", "--no-filters", "--stdin"],
          Buffer.from(entry.contentBase64, "base64"),
        ),
      );
      index.push(
        (entry.mode === 448 ? "100755" : "100644") + " " + hash + "\t" + entry.path + "\0",
      );
    }
    await git(["update-index", "-z", "--index-info"], index.join(""));
    const baseTree = oid(await git(["write-tree"]));
    const baseCommit = oid(
      await git(["commit-tree", baseTree, "-m", "Konteks local input baseline"]),
    );
    await git(["update-ref", "refs/heads/konteks-local", baseCommit]);
    await git(["symbolic-ref", "HEAD", "refs/heads/konteks-local"]);
    await write(join(options.container, "source", ".git"), pointer);
    const receipt = NativeGitReceiptSchema.parse({
      format: "konteks-local-git-v1",
      baseCommit,
      baseTree,
      configDigest: "sha256:" + sha256Hex(config),
    });
    await verifyNativeGitWorkspace(options.container, receipt);
    // Flush the generated metadata before the caller atomically publishes its container.
    if (process.platform !== "win32") {
      const flush = async (path: string): Promise<void> => {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw unavailable();
        if (stat.isDirectory())
          for (const name of await readdir(path)) await flush(join(path, name));
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      };
      await flush(join(options.container, "git"));
      await flush(join(options.container, "hooks-disabled"));
    }
    return receipt;
  } catch {
    throw unavailable();
  }
}

/** Read-only verification: dirty files and later local commits are never reset. */
export async function verifyNativeGitWorkspace(container: string, value: unknown): Promise<void> {
  try {
    const receipt = NativeGitReceiptSchema.parse(value);
    await directory(container);
    await directory(join(container, "source"));
    await directory(join(container, "git"));
    await directory(join(container, "hooks-disabled"));
    if ((await readdir(join(container, "hooks-disabled"))).length !== 0) throw unavailable();
    if ((await boundedFile(join(container, "source", ".git"), 4096)).toString("utf8") !== pointer)
      throw unavailable();
    const actual = await boundedFile(join(container, "git", "config"), 16 * 1024);
    if (
      actual.toString("utf8") !== config ||
      receipt.configDigest !== "sha256:" + sha256Hex(actual)
    )
      throw unavailable();
    await directory(join(container, "git", "info"));
    if (
      (await boundedFile(join(container, "git", "info", "attributes"), 4096)).toString("utf8") !==
      attributes
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
}
