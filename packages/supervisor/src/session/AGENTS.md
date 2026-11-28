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
  DSH's verified ACP bridge projects its committed tool name into an announced
  call's title and drains that call before its id-only approval. Match only
  the retained call and the deterministic public names of this session's known
  coordination tools; never use an approval title or reverse-parse a namespace.
- **`allow_once` only.** Every policy allow is `allow_once`; `allow_always` is
  never offered to policy or a person (OpenCode would store it and stop
  asking; Antigravity's offer is stripped before anything sees it).
- **Explicit native escalation asks a person.** Codex command permission bundles,
  standalone filesystem/network permission grants, network approvals and command
  paths/cwd outside trusted roots are never automatically approved. Claude's
  structured `SandboxNetworkAccess` and blocked shell paths also defer, except
  a Claude shell command whose blocked paths lie only in the working copy and
  the session context folder (`sessionContextRoot`, data the agent is told to
  read): it is refused at once with a note naming the Read tool, never put to
  a person and never allowed. A `planning` assignment goes further: a Claude
  shell call with any flagged path outside the working copy and this session's
  context folder — including a required organization skill folder — is refused
  at once, never deferred, because an estimate's result is `submit_result` and
  nothing reads a shell result. Other assignment kinds keep the allow-once
  deferral, and a skill folder still asks for them. If human
  deferral or the exact safe options are unavailable, refuse. Codex's manual
  standalone grant is turn-scoped; session grants and strict automatic review
  are excluded from the broker and Core view. Ordinary same-authority commands
  retain the command policy; these checks do not attest OS confinement.
  `src/__tests__/outside-folder-command-human-gate.test.ts` guards this: it
  drives Claude Bash/PowerShell and Codex execute through every evaluator and
  deferral mode, checks the host adapters' shell folders and the broker's hold
  and deadline. Any new allow branch or host adapter must extend that guard's
  matrix; `src/__tests__/session.test.ts` holds the end-to-end answer to the
  runner until the person's own answer arrives through the broker.
- **Only the session's own MCP servers.** A tool whose server is not in the
  session's `sessionServers` is refused without asking. `konteks-browser` is
  allowed only on a session given the browser, and never a hidden browser tool.
  An admitted tool (`admittedMcpTools`) is deferred `allowOnceOnly`, never
  allowed by the general policy. Instance-bound direct Claude sessions admit
  account connectors with one-time human deferral; ordinary sessions admit none.
- **Host agents are rebuilt, then judged.** For dsh, OpenCode and Antigravity,
  `hostToolGovernance` runs first and the unchanged general policy second. A
  request must match the `tool_call` it names; it is rebuilt into the policy's
  shape (shell to command, edits to paths inside the working copy); `.env`
  reads, uncorrelated, unknown or mismatched requests are refused. Runner
  events are handled concurrently, so a request can overtake its own
  `tool_call` inside the connector: `ToolCallArrivals` holds a request whose
  call is not yet recorded (`unannouncedCall`) until it arrives, for at most
  `TOOL_CALL_ARRIVAL_MS` or until the session closes; only then is it judged
  uncorrelated. dsh words a selected reject as "the user rejected tool", so
  every refusal by Konteks on a dsh session answers `cancelled`
  (`cancelsPolicyRefusal`); only a person's reject is a reject.
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

## Session context and instruction scope

- **One resolved folder per session.** `sessionContextFolder` and
  `resolveSessionContextFolder` (`../native/input-preparer.ts`) derive
  `<RUNNER_WORKSPACE_DIR>/session-context/session-<hash>` (or
  `assignment-<hash>` for assignment-isolated context) from the session's own
  binding, resolve the result after `realpath`, and refuse a folder that is
  the `session-context` parent, a sibling session, the operator's home or
  anywhere outside it. Each refusal is a `LoggedRefusal` naming its rule
  (`session_context_folder_is_parent`, `_is_sibling`, `_in_operator_home`,
  `_outside_session`, `_missing`). Only the resolved `source` folder becomes
  `readOnlyRoots` and `sessionContextRoot`; `verify()` re-resolves it before
  every prompt.
- **The parent is not a read root.** `isWithinReadRoots` refuses any path
  under a `session-context` parent unless it is inside this session's single
  own context root, even when a broken caller declares the parent as a read
  root. The session's own folder is the only context path the policy and the
  Claude escalation classify as data to read.
- **Instruction scope.** Claude's bridge excludes the user `CLAUDE.md`, its
  rules folder, every parent `CLAUDE.md` and auto memory, including under a
  personal profile whose `HOME` is the operator's home
  (`scripts/claude-instruction-scope.mjs`, marker
  `instruction_scope version=4`). Codex reads `$CODEX_HOME/AGENTS.md` and
  `AGENTS.override.md` into `Config.user_instructions` independently of project
  docs, so the supervisor gives it a private home overlay
  (`../native/codex-home-overlay.ts`) that links the official login and thread
  store but omits those files, every `memories*` entry, and personal `skills/`,
  `prompts/`, `plugins/` and `instructions/` folders. Its `config.toml` is a
  sanitized copy without `developer_instructions`, `model_instructions_file`,
  `experimental_instructions_file`, `instructions`, `base_instructions` or
  `compact_prompt` in any TOML spelling (bare, quoted, dotted, table-scoped). The thread config also sets `project_doc_max_bytes: 0` (no
  parent or nested project-doc walk) and always sets `developer_instructions`
  (empty when the working copy has none, otherwise its root `AGENTS.md`); this
  intentionally drops nested files and replaces an operator value. The patch
  (`v13`) refuses any `CODEX_HOME` that is not the marked overlay, and any
  marked overlay that still exposes those files. Host agents
  (dsh/OpenCode/Antigravity) take `AGENTS.md` only from the working copy
  (`packages/agent-runner/src/host/working-copy-instructions.ts`).
- **Out-of-folder locations that remain.** Two are genuinely required: the
  session's own context folder, and the selected organization skill folders
  staged by input preparation outside the working copy. The context folder is
  data only: a Claude shell command reaching it is refused at once with the
  Read tool named. A skill folder is data the agent reads with
  Read/Grep/Glob; a shell command reaching it is never auto-allowed — it is
  deferred as a one-time allow through the broker for an ordinary assignment
  and refused for a planning estimate. No default, configuration or fallback
  makes either auto-allowed. `src/__tests__/session-context-resolution-guard.test.ts`
  drives the resolver and the policy with home, sibling, parent, symlink and
  environment inputs; `src/__tests__/outside-folder-command-human-gate.test.ts`
  extends its matrix with the context parent, a sibling session and a skill
  folder.

## Finding: the four 2026-11-04 estimate cards

The TKT-3 delivery description carries the full write-up; this is the code
cross-reference.

- **One path raised all four.** `withSessionContext`/`contextReadHint`
  (`../native/input-preparer.ts`) tells every agent to read this session's
  context folder and adds only that folder to `readOnlyRoots`.
  `repositoryContext` → `sourceWorkspace` stage it at
  `<RUNNER_WORKSPACE_DIR>/session-context/session-<hash>/source`, where
  `hash = sha256(JCS({workspaceId, instanceId, sessionId}))` and
  `RUNNER_WORKSPACE_DIR` is `<connector root>/workspaces/<agentId>`
  (`packages/launcher/src/native/install.ts`, `native/installation.ts`).
  The working copy is a different checkout, so a shell `wc`/`ls`/`cat`/`sed`
  over the context folder is outside it and asked a person.
- **The heading did not prove the location.** On 11-04 `escalationTitle`
  embedded the model-written tool title and every located Claude shell call
  read "Outside this session's folder"; the command is embedded only since
  2026-11-05. The four titles name the staged context/memory files, not
  `~/.claude`.
- **No card resolved into the operator's home.** A bundled runner's `HOME` is
  its private `RUNNER_CREDENTIAL_DIR`; a personal Claude profile sets `HOME`
  to the operator's home (`packages/agent-runner/src/bridge/spec.ts`), and the
  Claude bridge patch excludes auto memory. `~/.claude` was reachable under a
  personal profile, but it is not what these four commands named.
- **Sibling memory was reachable, outside the roots.** `readOnlyRoots` held
  only this session's context folder, so a sibling
  `session-context/session-<other>/` and the `session-context/` parent were
  outside it; these checks do not provide process/OS confinement, so a shell
  naming a sibling would have run had a person allowed it. All four were
  denied, so nothing was read. `isWithinReadRoots` now refuses a sibling or
  the parent outright (see above).
- **Nothing consumed the result.** An estimate's output is `submit_result`;
  no code reads the shell result. That is why a planning shell call is now
  refused instead of deferred, including one that reaches a staged
  organization skill folder: the Read tool reaches those roots, and a
  planning estimate never needs a shell there.
