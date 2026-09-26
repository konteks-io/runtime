# konteks-remote

This `konteks-io/runtime` repository is the canonical implementation source for
the native BYOA runtime, including local E2E builds and repairs. The former
`remote-instance` repository retains architecture and proof history only; do
not build or deploy the connector from that checkout.

`konteks-remote` is the Konteks native runtime connector. It installs on a
developer's or team's own machine, runs the coding agents that are already
installed there (Claude Code, Codex, DeepSeek Harness) under their
own subscriptions or keys, and connects them to a Konteks workspace over an
outbound, authenticated channel. No Docker, no local databases. The only
provider key on the host is a DeepSeek API key, if you use DeepSeek Harness,
kept in the connector's private folder.

## Install

There are two doors, and they lead to the same place.

### From your own coding agent

If you already work in Claude Code or Codex, you never have to open the app.
Paste [the onboarding block](bootstrap/onboarding.md) into your agent, inside
a repository you care about, or a new, empty project folder. Every release also
ships [the same steps written for the agent itself](bootstrap/connect.md), so a
single sentence with a link to that file is enough. It installs the connector into your own user
directory — no `sudo`, no package — then asks you for an email and the
six-digit code Konteks sends back. That is the whole of it before the machine
is connected; from there your agent offers to make the folder you are in your
first System (on Konteks managed git if it has no remote yet), and turns what
you want to build first into your first initiative.

```sh
curl -fsSL -o "${TMPDIR:-/tmp}/konteks-install.sh" https://github.com/konteks-io/runtime/releases/latest/download/install.sh && sh "${TMPDIR:-/tmp}/konteks-install.sh" --user --enroll
```

The installer is downloaded to a file your agent can read before it runs,
rather than piped into `sh`. It ends by printing the first onboarding step as
JSON; each later step comes from `konteks-remote onboard --json`.

Once the folder is a repository, onboarding offers Graft, a map of the code
that Claude Code, Codex and DeepSeek Harness read before they search. On a yes the connector
downloads the release's Graft package, checks it against the digest the
installer recorded from the signed checksums, and unpacks it in `~/.graft`
with its own copy of Node, so it needs no Node on the laptop and keeps working
if Konteks is removed. Its usage statistics are off, nothing goes to a paid
model, and its files stay out of your commits through the repository's local
`.git/info/exclude`.

macOS and Linux. The connector executable is verified against the same signed
checksum manifest the packages are, so this path is verified differently from
the package path, not less.

### From the Konteks app

Create a runtime in the Konteks App (Settings → Runtimes → Connect) and copy
the command it shows. It carries only a non-secret activation id; the
activation code is prompted without echo.

```sh
curl -fsSL https://github.com/konteks-io/runtime/releases/latest/download/install.sh | sh -s -- --activation-id <id>
```

```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://github.com/konteks-io/runtime/releases/latest/download/install.ps1))) -ActivationId <id>"
```

The bootstrap verifies the signed checksum manifest and the publisher
signature of the installer package before running anything. Signed packages
are also published as plain release assets for offline or audited installs.

Supported platforms: macOS 13+ (Apple silicon and Intel), Windows 10/11
(x64), Debian 12/13 (amd64, arm64).

## Day-to-day

```
konteks-remote status          # cloud readiness, lease, agents
konteks-remote auth login codex
konteks-remote auth login dsh  # asks for your DeepSeek API key, without echo
konteks-remote agents
konteks-remote doctor
konteks-remote preview status  # this computer's live session previews (read-only)
konteks-remote update --check  # what the stable channel offers
konteks-remote update          # stage, drain, swap, verify; rolls back on failure
konteks-remote stop | start
konteks-remote uninstall       # finish running work, remove this runtime from its workspace, delete the connector
```

### Live previews

A session's agent can run a live preview of its work: a dev server started
from the session's working copy on this computer. There is nothing to set up.
The agent calls `preview_start` (one of three tools the connector gives it,
beside the platform tools; `preview_status` and `preview_stop` are the
others), and the connector:

