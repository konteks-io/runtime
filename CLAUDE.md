Follow [HARDENING.md](HARDENING.md): Graft freshness remains required; broader C00 cleanup is deferred.

# Runtime agent entry point

Read [AGENTS.md](AGENTS.md) and [HARDENING.md](HARDENING.md) before editing.
The hardening policy is mandatory for all maintenance work.
Customer-visible file names are in AGENTS.md: resolve the connector with
`resolveNativeConnectorExecutable`, never a literal `connector`.
The runtime is native-only (the appliance is retired and deleted) and runs
Claude Code, Codex and DeepSeek Harness; Pi and OpenCode are retired (see
AGENTS.md for how stored values stay readable).
Session previews run in the supervisor (`packages/supervisor/src/preview/`):
one supervised dev server per session, forwarded only to its own loopback
port; the per-machine switch is Core's (see AGENTS.md). A viewer's first
request for a session with nothing running starts it (`PreviewChannel`
`autoStart`, `Supervisor.startPreviewForViewer`) in the worktree the session
registered with `SessionPreviewAccess.permit`, answering 503
`STARTING_MESSAGE` ("Starting preview…", which Core turns into a refreshing
page); `startedBy` records agent or viewer.
Claude Code and Codex QA/validator/executor sessions get a headless browser
(Playwright MCP, `konteks-browser`, bundled in their agent packages) whose
every request goes through the session's `PreviewBrowserGateway`, which
admits only that session's running preview (see AGENTS.md); dsh gets none.
