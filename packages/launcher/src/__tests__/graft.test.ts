import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGraft, graftAlreadyWired, planGraft, prepareDeliveryGraft, wireGraft, writeGraftRecord, type GraftTool } from "../native/graft.js";

/**
 * Graft in the person's repository (W1-G1..G3, WS1-081). A stand-in Graft
 * program writes what the real one writes, so what is kept out of git, and
 * what the wiring points at, can be checked without the real package.
 */

const FAKE_GRAFT = `
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.GRAFT_TEST_LOG), JSON.stringify({ args, dnt: process.env.DO_NOT_TRACK, noGitignore: process.env.GRAFT_NO_GITIGNORE }) + "\\n");
if (args[0] === "init") {
  const repo = args[1];
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); };
  w(".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-hooks.cjs" stop' }] }] }, permissions: { allow: ["Bash(graft:*)"] } }));
  w(".claude/helpers/graft-hooks.cjs", "// hooks");
  w(".claude/skills/graft/SKILL.md", "# graft");
  w(".mcp.json", JSON.stringify({ mcpServers: { graft: { command: "graft", args: ["mcp"] } } }));
  const agents = path.join(repo, "AGENTS.md");
  fs.writeFileSync(agents, (fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "") + "<!-- graft:start -->\\n");
  w("graft/INDEX.md", "# index");
  w(".ignore", "!graft/");
  console.log("✓ wiring: 4 nodes (2 file, 2 function), 3 edges, 2 cards [typescript]");
}
`;

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