- reads `.konteks/preview.yaml` if the repository has one (`serve.command`,
  `install`, `prepare`, `healthPath`, `env`: the same `serve` fields as the
  cloud preview), or otherwise works out the command: the `dev` (else
  `start`, `serve`) script in `package.json`, run with the package manager its
  lockfile names, with the host/port flags Vite, Next.js, Astro, Nuxt,
  Angular and similar dev servers need; `npm install` (or the matching
  manager) first when `node_modules` is missing; `manage.py runserver` for
  Django and `bin/rails server` for Rails;
- picks a free port on `127.0.0.1` (43100–43999), passes it as `$PORT` with
  `HOST=127.0.0.1`, and runs the command with only an allow-listed
  environment (your `PATH` from your login shell, home, locale, package
  manager folders; never the connector's keys or tokens);
- answers with the state, `http://127.0.0.1:<port>` for a browser on this
  computer (a QA agent's, say), what command it used or inferred and why,
  and the last log lines.

People open the preview from the session in Konteks; the relay carries it on
the session's `preview:<sessionId>` channel to this computer, which forwards
it only to that session's own port. Nobody has to ask the agent first: when a
viewer opens a session's preview and nothing runs, the connector starts it
itself (same inference, same caps) as long as the session's worktree is still
here and this computer takes work, and answers "Starting preview" until it is
up; Konteks shows a page that refreshes by itself meanwhile. A preview that
just failed is not restarted on every refresh (at most once a minute).
`preview_status` and `konteks-remote preview status` say whether the agent or
a viewer started it. A preview stops after 30 minutes with no
viewer and no agent activity, when its session ends, when this computer
stops taking work or loses its lease, and when the connector stops; a
restarted connector kills any preview a crashed one left and never adopts
it. At most 3 run at once. `SUPERVISOR_PREVIEW_IDLE_MINUTES` and
`SUPERVISOR_PREVIEW_MAX_RUNNING` in the connector service's environment
change those two numbers (whole minutes up to 1440, and up to 16 previews;
anything else keeps the default). A command the connector's command policy refuses (`git push`,
`ssh`, `sudo`, …) is refused in `preview.yaml` too.

A repository with an unusual dev server says how to serve it:

```yaml
# .konteks/preview.yaml
serve:
  command: pnpm --filter web dev --host $HOST --port $PORT
  install: pnpm install
  healthPath: /
  env:
    VITE_API_URL: http://127.0.0.1:8787
```

### A browser for QA

Claude Code and Codex sessions that have a preview (the validator, QA-mode
and other conversations, and the executor; not planning) also get a headless browser
on the session's preview: Microsoft's Playwright MCP (`@playwright/mcp`
0.0.82, pinned in `release/native-agent-builds.json` and carried inside the
Claude Code and Codex agent packages, run on their own Node). Its tools
(`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_take_screenshot`, `browser_verify_*`, …) appear as the
`konteks-browser` MCP server. There is nothing to set up:

- it uses Google Chrome when it is installed, headless with a throwaway
  in-memory profile (never your own); without Chrome it installs
  Playwright's Chromium once, the first time an agent uses the browser, into
  the connector's data folder;
- every request the page makes goes through that session's gateway on
  `127.0.0.1`, which lets through only the session's running preview (its
  `http://127.0.0.1:<port>`, and the WebSocket hot reload on the same port).
  Other ports on this computer, the internet and HTTPS are refused, and so
  is anything while no preview runs: the browser shows "No live preview is
  running for this session. Call preview_start …";
- a QA agent can also test the session's cloud preview or a registered
  application: it calls Konteks' `environment_open` tool, which answers with
  a one-time sign-in link (cloud preview) or the application's address, and
  the session's browser may then reach exactly those origins until Konteks
  says they expire. The connector reads them from Konteks' answer as it
  passes through the session's platform tool connection, so the agent
  cannot add an address of its own; a registered application whose name
  points at this computer is refused. Playwright's own origin list follows
  (the browser restarts once, before the call that opens the new address);
