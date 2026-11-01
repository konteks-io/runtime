# Supervisor (the connector daemon)

## Purpose

The long-running service (`src/daemon.ts`, `src/supervisor.ts`): leases and
heartbeats with Core, the relay connection, the pull-based work orchestrator,
relayed ACP sessions and their tool policy, native runners, previews and the
QA browser, structured results, updates and doctor/support.

## Map (`src/`)

- `core/client.ts` (Core HTTP), `relay/` (relay socket, channel mux),
  `lease/`, `heartbeat/` (heartbeat, liveness watchdog), `reconnect/`.
- `control/`: signed Core directives (version policy, permissions, cancellations).
- `work/`: orchestrator, accepted work kinds, direct/continued sessions.
- `session/`: relayed ACP session and permission policy. See `src/session/AGENTS.md`.
- `integration/`: integration task carrier. See `src/integration/AGENTS.md`.
- `native/`: install record, runners, host-agent install adapters, updates,
  execution gate, supported agents, Antigravity fetch/update/removal.
- `preview/`: dev-server process manager, forwarder, preview MCP server, browser gateway.
- `structured-result/`: `konteks-result` MCP server and turn handling.
- `mcp/capability-facade.ts`: the platform MCP facade a session sees.
- `onboard/`, `skills/`, `state/` (journal, outbox), `support/` (doctor, bundle).

## Invariants

- **Previews.** At most one dev server per session, in that session's
  worktree, on a loopback port it picks (`PREVIEW_PORT_RANGE`), with an
  allow-listed environment; the in-process forwarder for `preview:<sessionId>`
  dials ONLY that port. The per-machine on/off switch is Core's: do not add a
  local one, a `preview` work kind or a separate forwarder process. A viewer
  may auto-start a preview only in the worktree the session registered
  (`SessionPreviewAccess.permit`).
- **Preview activity.** The heartbeat's `previews` lists the previews the
  agent started (an agent start on a viewer's preview makes it the agent's,
  never back) and used within 3 minutes (`agentActive`,
  `PREVIEW_AGENT_ACTIVE_WINDOW_MS`). Only `touchByAgent` (preview tool,
  agent browser) and an agent start move `agentActiveAt`; viewer traffic,
  prompts and session updates use `touch`, which only defers the idle stop.
  Sent only to a Core at `REMOTE_PREVIEW_ACTIVITY_MIN_CORE_CONTRACT_VERSION`
  (7.8): an older Core's strict schema refuses the whole heartbeat.
- **QA browser boundary.** `PreviewBrowserGateway` (`preview/browser-gateway.ts`)
  is the security boundary, not Playwright's `--allowed-origins`. It admits
  the session's running preview plus origins Core granted, read only from the
  `environment_open` answer by `McpCapabilityFacade` (same session, http(s),
  capped expiry). Never add another way to grant an origin; the agent must
  not widen the list. A registered application host must not resolve to this
  computer. CONNECT and upgrade sockets get an `error` listener first: an
  unhandled reset ends the connector.
- **Structured results.** Every non-direct session gets `konteks-result`
  (`submit_result`). Never move the schema into a `session/prompt` request
  field: the native operation permit signs the parsed request's digest. The
  follow-up prompt (`<id>#konteks-result-follow-up`) is never sent to Core.
- **Failure history.** Capture bounded typed facts at operation owners; the
  supervisor supplies the instance and exact retained claim. The separate
  bounded durable queue requires native recovery authority and Core 7.12,
  and checks instance, failure ID and digest before acknowledging a receipt.
  Diagnostics never settle work, meter usage or delay an operation or stop.
  Never include raw logs, provider text, private paths or inferred causes.
- **Coordination calls.** Claude Code and Codex use their structured ACP tool
  identity; qualified DeepSeek Harness uses its committed call ledger and the
  exact session-installed MCP name mapping. Both ordinary policy and host
  fast-allow paths capture before `allow_once`; the native journal retains
  only its bound operation identity and payload hash. The platform facade
  requires one matching capture and supplies Core's invocation header itself.
  Missing, changed or ambiguous capture fails closed. DSH advertises capture
  only for the verified provider version; other adapters do not advertise
  `coordination-invocations-v1:<agentId>`. A structured wait is only a request;
  Harness owns blocker validation and publishing its durable checkpoint.
- **Direct work** (`work/continued-session.ts`, `isDirectAssignment`): no
  preamble, no Konteks MCP servers, no preview/browser/result tool, policy root
  = the session's own folder, no repository selection.
- **Workspace checkpoints** use the signed Core checkpoint contract gate.
  Dirty ownership is retained before agent writes. A stopped execution can
  retain an immutable snapshot for retry; this grants no new execution or
  accepted-output authority. Restore into a fresh private folder, verify before
  acknowledging, and retain every superseded checkout. An active recovered
  folder keeps later uncommitted edits across preparation and supervisor restarts.
