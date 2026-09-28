Follow [HARDENING.md](HARDENING.md): Graft freshness remains required; broader C00 cleanup is deferred.

# Runtime agent entry point

Read [AGENTS.md](AGENTS.md) and [HARDENING.md](HARDENING.md) before editing.
The hardening policy is mandatory for all maintenance work.
Customer-visible file names are in AGENTS.md: resolve the connector with
`resolveNativeConnectorExecutable`, never a literal `connector`.
The runtime is native-only (the appliance is retired and deleted) and runs
Claude Code, Codex and DeepSeek Harness; Pi and the old bundled OpenCode are
retired (see AGENTS.md for how stored values stay readable). Host-installed
agents go through per-agent host adapters; OpenCode 2 is registered and
detected but gated (not offered) until its CP4 security checkpoint; its
runner already spawns with the locked config, one process per working copy,
after a start self-check (AGENTS.md).
Session previews run in the supervisor (`packages/supervisor/src/preview/`):
one supervised dev server per session, forwarded only to its own loopback
port; the per-machine switch is Core's (see AGENTS.md). A viewer's first
request for a session with nothing running starts it (`PreviewChannel`
`autoStart`, `Supervisor.startPreviewForViewer`) in the worktree the session
registered with `SessionPreviewAccess.permit`, answering 503
`STARTING_MESSAGE` ("Starting preview…", which Core turns into a refreshing
page); `startedBy` records agent or viewer.
Claude Code and Codex sessions with a preview (validator, QA-mode and other
conversations, executor) get a headless browser
(Playwright MCP, `konteks-browser`, bundled in their agent packages) whose
every request goes through the session's `PreviewBrowserGateway`, which
admits only that session's running preview plus the origins Core's
`environment_open` answer grants it (read by the session's MCP facade; see
AGENTS.md); dsh gets none.
Every session also gets the `konteks-result` MCP server (`submit_result`,
`packages/supervisor/src/structured-result/`): a prompt ending with the
structured-output contract binds its schema to the tool, the connector
validates the agent's call, falls back to a fenced result and then one
follow-up prompt, and returns `structuredOutput: { source, value }` with the
prompt completion (see AGENTS.md).
