# konteks-remote

`konteks-remote` is the Konteks native runtime connector. It installs on a
developer's or team's own computer, runs the coding agents already there
(Claude Code, Codex, DeepSeek Harness, OpenCode 2) and Google Antigravity
(downloaded from Google after you say yes), under their own subscriptions or
keys, and connects them to a Konteks workspace over an outbound,
authenticated channel. No Docker and no local databases. The only provider
keys on the computer are the ones you give DeepSeek Harness, OpenCode or
Google Antigravity, kept in the connector's private folder.

This repository (`konteks-io/runtime`) is the only source for the connector.
The older `remote-instance` repository keeps architecture and proof history
only; do not build or deploy from it.

## How it fits

- **Konteks Core** (HTTPS): enrollment, leases, heartbeats, work assignments,
  signed directives and the version policy (target and minimum release).
- **Relay** (WebSocket): carries live ACP sessions, previews and control
  messages between Konteks and this computer.
- **Local agents** (ACP over stdio): the connector starts each agent's ACP
  bridge or server, gives it the session's tools and answers every
  permission request with its own policy.
- **Contracts**: wire types come from the `@konteks/agent-core` and
  `@konteks/backstage-plugin-common` packages (the sibling `packages` repo),
  vendored under `vendor/`.
- **Releases**: GitHub Releases of this repo; `releases/latest` is the stable
  channel every installed connector follows.

## Quick start

### Install from your own coding agent

If you already work in Claude Code or Codex, paste
[the onboarding block](bootstrap/onboarding.md) into your agent, inside a
repository you care about or a new, empty folder. Every release also ships
[the same steps written for the agent itself](bootstrap/connect.md), so one
sentence with a link to that file is enough. It installs the connector into
your own user folder (no `sudo`, no package), then asks for an email and the
six-digit code Konteks sends. From there your agent offers to make the folder
your first System and turns what you want to build first into your first
initiative.

```sh
curl -fsSL -o "${TMPDIR:-/tmp}/konteks-install.sh" https://github.com/konteks-io/runtime/releases/latest/download/install.sh && sh "${TMPDIR:-/tmp}/konteks-install.sh" --user --enroll
```

The installer is saved to a file your agent can read before running it. It
ends by printing the first onboarding step as JSON; each later step comes
from `konteks-remote onboard --json`. This path is macOS and Linux only.

Once the folder is a repository, onboarding offers Graft, a map of the code
that the agents read before they search. On a yes the connector downloads the
release's Graft package, checks it against the digest from the signed
checksums, and unpacks it under `~/.graft` with its own Node. Its usage
statistics are off, and its files stay out of your commits through
`.git/info/exclude`.

### Install from the Konteks app

Create a runtime in the Konteks app (Runtimes, Connect). On Windows, choose
**Download Windows installer** and open `konteks-runtime-setup.cmd` from
Downloads on the computer you want to connect. Follow the setup window and
approve Windows' installation prompt; it may show "Unknown publisher".
Enter the one-time code shown in the app when setup asks for it. The file
contains only the non-secret activation id, and code entry is not echoed.
Keep setup open until it finishes, then return to the app to check that the
computer is ready. If setup fails, the window stays open with its error and
retry instructions.

On macOS and Linux, or with **Use a terminal instead**, copy the command
shown in the app. These are the terminal entry points:

```sh
curl -fsSL https://github.com/konteks-io/runtime/releases/latest/download/install.sh | sh -s -- --activation-id <id>
```

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://github.com/konteks-io/runtime/releases/latest/download/install.ps1))) -ActivationId <id>"
```

Without `--agents`, `install` uses the agents it finds and connects even with
none. In a terminal it offers, once each, Claude Code through Anthropic's
official installer and Codex, which ships with the connector. On Windows,
Claude Code needs Git for Windows; when it is missing the installer offers
winget (`Git.Git`) or names https://git-scm.com/download/win. It then starts
each agent's sign-in and says which agents are ready. Without a terminal
nothing is downloaded. `--agents` names exactly the agents to use, each
required. `konteks-remote agent add claude-code|codex` offers the same later.

Supported platforms: macOS 13+ (Apple silicon and Intel), Windows 10/11 (x64),
Debian 12/13 and Ubuntu 22.04/24.04 (amd64, arm64).

### Build and test from source

Node 22 (`.nvmrc`; CI uses 22.23.2). The workspaces link the sibling
`../packages` checkout; without it, run `node scripts/ci-vendored-contracts.mjs --yes`
first to point them at `vendor/` (this edits `package.json` files: do not
commit that).

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test                 # node:test over scripts/*.test.mjs, then vitest
npm run ci:check         # lint, typecheck, test, AGPL and secret-canary checks
```

