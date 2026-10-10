import { describe, expect, it } from "vitest";
import { SessionToCoreMessageSchema } from "@konteks/remote-common";
import {
  boundPublicToolTitle,
  canonicalizeAcpToolActivity,
  chunkOptions,
  contractIssue,
  nextTrail,
  omitPrivateAcpToolPayload,
  redactActivity,
  redactSessionMessage,
  type ChunkTrail,
} from "../session/activity.js";

/** Redact a stream chunk by chunk the way RelayedSession does. */
function redactStream(chunks: string[], root = "/Users/me/work"): string {
  let previous: ChunkTrail | undefined;
  return chunks.map(chunk => {
    const options = chunkOptions(previous);
    const output = redactActivity(chunk, root, options) as string;
    previous = nextTrail(previous, chunk, options, output);
    return output;
  }).join("");
}

describe("streamed activity redaction", () => {
  it("applies a chunk's continuation only to its text, never to the message's own fields", () => {
    const message = { kind: "acp", method: "session/update", params: { sessionId: "acp-1",
      update: { sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "o/src/index.ts now" } } } };
    const chunk = { startsAtBoundary: false, continuesPath: true };
    // The cause: the chunk's options reached `kind`, `method` and `sessionUpdate`.
    const whole = SessionToCoreMessageSchema.safeParse(redactActivity(message, "/Users/me/work", chunk));
    expect(whole.success).toBe(false);
    expect(whole.success ? undefined : contractIssue(whole.error.issues)).toMatchObject({ issuePath: expect.stringMatching(/^(kind|method|params\.update\.sessionUpdate)$/) });
    const scoped = SessionToCoreMessageSchema.safeParse(redactSessionMessage(message, "/Users/me/work", chunk));
    expect(scoped.success).toBe(true);
    expect(scoped.data).toMatchObject({ kind: "acp", method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "[local-path] now" } } } });
  });

  it.each([
    ["Agent", "other"],
    ["ToolSearch", "search"],
  ] as const)("retains Claude %s identity after private metadata is removed", (name, kind) => {
    const canonical = canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call",
      toolCallId: `tool-${name}`,
      title: "Other",
      kind: "other",
      status: "pending",
      _meta: { "claude.ai/tool": { name, kind: "other", private: "must-not-leave" } },
    }, "claude-code");

    expect(redactActivity(canonical, "/Users/me/work")).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: `tool-${name}`,
      title: name,
      name,
      kind,
      status: "pending",
    });
  });

  it("canonicalizes Claude ToolSearch when the bridge exposes only its public title", () => {
    const canonical = canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call",
      toolCallId: "tool-search-title-only",
      title: "ToolSearch",
      kind: "other",
      status: "pending",
    }, "claude-code");

    expect(canonical).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tool-search-title-only",
      title: "ToolSearch",
      name: "ToolSearch",
      kind: "search",
      status: "pending",
    });
  });

  it("promotes a Claude platform MCP tool label to the federated tool name", () => {
    const canonical = canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call",
      toolCallId: "tool-ideation",
      title: "mcp__konteks-1788413200202-4qlo2i__platform__builtin__ideation_system",
      kind: "other",
      status: "pending",
      rawInput: { intent: "add todos" },
    }, "claude-code");

    expect(redactActivity(canonical, "/Users/me/work")).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tool-ideation",
      title: "mcp__konteks-1788413200202-4qlo2i__platform__builtin__ideation_system",
      name: "platform__builtin__ideation_system",
      kind: "other",
      status: "pending",
    });
    // A later update of the same call keeps the promoted identity.
    expect(canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-ideation",
      status: "completed",
    }, "claude-code", { name: "platform__builtin__ideation_system", kind: "other" })).toMatchObject({
      name: "platform__builtin__ideation_system",
    });
    // Anything outside the platform namespace stays an anonymous tool.
    expect(canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call",
      toolCallId: "tool-other",
      title: "mcp__some-server__delete_everything",
      kind: "other",
      status: "pending",
    }, "claude-code")).not.toHaveProperty("name");
  });

  it.each([
    ["bash", { command: "python -m pytest -q" }, "python -m pytest -q", "execute"],
    ["edit", { file_path: "/Users/me/work/temps.py", old_string: "a", new_string: "b" }, "Edit temps.py", "edit"],
    ["write", { file_path: "tests/test_temps.py", content: "x" }, "Write tests/test_temps.py", "edit"],
    ["read", { file_path: "/Users/me/work/README.md" }, "Read README.md", "read"],
    ["grep", { pattern: "def celsius", path: "." }, "Search for def celsius", "search"],
    ["glob", { pattern: "**/*.py" }, "Find **/*.py", "search"],
    ["web_search", { queries: ["kelvin formula"] }, "Search the web for kelvin formula", "fetch"],
  ] as const)("names a DeepSeek Harness %s step by what it touches", (tool, rawInput, title, kind) => {
    const canonical = canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call", toolCallId: `dsh-${tool}`, title: tool, kind: "other", status: "in_progress", rawInput,
    }, "dsh");

    expect(redactActivity(omitPrivateAcpToolPayload(canonical), "/Users/me/work")).toEqual({
      sessionUpdate: "tool_call", toolCallId: `dsh-${tool}`, title, kind, status: "in_progress",
    });
    // Its end carries no title, so the page keeps the one above.
    expect(canonicalizeAcpToolActivity({ sessionUpdate: "tool_call_update", toolCallId: `dsh-${tool}`, status: "failed" }, "dsh", { kind, title }))
      .toEqual({ sessionUpdate: "tool_call_update", toolCallId: `dsh-${tool}`, status: "failed", kind });
  });

  it("shows a command's paths by their last part instead of a mask, but never a home folder", () => {
    const titled = (title: string) => redactActivity(boundPublicToolTitle({ sessionUpdate: "tool_call", toolCallId: "codex-1", title, kind: "execute" }, "/Users/me/work"), "/Users/me/work") as { title: string };
    expect(titled("/opt/homebrew/bin/uv --cache-dir /Users/me/.cache/uv pip install --python /Users/me/work/.venv/bin/python pytest").title)
      .toBe("…/uv --cache-dir …/uv pip install --python [workspace]/.venv/bin/python pytest");
    expect(titled("ls /Users/me").title).toBe("ls [local-path]");
    expect(titled('cat "C:\\Users\\me\\work\\notes.txt"').title).toBe('cat "…/notes.txt"');
    expect(titled("echo https://example.com/a/b/c").title).toBe("echo https://example.com/a/b/c");
  });

  it("keeps DeepSeek Harness' own title when the step's input names nothing", () => {
    expect(canonicalizeAcpToolActivity({ sessionUpdate: "tool_call", toolCallId: "dsh-todo", title: "todo", kind: "other", rawInput: { items: [] } }, "dsh"))
      .toMatchObject({ title: "todo" });
    expect(canonicalizeAcpToolActivity({ sessionUpdate: "tool_call", toolCallId: "dsh-edit", title: "edit", kind: "other", rawInput: "not json" }, "dsh"))
      .toMatchObject({ title: "edit", kind: "edit" });
  });

  it("does not mistake a catalog ref split at a chunk boundary for a local path", () => {
    const ref = '"component:default/konteks-component-system-595ee944" "vcsrepository:default/konteks-toopay-orders-api"';
    expect(redactStream(['"component:default', '/konteks-component-system-595ee944" "vcsrepository:defaul', 't/konteks-toopay-orders-api"'])).toBe(ref);
    expect(redactStream(['"componen', 't:default/konteks-component-system-595ee944" "vcsrepository:default/konteks-toopay-orders-api"'])).toBe(ref);
  });

  it("still redacts local paths, including one split across chunks", () => {
    expect(redactStream(["see /Users/other/secret.txt now"])).toBe("see [local-path] now");
    // One path is one mask, however many chunks it streamed in (10-09: a
    // Codex answer showed seventy masks in a row for one folder).
    expect(redactStream(["see ", "/Users/oth", "er/secret.txt now"])).toBe("see [local-path] now");
    expect(redactStream(["see ", "/Us", "ers/o", "ther/se", "cret.txt now"])).toBe("see [local-path] now");
    expect(redactStream(["open C:", "\\Users\\x.txt"])).toBe("open C:[local-path]");
    expect(redactStream(["a https://example.test/x b"])).toBe("a https://example.test/x b");
  });

  it("leaves a bare root slash and Markdown around it alone", () => {
    expect(redactStream(["**sudo ls /** — didn't run"])).toBe("**sudo ls /** — didn't run");
    expect(redactStream(["**sudo ls /", "** — didn't run"])).toBe("**sudo ls /** — didn't run");
    expect(redactStream(["run ls / now"])).toBe("run ls / now");
    expect(redactStream(["**read /Users/other/a.txt**"])).toBe("**read [local-path]**");
  });

  it("keeps a URL scheme split across chunks intact", () => {
    const url = "https://gitea.sev-2.com/toopay/orders-api";
    expect(redactStream(["https", "://gitea.sev-2.com/toopay/orders-api"])).toBe(url);
    expect(redactStream(["https", "://g", "itea.sev-2.com/toopay/orders-api"])).toBe(url);
    expect(redactStream(["https", ":/", "/gitea.sev-2.com/toopay/orders-api"])).toBe(url);
    expect(redactStream(['"repository_urls":["https', '://gitea.sev-2.com/toopay/orders-api"]'])).toBe(
      '"repository_urls":["https://gitea.sev-2.com/toopay/orders-api"]',
    );
  });

  it("redacts a drive path whose letter was emitted in the previous chunk", () => {
    expect(redactStream(["open C", ":\\Users\\alice\\creds.txt"])).toBe("open C[local-path]");
    expect(redactStream(["open C", ":/Users/alice/creds.txt"])).toBe("open C[local-path]");
  });

  it("treats macOS Application Support as part of a path, and names the session folder", () => {
    const root = "/Users/me/Library/Application Support/konteks-remote/workspaces/codex/session-1/source";
    // Before: "[local-path] Support/konteks-remote/workspaces/codex/session-1/source".
    expect(redactActivity(`I'm working in \`${root}\`.`, root)).toBe("I'm working in `[workspace]`.");
    expect(redactActivity(`ls -la "${root}"`, root)).toBe('ls -la "[workspace]"');
    expect(redactActivity(`cat "${root}/notes/a.txt"`, root)).toBe('cat "[workspace]/notes/a.txt"');
    expect(redactActivity("see /Users/me/Library/Application Support/other/x.txt now", root)).toBe("see [local-path] now");
    expect(redactActivity("Application Support is a folder name", root)).toBe("Application Support is a folder name");
  });

  it("redacts a path an agent quotes in Markdown code or a link", () => {
    expect(redactStream(["I edited `/Users/other/app/x.ts` and [/Users/other/b](/Users/other/b)"]))
      .toBe("I edited `[local-path]` and [[local-path]]([local-path])");
    expect(redactStream(["I edited `", "/Users/other/app/x.ts` now"])).toBe("I edited `[local-path]` now");
    expect(redactStream(["I edited `", "/Users/oth", "er/app/x.ts` now"])).toBe("I edited `[local-path]` now");
    // A quoted root-anchored slip that is not a host path stays readable: a refusal quotes it back.
    expect(redactStream(["`/storefront/app/page.tsx` starts at the root"])).toBe("`/storefront/app/page.tsx` starts at the root");
    // Globs and HTML are not paths, even with a closing tag split across chunks.
    expect(redactStream(["rg -g '!**/.DS_Store' and </p>"])).toBe("rg -g '!**/.DS_Store' and </p>");
    expect(redactStream(["renders as <h2>Title</", "h2>. Added a test."])).toBe("renders as <h2>Title</h2>. Added a test.");
  });

  it("keeps Application Support inside a path when a chunk ends at its space", () => {
    // 10-09, connector 0.12.12: Codex streamed "…/Library/Application" then
    // " Support/konteks-remote/…", and the page read
    // "/[local-path] Support/konteks-remote/workspaces/codex/session-…/source".
    const tail = " Support/konteks-remote/workspaces/codex/session-58ca/source`, and it isn’t empty.";
    expect(redactStream(["I’m in `/", "Users/me/Library/Application", tail])).toBe("I’m in `/[local-path]`, and it isn’t empty.");
    expect(redactStream(["I’m in `", "/Users/me/Library/Application ", tail.slice(1)])).toBe("I’m in `[local-path] `, and it isn’t empty.");
    expect(redactStream(["see /Users/me/Library/Application", " Support/konteks", "-remote/x.txt now"])).toBe("see [local-path] now");
    // Only that folder continues the path: other words after "Application" stay.
    expect(redactStream(["open /Applications/Foo.app/Application", " Supporting docs"])).toBe("open [local-path] Supporting docs");
    expect(redactStream(["the Application", " Support/team page"])).toBe("the Application Support/team page");
  });
});


