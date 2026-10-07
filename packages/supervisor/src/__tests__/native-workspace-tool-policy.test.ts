import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { McpToolCallLedger } from "../session/permission-tool-identity.js";
import { EvaluatorPolicyResponder } from "../session/policy-responder.js";
import { DEFAULT_BASH_BLOCKLIST, POLICY_REFUSAL_PREFIX, blockedCommandPattern, createWorkspaceToolPolicy, describeRefusedPath, isWithinWorkspace, type WorkspaceToolPolicyEvaluation, type WorkspaceToolPolicyContext } from "../session/workspace-tool-policy.js";

const options = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
] as RequestPermissionRequest["options"];

function request(toolCall: Record<string, unknown>): RequestPermissionRequest {
  return { sessionId: "acp-1", toolCall: { toolCallId: "t1", ...toolCall }, options } as RequestPermissionRequest;
}

describe("native workspace tool policy", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-policy-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const context = { assignmentId: "a", agentId: "claude-code", workspaceRoot: root };
  const responder = new EvaluatorPolicyResponder(createWorkspaceToolPolicy(), () => true);

  it("answers ordinary tool calls by policy instead of deferring them to a human", async () => {
    await expect(responder.evaluatePermission(request({ kind: "other", title: "mcp__konteks-platform__prd_submit" }), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    // The session's preview tools run without a prompt: they only act inside its worktree.
    await expect(responder.evaluatePermission(request({ kind: "other", title: "mcp__konteks-preview__preview_start", rawInput: {} }), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    await expect(responder.evaluatePermission(request({ kind: "execute", title: "npm test", rawInput: { command: "npm test" } }), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    await expect(responder.evaluatePermission(request({ kind: "edit", title: "Write", rawInput: { file_path: join(root, "src", "a.ts") } }), context))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
  });

  it("allows the QA browser's tools only on a session given the browser, and never the unsafe ones", async () => {
    const browser = { ...context, browserTools: true };
    // Identity is the bridge's structured tool name, never the title.
    const claude = (toolName: string, rest: Record<string, unknown> = {}) => request({ kind: "other", title: toolName, ...rest, _meta: { claudeCode: { toolName } } });
    await expect(responder.evaluatePermission(claude("mcp__konteks-browser__browser_navigate", { rawInput: { url: "http://127.0.0.1:43100/" } }), browser))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    const ledger = new McpToolCallLedger();
    ledger.observe({ sessionUpdate: "tool_call", toolCallId: "t1", rawInput: { server: "konteks-browser", tool: "browser_click", arguments: {} }, _meta: { is_mcp_tool_call: true } });
    await expect(responder.evaluatePermission({ ...request({ kind: "execute", status: "pending" }), _meta: { is_mcp_tool_approval: true } } as RequestPermissionRequest, { ...browser, agentId: "codex", ledger }))
      .resolves.toEqual({ kind: "allow", optionId: "allow" });
    await expect(responder.evaluatePermission(claude("mcp__konteks-browser__browser_navigate"), context))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
    await expect(responder.evaluatePermission(claude("mcp__konteks-browser__browser_run_code_unsafe"), browser))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
    // A title alone allows nothing.
    await expect(responder.evaluatePermission(request({ kind: "other", title: "mcp__konteks-browser__browser_navigate" }), browser))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
    // Human deferral is never how a browser call is decided.
    await expect(new EvaluatorPolicyResponder(null, () => true).evaluatePermission(claude("mcp__konteks-browser__browser_route"), browser))
      .resolves.toEqual({ kind: "deny", optionId: "reject" });
  });

  it("denies blocklisted commands, including a shell call judged by its title", async () => {
    await expect(responder.evaluatePermission(request({ kind: "execute", rawInput: { command: "git push origin main" } }), context))
      .resolves.toMatchObject({ kind: "deny", optionId: "reject", refusal: { reason: "bash_blocklist", pattern: "git push" } });
    await expect(responder.evaluatePermission(request({ kind: "execute", title: "sudo rm -rf x" }), context))
      .resolves.toMatchObject({ kind: "deny", optionId: "reject" });
    expect(blockedCommandPattern("git branch --show-current", ["nc "])).toBeNull();
  });

  it("denies file changes outside the workspace, through locations or a symlink", async () => {
    await expect(responder.evaluatePermission(request({ kind: "edit", rawInput: { file_path: "/etc/hosts" } }), context))
      .resolves.toMatchObject({ kind: "deny", optionId: "reject" });
    await expect(responder.evaluatePermission(request({ kind: "delete", locations: [{ path: join(root, "..", "x") }] }), context))
      .resolves.toMatchObject({ kind: "deny", optionId: "reject" });
    symlinkSync(tmpdir(), join(root, "escape"));
    expect(isWithinWorkspace(join(root, "escape", "file.txt"), root)).toBe(false);
    expect(isWithinWorkspace("src/new-file.ts", root)).toBe(true);
  });
});

// One of four paths in a Codex "Edit files" call was written
// from the filesystem root, the whole call was refused, and neither the log nor
// the agent learned which path or why.
describe("a refused file change names what is outside and how to fix it", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-refusal-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "session-1");
  mkdirSync(join(cwd, "storefront", "lib"), { recursive: true });
  const policy = createWorkspaceToolPolicy();
  const judge = (locations: string[]) => policy.evaluateToolUse({
    toolName: "edit", input: { locations: locations.map(path => ({ path })) }, repoPath: cwd, workspaceRoot: root, agentId: "codex", toolUseId: "t",
  }) as WorkspaceToolPolicyEvaluation;

  it("refuses the whole call, names every outside path and the working copy, and suggests the working-copy path", () => {
    const page = "/storefront/app/checkout/confirmation/[orderId]/page.tsx";
    const evaluation = judge([join(cwd, "storefront", "lib", "orders.ts"), page, join(cwd, "storefront", "lib", "cart.ts"), "../../outside.txt"]);
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.refusal).toEqual({ reason: "outside_workspace", pathCount: 4, outside: [
      { path: page, rootAnchored: true, suggestion: "storefront/app/checkout/confirmation/[orderId]/page.tsx" },
      { path: "../../outside.txt", rootAnchored: false },
    ] });
    expect(evaluation.denyMessage).toBe(`Konteks refused this file change: 2 of 4 paths are outside the workspace \`${cwd}/\`. ` +
      `\`${page}\` starts at the filesystem root; inside the workspace it is \`storefront/app/checkout/confirmation/[orderId]/page.tsx\`; ` +
      "`../../outside.txt` is outside it. Nothing in it was applied. Use paths inside the workspace, relative to it, and try again.");
    expect(evaluation.denyMessage!.startsWith(POLICY_REFUSAL_PREFIX)).toBe(true);
  });

  it("never allows a root-anchored path: an ACP answer cannot rewrite where the agent writes", () => {
    expect(judge(["/storefront/lib/orders.ts"]).allowed).toBe(false);
  });

  it("reads a path as root-anchored only when that is unambiguous and stays inside", () => {
    // A real folder at the filesystem root is the agent's real target.
    expect(describeRefusedPath("/etc/hosts", root, cwd)).toEqual({ path: relative(cwd, "/etc/hosts"), rootAnchored: false });
    // A traversal is never reinterpreted.
    expect(describeRefusedPath("/storefront/../../x", root, cwd).rootAnchored).toBe(false);
    // A folder the working copy does not have is not a working-copy path.
    expect(describeRefusedPath("/nowhere-in-copy/x.ts", root, cwd).rootAnchored).toBe(false);
    // A symlink inside the working copy that leaves the boundary stays outside.
    symlinkSync(tmpdir(), join(cwd, "linked"));
    expect(describeRefusedPath("/linked/x.ts", root, cwd).rootAnchored).toBe(false);
    // An absolute path elsewhere is shown relative to the working copy, never as this computer's path.
    expect(describeRefusedPath(join(root, "..", "other", "x.ts"), root, cwd)).toEqual({ path: "../../other/x.ts", rootAnchored: false });
  });
});

describe("the connector's command blocklist", () => {
  it("lets ordinary output discards and project paths through, and still blocks the real thing", () => {
    expect(blockedCommandPattern("ls context 2>/dev/null", DEFAULT_BASH_BLOCKLIST)).toBeNull();
    expect(blockedCommandPattern("npm test > /dev/null 2>&1 &", DEFAULT_BASH_BLOCKLIST)).toBeNull();
    expect(blockedCommandPattern("rm -rf /tmp/work/node_modules", DEFAULT_BASH_BLOCKLIST)).toBeNull();

    expect(blockedCommandPattern("echo x > /dev/sda", DEFAULT_BASH_BLOCKLIST)).toBe("/dev/");
    expect(blockedCommandPattern("rm -rf /", DEFAULT_BASH_BLOCKLIST)).toBe("rm -rf /");
    expect(blockedCommandPattern("cd x && rm -rf /*", DEFAULT_BASH_BLOCKLIST)).toBe("rm -rf /");
  });

  it("refuses Windows elevation like sudo, and leaves look-alikes alone", () => {
    expect(blockedCommandPattern("powershell -NoProfile -Command \"Start-Process -Verb RunAs -Wait -FilePath cmd.exe\"", DEFAULT_BASH_BLOCKLIST)).toBe("runas");
    expect(blockedCommandPattern("Start-Process pwsh -Verb:RunAs", DEFAULT_BASH_BLOCKLIST)).toBe("verb:runas");
    expect(blockedCommandPattern("runas /user:Administrator cmd", DEFAULT_BASH_BLOCKLIST)).toBe("runas");
    expect(blockedCommandPattern("gsudo net stop wuauserv", DEFAULT_BASH_BLOCKLIST)).toBe("gsudo");
    expect(blockedCommandPattern("sudo -n true", DEFAULT_BASH_BLOCKLIST)).toBe("sudo ");
    expect(blockedCommandPattern("type runas.txt", DEFAULT_BASH_BLOCKLIST)).toBeNull();
    expect(blockedCommandPattern("npm run assemble", DEFAULT_BASH_BLOCKLIST)).toBeNull();
  });
});

describe("session reads with verified organization skill roots", () => {
  const runner = mkdtempSync(join(tmpdir(), "read-policy-"));
  afterAll(() => rmSync(runner, { recursive: true, force: true }));
  const cwd = join(runner, "own"), peer = join(runner, "peer"), skill = join(runner, "skills", "selected");
  mkdirSync(cwd); mkdirSync(peer); mkdirSync(skill, { recursive: true });
  const policy = createWorkspaceToolPolicy();
  const judge = (toolName: string, input: Record<string, unknown>) => {
    const context: WorkspaceToolPolicyContext = { toolName, input, repoPath: cwd, workspaceRoot: cwd,
      readOnlyRoots: [skill], agentId: "claude-code", toolUseId: "read" };
    return Promise.resolve(policy.evaluateToolUse(context));
  };

  it("allows session-relative reads and selected skill reads, but never gives those skills write authority", async () => {
    expect((await judge("read", { file_path: "README.md" })).allowed).toBe(true);
    expect((await judge("read", { file_path: join(skill, "SKILL.md") })).allowed).toBe(true);
    expect((await judge("search", { path: skill })).allowed).toBe(true);
    expect((await judge("edit", { file_path: join(skill, "SKILL.md") })).allowed).toBe(false);
  });

  it("denies peer, unnamed and mixed reads, and cannot be widened by tool arguments", async () => {
    expect((await judge("read", { file_path: join(peer, "private.txt") })).allowed).toBe(false);
    expect((await judge("search", { pattern: "*" })).allowed).toBe(false);
    expect((await judge("read", { file_path: join(peer, "private.txt"), readOnlyRoots: [peer] })).allowed).toBe(false);
    expect((await judge("read", { locations: [{ path: join(cwd, "README.md") }, { path: join(peer, "private.txt") }] })).allowed).toBe(false);
  });

  it("rejects a skill symlink escaping its declared directory and a dangling-link observation", async () => {
    symlinkSync(peer, join(skill, "escape"));
    expect((await judge("read", { file_path: join(skill, "escape", "private.txt") })).allowed).toBe(false);
    symlinkSync(join(peer, "missing-directory"), join(cwd, "dangling"));
    expect((await judge("read", { file_path: join(cwd, "dangling", "private.txt") })).allowed).toBe(false);
  });
});
