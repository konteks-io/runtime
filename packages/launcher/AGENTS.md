# Launcher (`konteks-remote` CLI)

## Purpose

The command people (and their agents) run: install and onboarding, agent
add/remove, sign-in relays, status/doctor/support, service registration
(launchd, user systemd, Windows Task Scheduler), the update transaction and
uninstall. It talks to the running supervisor over the local control socket
(`packages/common/src/control-socket.ts`).

## Entry files

- `src/native/cli.ts`: `createNativeProgram`, the command table.
- `src/native/commands.ts`: command actions, `serve`, service refresh.
- `src/native/install.ts`, `agent-setup.ts`, `consent.ts`: install, agent add/remove.
- `src/native/onboard.ts`: agent-first onboarding, one step per run (`STEPS`
  table, retry and failure replies); `onboard-session.ts` holds what every
  step shares, `onboard-connect.ts` / `onboard-system.ts` / `onboard-closing.ts`
  the steps; `graft.ts`: Graft wiring.
- `src/native/service.ts`: service definitions and errors.
- `src/native/update-transaction.ts`, `update.ts`: stage, drain, swap, verify, roll back.
- `src/native/launcher-delegate.ts`: the Windows MSI launcher hand-off.
- `src/verbose.ts`: `--verbose` / `KONTEKS_REMOTE_VERBOSE=1` output on stderr.

## Invariants

- **Command table is a contract.** `packages/release/src/connector-commands.json`
  must list every command a person runs, with arguments and options that exist
  in `createNativeProgram` (`src/__tests__/connector-commands.test.ts`).
- **Control ops are versioned by op, not by field.** Older launchers parse
  `status` strictly: add a new control op (as `update.channel`) instead of a
  new `status` field.
- **Agent setup.** Install without `--agents` detects agents and requires none;
  it offers a missing Claude Code only through Anthropic's official installer
  and Codex by creating its profile for the shipped CLI. No TTY or `--json`
  never asks or downloads. An explicit `--agents` list stays strict. On
  Windows, Claude Code needs Git for Windows (`findGitForWindows` in
  `packages/common`), offered once through winget.
- **Fetched agents need the person's yes.** `agent add antigravity` /
  `install --agents ...,antigravity` check `assertFetchable` first, then ask
  `consentText` verbatim (`consent.ts`): a terminal answer or `--yes` given by
  the person; a relaying agent never adds `--yes`. The fetch runs while the
  service keeps running, before the add drains and stops it. Enrollment never
  detects Antigravity and refuses it in `install --enroll --agents`. Only a
  fetched agent is removable with `agent remove` (signs out, then deletes its
  versions, credentials and workspaces).
- **Service definitions follow the serving release.** `serve` rewrites a
  definition that differs from what it renders and has the service manager
  reload it (launchd `bootout` + `bootstrap`, systemd `daemon-reload` +
  restart) at most once per definition per 10 minutes
  (`SERVICE_RELOAD_WINDOW_MS`); a foreground `serve` is never restarted.
- launchd plists set `ExitTimeOut` (`LAUNCHD_EXIT_TIMEOUT_SECONDS` = 30, above
  the daemon's watchdog), or launchd SIGKILLs a stopping connector after 5 s.
- Windows Task XML is UTF-16LE with a BOM, written and compared as bytes via
  `encodeServiceDefinition`; a failed registration restores the exact bytes it
  found. `RestartOnFailure/Count` stays 255 (schema unsignedByte).
- A failed service step is a `NativeServiceCommandError` (step, command, exit
  code, output excerpt), told by `describeServiceFailure`, and recorded in
  `supervisor/service-start-failure.json` for `doctor` and `support`.
- **Update transaction.** It reads the service pid before stopping and
  accepts that process being gone as proof; it ends the process group after
  `stopGraceMs`; any abort after the stop and before the swap restarts the
  unchanged release (`restartUnchanged`). `keepLauncherCurrent` keeps
  `<root>/bin/konteks-remote` on the running release.
- **Windows launcher.** The MSI's `konteks-remote.exe` (not writable without
  elevation) runs `releases\<id>\konteks-connector.exe` from
  `native-runtime.json` with the same argv and exit code, setting
  `KONTEKS_REMOTE_VIA_LAUNCHER=1` on the child. It runs its own code for
  `install`, `uninstall`, `stage-enrollment`, with nothing or a `pending`
  record installed, when its own version is newer, or when the target is not a
  regular file at exactly `releases\<id>\<name>` under the root's real path.
- Resolve the connector executable with `resolveNativeConnectorExecutable`,
  never a literal file name (root `AGENTS.md`).

## Gotchas

- Windows has no `<root>\bin` launcher; the MSI command is the person's command.
- Windows tests run in CI only (`.github/workflows/ci.yaml` `windows-native`).