Run one test file with `npx vitest run --project unit <path>`. The opt-in
characterization suite needs installed agents or Linux:
`npm run test:characterization`.

## Using the connector

```
konteks-remote status          # connection, lease, agents
konteks-remote agents          # each agent and whether it is ready
konteks-remote auth status
konteks-remote auth login <agent>   # claude-code, codex, dsh, opencode, antigravity
konteks-remote auth logout <agent>
konteks-remote agent add <agent>
konteks-remote doctor
konteks-remote preview status  # this computer's session previews (read-only)
konteks-remote update --check  # what the stable channel offers
konteks-remote update          # stage, drain, swap, verify; rolls back on failure
konteks-remote stop | start
konteks-remote git key add | list   # key for Konteks-managed repositories
konteks-remote support         # collect a support bundle
konteks-remote uninstall
```

`--verbose` (or `KONTEKS_REMOTE_VERBOSE=1`) also prints each service command,
its exit code and output. The connector reports these commands to Konteks from
`packages/release/src/connector-commands.json` (checked against the real
command table), and each release publishes them as `commands.json`.

### What the runtime page shows

On each heartbeat the connector reports every supported agent's state on this
computer (ready, needs sign-in, sign-in expired, not installed, unsupported
version, not added, failed, or not supported on this system) with the version
found, the supported range and the install command. Agents it does not run
are looked up in the background, never by running an agent with your
credentials. It also reports each agent's slash commands as last announced in
a session here, minus the ones Konteks refuses.

A **direct session** (New session on the runtime's page) is a plain chat with
one of your agents: each prompt runs in the session's own private, empty
folder with no Konteks instructions, skills or tools in front of your text.
The safety rules stay: blocked commands (`git push`, `sudo`, ...) are refused,
file changes outside the session's folder are refused, sign-in requests are
declined, and the rest is asked in the chat.

### What a Konteks session leaves out

A Konteks session works in your repository but does not run what the
repository chose to run. With Claude Code, the repository's hooks do not run
and the servers in its `.mcp.json` are not started; its `CLAUDE.md` is still
read. Your claude.ai connectors are not loaded, and the MCP servers in your
Codex configuration are switched off for each Konteks thread. A session can
call only the tools Konteks gave it. Your own agent sessions outside Konteks
are unchanged.

### Live previews

A session's agent can run a live preview: a dev server started from the
session's working copy. It calls `preview_start` (with `preview_status` and
`preview_stop`), and the connector:

- reads `.konteks/preview.yaml` if present (`serve.command`, `install`,
  `prepare`, `healthPath`, `env`), or infers the command: the `dev` (else
  `start`, `serve`) script with the package manager the lockfile names, plus
  the host/port flags common dev servers need; `manage.py runserver` for
  Django and `bin/rails server` for Rails;