- the tools that could run code outside the page or rewrite its traffic
  (`browser_run_code_unsafe`, `browser_route`, …) are hidden and refused;
- DeepSeek Harness sessions get no browser (dsh carries no agent package to
  run it in).

`doctor` reports the browser's version, which agents carry it, and whether it
uses Chrome or Playwright's Chromium.

To stop offering previews from a computer, switch previews off for that
runtime in Konteks (Customize → Runtimes); it is on by default. Konteks and
the relay then open no preview channel to it. `konteks-remote preview status`
shows what runs here; `doctor` reports whether previews are offered and when
one last failed to start.

### DeepSeek Harness

DeepSeek Harness (`dsh`) runs from your own install, not from a package in the
release. Supported versions are 0.1.5-rc.3 (npm `latest`, what the DeepSeek
Harness homepage's `npx @deepseek-ai/dsh web` installs) up to, not including,
0.1.8. Install one with your Node (22.19+ in the 22 line, or 24+), then add it
and give it a key:

```sh
npm install -g @deepseek-ai/dsh@0.1.7-rc.2
konteks-remote agent add dsh
konteks-remote auth login dsh
```

The connector finds it on `PATH`, in npm's global folders, or in npm's npx
cache (the newest supported copy there; set `DSH_EXECUTABLE` and `DSH_NODE` for
any other layout), checks the version, and
proves its own settings are in force before every start. Every tool call
DeepSeek Harness makes outside reading goes through the same policy as Claude
Code and Codex. The key is checked with DeepSeek (no tokens used) and stored
only in the connector's private folder. If it cannot start (an unsupported
version, say), it is left out and retried in the background with the reason in
the connector log; your other agents keep working.

Pi and OpenCode are no longer supported: `install --agents` and `agent add`
refuse them, and an installation that still lists one keeps working without
it (the connector log says it was skipped). The Docker Compose remote
instance is retired; the connector on your own computer is the only way to
run Konteks agents.

`uninstall` lets running work finish (up to 15 minutes), has Konteks drain,
revoke and tombstone this runtime, stops and unregisters the service and
deletes the connector's folder. Your repositories and your coding agents'
logins are not touched. A machine that lost its key stops and says so;
running `konteks-remote onboard` again connects it as a runtime that replaces
its old one.

The connector runs as a user service (launchd, user systemd, or Task
Scheduler). It checks the stable channel on its own and applies updates
transactionally: the new release is staged beside the running one, work is
drained, the service is swapped and health-gated, and the previous release is
restored if the gate fails. A new release whose service exits as it starts is
rolled back after three failed starts, within seconds, rather than at the
gate's three-minute deadline. `update` and `update --check` say when the
connector updated itself, and when a release already failed here.

In Activity Monitor, `ps` or Task Manager the service shows as
`konteks-connector` (Linux cuts process names to 15 characters:
`konteks-connect`), and a command you run as `konteks-remote`. Both are the
same signed program. Releases installed before the rename call it `connector`;
the service, `start` and rollback accept either name, and each new release
keeps a `connector` copy for launchers installed before the rename.

## How releases are trusted

Every release is a signed `native-manifest.json` that pins each artifact by
SHA-256 digest and size. The verification roots are embedded in the connector
executable at build time, so neither GitHub nor the network is a trust anchor.
`releases/latest/download/native-manifest.json` is the stable channel.

## Building

Node 22.23.2 is required.

```sh
npm ci
npm run typecheck
npm test
```

The shared Konteks contract packages are vendored under `vendor/` as built
tarballs. Releases are produced by the `release` workflow on a `v*` tag; see
`.github/workflows/release.yaml` for the platform matrix and the signing
inputs.

## License

Copyright 2026 Konteks. Licensed under the Apache License, Version 2.0; see
`LICENSE`. Third-party components and adapted code are listed in
`THIRD_PARTY_NOTICES.md`.
