import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isFsErrorWithCode, writeSecretFile } from "@konteks/remote-common";
import { readNativeRecord } from "./install.js";

const run = promisify(execFile);

/**
 * Graft, wired into the person's repository (W1-G1..G3, WS1-081).
 *
 * Graft maps a repository into a small linked graph its coding agents read
 * before they grep. It is a Node program with native grammar builds, so a
 * release ships it as one prebuilt package next to the connector, listed in
 * the release's signed checksums. The trusted installer records that
 * package's digest (`installer/graft.json`); nothing is downloaded until the
 * person says yes, and the download is refused unless it matches.
 *
 * It runs on the Node that the release's own agent packages carry, so the
 * laptop needs no Node of its own. Every run has usage statistics off
 * (`DO_NOT_TRACK`, and `graft telemetry disable` once), and only Graft's
 * no-model build runs: nothing is sent to a paid model.
 *
 * Its files are the person's to share or not: they are kept out of git with
 * the repository's local exclude file, never committed on their behalf.
 */

export const GRAFT_RECORD = "graft.json";

export const GraftRecordSchema = z
  .object({
    /** The package's file name in the release, e.g. konteks-graft-macos-arm64.tgz. */
    name: z.string().regex(/^[A-Za-z0-9._-]+\.tgz$/),
    /** Lowercase hex SHA-256 from the release's signed checksums. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    /** The release download base the installer used. */
    base: z.string().url(),
  })
  .strict();
export type GraftRecord = z.infer<typeof GraftRecordSchema>;

export interface GraftTool {
  node: string;
  cli: string;
}

/** The agent families Graft knows how to wire, by Graft's own ids. */
export const GRAFT_AGENT_IDS: Record<string, string> = { "claude-code": "claude", codex: "agents" };

/** What each wired agent adds to the repository, in words for the offer. */
const GRAFT_FILES: Record<string, string[]> = { claude: [".claude/", ".mcp.json"], agents: ["AGENTS.md"] };

/** Files Graft may write that a repository might already track. */
const TRACKABLE = [".claude/settings.json", ".mcp.json", "AGENTS.md", ".ignore"];

export async function readGraftRecord(root: string): Promise<GraftRecord | null> {
  const raw = await readFile(join(resolve(root), "installer", GRAFT_RECORD), "utf8").catch(error => {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
  if (raw === null) return null;
  const parsed = GraftRecordSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function writeGraftRecord(root: string, record: GraftRecord): Promise<void> {
  await mkdir(join(resolve(root), "installer"), { recursive: true, mode: 0o700 });
  await writeSecretFile(join(resolve(root), "installer", GRAFT_RECORD), JSON.stringify(GraftRecordSchema.parse(record)));
}

const executable = async (path: string) => access(path, constants.X_OK).then(() => true, () => false);

/**
 * The Node Graft runs on: the one inside this release's staged agent
 * packages, which the connector already verified. Null when none is staged.
 */
export async function graftNode(root: string): Promise<string | null> {
  const record = await readNativeRecord(root).catch(() => null);
  if (!record || record.releaseId === "pending") return null;
  for (const agent of record.agents) {
    const node = join(resolve(root), "releases", record.releaseId, "agents", agent, "bin", "node");
    if (await executable(node)) return node;
  }
  return null;
}

/** The unpacked package for this record, if it is already here. */
function toolDirectory(root: string, record: GraftRecord): string {
  return join(resolve(root), "tools", `graft-${record.digest.slice(0, 16)}`);
}

const cliOf = (directory: string) => join(directory, "node_modules", "@nanonets", "graft", "dist", "cli.js");

/**
 * Download, verify and unpack Graft, once. Refuses a package whose digest is
 * not the one the installer recorded from the signed checksums.
 */
export async function ensureGraft(
  root: string,
  deps: { fetchFn?: typeof fetch; node?: (root: string) => Promise<string | null> } = {},
): Promise<GraftTool> {
  const record = await readGraftRecord(root);
  if (!record) throw new Error("this connector release does not include Graft");
  const node = await (deps.node ?? graftNode)(root);
  if (!node) throw new Error("the agent packages Graft runs on are not unpacked yet");
  const directory = toolDirectory(root, record);
  if (await stat(cliOf(directory)).then(() => true, () => false)) return { node, cli: cliOf(directory) };

  const response = await (deps.fetchFn ?? fetch)(`${record.base.replace(/\/+$/, "")}/${record.name}`);
  if (!response.ok) throw new Error(`Graft could not be downloaded (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== record.digest) throw new Error("the downloaded Graft package does not match this release's checksum, so it was not installed");

  const work = join(tmpdir(), `konteks-graft-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    const archive = join(work, record.name);
    await writeFile(archive, bytes, { mode: 0o600 });
    const unpacked = join(work, "graft");
    await mkdir(unpacked, { mode: 0o700 });
    await run("tar", ["-xzf", archive, "-C", unpacked]);
    if (!(await stat(cliOf(unpacked)).then(() => true, () => false))) throw new Error("the Graft package has no command in it");
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await rm(directory, { recursive: true, force: true });
    await rename(unpacked, directory);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { node, cli: cliOf(directory) };
}

/** Every Graft run: statistics off, and its own .gitignore edit off (we exclude locally). */
function graftEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DO_NOT_TRACK: "1", GRAFT_NO_GITIGNORE: "1" };
}

export async function runGraft(tool: GraftTool, args: string[], cwd: string, timeoutMs = 10 * 60_000): Promise<string> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(tool.node, [tool.cli, ...args], { cwd, env: graftEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", chunk => (out += String(chunk)));
    child.stderr.on("data", chunk => (out += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolveRun(out);
      else reject(new Error(lastLine(out) ?? `graft exited with ${code}`));
    });
  });
}

function lastLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean)
    .at(-1);
}