- picks a free port on `127.0.0.1` (43100 to 43999), passes `$PORT` and
  `HOST=127.0.0.1`, and runs with an allow-listed environment (never the
  connector's keys or tokens);
- answers with the state, the local URL, the command and why, and the last
  log lines.

People open the preview from the session in Konteks; the relay carries it to
this computer, which forwards it only to that session's port. When a viewer
opens a preview and nothing runs, the connector starts it itself, if the
session's worktree is still here. A preview stops after 30 idle minutes, when
its session ends, when this computer stops taking work or loses its lease, and
when the connector stops. At most 3 run at once. Commands the connector's
policy refuses (`git push`, `ssh`, `sudo`, ...) are refused in `preview.yaml`
too.

```yaml
# .konteks/preview.yaml
serve:
  command: pnpm --filter web dev --host $HOST --port $PORT
  install: pnpm install
  healthPath: /
  env:
    VITE_API_URL: http://127.0.0.1:8787
```

Previews are switched on or off per runtime in Konteks (on by default).

### Structured results

Turns that need a typed answer (a plan, a verdict, an estimate) use a local
tool server, `konteks-result`, with one tool, `submit_result`. The connector
takes the JSON Schema from the prompt, makes it the tool's input schema,
validates every call and says exactly what to fix. If the turn ends without a
valid call, it looks for the result in the agent's last message, then asks the
agent once more in the same session. Claude Code re-reads its tools, so the
schema only appears in the tool; for Codex the prompt line carries it.

### A browser for QA

Sessions that have a preview (validator, QA and executor conversations; not
planning) also get a headless browser, Microsoft's Playwright MCP
(`@playwright/mcp`, pinned in `release/native-agent-builds.json`), as the
`konteks-browser` MCP server, whichever agent runs them. Claude Code and Codex
run their own bundled copy; other agents run the copy from an installed
Claude Code or Codex package, or your own Node 20+.

- It uses Google Chrome when installed (headless, throwaway profile), else
  installs Playwright's Chromium once into the connector's folder.
- Every request goes through the session's gateway on `127.0.0.1`, which lets
  through only the session's running preview, plus the cloud preview or
  registered application Konteks grants through its `environment_open` tool,
  until those grants expire. The agent cannot add an address itself.
- Tools that could run code outside the page or rewrite its traffic are
  hidden and refused.
- With no Claude Code or Codex package, or no usable Node, there is no
  browser; `doctor` says why.

### DeepSeek Harness

DeepSeek Harness (`dsh`) runs from your own install. Supported versions are
0.1.5-rc.3 up to, not including, 0.1.8, on Node 22.19+ or 24+:

```sh
npm install -g @deepseek-ai/dsh@0.1.7-rc.2
konteks-remote agent add dsh
konteks-remote auth login dsh    # asks for your DeepSeek API key, without echo
```

The connector finds it on `PATH`, in npm's global folders or the npx cache
(`DSH_EXECUTABLE` and `DSH_NODE` for other layouts), checks its version and
settings before every start, and keeps the key only in its private folder. If
it cannot start, it is left out and retried; other agents keep working.

### OpenCode

OpenCode 2 (`opencode`) runs from your own install, versions 2.0.18 up to, not
including, 3.0.0. OpenCode 1 is refused by name.

```sh
curl -fsSL https://opencode.ai/v2/install | bash   # Windows: npm install -g @opencode/cli
konteks-remote agent add opencode
konteks-remote auth login opencode
```

It is found on `PATH` (`opencode2` before `opencode`), the homepage
installer's `~/.opencode/bin`, npm, Homebrew, scoop or Chocolatey
(`OPENCODE_EXECUTABLE` for other layouts). Before every start the connector
proves its settings are in force: every tool call asks first, repository
config is ignored, plan mode is off. `auth login opencode` lists what your
OpenCode offers and relays the link and code, or takes an API key without echo
and types it into OpenCode's own prompt (`--provider`, `--method`, `--reuse`).
Zen's free models are used only when you switch them on in Konteks. OpenCode
runs with a scrubbed environment and a private home; your own OpenCode home,
sign-ins and service are never touched.

### Google Antigravity

Nobody installs Google Antigravity (`antigravity`); add it and sign it in:

```sh
konteks-remote agent add antigravity      # asks before downloading from Google
konteks-remote auth login antigravity     # a Gemini API key or Gemini Enterprise
```

`agent add` asks before downloading (`--yes` is that answer given by you up
front; without a terminal and without `--yes` nothing is downloaded). The
connector downloads Google's official Antigravity ACP server, checks it
against the version, sizes, hashes and Google signature this release pins,
keeps it in its own folder and checks it again before every start. It needs
about 1.5 GB free. Only macOS on Apple silicon is supported for now. A
Konteks update that pins a newer version fetches it on your first yes.
`konteks-remote agent remove antigravity` signs it out and deletes its
download and sign-ins.

Sign-in options:

- **Gemini API key** (`--api-key`): Konteks keeps the key on this computer and
  a local relay adds it to each request, so Antigravity never sees it. Each
  turn's cost is estimated at Google's list price.
- **Gemini Enterprise** (`--enterprise --project <project id> [--location global|us|eu]`,
  or from Konteks): sign in with Google in the browser. Your Google Cloud admin
  must set Terminal auto-execution to Require review. If Google finds no
  licence, run `gcloud services enable businessaicode.googleapis.com --project <project id>`
  and sign in again.

Personal Google accounts are not offered. Antigravity runs with a scrubbed
environment and a private home, keeps subagents and image tools off, gets your
repository's `AGENTS.md` in its first prompt, and at most two sessions run at
once. If it ever runs something without asking, the connector stops it and
takes it out of service until you restart the connector. Its `/plan` and
`/logout` commands are not available. Behind a proxy, the download and the key
relay honour `HTTPS_PROXY` (or `ALL_PROXY`) and `NO_PROXY`.

### Retired agents

Pi is no longer supported: `install --agents` and `agent add` refuse it, and
an installation that still lists it keeps working without it. A pre-7.0.0
installation that listed the old bundled OpenCode reads it as your own
OpenCode 2. The Docker Compose remote instance is retired.

### Uninstall

`uninstall` lets running work finish (up to 15 minutes), has Konteks drain,
revoke and tombstone this runtime, unregisters the service and deletes the
connector's folder. Your repositories and your agents' logins are not touched.

## Project layout

```
packages/common/        shared primitives (crypto, process, secret files, proxy)
packages/release/       release model: bridges, manifests, pins, connector commands
packages/sysmon/        host resource signals
packages/agent-runner/  per-agent runner: ACP bridges, host agents, sign-in, sessions
packages/supervisor/    the connector daemon: Core, relay, work, sessions, previews, updates
packages/launcher/      the konteks-remote CLI, service registration, update transaction
scripts/                build, release, bridge patches, CI checks, agent-on-every-OS proof
bootstrap/              install.sh, install.ps1, onboarding.md, connect.md
release/                build pins and release policy
packaging/              Debian control file and Windows MSI (WiX) source
vendor/                 vendored @konteks contract tarballs
```

## API

The connector serves no public HTTP API. It is a client of Core's
remote-instance API and the relay; the wire contracts live in the sibling
`packages` repo. Two artifacts here are contracts of their own:

- `packages/release/src/connector-commands.json`: the commands the connector
  reports and every release publishes as `commands.json`.
- The signed `native-manifest.json` each release publishes (built by
  `scripts/assemble-release-manifest.mjs` from `release/release-policy.json`).

## Configuration

An installed connector takes its settings from its private runtime record, not
from environment files. `.env.example` lists the variables for local
development of the launcher, supervisor and release tooling. Variables a
person may set on the connector service:

| Variable | Effect |
| --- | --- |
| `SUPERVISOR_PREVIEW_IDLE_MINUTES` | Idle minutes before a preview stops (1 to 1440, default 30). |
| `SUPERVISOR_PREVIEW_MAX_RUNNING` | Previews at once (1 to 16, default 3). |
| `KONTEKS_REMOTE_VERBOSE` | `1` prints service commands and their output. |
| `DSH_EXECUTABLE`, `DSH_NODE` | DeepSeek Harness location when not found. |
| `OPENCODE_EXECUTABLE` | OpenCode location when not found. |
| `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | Proxy for the Antigravity download and key relay. |

`KONTEKS_RELEASE_MANIFEST_URL` and `NODE_EXTRA_CA_CERTS` override the release
channel for tests: set them on one process only, never session-wide.
`status` and `doctor` report an active override.

## Deployment and releases

### How releases are trusted

Every release is a signed `native-manifest.json` that pins each artifact by
SHA-256 digest and size. The verification roots are embedded in the connector
at build time, so neither GitHub nor the network is a trust anchor. Both
bootstraps pin the Konteks release key (Ed25519) in the script itself, and the
release job refuses a release signed by any other key. On Windows the MSI is
not yet Authenticode-signed: `install.ps1` verifies the Ed25519 signature on
`SHA256SUMS` itself (in Windows PowerShell 5.1), checks the MSI's SHA-256
against it, and installs nothing if either fails; Windows then shows "Unknown
publisher".

### Updates

The connector runs as a user service (launchd, user systemd or Task
Scheduler), checks the stable channel every 6 hours, and updates
transactionally: the new release is staged, work is drained, the service is
swapped and health-gated, and the previous release is restored if the gate
fails. A release that is being checked takes no new work. Konteks can also
require an update when a release is below its minimum.

On a connected runtime's page, choose **Update this computer** to request the
signed release Konteks accepts. The computer must remain on and connected;
the update waits for active work and may briefly disconnect it. The app shows
**Update complete** only after a healthy replacement reconnects and Konteks
confirms the requested version and signed release. A refused or failed update
shows a retry instruction. Older runtimes need the installer run once to
enable this action. `konteks-remote update` remains available in a terminal.

The Windows bootstrap shows its download, verification, installation and
runtime update stages. Approve the Windows elevation prompt to install the
command; cancelling it gives a retry instruction. If Windows Installer fails,
the bootstrap prints its error code and a retained `logs/installer-*.log` path
under `%USERPROFILE%\AppData\Local\konteks-remote`. A successful MSI that
requests a Windows restart continues to connect or update the runtime and
reports the restart requirement. The bootstrap's `-Update` also refreshes the
MSI command and can require elevation.

### Releasing

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yaml`: it builds the
macOS `.pkg`, Windows `.msi` and Debian `.deb` packages and the offline agent
packages, signs the manifest and checksums, and publishes an immutable GitHub
Release. `ci.yaml` checks every pull request; `agent-os-proof.yaml` proves
each agent (Claude Code, Codex, DeepSeek Harness, OpenCode) on macOS, Linux
and Windows through the connector's own code, with a scripted model and no
credentials (`node scripts/agent-os-proof.mjs --agent <agent> --out result.json`
after `npm run build`).

## Troubleshooting

- **Logs.** macOS and Windows: `logs/connector.log` in the connector's folder
  (on Windows kept under 20 MB at each start). Linux: the user journal. When
  the connector is not running, `doctor` and `support` show the last failed
  start and the log's last lines.
- **Process names.** The service shows as `konteks-connector` (Linux:
  `konteks-connect`); the command you run is `konteks-remote`. Releases from
  before the rename call it `connector`; both names are accepted.
- **Old Windows MSI.** An MSI from before 0.10.11 runs its own old code;
  `doctor` says so. Run the Windows install line once with `-Update` in place
  of `-ActivationId` to replace it, update and start the connector.
- **Lost machine key.** The connector stops and says so; run
  `konteks-remote onboard` again to connect it as a replacement runtime.

## License

Copyright 2026 Konteks. Licensed under the Apache License, Version 2.0; see
`LICENSE`. Third-party components and adapted code are listed in
`THIRD_PARTY_NOTICES.md`.

## Optional native trace export

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in the connector service environment to
an explicit HTTP(S) OTLP trace endpoint. Without it, tracing stays disabled.
`OTEL_SDK_DISABLED=true` disables export. Credentials must not appear in the URL.
The connector exports bootstrap and preview tool spans with bounded identifiers,
stable failure codes, exit status and accurate outcomes; it does not export
commands, provider bodies or exception messages. Events use the actual active
span context. The bounded batch queue holds at most 1,024 spans and flushes at
shutdown. Telemetry configuration never grants or replaces execution authority.

For controller-owned local E2E, set `KONTEKS_E2E_NATIVE_OTLP_TRACES_ENDPOINT` in
the ignored controller `.env`; it applies only to the native connector process.
Agent rules: see AGENTS.md (map and guardrails).

### Native permission-answer producer pin

Permission-answer rollout requires the same explicit dedicated producer in
Core (`remoteInstance.permissionAnswerProducer`), Relay
(`RELAY_CORE_PERMISSION_ANSWER_PRODUCER`), and the native installation's
private operator-owned `native-runtime.json` (`corePermissionAnswerProducer`).
The native pin is optional and has no default. An environment variable cannot
provide or replace it. Coordinate the pin while native work is drained, preserve
all existing installation identity, manifest and key fields, and restart through
the installation's normal service controller. An absent pin keeps answers closed.
The pin does not replace Core signature/permit verification, current connection
and execution authority, exact tool-call binding or assignee approval.