describe("a Codex file search that finds nothing", () => {
  const failed = (exitCode: number, output = "") => ({
    sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed",
    rawOutput: { formatted_output: output, exit_code: exitCode },
  });

  it("is shown as done, not failed", () => {
    // 10-09: `rg --files -g AGENTS.md` exits 1 on most turns; each read "List files · Failed".
    expect(canonicalizeAcpToolActivity(failed(1), "codex", { kind: "read", title: "List files" }))
      .toMatchObject({ status: "completed" });
    expect(canonicalizeAcpToolActivity(failed(1), "codex", { kind: "search", title: "Search for 'TODO'" }))
      .toMatchObject({ status: "completed" });
  });

  it("is shown as done when a longer command ends in a search that found nothing", () => {
    // 10-09: `cat …; cat …; rg --files -g AGENTS.md …` read "Failed" though every step worked.
    const title = "\"cat tests/test_cli.py; cat pytest.ini; rg --files --hidden -g AGENTS.md -g '!.venv/**'\"";
    expect(canonicalizeAcpToolActivity({ ...failed(1, "[pytest]\ntestpaths = tests"), title }, "codex", undefined))
      .toMatchObject({ status: "completed" });
    expect(canonicalizeAcpToolActivity({ ...failed(1, "x"), title: "git log | grep fixme" }, "codex", undefined))
      .toMatchObject({ status: "completed" });
    // A search that broke (2), or a command that ends in something else, still failed.
    expect(canonicalizeAcpToolActivity({ ...failed(2, "rg: bad flag"), title }, "codex", undefined)).toMatchObject({ status: "failed" });
    expect(canonicalizeAcpToolActivity({ ...failed(1, "x"), title: "rg -n foo src; pytest -q" }, "codex", undefined)).toMatchObject({ status: "failed" });
  });

  it("still fails when the command broke or was not a search", () => {
    expect(canonicalizeAcpToolActivity(failed(2), "codex", { kind: "read", title: "List files" })).toMatchObject({ status: "failed" });
    expect(canonicalizeAcpToolActivity(failed(1, "rg: notes: No such file"), "codex", { kind: "read", title: "List files" }))
      .toMatchObject({ status: "failed" });
    expect(canonicalizeAcpToolActivity(failed(1), "codex", { kind: "execute", title: "Run command" })).toMatchObject({ status: "failed" });
  });
});

describe("a tool whose title is a long command", () => {
  it("keeps its update, with the title cut to one readable line", () => {
    // 10-09 03:14Z: Claude Code titled a heredoc command past 2048 characters; both updates were refused (`too_big`).
    const title = `cat > notes.md <<'EOF'\n${"word ".repeat(600)}\nEOF`;
    const message = (update: unknown) => ({ kind: "acp", method: "session/update", params: { sessionId: "acp-1", update } });
    const update = { sessionUpdate: "tool_call_update", toolCallId: "toolu-1", title, status: "completed" };
    expect(SessionToCoreMessageSchema.safeParse(message(update)).success).toBe(false);
    const bounded = boundPublicToolTitle(update) as { title: string; status: string };
    expect(SessionToCoreMessageSchema.safeParse(message(bounded)).success).toBe(true);
    expect(bounded).toMatchObject({ status: "completed", title: expect.stringMatching(/^cat > notes\.md <<'EOF'.*…$/s) });
    expect(bounded.title.length).toBeLessThanOrEqual(600);
    expect(boundPublicToolTitle({ ...update, title: "ls" })).toEqual({ ...update, title: "ls" });
  });
});
