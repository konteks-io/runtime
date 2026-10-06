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
- **Direct work** (`work/continued-session.ts`, `isDirectAssignment`): no
  preamble, no Konteks MCP servers, no preview/browser/result tool, policy root
  = the session's own folder, no repository selection.
- **Core contract gating.** `availableCommands`, `supportedAgents`,
  `connectorCommands`, pay-per-use and option billing go only to a 7.1 Core;
  `integration` work only from 7.3 (`work/accepted-kinds.ts`). The
  `agent_runner` component always advertises `core-contract-version-v1`.
  Supported-agent detection (`NotAddedAgentsDetector`) never runs on the
  heartbeat path.
- **Execution gate** (`native/execution-gate.ts`): a running agent stops only
  when Core answers (fenced, denied, revision fence), never on a timeout;
  renewals retry with backoff. `CoreClient.executionSigningKeys` serves the
  last confirmed key set for a bounded time, never an unknown key id.
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
- A repository role session whose turn ended unfinished is retired after its
  process is proven gone (`retireAfterClose` in `work/orchestrator.ts`);
  generated changes in the working copy are kept.
