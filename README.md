# konteks-remote

This `konteks-io/runtime` repository is the canonical implementation source for
the native BYOA runtime, including local E2E builds and repairs. The former
`remote-instance` repository retains architecture and proof history only; do
not build or deploy the connector from that checkout.

`konteks-remote` is the Konteks native runtime connector. It installs on a
developer's or team's own machine, runs the coding agents that are already
installed there (Claude Code, Codex, DeepSeek Harness, OpenCode 2), and
Google Antigravity, which it downloads from Google after you say yes, under
their own subscriptions or keys, and connects them to a Konteks workspace over
an outbound, authenticated channel. No Docker, no local databases. The only
provider keys on the host are the ones you give DeepSeek Harness, OpenCode or
Google Antigravity (a DeepSeek key; any provider's key OpenCode supports; a
Gemini API key), kept in the connector's private folder.

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
that Claude Code, Codex, DeepSeek Harness and OpenCode read before they search. On a yes the connector
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

Nothing needs to be installed first. Without `--agents`, `install` uses the
agents it finds on the computer and connects even with none. Before asking
for the code it offers, once each and only in a terminal: Claude Code through
Anthropic's official installer (`https://claude.ai/install.ps1` on Windows,
`https://claude.ai/install.sh` elsewhere), and Codex, which ships with the
connector (nothing is downloaded). On Windows, Claude Code needs Git for
Windows; when it is missing it asks once to install it with winget
(`Git.Git`), or names https://git-scm.com/download/win. It then starts each one's own sign-in and
ends by saying which agents are ready, with the one command for the rest
(`konteks-remote agent add claude-code|codex` offers the same later). Without a
terminal nothing is downloaded. `--agents` names exactly the agents to use,
each required.

The bootstrap verifies the signed checksum manifest and the publisher
signature of the installer package before running anything. Signed packages
are also published as plain release assets for offline or audited installs.

Both bootstraps pin the Konteks release key (Ed25519) in the script itself;
it is never taken from the download location, and the release job refuses to
publish a release signed by any other key. On Windows the MSI is not yet
Authenticode-signed (Konteks has no Windows code-signing certificate), so
`install.ps1` trusts it through the signed checksums alone: it verifies the
Ed25519 signature on `SHA256SUMS` itself, in plain Windows PowerShell 5.1,
checks the MSI's SHA-256 against it, and installs nothing if either fails.
Windows then shows "Unknown publisher" at the elevation prompt. A release
that does carry an Authenticode signature must also be valid and from the
expected publisher.

Supported platforms: macOS 13+ (Apple silicon and Intel), Windows 10/11
(x64), Debian 12/13 and Ubuntu 22.04/24.04 (amd64, arm64).

## Day-to-day

```
konteks-remote status          # cloud readiness, lease, agents
konteks-remote auth login codex
konteks-remote auth login dsh  # asks for your DeepSeek API key, without echo
konteks-remote auth login opencode  # pick a provider, then its link and code, or its API key without echo
konteks-remote agents
konteks-remote doctor
konteks-remote preview status  # this computer's live session previews (read-only)
konteks-remote update --check  # what the stable channel offers
konteks-remote update          # stage, drain, swap, verify; rolls back on failure
konteks-remote stop | start
konteks-remote --verbose start # also print each service command, its exit code and output (or KONTEKS_REMOTE_VERBOSE=1)
konteks-remote uninstall       # finish running work, remove this runtime from its workspace, delete the connector
```

