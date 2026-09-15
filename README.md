# konteks-remote

`konteks-remote` is the Konteks native runtime connector. It installs on a
developer's or team's own machine, runs the coding agents that are already
installed there (Claude Code, Codex, OpenCode) under their own subscriptions,
and connects them to a Konteks workspace over an outbound, authenticated
channel. No Docker, no local databases, no provider API keys on the host.

## Install

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
konteks-remote agents
konteks-remote doctor
konteks-remote update --check  # what the stable channel offers
konteks-remote update          # stage, drain, swap, verify; rolls back on failure
konteks-remote stop | start
```

The connector runs as a user service (launchd, user systemd, or Task
Scheduler). It checks the stable channel on its own and applies updates
transactionally: the new release is staged beside the running one, work is
drained, the service is swapped and health-gated, and the previous release is
restored if the gate fails.

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

Copyright © Konteks. Third-party components are listed in
`THIRD_PARTY_NOTICES.md`.
