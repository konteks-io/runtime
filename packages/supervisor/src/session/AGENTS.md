# Relayed sessions and permission policy

## Purpose

`relayed-session.ts` runs one ACP session for a Konteks assignment: it mounts
the session's MCP servers (platform facade, preview, browser, result), relays
events, and answers every `session/request_permission`. This folder holds the
whole permission path.

## Entry files

- `relayed-session.ts`: session wiring, `admittedMcpTools` seam, quarantine.
- `permission-tool-identity.ts`: structured tool identity, `McpToolCallLedger`.
- `policy-responder.ts` (`EvaluatorPolicyResponder`) and
  `workspace-tool-policy.ts` (`createWorkspaceToolPolicy`, blocked commands,
  working-copy paths): the general policy every agent shares.
- `host-tool-governance.ts` (`hostToolGovernance`): per-host-agent layer for
  dsh, OpenCode (`opencode-tool-governance.ts`, `opencode-code-mode.ts`) and
  Antigravity (`antigravity-tool-governance.ts`).
- `opencode-prompt.ts`, `antigravity-prompt.ts`: the one-line tool hints.

## Invariants

- **Identity from structured fields only.** Claude's tool name comes from
  `toolCall._meta.claudeCode.toolName` (set by the bridge patch); a Codex MCP
  approval is matched by tool call id to the `tool_call` codex-acp announced
  (`McpToolCallLedger`). A title (Claude's Bash title is model-written) can
  only refuse, and an MCP call with no readable server/tool is refused.
- **`allow_once` only.** Every policy allow is `allow_once`; `allow_always` is
  never offered to policy or a person (OpenCode would store it and stop
  asking; Antigravity's offer is stripped before anything sees it).
- **Only the session's own MCP servers.** A tool whose server is not in the
  session's `sessionServers` is refused without asking. `konteks-browser` is
  allowed only on a session given the browser, and never a hidden browser tool.
  An admitted tool (`admittedMcpTools`) is deferred `allowOnceOnly`, never
  allowed by the general policy; ordinary and direct sessions admit nothing.
- **Host agents are rebuilt, then judged.** For dsh, OpenCode and Antigravity,
  `hostToolGovernance` runs first and the unchanged general policy second. A
  request must match the `tool_call` it names; it is rebuilt into the policy's
  shape (shell to command, edits to paths inside the working copy); `.env`
  reads, uncorrelated, unknown or mismatched requests are refused.
- **OpenCode Code Mode** (`opencode-code-mode.ts`, acorn): approve only
  `[const|let x =] await tools["<server>"].<tool>(<literal args>)` statements
  and a final `return`, for this session's own servers; the reported
  `rawOutput.metadata.toolCalls` must list only approved calls.
- **Antigravity.** The workspace-trust question is always "Don't Trust";
  subagent and unknown tools are refused; a command naming the private home,
  `~`, `$HOME`, `$GEMINI_HOME`, `.gemini` or token files is refused. The
  server reports an allowed request's work as a separate call: pair it with
  one allowed request, once.
- **Tripwire.** A gated tool that completes unasked, an unapproved Code Mode
  call, or an unasked read outside the working copy cancels the turn and
  quarantines that agent on this connector (other agents keep running).
  `quarantineMessageFor` names the Gemini Enterprise "Terminal
  auto-execution: Require review" setting when that credential is in use.
- File changes are judged against each session's verified working copy
  (`policyRoot()`), including non-direct assignments. The general policy judges
  recognized structured read/search calls against that copy plus the selected
  organization-skill directories verified by input preparation. Roots are local
  typed context, never tool arguments; a judged read must name a path. dsh
  read/read_image/grep/glob calls ask through its hook and reach this policy.
  OpenCode named read/search tools ask before these roots are judged; an
  unasked completion trips even without a named path. Its omitted grep/glob
  path uses the pinned provider's session cwd default. Antigravity uses the
  same roots for asked and observed named reads. Provider controls and
  tripwires remain. Vendor-internal skill loads,
  opaque unasked reads and shell execution still require separate controls.
  These ACP permission checks do not provide process/OS confinement.

## Gotchas

- Code Mode asks at a block's first MCP call, not before the block runs;
  OpenCode's own tools are denied in its locked config instead.
- Integration task sessions do not use this policy: see `../integration/AGENTS.md`.