- **A delivery session coming back** (D105): a harness turn that finds its own
  old checkout started at another commit (`staleCheckout`) replaces it only when
  `staleCheckoutVerdict` says nothing is unsaved (no edits, exactly its last
  accepted output, or every edit already in the published commit). Otherwise the
  checkout is moved aside intact (`<worktree>.kept-<baseline>-<ms>`, warn
  `native.repository.stale_checkout` `outcome: kept`) and a fresh checkout
  continues. With a Core at contract 7.10 it reports the `kept` workspace
  operation, so the delivery's session and Updates say so; a failed report
  only logs. A restored folder is retired, never deleted. Other preserved
  checkouts at another commit still refuse.
- **Core contract gating.** `availableCommands`, `supportedAgents`,
  `connectorCommands`, pay-per-use and option billing go only to a 7.1 Core;
  `operations` work (an ops session's conversation turn, the `ops` role any
  ready agent advertises) from 7.1 too; `integration` work only from 7.3
  (`work/accepted-kinds.ts`); a heartbeat's
  `previews` only from 7.8; workspace checkpoints and their chunk transfer
  only from 7.9. The
  `agent_runner` component always advertises `core-contract-version-v1`.
  Supported-agent detection (`NotAddedAgentsDetector`) never runs on the
  heartbeat path.
- **Execution gate** (`native/execution-gate.ts`): a running agent survives
  timeouts; renewals retry with backoff. A signed check outside its time window
  (`expired` or `not_yet_valid`) is retried without adopting its authority;
  new dispatch still requires a current verified lease. Core refusals, revision
  fences, invalid signatures and authority mismatches stop the execution.
  `CoreClient.executionSigningKeys` serves the last confirmed key set for a
  bounded time, never an unknown key id.
- **Owner refresh.** `NativeEnrollment` signs `issuedAt` Unix seconds from
  `clock.coreNow()` with the instance-key body. Core and Common require that
  field within a ±300s window; release the matched cohort before enforcing it.
  Other enrollment bodies and the running connector's root-lock handoff keep
  their existing contracts.
- **Self-recovery.** A lapsed lease is never renewed in-process: the liveness
  watchdog asks the service manager to restart (`leaseLapseNeedsRestart`).
  A runtime below Core's minimum may install a strictly newer signed release
  without an accepted one (`mayUpdateWithoutAcceptedRelease`). A release on
  update probation (`updateProbation`) takes no new work. Native runners stop
  side by side (`Promise.allSettled`). `reapStrayServers` touches only
  `<root>/releases/`.
- **Holder-bound replay** (`relay/channel-mux.ts`): session and preview
  frames stay until their holder acknowledges them, with no age limit. On a
  relay whose upgrade response names `holder-replay-request-v1` in
  `konteks-relay-features` (`relay/relay-client.ts`), they are re-sent after
  a reconnect only on its `replay_request` or ahead of the channel's next
  frame; an older relay gets them on every handshake. The connector is never
  told a session ended, and Core keeps idle sessions open, so do not retire
  or renumber a session channel: the App holder drops any frame at or below
  its durable cursor.
- **Handshake channel cap.** `handshakeCursors` never names more than
  `maxHandshakeChannels` (512; over it the relay refuses every handshake
  with 4401). Fully acknowledged holder-bound channels are left out first,
  least recently active first, and keep their local cursor.
- **Host agents never fail the connector.** A listed host agent the load cannot
  find or verify is returned in `unavailableAgents` and parked with
  `NativeAgentRetry` (`parkUnavailableHostAgent`).
- A personal Claude profile runs the operator's own `claude`; the runner
  advertises `claude-code-executable:<version>:sha256:<hex>`
  (`native/claude-executable-identity.ts`).
- Fetched-agent integrity (`native/fetched-archive.ts`,
  `antigravity-installation.ts`): download exactly the pinned bytes, refuse
  zip64/encrypted/linked/`..` entries, verify signature and hashes on every
  load and start. Never place fetched agents on PATH or under `credentials/`.

## Gotchas

- `status` must stay parseable by older launchers: add control ops, not fields.
- Core re-sends a person's control delivery until its report arrives, so a
  repeat is normal: a sign-in that ended is answered with its terminal report
  (`native/finished-logins.ts`, the last 200 within 24 h, kept on disk), and
  an on-computer start is claimed before its first await so two copies open
  one window. Every arrival logs `control_delivery.received`.
- A repository role session whose turn ended unfinished is retired after its
  process is proven gone (`retireAfterClose` in `work/orchestrator.ts`);
  generated changes in the working copy are kept.
- The delivery-output path names every refusal: capture throws
  `OutputCaptureRefusal` with a diagnostic and Git step, and `DeliveryOutput`
  tags each step (`native/delivery-output-failure.ts`). A retained retry
  (attempt 1, then every 12th) is also reported as a `turn` runtime failure.
  A new bare refusal there is a blind spot again: give it a name.
  The recovery-checkpoint path does the same (`NamedRefusal`, each Git call
  takes a `CheckpointGitStep`); `seal()` reports the cause in the stage, e.g.
  `workspace_capture_file_hardlinked` (`native/workspace-checkpoint-failure.ts`).
