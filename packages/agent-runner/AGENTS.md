# Agent runner

## Purpose

One runner process per agent. It spawns the agent's ACP bridge (offline
packages for Claude Code and Codex) or the person's own install (dsh, OpenCode
2) or the fetched Google Antigravity server, owns its private home and
sign-in, runs sessions, reports models, usage and learnt slash commands, and
serves the supervisor over the runner port (`packages/supervisor/src/runner-port.ts`).

## Entry files

- `src/runtime.ts`: the runner; `CODEX_SESSION_GOVERNANCE`, `DEFAULT_MODEL_CAPABILITY_TTL_MS`.
- `src/bridge/`: spawn spec, ACP client (`process.ts`), Codex shared app-server
  transport, Playwright MCP launcher (`browser-*.ts`), model capability,
  instruction-scope marker observer.
- `src/host/host-agent.ts`: `HostAgentRunnerAdapter`, the seam every host agent
  implements; `registry.ts`; `dsh.ts`, `opencode.ts`, `antigravity.ts`,
  `antigravity-relay.ts`, `allow-list-environment.ts`.
- `src/auth/`: sign-in flows (`opencode-auth.ts`, `antigravity-auth.ts`, `dsh-key.ts`, ...).
- `src/sessions/`: `manager.ts`, `available-commands.ts`, `usage-label.ts`.

## Invariants

- **No per-agent branches in generic code.** A host agent is a
  `HostAgentRunnerAdapter` here plus a `HostAgentInstallAdapter` in
  `packages/supervisor/src/native/host-agents.ts`; generic code only calls
  adapter seams (`bindWorkingCopy`, `refusedSessionModes`,
  `refusedPromptCommands`, `sessionMeta`, `verifySession`, `promptPrelude`,
  `processLimits`, `wrapSpawn`, `measureTurn`, ...).
- **Environments are allow-lists.** Every OpenCode and Antigravity process,
  including `--version`, `debug` and sign-in, gets only
  `allowListEnvironment` plus Konteks settings, in a private home under the
  runner's credential dir. Never pass `GITHUB_TOKEN`, `GH_TOKEN`, provider keys,
  or inherited `OPENCODE_*`, `GEMINI_*`, `GOOGLE_*`, `CLOUDSDK_*`, `AGY_*`.
- **Keys never travel as text.** An API key is read with the launcher's hidden
  prompt and is never an argument, environment variable, event or log line.
  OpenCode keys are typed into OpenCode's own prompt on a pty (refused on
  Windows), and output lines carrying them are dropped. The Gemini key stays
  in the connector (0600, outside the agent home); each Antigravity process
  gets a loopback relay with a random token instead (`antigravity-relay.ts`).
  The connector never opens OpenCode's database.
- **OpenCode.** Locked config through `OPENCODE_CONFIG_CONTENT` with project
  config and file watcher disabled; one execution process per working copy,
  never reused for another session (MCP servers are process-wide); `plan`
  mode refused.
- **Antigravity.** Every `session/new|load|resume` carries `_meta.agy` with the
  tool allowlist and disabled tools; only `default` mode (`auto_edit`, `yolo`
  refused); the working copy's `AGENTS.md` goes in the first prompt; at most
  two execution processes (`ANTIGRAVITY_PROCESS_LIMITS`); `/plan` and
  `/logout` prompts refused. Personal Google sign-in stays off until
  `ANTIGRAVITY_LOGIN_OPTIONS` in packages releases it.
- **Codex** sessions are pinned to codex-acp's Ask for approval mode
  (`CODEX_SESSION_GOVERNANCE`) before ready; `allowedModeIds` refuses every
  other mode on `set_mode`, `set_config_option` and admitted configurations.
- Bridge clients answer `fs/*` and `terminal/*` with method not found.
- **Browser.** Never pass `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`
  and never `npx` Playwright at runtime; hidden tools are refused
  (`isDeniedBrowserTool`). The launcher re-reads allowed origins from the
  session gateway and restarts Playwright only when nothing is in flight.
- **7.1 Core only.** Pay-per-use turns, `availableCommands` and option
  billing are reported only while `coreAcceptsRouteBilling` holds.
- Learnt slash commands are stored per agent in
  `<RUNNER_CREDENTIAL_DIR>/available-commands.json` (0600), minus the
  adapter's refused commands.

## Gotchas

- OpenCode's self-check lists default agents for about a second on a fresh
  service; it reads `debug agents` until stable (`opencode-self-check.ts` in
  the supervisor).
- Code Mode `fetch` in OpenCode runs unasked and cannot be removed; it is
  treated as an allowed web fetch.