The connector tells Konteks these commands, with one plain line each and the
systems they run on (`packages/release/src/connector-commands.json`, checked
against the launcher's real command table and built into the connector), so
the runtime's page lists exactly what the installed connector has. Each
release also publishes them as `commands.json`.

### What the runtime page shows

The connector tells Konteks, on each heartbeat, every supported agent's real
state on this computer (ready, needs sign-in, sign-in expired, not installed,
unsupported version, installed but not added, not added, failed, or not
supported on this system), with the version it found, the supported range and
the install command. Agents it does not run are looked up the way onboarding
does, in the background (a minute, doubling to fifteen), never by running an
agent with your credentials. It also reports each agent's slash commands, the
latest list the agent announced in a session here (kept in the agent's own
connector folder across restarts; commands Konteks refuses, such as Google
Antigravity's `/plan` and `/logout`, are left out).

A **direct session** (New session on the runtime's page) is a plain chat with
one of your agents on this computer: each prompt runs in the session's own
private, empty folder, with no Konteks instructions, skills or tools in front
of your text, so a leading `/command` reaches the agent as typed. The usual
safety rules stay: blocked commands (`git push`, `sudo`, …) are refused,
file changes outside the session's folder are refused, sign-in requests are
declined, and whatever the policy leaves to you is asked in the chat.

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

### Structured results

Some Konteks turns need a typed answer: a plan from the planner, a verdict
from a validator or QA reviewer, an estimate from ideation. Every session gets
a third local tool server beside the platform and preview tools,
`konteks-result`, with one tool, `submit_result`. When a turn's prompt ends
with Konteks' structured-output contract, the connector takes the JSON Schema
out of the prompt, makes it the tool's input schema, and tells the agent in
one line to call `submit_result` when it is finished. It checks every call
against the schema and answers with exactly what to fix, so the agent corrects
itself in the same turn; the first valid call is kept and returned to Konteks
with the turn's completion. If the turn ends without one, the connector looks
for the result in the agent's final message, and failing that asks the agent
once more in the same session before it reports the turn. Nothing leaves this
computer through the tool, and your agent's own session history shows the
one-line request and the tool call instead of a schema dump.

Claude Code re-reads its tools when the connector announces the schema, so
the schema only appears in the tool definition. Codex keeps the tool list it
read when the session started; for Codex the prompt line carries the schema,
and the tool still validates. A connector older than this keeps the contract
in the prompt and the agent answers with a fenced JSON block, as before.

### A browser for QA

Sessions that have a preview (the validator, QA-mode and other
conversations, and the executor; not planning) also get a headless browser
on the session's preview, whichever agent runs them (Claude Code, Codex,
DeepSeek Harness, OpenCode or Google Antigravity): the browser belongs to the connector, not to
one agent. It is Microsoft's Playwright MCP (`@playwright/mcp` 0.0.82, pinned
in `release/native-agent-builds.json` and carried inside the Claude Code and
Codex agent packages). Claude Code and Codex run their own copy; the other
agents run the copy in an installed Claude Code (or else Codex) package, on
that package's Node, or on your own Node (20 or newer, the one DeepSeek
Harness uses first) when the package's cannot run. Its tools
(`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_take_screenshot`, `browser_verify_*`, …) appear as the
`konteks-browser` MCP server (OpenCode calls them from its Code Mode as
`tools["konteks-browser"].browser_navigate({ ... })`). There is nothing to
set up:

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
- a computer with neither a Claude Code nor a Codex package installed, or
  with no Node that can run the browser, has no browser: sessions there check
  work without opening one, the connector does not advertise `browser_tool`
  (so Konteks can keep QA elsewhere), and `doctor` says why in one line
  ("Add one with `konteks-remote agent add claude-code`", or "Install Node
  from https://nodejs.org").

`doctor` reports the browser's version, which agents get it, which Node it
runs on, and whether it uses Chrome or Playwright's Chromium.

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

### OpenCode

OpenCode 2 (`opencode`) runs from your own install too, never from the
release. Supported versions are 2.0.18 up to, not including, 3.0.0: the line
OpenCode's homepage installs. OpenCode 1 (npm `opencode-ai`, brew
`anomalyco/tap/opencode`) is refused by name. Install it, then add it and sign
it in:

```sh
curl -fsSL https://opencode.ai/v2/install | bash   # Windows: npm install -g @opencode/cli
konteks-remote agent add opencode
konteks-remote auth login opencode
```

The connector finds it on `PATH` (`opencode2` before `opencode`), in the
homepage installer's `~/.opencode/bin`, npm's global folders, Homebrew, scoop
or Chocolatey (`OPENCODE_EXECUTABLE` for any other layout), reads its version,
and before every start proves with `opencode debug agents` that the Konteks
settings are in force: every tool call asks first, repository config is
ignored, and its plan mode is off. Its tool calls go through the same policy
as the other agents (shell commands, edits inside the working copy only, its
code blocks limited to calls to Konteks' own tools; any call that skips the
check takes OpenCode out of service on that computer).

