import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRemoteFileTreeDigest } from "@konteks/remote-common";
import { initializeNativeGitWorkspace, verifyNativeGitWorkspace } from "../native/git-workspace.js";
import { testGitCommand, testGitTool } from "./native-git-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "konteks-local-git-"));
  roots.push(root);
  const container = join(root, "assignment"),
    cwd = join(container, "source");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const tool = await testGitTool();
  const files = {
    ".gitignore": "*.ignored\n",
    ".gitattributes": "* filter=hostile text\n",
    "keep.ignored": "ignored but selected\r\n",
    "run.sh": "#!/bin/sh\nexit 0\n",
  };
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    mode: path === "run.sh" ? 448 : 384,
    sizeBytes: Buffer.byteLength(content),
    digest: "sha256:" + createHash("sha256").update(content).digest("hex"),
    contentBase64: Buffer.from(content).toString("base64"),
  }));
  for (const entry of entries) {
    await writeFile(join(cwd, entry.path), Buffer.from(entry.contentBase64, "base64"), {
      mode: entry.mode,
    });
    await chmod(join(cwd, entry.path), entry.mode);
  }
  const tree = {
    format: "konteks-file-tree-v1",
    treeDigest: computeRemoteFileTreeDigest(entries),
    entries,
  };
  const git = (...args: string[]) => testGitCommand(tool, cwd, args);
  return { root, container, cwd, tool, tree, git };
}

describe("private native Git baseline", () => {
  it("excludes test-host tool discovery helpers from the production build", async () => {
    const config = JSON.parse(
      await readFile(new URL("../../tsconfig.json", import.meta.url), "utf8"),
    );
    expect(config.exclude).toContain("src/__tests__/**");
  });
  it("creates a byte-exact local baseline, including ignored files and executable modes", async () => {
    const f = await fixture();
    const receipt = await initializeNativeGitWorkspace({
      container: f.container,
      tool: f.tool,
      tree: f.tree,
    });
    expect(await f.git("rev-parse", "HEAD")).toBe(receipt.baseCommit + "\n");
    expect(await f.git("show", "HEAD:keep.ignored")).toBe("ignored but selected\r\n");
    expect(await f.git("ls-tree", "HEAD", "run.sh")).toMatch(/^100755 blob /);
    expect(await f.git("remote")).toBe("");
    expect(await f.git("status", "--porcelain")).toBe("");
    expect(await readFile(join(f.cwd, ".git"), "utf8")).toBe("gitdir: ../git\n");
    await verifyNativeGitWorkspace(f.container, receipt);
  });
  it("ignores inherited configuration, templates, hooks and process credentials", async () => {
    const f = await fixture();
    const global = join(f.root, "hostile-config");
    await writeFile(
      global,
      '[core]\n repositoryformatversion = 999\n[filter "hostile"]\n required = true\n clean = false\n',
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.repositoryformatversion");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "999");
    vi.stubEnv("GIT_DIR", join(f.root, "foreign"));
    vi.stubEnv("GIT_TEMPLATE_DIR", "/missing/template");
    const receipt = await initializeNativeGitWorkspace({
      container: f.container,
      tool: f.tool,
      tree: f.tree,
    });
    expect(await f.git("show", "HEAD:keep.ignored")).toBe("ignored but selected\r\n");
    await verifyNativeGitWorkspace(f.container, receipt);
  });
  it("does not reset local edits or commits when verifying an existing baseline", async () => {
    const f = await fixture(),
      receipt = await initializeNativeGitWorkspace({
        container: f.container,
        tool: f.tool,
        tree: f.tree,
      });
    await writeFile(join(f.cwd, "run.sh"), "local edits");
    await f.git(
      "-c",
      "user.name=Test Agent",
      "-c",
      "user.email=test@invalid",
      "commit",
      "-am",
      "Local agent work",
    );
    const localHead = await f.git("rev-parse", "HEAD");
    expect(localHead.trim()).not.toBe(receipt.baseCommit);
    await verifyNativeGitWorkspace(f.container, receipt);
    expect(await readFile(join(f.cwd, "run.sh"), "utf8")).toBe("local edits");
    await expect(
      initializeNativeGitWorkspace({ container: f.container, tool: f.tool, tree: f.tree }),
    ).rejects.toThrow();
    expect(await f.git("rev-parse", "HEAD")).toBe(localHead);
  });
  it("rejects changed configuration and pointers without running repository code", async () => {
    const f = await fixture(),
      receipt = await initializeNativeGitWorkspace({
        container: f.container,
        tool: f.tool,
        tree: f.tree,
      });
    await writeFile(join(f.container, "git", "config"), "[include]\n path = /private/other\n");
    await expect(verifyNativeGitWorkspace(f.container, receipt)).rejects.toThrow();
    const g = await fixture(),
      second = await initializeNativeGitWorkspace({
        container: g.container,
        tool: g.tool,
        tree: g.tree,
      });
    await writeFile(join(g.cwd, ".git"), "gitdir: /elsewhere\n");
    await expect(verifyNativeGitWorkspace(g.container, second)).rejects.toThrow();
  });
  it("refuses missing, relative or changed tool executables before initialization", async () => {
    const f = await fixture();
    for (const tool of [
      { ...f.tool, executable: "git" },
      { ...f.tool, executable: join(f.root, "missing") },
      { ...f.tool, digest: "sha256:" + "f".repeat(64) },
    ]) {
      await expect(
        initializeNativeGitWorkspace({ container: f.container, tool, tree: f.tree }),
      ).rejects.toThrow();
    }
    await expect(access(join(f.cwd, ".git"))).rejects.toThrow();
  });
  it("does not initialize over imported Git metadata", async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, ".git"), "gitdir: ../foreign\n");
    await expect(
      initializeNativeGitWorkspace({ container: f.container, tool: f.tool, tree: f.tree }),
    ).rejects.toThrow();
    expect(await readFile(join(f.cwd, ".git"), "utf8")).toBe("gitdir: ../foreign\n");
  });
  it("refuses added hooks and changed attribute isolation on reuse", async () => {
    const f = await fixture(),
      receipt = await initializeNativeGitWorkspace({
        container: f.container,
        tool: f.tool,
        tree: f.tree,
      });
    await writeFile(join(f.container, "hooks-disabled", "pre-commit"), "untrusted");
    await expect(verifyNativeGitWorkspace(f.container, receipt)).rejects.toThrow();
    const g = await fixture(),
      second = await initializeNativeGitWorkspace({
        container: g.container,
        tool: g.tool,
        tree: g.tree,
      });
    await writeFile(join(g.container, "git", "info", "attributes"), "* filter=external\n");
    await expect(verifyNativeGitWorkspace(g.container, second)).rejects.toThrow();
  });
});