async function git(repo: string, args: string[]): Promise<string> {
  return (await run("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** What the offer says: the files Graft adds, and any the repository already tracks. */
export async function planGraft(repo: string, families: string[]): Promise<{ agents: string[]; adds: string[]; tracked: string[]; files: number }> {
  const agents = families.map(family => GRAFT_AGENT_IDS[family]).filter((id): id is string => Boolean(id));
  const adds = ["graft/", ...agents.flatMap(id => GRAFT_FILES[id] ?? [])];
  const listed = (await git(repo, ["ls-files", "--", ...TRACKABLE]).catch(() => "")).split("\n").filter(Boolean);
  const files = (await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"]).catch(() => "")).split("\n").filter(Boolean).length;
  return { agents, adds, tracked: listed.filter(path => agents.some(id => (GRAFT_FILES[id] ?? []).some(add => path.startsWith(add.replace(/\/$/, ""))))), files };
}

/** Roughly how long the first build takes, for the note before it. */
export function graftBuildSeconds(files: number): number {
  return Math.max(5, Math.ceil(files / 150) * 5);
}

const EXCLUDE_MARK = "# Konteks: Graft's local files (set up by konteks-remote onboard)";

/**
 * Wire Graft for this machine's agents and build its map. Returns what was
 * added (kept out of git locally) and which tracked files it changed.
 */
export async function wireGraft(
  root: string,
  repo: string,
  families: string[],
  tool: GraftTool,
): Promise<{ added: string[]; changedTracked: string[]; mappedFiles: number | null }> {
  const { agents } = await planGraft(repo, families);
  const before = new Set((await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).split("\n").filter(Boolean));
  await runGraft(tool, ["telemetry", "disable"], repo, 60_000);
  const output = await runGraft(tool, ["init", repo, "--agents", ...agents, "--no-global", "-y"], repo);
  await pointWiringAtTool(repo, tool);
  await installGraftShim(root, tool);

  const after = (await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).split("\n").filter(Boolean);
  const fresh = after.filter(line => !before.has(line));
  const added = collapse(fresh.filter(line => line.startsWith("?? ")).map(line => line.slice(3)));
  const changedTracked = fresh.filter(line => !line.startsWith("?? ")).map(line => line.slice(3));
  await excludeLocally(repo, added);
  const mapped = /\((\d+) files?\b/.exec(output);
  return { added, changedTracked, mappedFiles: mapped ? Number(mapped[1]) : null };
}

/** `graft/a.md`, `graft/b.md` → `graft/`: exclude whole directories Graft owns. */
function collapse(paths: string[]): string[] {
  const owned = ["graft/", ".claude/helpers/", ".claude/skills/graft/"];
  const out = new Set<string>();
  for (const path of paths) out.add(owned.find(prefix => path.startsWith(prefix)) ?? path);
  return [...out].sort();
}

async function excludeLocally(repo: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
  const file = join(gitDir, "info", "exclude");
  const current = await readFile(file, "utf8").catch(() => "");
  const known = new Set(current.split("\n").map(line => line.trim()));
  const missing = paths.map(path => `/${path}`).filter(line => !known.has(line));
  if (missing.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  const block = [...(known.has(EXCLUDE_MARK) ? [] : [EXCLUDE_MARK]), ...missing].join("\n");
  await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}\n`);
}

/**
 * Graft's wiring calls `node` and `graft` from PATH, which a laptop without
 * Node has neither of. These files stay local, so they can name the Node and
 * the Graft this machine has.
 */
async function pointWiringAtTool(repo: string, tool: GraftTool): Promise<void> {
  const quoted = JSON.stringify(tool.node);
  const settingsPath = join(repo, ".claude", "settings.json");
  const settings = await readFile(settingsPath, "utf8").catch(() => null);
  if (settings !== null) {
    const rewritten = JSON.stringify(
      JSON.parse(settings, (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("node ") && value.includes("graft-") ? `${quoted} ${value.slice(5)}` : value,
      ),
      null,
      2,
    );
    await writeFile(settingsPath, `${rewritten}\n`);
  }
  const mcpPath = join(repo, ".mcp.json");
  const mcp = await readFile(mcpPath, "utf8").catch(() => null);
  if (mcp !== null) {
    const parsed = JSON.parse(mcp) as { mcpServers?: Record<string, unknown> };
    if (parsed.mcpServers?.graft) {
      parsed.mcpServers.graft = { command: tool.node, args: [tool.cli, "mcp"], env: { DO_NOT_TRACK: "1" } };
      await writeFile(mcpPath, `${JSON.stringify(parsed, null, 2)}\n`);
    }
  }
}

/** A `graft` command next to `konteks-remote`, for the commands AGENTS.md teaches. */
export async function installGraftShim(root: string, tool: GraftTool): Promise<string> {
  const bin = join(resolve(root), "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const shim = join(bin, "graft");
  await writeFile(shim, `#!/bin/sh\n# Graft, as konteks-remote installed it; usage statistics stay off.\nDO_NOT_TRACK=1 GRAFT_NO_GITIGNORE=1 exec ${JSON.stringify(tool.node)} ${JSON.stringify(tool.cli)} "$@"\n`);
  await chmod(shim, 0o755);
  return shim;
}