Sign-in works like the other agents: `auth login opencode` lists what your
OpenCode offers (subscriptions first: OpenCode Console, ChatGPT, GitHub
Copilot, SuperGrok, GitLab, Poe) and relays the link and code, or takes an API
key without echo and types it into OpenCode's own prompt; `--provider` and
`--method` pick directly, `--reuse` shows which providers your own OpenCode
uses so you can sign in to the same ones here, and `auth logout opencode
[--provider X]` signs out. Subscription sign-ins can also be started from the
site. Zen's free models are used only when you switch them on in Konteks.

OpenCode runs with a scrubbed environment: every OpenCode command the
connector starts (sessions, `--version`, `debug`, `auth`) gets only what it
needs (PATH, locale, temp folders, proxy settings, a private home under the
connector's folder) and never your `GITHUB_TOKEN`, `GH_TOKEN`, provider keys,
`AWS_*`, `AZURE_*`, Google credentials or inherited `OPENCODE_*` variables.
Your own OpenCode home, sign-ins and background service are never touched.

If OpenCode cannot start, or is removed or replaced by an unsupported version,
it is left out and retried in the background (it is found again if you
reinstall it another way); your other agents keep working, and `doctor` says
why. `doctor` also shows its version, how it was installed, the settings check,
what it is signed in with (labels only), whether free models are on and
whether its sessions get the QA browser.

### Google Antigravity

Google Antigravity (`antigravity`) is the fifth agent. Nobody installs it:
add it and sign it in on the computer.

```sh
konteks-remote agent add antigravity      # asks before downloading from Google
konteks-remote auth login antigravity     # a Gemini API key or Gemini Enterprise
```

`agent add antigravity` (or `install --agents ...,antigravity`) shows this
question and downloads only on your yes (`--yes` is that yes given up front,
by you; without a terminal and without `--yes` nothing is downloaded):

> Konteks will download Google Antigravity from Google's server
> (dl.google.com, about 110 MB, 400 MB on disk), check Google's signature, and
> keep it updated with Konteks updates. Google's terms apply to its use
> (antigravity.google/terms). Download it now? [y/N]

The connector then downloads Google's official Antigravity ACP server (never
the `agy` CLI, and never a copy the Antigravity app or an editor downloaded)
while the connector keeps running, checks it against the exact version, sizes,
hashes and Google signature this Konteks release pins, keeps it in the
connector's own folder, and checks it again before every start. It needs about
1.5 GB free to download. Only macOS on Apple silicon is supported for now;
elsewhere the command says "Google Antigravity is not available for this
computer yet." before asking anything. Running `agent add antigravity` again
downloads a copy that no longer matches Google's release. Onboarding never
finds it on its own (the Antigravity app and the `agy` CLI are other
products); with no other agent it offers it in one line.

Until you add it, Konteks shows it as "Not added" with that command
(Customize, Runtimes), and "Downloading" while `agent add` fetches it;
`konteks-remote agents` says the same.

Updates: when a Konteks update pins a newer Google Antigravity, the connector
downloads it in the background on your first yes, checks it, runs its start
check, switches to it and deletes the old version; if that fails, the old
folder stays, it is tried again, and `doctor` says why.
`konteks-remote agent remove antigravity` asks once, stops the connector,
signs Antigravity out, deletes its download and its sign-ins on this computer,
and starts the connector again; your other agents are untouched. Uninstalling
the connector removes it too. It runs with a scrubbed environment and a private home: never your
`GITHUB_TOKEN`, Gemini or Google Cloud variables, provider keys, `~/.gemini`,
the Antigravity app or your macOS keychain. Before it starts, the connector
checks that the server answers as the version it knows. Every session keeps
subagents and image tools off, stays in the mode that asks before commands and
edits, and gets your repository's `AGENTS.md` in its first prompt (Google's
server does not read it). At most two Antigravity sessions run at once on a
computer.

Sign it in on the computer with `konteks-remote auth login antigravity`:

- **Gemini API key** (`--api-key`): paste a key from
  https://aistudio.google.com/apikey into the hidden prompt. Konteks checks it
  with Google and keeps it only on this computer; Google Antigravity itself
  never sees it (a relay on this computer adds it to each request to Google).
  Google bills its use to your key; Konteks shows each turn's cost estimated at
  Google's list price.
