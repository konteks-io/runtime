import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_LINE_TOOLS_DIR,
  GIT_XCODE_LICENSE_MESSAGE,
  connectorGit,
  connectorGitEnv,
  gitChoiceReport,
  isGitXcodeLicenseError,
  requireConnectorGit,
  resolveGit,
} from "../git-choice.js";

const LICENSE = "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.";

/** A scripted `git --version`: each call answers with the next result, by whether DEVELOPER_DIR is set. */
function fakeRun(answer: (developerDir: string | undefined) => { code: number; stdout?: string; stderr?: string }) {
  return vi.fn(async (request: { env?: NodeJS.ProcessEnv }) => {
    const result = answer(request.env?.DEVELOPER_DIR);
    return { code: result.code, signal: null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  });
}
const tools = join("/fake", "CommandLineTools");
const toolsGit = join(tools, "usr", "bin", "git");
const withTools = (path: string) => path === toolsGit;
const noFiles = () => false;
const licenseGate = fakeRun(dir => (dir === tools ? { code: 0, stdout: "git version 2.50.1 (Apple Git-155)\n" } : { code: 69, stderr: LICENSE }));

describe("choosing git (injected platform and probe)", () => {
  it("takes the Command Line Tools' git when Xcode's license refuses and that git runs", async () => {
    const run = fakeRun(dir => (dir === tools ? { code: 0, stdout: "git version 2.50.1\n" } : { code: 69, stdout: LICENSE }));
    const choice = await resolveGit({ platform: "darwin", env: { PATH: "" }, commandLineTools: tools, run: run as never, isFile: withTools });
    expect(choice).toEqual({ git: "command_line_tools", path: toolsGit, reason: "xcode_license_pending", env: { DEVELOPER_DIR: tools } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports the license finding, and takes no fallback, when there are no Command Line Tools", async () => {
    const choice = await resolveGit({ platform: "darwin", env: { PATH: "" }, commandLineTools: tools, run: licenseGate as never, isFile: noFiles });
    expect(choice).toMatchObject({ git: "default", reason: "xcode_license_pending", env: {}, blocked: { code: "git_xcode_license_pending", message: GIT_XCODE_LICENSE_MESSAGE } });
  });

  it("reports the license finding when the Command Line Tools' git does not run either", async () => {
    const run = fakeRun(() => ({ code: 69, stderr: LICENSE }));
    const choice = await resolveGit({ platform: "darwin", env: { PATH: "" }, commandLineTools: tools, run: run as never, isFile: withTools });
    expect(choice.blocked?.code).toBe("git_xcode_license_pending");
    expect(choice.env).toEqual({});
  });

  it("never falls back on another git failure, so that error still surfaces", async () => {
    const run = fakeRun(() => ({ code: 128, stderr: "fatal: not a git repository" }));
    const choice = await resolveGit({ platform: "darwin", env: { PATH: "" }, commandLineTools: tools, run: run as never, isFile: withTools });
    expect(choice).toEqual({ git: "default", path: null, reason: "default", env: {} });
    expect(run).toHaveBeenCalledTimes(1);
    const missing = vi.fn(async () => { throw new Error("spawn git ENOENT"); });
    expect(await resolveGit({ platform: "darwin", env: { PATH: "" }, run: missing as never, isFile: withTools })).toEqual({ git: "default", path: null, reason: "default", env: {} });
  });

  it("leaves Linux and Windows untouched: nothing is probed", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const run = vi.fn();
      const choice = await resolveGit({ platform, env: { PATH: "" }, commandLineTools: tools, run: run as never, isFile: withTools });
      expect(choice).toEqual({ git: "default", path: null, reason: "default", env: {} });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("names the Command Line Tools at their fixed place by default", () => {
    expect(COMMAND_LINE_TOOLS_DIR).toBe("/Library/Developer/CommandLineTools");
  });
});

// A shell script stands in for git on a temporary PATH; Windows has no /bin/sh.
describe.skipIf(process.platform === "win32")("choosing git (a fake git on a temporary PATH)", () => {
  let root: string;
  let bin: string;
  let tools: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "git-choice-"));
    bin = join(root, "bin");
    tools = join(root, "CommandLineTools");
    await mkdir(bin);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /** `git` on the temporary PATH: the Xcode shim's license refusal unless DEVELOPER_DIR names the fake tools. */
  async function fakeGit(body: string): Promise<string> {
    const path = join(bin, "git");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }
  const shim = () => fakeGit(`if [ "$DEVELOPER_DIR" = "${tools}" ]; then echo "git version 2.50.1"; exit 0; fi\necho "${LICENSE}" >&2\nexit 69`);
  async function fakeTools(): Promise<void> {
    await mkdir(join(tools, "usr", "bin"), { recursive: true });
    await writeFile(join(tools, "usr", "bin", "git"), "");
  }
  const env = () => ({ PATH: `${bin}:/usr/bin:/bin` });

  it("chooses the Command Line Tools' git and hands DEVELOPER_DIR to git calls and agents", async () => {
    const git = await shim();
    await fakeTools();
    const choice = await connectorGit(git, { platform: "darwin", env: env(), commandLineTools: tools });
    expect(choice).toEqual({ git: "command_line_tools", path: join(tools, "usr", "bin", "git"), reason: "xcode_license_pending", env: { DEVELOPER_DIR: tools } });
    expect(connectorGitEnv()).toEqual({ DEVELOPER_DIR: tools });
    expect(gitChoiceReport(choice)).toEqual({ git: "command_line_tools", path: join(tools, "usr", "bin", "git"), reason: "xcode_license_pending", blocked: null });
    // Probed once per command.
    expect(await connectorGit(git)).toBe(choice);
  });

  it("reports the plain license finding when no Command Line Tools exist", async () => {
    const git = await shim();
    const choice = await resolveGit({ platform: "darwin", command: "git", env: env(), commandLineTools: tools });
    expect(choice).toMatchObject({ git: "default", path: git, reason: "xcode_license_pending", env: {} });
    expect(gitChoiceReport(choice).blocked).toBe("Git on this Mac needs the Xcode license accepted. Run: sudo xcodebuild -license accept");
    await connectorGit(git, { platform: "darwin", env: env(), commandLineTools: tools });
    const refusal = await requireConnectorGit(git).then(() => null, (error: unknown) => error);
    expect(isGitXcodeLicenseError(refusal)).toBe(true);
    expect(refusal).toMatchObject({ code: "prerequisite_missing", diagnostic: "git_xcode_license_pending", message: GIT_XCODE_LICENSE_MESSAGE });
  });

  it("takes no fallback for another git error, and keeps git as found", async () => {
    const git = await fakeGit(`echo "fatal: bad config line 1 in file /etc/gitconfig" >&2\nexit 128`);
    await fakeTools();
    const choice = await resolveGit({ platform: "darwin", command: "git", env: env(), commandLineTools: tools });
    expect(choice).toEqual({ git: "default", path: git, reason: "default", env: {} });
  });

  it("leaves a non-Mac untouched even behind the license text", async () => {
    const git = await shim();
    await fakeTools();
    expect(await resolveGit({ platform: "linux", command: "git", env: env(), commandLineTools: tools })).toEqual({ git: "default", path: git, reason: "default", env: {} });
  });
});