describe("graft", () => {
  let dir: string;
  let repo: string;
  let root: string;
  let tool: GraftTool;
  let home: string;
  let savedHome: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "konteks-graft-"));
    repo = join(dir, "table-booking");
    root = join(dir, "connector");
    await mkdir(repo);
    await mkdir(root);
    git(repo, "init", "-q");
    await writeFile(join(repo, "index.ts"), "export const a = 1\n");
    const cli = join(dir, "fake-graft.cjs");
    await writeFile(cli, FAKE_GRAFT);
    tool = { node: process.execPath, cli };
    process.env.GRAFT_TEST_LOG = join(dir, "graft.log");
    home = join(dir, "home");
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    delete process.env.GRAFT_TEST_LOG;
    process.env.HOME = savedHome;
    await rm(dir, { recursive: true, force: true });
  });

  it("names the files it adds for this machine's agents, and the ones git already tracks", async () => {
    expect(await graftAlreadyWired(repo)).toBe(false);
    const plain = await planGraft(repo, ["claude-code", "codex"]);
    expect(plain.agents).toEqual(["claude", "agents"]);
    expect(plain.adds).toEqual(["graft/", ".claude/", ".mcp.json", "AGENTS.md"]);
    expect(plain.tracked).toEqual([]);
    expect(plain.files).toBe(1);

    await writeFile(join(repo, "AGENTS.md"), "# rules\n");
    git(repo, "add", "AGENTS.md");
    expect((await planGraft(repo, ["codex"])).tracked).toEqual(["AGENTS.md"]);
    expect((await planGraft(repo, ["claude-code"])).tracked).toEqual([]);
  });

  it("wires Graft with statistics off, keeps its files out of git, and points them at this machine's Node", async () => {
    const wired = await wireGraft(root, repo, ["claude-code", "codex"], tool);
    expect(wired.mappedFiles).toBe(2);
    expect(wired.changedTracked).toEqual([]);
    expect(wired.added).toEqual([".claude/helpers/", ".claude/settings.json", ".claude/skills/graft/", ".ignore", ".mcp.json", "AGENTS.md", "graft/"]);

    // Nothing Graft wrote shows as a change the person did not ask for (W1-G3).
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").trim()).toBe("?? index.ts");
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/graft/");
    expect(exclude).toContain("# Konteks: Graft's local files");

    // Every run had usage statistics off, and init stayed inside the repository.
    const runs = (await readFile(join(dir, "graft.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; dnt: string; noGitignore: string });
    expect(runs.map(r => r.args[0])).toEqual(["telemetry", "init"]);
    expect(runs[0]!.args).toEqual(["telemetry", "disable"]);
    expect(runs[1]!.args).toEqual(["init", repo, "--agents", "claude", "agents", "--no-global", "-y"]);
    expect(runs.every(r => r.dnt === "1" && r.noGitignore === "1")).toBe(true);

    // The wiring names this machine's Node and Graft, not whatever PATH has.
    const settings = JSON.parse(await readFile(join(repo, ".claude", "settings.json"), "utf8")) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }; permissions: unknown };
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toBe(`${JSON.stringify(process.execPath)} "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-hooks.cjs" stop`);
    expect(settings.permissions).toEqual({ allow: ["Bash(graft:*)"] });
    const mcp = JSON.parse(await readFile(join(repo, ".mcp.json"), "utf8")) as { mcpServers: { graft: { command: string; args: string[]; env: Record<string, string> } } };
    expect(mcp.mcpServers.graft).toEqual({ command: process.execPath, args: [tool.cli, "mcp"], env: { DO_NOT_TRACK: "1", NO_UPDATE_NOTIFIER: "1" } });
    const shim = await readFile(join(root, "bin", "graft"), "utf8");
    expect(shim).toContain("DO_NOT_TRACK=1");
    expect(shim).toContain(tool.cli);

    // Graft's own npm update check is answered in ~/.graft, so it never runs.
    const check = JSON.parse(await readFile(join(home, ".graft", "update-check.json"), "utf8")) as { checkedAt: number };
    expect(check.checkedAt).toBeGreaterThan(Date.now() + 1e12);

    expect(await graftAlreadyWired(repo)).toBe(true);

    // Wiring again adds no second exclude block.
    await wireGraft(root, repo, ["claude-code", "codex"], tool);
    expect((await readFile(join(repo, ".git", "info", "exclude"), "utf8")).split("# Konteks: Graft's local files").length).toBe(2);
  });

  it("says which tracked file Graft changed instead of hiding it", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# rules\n");
    git(repo, "add", "AGENTS.md");
    const wired = await wireGraft(root, repo, ["codex"], tool);
    expect(wired.changedTracked).toEqual(["AGENTS.md"]);
    expect(wired.added).not.toContain("AGENTS.md");
  });

  it("keeps tracked Graft annotations local in a generated delivery worktree", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# rules\n");
    git(repo, "add", "AGENTS.md", "index.ts");
    git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
    await prepareDeliveryGraft(root, repo, "codex", {
      available: async () => true,
      ensure: async () => tool,
      wire: wireGraft,
    });
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    expect(git(repo, "ls-files", "-v", "AGENTS.md")).toMatch(/^S /);
    expect(await readFile(join(repo, "graft", "INDEX.md"), "utf8")).toContain("index");
  });

  it("installs only a package whose checksum is the one the installer recorded", async () => {
    const packaged = join(dir, "pkg");
    await mkdir(join(packaged, "node_modules", "@nanonets", "graft", "dist"), { recursive: true });
    await writeFile(join(packaged, "node_modules", "@nanonets", "graft", "dist", "cli.js"), "// graft\n");
    const archive = join(dir, "konteks-graft-macos-arm64.tgz");
    execFileSync("tar", ["-czf", archive, "-C", packaged, "."]);
    const bytes = await readFile(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const served = (body: Buffer) => (async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch;
    const stagedNode = join(dir, "staged-node");
    await writeFile(stagedNode, "#!/bin/sh\n", { mode: 0o755 });
    const node = async () => stagedNode;

    await writeGraftRecord(root, { name: "konteks-graft-macos-arm64.tgz", digest, base: "https://release.test/download" });
    await expect(ensureGraft(root, { fetchFn: served(Buffer.from("tampered")), node })).rejects.toThrow(/does not match this release's checksum/);

    const installed = await ensureGraft(root, { fetchFn: served(bytes), node });
    // It lives in ~/.graft with its own Node, so it outlives Konteks (WS1-091).
    expect(installed.cli.startsWith(join(home, ".graft", "konteks"))).toBe(true);
    expect(installed.node).toBe(join(dirname(dirname(dirname(dirname(dirname(installed.cli))))), "bin", "node"));
    expect(await readFile(installed.node, "utf8")).toBe("#!/bin/sh\n");
    expect(await readFile(installed.cli, "utf8")).toBe("// graft\n");
    // Once unpacked it is not downloaded again.
    const again = await ensureGraft(root, { fetchFn: (async () => { throw new Error("must not download"); }) as unknown as typeof fetch, node });
    expect(again.cli).toBe(installed.cli);
  });

  it("refuses when the release has no Graft, or its Node is not unpacked", async () => {
    await expect(ensureGraft(root, { node: async () => process.execPath })).rejects.toThrow(/does not include Graft/);
    await writeGraftRecord(root, { name: "konteks-graft-macos-arm64.tgz", digest: "0".repeat(64), base: "https://release.test/download" });
    await expect(ensureGraft(root, { node: async () => null })).rejects.toThrow(/not unpacked yet/);
  });
});
