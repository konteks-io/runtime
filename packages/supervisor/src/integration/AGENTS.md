# Integration tasks

## Purpose

Runs `integration` work (asked for only from a Core that signs
`coreContractVersion` 7.3, `../work/accepted-kinds.ts`): one bounded task
against an external tool the person's own Claude Code or Codex can reach.
It never takes the relayed-session path: `IntegrationTaskCarrier` runs it and
its structured result becomes the terminal report. The `agent_runner`
component advertises `integration-task-v1` when a Claude Code or Codex runner
is installed.

## Entry files

- `carrier.ts`: fetches the frozen task (`fetchWorkload`), validates it,
  dispatches by operation; `compose.ts` wires it.
- `discovery.ts`: model-free `discover`.
- `setup.ts`: official connection setup (`add`, `sign_in`, `remove`).
- `session.ts`, `prompt.ts`, `tool-gate.ts`: the gated ACP session for
  `probe | read | verify | write`.

## Invariants

- **The task is what Core froze.** Parse with `IntegrationWorkloadSchema`;
  refuse (`schema_invalid`) unless its digest equals the source's
  `specDigest` and it names the assignment's task and agent.
- **Discovery is model-free and allowlisted.** Codex: `mcpServerStatus/list`
  on the shared app-server; Claude: the bundled Agent SDK in a child process,
  empty private folder, hooks off, every tool refused. Only server name,
  source kind, status, provider category and tool names leave (secret-canary
  tests guard this).
- **Setup runs only the reviewed catalogue entry** it names
  (`officialConnectionSetup`; endpoint, server name and command digest must
  match). Codex `mcp add` never overwrites an existing entry
  (`already_present`); `remove` of an entry Konteks did not add needs the
  person's confirmation. Output is never read; handoff entries run nothing.
- **One gated session per task** on the bound agent, in an empty private
  folder, with only `konteks-result` (plus E2E fixtures). The bound source is
  admitted for that session only, through `_meta.konteksIntegration` on
  `session/new` (never resume/load/fork), which the bridge patches honour
  (`scripts/AGENTS.md`).
- **`IntegrationToolGate` is the whole permission policy:** structured
  identity only; only `admittedTools` up to `limits.maxToolCalls`; a read's
  fixed `requiredArgs` present and equal; generic `executeRead` only with its
  operation pinned, `executeWrite`/`executeDestructive` never; a write only
  with the approved canonical arguments, once per nonce, recorded in the
  journal's `integration-writes` table BEFORE the `allow_once`; everything
  else denied without deferral.
- **The turn ends when the result is in.** Once `submit_result` is accepted
  and no allowed call is still running, the session cancels the agent's turn
  instead of waiting for its closing message (nothing reads it). The result
  tool is always loaded (`anthropic/alwaysLoad`), so Claude never spends a
  step finding it. `integration.task.timing` logs each allowed call's ask
  and end and the result, in ms after the prompt.
- **A routed read is a utility turn.** When Core routes the assignment to a
  model (`agentRoute.sessionConfig.model`, Core's per-workspace choice of the
  agent's fastest offered model), the session takes that model if offered,
  the lowest effort it offers (`thought_level`) and no extended thinking
  (Claude `_meta.claudeCode.options.thinking`), each best effort
  (`agent-runner/src/sessions/utility-turn.ts`). An unrouted read runs on the
  agent's own settings.
- **A locked read ends on its calls.** A spec's `completesWhenCalled`
  (sent only to a connector advertising `integration-task-calls-complete-v1`,
  which it does only to a Core of contract 7.6) ends the turn once each named
  tool's own result was observed; the prompt asks for no summary and no
  agent report is kept.
- **Warm read sessions** (`warm.ts`, `opened-session.ts`): after a read, the
  carrier opens one new session of the same shape (agent, admitted sources,
  utility model) per agent, closed after 3 min idle. The next read of that
  shape takes it (`adoptSession` moves it to the task's assignment; only a
  never-prompted integration session can be adopted), so one gated session
  per task still holds. A session that finds every execution slot held
  closes it first (`reclaimIdleExecution`), and a read of another shape
  replaces it. `integration.warm_session` logs ready, reused, missed (with
  why) and closed (with why); `integration.task.timing` says `warmSession`.
- The connector's own observation of each allowed call is the evidence
  (`connector_observed`, bounded, hashed); the agent's `submit_result` is only
  `agentReport`. An MCP call that completes without reaching the gate cancels
  the turn (`ungated_call`).
- A source the agent cannot hold (Claude: account connectors only; Codex:
  personal servers only) is a typed `operation_unsupported` result with no session.
- `fixture_mcp` sources (loopback URLs, never commands) exist only when the
  connector process runs with `KONTEKS_E2E_NATIVE_CONNECTOR=1`
  (`KONTEKS_E2E_FIXTURE_MCP_SERVERS` names Claude's synthetic servers).
