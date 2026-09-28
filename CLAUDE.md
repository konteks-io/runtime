Follow [HARDENING.md](HARDENING.md): Graft freshness remains required; broader C00 cleanup is deferred.

# Runtime agent entry point

Read [AGENTS.md](AGENTS.md) and [HARDENING.md](HARDENING.md) before editing.
The hardening policy is mandatory for all maintenance work.
Customer-visible file names are in AGENTS.md: resolve the connector with
`resolveNativeConnectorExecutable`, never a literal `connector`.
The runtime is native-only (the appliance is retired and deleted) and runs
Claude Code, Codex, DeepSeek Harness and OpenCode 2; Pi is retired (see AGENTS.md for how
stored values stay readable). On the development branch the
workspaces link the sibling `../packages` sources (`file:../packages/...`,
restored after every merge from `main`, as in Core and the App); `main` and
public exports use the 7.1.0 tarballs in `vendor/` (`export-public.mjs` reads
`konteksContracts`). To refresh `vendor/`, `npm pack` from packages and keep
`konteksContracts` at that version; never regenerate the whole lockfile. CI
(`ci.yaml`, `release.yaml`, `agent-os-proof.yaml`) runs
`scripts/ci-vendored-contracts.mjs` before `npm ci`, so the sibling links
need no switching for a pull request. `agent-os-proof.yaml` (CP0-X) proves
every agent on every OS through the connector's own code
(`scripts/agent-os-proof.mjs`, a scripted model in
`scripts/agent-os-proof/`); results per OS and agent are in
opencode-runtime-support `proof/os-matrix.md`. Host-installed
agents go through per-agent host adapters; OpenCode 2 is offered (CP6:
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
20+); Claude Code and Codex keep their own copy, dsh and OpenCode get
`RUNNER_BROWSER`. Every request goes through the session's
`PreviewBrowserGateway`, which admits only that session's running preview
plus the origins Core's `environment_open` answer grants it (read by the
session's MCP facade; see AGENTS.md). No package or no Node: no browser, a
plain doctor line, and no `browser_tool` capability.
Every session also gets the `konteks-result` MCP server (`submit_result`,
`packages/supervisor/src/structured-result/`): a prompt ending with the
structured-output contract binds its schema to the tool, the connector
validates the agent's call, falls back to a fenced result and then one
follow-up prompt, and returns `structuredOutput: { source, value }` with the
prompt completion (see AGENTS.md).
