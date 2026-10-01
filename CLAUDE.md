Follow [HARDENING.md](HARDENING.md): Graft freshness remains required; broader C00 cleanup is deferred.

# Runtime agent entry point

Read [AGENTS.md](AGENTS.md) and [HARDENING.md](HARDENING.md) before editing.
The hardening policy is mandatory for all maintenance work.
Customer-visible file names are in AGENTS.md: resolve the connector with
`resolveNativeConnectorExecutable`, never a literal `connector`.
The runtime is native-only (the appliance is retired and deleted) and runs
Claude Code, Codex, DeepSeek Harness, OpenCode 2 and Google Antigravity; Pi is retired (see AGENTS.md for how
stored values stay readable). On the development branch the
workspaces link the sibling `../packages` sources (`file:../packages/...`,
restored after every merge from `main`, as in Core and the App); `main` and
public exports use the 7.2.0 tarballs in `vendor/` (`export-public.mjs` reads
`konteksContracts`). To refresh `vendor/`, `npm pack` from packages and keep
`konteksContracts` at that version; never regenerate the whole lockfile. CI
(`ci.yaml`, `release.yaml`, `agent-os-proof.yaml`) runs
`scripts/ci-vendored-contracts.mjs` before `npm ci`, so the sibling links
need no switching for a pull request. `agent-os-proof.yaml` (CP0-X) proves
every agent on every OS through the connector's own code
(`scripts/agent-os-proof.mjs`, a scripted model in
`scripts/agent-os-proof/`); results per OS and agent are in
opencode-runtime-support `proof/os-matrix.md` (at CP0-X: sessions are
refused on Linux and Windows, no durable execution-process owner there; Codex
escalations then went to Codex's own auto-reviewer; every Codex session is now
pinned to Ask for approval, so they reach the policy: `CODEX_SESSION_GOVERNANCE`).
Session hardening (external-integration Stage 0: no repository hooks or
`.mcp.json` servers, no account connectors or personal MCP servers, structured
tool identity, the Claude executable's identity) is described in AGENTS.md. Host-installed
agents go through per-agent host adapters (Google Antigravity is the first
FETCHED one: the connector downloads Google's zip pinned in
`release/src/fetched-agents.json` on the person's yes and re-verifies it
before every start, then proves its `initialize`; CP2: it spawns from a
private home with its tool filter on every session, `default` mode only, the
working copy's AGENTS.md in the first prompt and at most two processes;
CP3: it signs in with a Gemini API key held by the connector and relayed per
process on loopback (`host/antigravity-relay.ts`, turns priced at the list
price) or with Gemini Enterprise over ACP `authenticate` (`auth/antigravity-auth.ts`,
also from the site); CP4: its sessions are governed like OpenCode's
(`antigravity-tool-governance.ts`: request rebuilding, trust question always
refused, its own report of an allowed change paired with the request, the
tripwire and quarantine with the Gemini Enterprise Require review line,
`/plan` and `/logout` refused); CP6: offered: `agent add antigravity` and
`install --agents …,antigravity` ask Google's consent line (a terminal answer
or the person's `--yes`) and download while the service runs, a runtime
update's new pin is fetched on that first yes, checked and switched to
(`native/antigravity-update.ts`), `agent remove antigravity` signs out and
deletes it (`native/antigravity-removal.ts`), onboarding offers it in one line,
Graft wires `agents`, doctor has its line, the relay honours `HTTPS_PROXY`;
see AGENTS.md). Core's 7.1 fields (pay-per-use turns, download state,
`no_license`, option billing) go only to a Core that signs
`coreContractVersion` 7.1 or later into the desired configuration; the
`agent_runner` component always advertises `core-contract-version-v1` to ask
for it. OpenCode 2 is offered (CP6:
install, enrollment detection, `agent add opencode`, onboarding remedies,
Graft, a doctor line; a host agent missing or unsupported at load is left out
and retried, never fatal to the connector); its runner spawns with the
locked config, one process per working copy, after a start self-check, and
its sessions are governed like dsh's (CP4: request rebuilding, the Code Mode
gate, never `allow_always`, the tripwire and quarantine, plan mode refused;
AGENTS.md). CP3: it signs in through OpenCode's own `auth` commands
(`auth/opencode-auth.ts`: provider pick in the open, link and code relayed,
an API key typed into OpenCode's own prompt on a pty, never an argument or
log), reports `credentials[]`, honours Core's free-models switch, and labels
each turn's money by its provider's billing (`sessions/usage-label.ts`).
Session previews run in the supervisor (`packages/supervisor/src/preview/`):
one supervised dev server per session, forwarded only to its own loopback
port; the per-machine switch is Core's (see AGENTS.md). A viewer's first
request for a session with nothing running starts it (`PreviewChannel`
`autoStart`, `Supervisor.startPreviewForViewer`) in the worktree the session
registered with `SessionPreviewAccess.permit`, answering 503
`STARTING_MESSAGE` ("Starting preview…", which Core turns into a refreshing
page); `startedBy` records agent or viewer.
Sessions with a preview (validator, QA-mode and other conversations,
executor) of ANY agent get a headless browser (Playwright MCP,
`konteks-browser`): a connector capability (O8,
`native/browser-capability.ts`), the copy bundled in an installed Claude Code
or Codex package run on that package's Node or else the person's own (Node
20+); Claude Code and Codex keep their own copy, dsh, OpenCode and Google
Antigravity get `RUNNER_BROWSER`. Every request goes through the session's
`PreviewBrowserGateway`, which admits only that session's running preview
plus the origins Core's `environment_open` answer grants it (read by the
session's MCP facade; see AGENTS.md). No package or no Node: no browser, a
plain doctor line, and no `browser_tool` capability.
Every Konteks session (not a direct one) also gets the `konteks-result` MCP server (`submit_result`,
`packages/supervisor/src/structured-result/`): a prompt ending with the
structured-output contract binds its schema to the tool, the connector
validates the agent's call, falls back to a fenced result and then one
follow-up prompt, and returns `structuredOutput: { source, value }` with the
prompt completion (see AGENTS.md).
Runtime view (runtime-view CP2, see AGENTS.md): the heartbeat carries each
connected agent's learnt slash commands (`availableCommands`,
`availableCommandsLearntAt`, kept per agent in
`<RUNNER_CREDENTIAL_DIR>/available-commands.json`) and `supportedAgents` for all
five agents (`native/supported-agents.ts`), both only to a 7.1 Core; the
supervisor takes `direct` work (a person's own chat, `work/continued-session.ts`:
no preamble, no Konteks MCP servers, policy root = the session folder); the
connector reports its own commands (`packages/release/src/connector-commands.json`)
as the heartbeat's `connectorCommands` (7.1 Core only, first heartbeat of each
incarnation and on change) and the release ships them as `commands.json`.
Test overrides of the release channel (`KONTEKS_RELEASE_MANIFEST_URL`,
`NODE_EXTRA_CA_CERTS`) go on ONE process (the e2e controller sets them per
run); never `launchctl setenv` or a shell profile: a session-wide override
outlives the proof and silently points the owner's real connector at a dead
local channel (RCA 2026-09-30, `~/Projects/refactory/rca/`). `status` and
`doctor` report an active channel override.
