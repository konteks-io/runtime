import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionContextFolder, sessionContextFolder } from "../native/input-preparer.js";
import { nativePermissionEscalation } from "../session/native-permission-escalation.js";
import { createWorkspaceToolPolicy, isWithinReadRoots, type WorkspaceToolPolicyEvaluation } from "../session/workspace-tool-policy.js";

/**
 * The standing rule: context, memory and instruction resolution derives from
 * the session's own folder. A path that could leave it (the session-context
 * parent, a sibling session, the operator's home, a link out) is refused by
 * name, and never becomes a read root or an automatic allow.
 */
const RULE = "session context resolution stays inside this session's own folder";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Selection = Parameters<typeof sessionContextFolder>[1];

function selectionFor(sessionId: string): Selection {
  return {
    version: 1,
    binding: { workspaceId: "tenant", instanceId: "instance", sessionId, assignmentId: "assignment", attempt: 1 },
    claimId: "claim",
  } as Selection;
}

async function fixture(kind: string): Promise<{ parent: string; root: string; selection: Selection; folder: string; cwd: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `session-context-guard-${kind}-`)));
  roots.push(root);
  const parent = join(root, "session-context");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const selection = selectionFor(kind);
  const folder = sessionContextFolder(parent, selection).folder;
  return { parent, root, selection, folder, cwd: join(folder, "source") };
}

describe("the session context resolver", () => {
  it(`${RULE} — resolves only this session's own folder, never the session-context parent`, async () => {
    const f = await fixture("parent");
    await mkdir(f.cwd, { recursive: true, mode: 0o700 });
    expect(await resolveSessionContextFolder(f.parent, f.selection)).toMatchObject({ folder: f.folder, cwd: f.cwd });
    await rm(f.folder, { recursive: true, force: true });
    await symlink(f.parent, f.folder, "dir");
    await expect(resolveSessionContextFolder(f.parent, f.selection))
      .rejects.toMatchObject({ diagnostic: "session_context_folder_is_parent" });
  });

  it(`${RULE} — refuses a sibling session's context folder and never calls it this session's`, async () => {
    const f = await fixture("sibling");
    const sibling = join(f.parent, `session-${"a".repeat(64)}`);
    await mkdir(join(sibling, "source"), { recursive: true, mode: 0o700 });
    await symlink(sibling, f.folder, "dir");
    await expect(resolveSessionContextFolder(f.parent, f.selection))
      .rejects.toMatchObject({ diagnostic: "session_context_folder_is_sibling" });
  });

  it(`${RULE} — refuses a folder that resolves into the operator's home`, async () => {
    const f = await fixture("home");
    await symlink(homedir(), f.folder, "dir");
    await expect(resolveSessionContextFolder(f.parent, f.selection))
      .rejects.toMatchObject({ diagnostic: "session_context_folder_in_operator_home" });
  });

  it(`${RULE} — refuses a folder that resolves anywhere outside its own session folder`, async () => {
    const f = await fixture("outside");
    const outside = join(f.root, "elsewhere");
    await mkdir(join(outside, "source"), { recursive: true, mode: 0o700 });
    await symlink(outside, f.folder, "dir");
    await expect(resolveSessionContextFolder(f.parent, f.selection))
      .rejects.toMatchObject({ diagnostic: "session_context_folder_outside_session" });
  });

  it(`${RULE} — names a missing folder instead of falling back to another one`, async () => {
    const f = await fixture("missing");
    await expect(resolveSessionContextFolder(f.parent, f.selection))
      .rejects.toMatchObject({ diagnostic: "session_context_folder_missing" });
  });
});

