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
konteks-remote update --check  # what the stable channel offers
konteks-remote update          # stage, drain, swap, verify; rolls back on failure
konteks-remote stop | start
konteks-remote uninstall       # finish running work, remove this runtime from its workspace, delete the connector
```

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