- **Gemini Enterprise** (`--enterprise --project <project id> [--location
  global|us|eu]`, or from Konteks: Customize, Runtimes, Google Antigravity):
  sign in with Google in the browser on this computer, then confirm your
  licence on the page that follows. Your Google Cloud admin must set Terminal
  auto-execution to Require review. If Google finds no licence for the
  project, turn on the Business AI Code API
  (`gcloud services enable businessaicode.googleapis.com --project <project id>`)
  and sign in again.

Signing in with a personal Google account is not offered.
`konteks-remote auth logout antigravity [--api-key | --enterprise]` signs out.

Every command, file change, web fetch and tool call it asks for goes through
the same Konteks checks as the other agents: no `git push` or `sudo`, no
changes outside the working copy, only Konteks' own tools, never "always
allow". Your repository cannot switch its hooks on (Konteks always answers
"Don't trust"), and subagents stay off. If Antigravity ever runs something
without asking, the connector stops it and takes it out of service until you
restart the connector; on Gemini Enterprise that usually means your
organisation's Terminal auto-execution setting is not Require review, and the
message says so. Its `/plan` and `/logout` commands are not available.

Behind a proxy, both the download and the Gemini API key relay honour
`HTTPS_PROXY` (or `ALL_PROXY`) and `NO_PROXY` from the connector's own
environment.

`doctor` shows its version (pinned by this Konteks release), that it was
downloaded from Google with its signature checked, the start check, what it is
signed in with (labels only, never the project or a key, and the Business AI
Code API command when Google found no licence), the disk it uses, and whether
its sessions get the QA browser; after an unasked command on Gemini Enterprise
it names the "Terminal auto-execution: Require review" setting, and when your
organisation's MCP Servers setting dropped Konteks' tools it says "Konteks
tools unavailable: turn on MCP Servers in Gemini Enterprise settings".

Pi is no longer supported: `install --agents` and `agent add` refuse it, and
an installation that still lists it keeps working without it (the connector
log says it was skipped). An installation from before 7.0.0 that listed the
old bundled OpenCode now reads it as your own OpenCode 2.
The Docker Compose remote
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
gate's three-minute deadline. A bundled agent the new release cannot start
is listed as unavailable with the reason, so the gate decides at once and,
when that agent worked before, rolls back naming it. `update` and
`update --check` say when the connector updated itself, and when a release
already failed here; a second `update` while one is still downloading says so.
An update that stops the connector but cannot go ahead starts the same
release again and says once it answers. While the new release is being
checked it takes no new work. The running release keeps `konteks-remote`
itself on its own version, whichever `konteks-remote` ran the update.

On macOS and Windows the connector logs to `logs/connector.log` in its
folder, from its first line (on Windows the file is kept under 20 MB at each
start); on Linux, to the user journal. When the connector is not running,
`doctor` and `support` show the last failed start and the log's last lines. A release that finds its service still loaded with an
older definition (for example one that sent its output nowhere) has the
service manager reload it and restart once, so an updated connector keeps
logging where it did.

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
tarballs. A development branch may link a sibling contracts checkout instead;
CI then points those links at `vendor/` first
(`scripts/ci-vendored-contracts.mjs`, never committed). Releases are produced
by the `release` workflow on a `v*` tag; see
`.github/workflows/release.yaml` for the platform matrix and the signing
inputs.

### Every agent on every OS

The `agent-os-proof` workflow runs each agent (Claude Code, Codex, DeepSeek
Harness, OpenCode) on macOS, Linux (x64 and arm64) and Windows, installed the
way its own docs say, through the connector's own code
(`scripts/agent-os-proof.mjs`): finding it, its private home, the start
self-check, ACP `initialize` and `session/new`, model discovery, and a
governance probe driven by a scripted model (no credential needed): an
allowed command, the agent's environment, a write inside and outside the
working copy, `git push`, `sudo` (on Windows an elevation), the Konteks result
tool, all in a repository that carries every agent's own "ask nothing" config.
Fake credentials set in the job (`GITHUB_TOKEN`, provider keys) must never
reach an agent process. One real turn runs when a key is set as a repository
secret (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`; OpenCode
uses Zen's free model and needs none); otherwise it is reported as not proven.
Run one agent locally with
`node scripts/agent-os-proof.mjs --agent opencode --out result.json` after
`npm run build`.

## License

Copyright 2026 Konteks. Licensed under the Apache License, Version 2.0; see
`LICENSE`. Third-party components and adapted code are listed in
`THIRD_PARTY_NOTICES.md`.