describe("a session-context path is a read root only inside this session's own folder", () => {
  const policy = createWorkspaceToolPolicy();

  function evaluate(path: string, readOnlyRoots: readonly string[], cwd: string): Promise<WorkspaceToolPolicyEvaluation> {
    return policy.evaluateToolUse({ toolName: "read", input: { file_path: path }, repoPath: cwd, workspaceRoot: cwd,
      readOnlyRoots }) as Promise<WorkspaceToolPolicyEvaluation>;
  }

  it(`${RULE} — the own context folder is readable, the parent and every sibling are not`, async () => {
    const f = await fixture("readroots");
    const cwd = join(f.root, "worktree");
    await mkdir(join(f.cwd, "memory"), { recursive: true, mode: 0o700 });
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const own = join(f.cwd, "memory", "conversation.md");
    const sibling = join(f.parent, `session-${"b".repeat(64)}`, "source", "memory", "conversation.md");
    expect(isWithinReadRoots(own, cwd, [f.cwd])).toBe(true);
    expect(isWithinReadRoots(join(f.cwd, ".assistant", "session-context.json"), cwd, [f.cwd])).toBe(true);
    expect(isWithinReadRoots(sibling, cwd, [f.cwd])).toBe(false);
    // A broken caller that declares the parent is still refused.
    expect(isWithinReadRoots(sibling, cwd, [f.cwd, f.parent])).toBe(false);
    expect(isWithinReadRoots(f.parent, cwd, [f.cwd])).toBe(false);
    expect(await evaluate(own, [f.cwd], cwd)).toMatchObject({ allowed: true });
    for (const path of [sibling, f.parent, join(f.parent, "session-other", "memory", "conversation.md")]) {
      expect(await evaluate(path, [f.cwd], cwd)).toMatchObject({ allowed: false, refusal: { reason: "outside_read_roots" } });
    }
  });

  it(`${RULE} — a link that resolves into the operator's home is not a read root`, async () => {
    const f = await fixture("homeread");
    const cwd = join(f.root, "worktree");
    await mkdir(f.cwd, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await symlink(homedir(), join(f.cwd, "escape"), "dir");
    expect(isWithinReadRoots(join(f.cwd, "escape", ".claude", "CLAUDE.md"), cwd, [f.cwd])).toBe(false);
    expect(await evaluate(join(f.cwd, "escape", ".claude", "CLAUDE.md"), [f.cwd], cwd))
      .toMatchObject({ allowed: false, refusal: { reason: "outside_read_roots" } });
  });
});

describe("a Claude shell call outside this session's own context folder never auto-allows", () => {
  const options = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ];

  function decide(paths: string[], context: object): { kind: string; refusal?: { reason: string } } {
    return nativePermissionEscalation({
      sessionId: "acp", options,
      toolCall: { toolCallId: "tool", title: "Size of memory files", kind: "execute", locations: paths.map(path => ({ path })),
        rawInput: { command: "wc -l memory/conversation.md" }, _meta: { claudeCode: { toolName: "Bash" } } },
    } as never, context as never, { kind: "native", tool: "Bash" } as never, () => true) as never;
  }

  it(`${RULE} — the own context folder is refused to the Read tool, a sibling or the parent is never allowed`, async () => {
    const f = await fixture("escalation");
    const cwd = join(f.root, "worktree");
    await mkdir(f.cwd, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const context = { assignmentId: "assignment", agentId: "claude-code", cwd, workspaceRoot: cwd,
      readOnlyRoots: [f.cwd], sessionContextRoot: f.cwd, assignmentKind: "delivery" };
    expect(decide([join(f.cwd, "memory", "conversation.md")], context))
      .toMatchObject({ kind: "deny", refusal: { reason: "session_context_shell" } });
    for (const path of [f.parent, join(f.parent, `session-${"c".repeat(64)}`, "source", "memory", "conversation.md")]) {
      const decision = decide([path], context);
      expect(decision.kind, `${path} was ${decision.kind}`).not.toBe("allow");
      expect(decision.kind).toBe("defer");
    }
    for (const path of [f.parent, join(f.parent, `session-${"d".repeat(64)}`, "source", "memory", "conversation.md")]) {
      expect(decide([path], { ...context, assignmentKind: "planning" }))
        .toMatchObject({ kind: "deny", refusal: { reason: "planning_outside_shell" } });
    }
  });
});

describe("the instruction scopes are driven by the session folder, never the operator's home", () => {
  type ClaudeScope = (settings: Record<string, unknown>, cwd: string, userConfigDir: string) =>
    Promise<{ claudeMdExcludes: string[]; autoMemoryEnabled: boolean }>;
  type CodexScope = { konteksCodexInstructionScope: (workingCopy: string) => Record<string, unknown> };

  it(`${RULE} — under a personal Claude profile the user rules, ancestors and auto memory stay excluded`, async () => {
    const { isolateClaudeInstructions } = (await import("../../../../scripts/claude-instruction-scope.mjs")) as unknown as {
      isolateClaudeInstructions: ClaudeScope;
    };
    const root = await realpath(await mkdtemp(join(tmpdir(), "instruction-scope-claude-")));
    roots.push(root);
    const home = join(root, "operator-home");
    const cwd = join(home, "code", "repo");
    const user = join(home, ".claude");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(user, "rules"), { recursive: true });
    const settings = { env: { HOME: home, RUNNER_WORKSPACE_DIR: home, RUNNER_CREDENTIAL_DIR: user, RUNNER_MEMORY_DIR: join(user, "memory") } };
    const result = await isolateClaudeInstructions(settings, cwd, user);
    for (const excluded of [join(user, "CLAUDE.md"), `${join(user, "rules")}/**`, join(home, "code", "CLAUDE.md"), join(home, "CLAUDE.md")]) {
      expect(result.claudeMdExcludes).toContain(excluded);
    }
    expect(result.claudeMdExcludes).not.toContain(join(cwd, "CLAUDE.md"));
    expect(result.autoMemoryEnabled).toBe(false);
    // No RUNNER_* value can move those roots: the same exclusions without them.
    expect((await isolateClaudeInstructions({}, cwd, user)).claudeMdExcludes).toEqual(result.claudeMdExcludes);
  });

  it(`${RULE} — the Codex thread scope carries only the working copy's instructions`, async () => {
    // The fixture-backed test in scripts/codex-acp-live-user-patch.test.mjs
    // drives the patched upstream createSessionConfig and checks the config
    // that reaches thread/start. This guard checks the scope's contract.
    const { konteksCodexInstructionScope } = (await import("../../../../scripts/codex-acp-live-user-patch.mjs")) as unknown as CodexScope;
    const root = await realpath(await mkdtemp(join(tmpdir(), "instruction-scope-codex-")));
    roots.push(root);
    const workingCopy = join(root, "work");
    const sharedHome = join(root, "operator", ".codex");
    await mkdir(workingCopy, { recursive: true });
    await mkdir(sharedHome, { recursive: true });
    await writeFile(join(workingCopy, "AGENTS.md"), "# working copy rules\n");
    await writeFile(join(sharedHome, "AGENTS.md"), "# operator private rules\n");
    await writeFile(join(sharedHome, "AGENTS.override.md"), "# operator private override\n");
    const scope = konteksCodexInstructionScope(workingCopy);
    expect(scope).toMatchObject({ project_doc_max_bytes: 0, features: { memories: false }, developer_instructions: "# working copy rules\n" });
    // Nothing in the thread scope names the shared profile or its files.
    expect(JSON.stringify(scope)).not.toMatch(/operator private|\.codex|CODEX_HOME/);
  });
});
