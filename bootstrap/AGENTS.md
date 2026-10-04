# Bootstrap installers

## Purpose

The first code a person runs: `install.sh` (macOS, Debian/Ubuntu) and
`install.ps1` (Windows) download, verify and install the connector, then hand
over to `konteks-remote install` or onboarding. `onboarding.md` (for the
person to paste into their agent) and `connect.md` (written for the agent
itself) are product content, copied into every GitHub Release by
`.github/workflows/release.yaml`.

## Entry files

- `install.sh`: `--activation-id <id>`, `--user` (user-local, no sudo),
  `--enroll` (agent-first onboarding), `--version`.
- `install.ps1`: `-ActivationId`, `-Update` (latest MSI on a connected
  computer, then `update` and `start`), `-VerifyOnly` (defines the verifier only, used by the CI test); `-User` / `-Enroll`
  only say the Windows user-local path is not available yet.
- Tests: `scripts/bootstrap-install.test.mjs` (in `npm test`),
  `scripts/test-bootstrap-verifier.ps1` (CI, PowerShell 5.1 and 7).

## Invariants

- **The release key is pinned in both scripts** (`PINNED_RELEASE_PUBKEY` in
  `install.sh`, `$PinnedReleaseKey` in `install.ps1`), never taken from the
  download location. Rotating it changes both scripts in the same release;
  `scripts/bake-bootstrap.mjs` refuses to publish a release signed by another key.
- The repository copy of `install.sh` has empty `BAKED_EXECUTABLE_SUMS` /
  `BAKED_RELEASE_PUBKEY_SHA256`; the release job fills them, so a script
  fetched from a tag installs only that tag's bytes. Do not hand-fill them.
- On Windows the MSI is not Authenticode-signed yet: `install.ps1` trusts it
  only through its own Ed25519 check of the signed `SHA256SUMS`, in plain
  Windows PowerShell 5.1. Keep the script parseable by 5.1 (CI parses it and
  runs the verifier under both shells).
- The activation code is never an argument: only the non-secret activation id
  is passed; the launcher prompts for the code without echo. No general
  command passthrough.
- `install.sh` must pass `sh -n` and `install.sh --version` (CI).
- `onboarding.md` and `connect.md` are read by people and their agents at
  install time: keep commands in them identical to the launcher's real ones
  (`packages/release/src/connector-commands.json`).

## Gotchas

- macOS LibreSSL cannot verify Ed25519; `install.sh --user` then relies on the
  baked digests and says so rather than faking the check.
- Overrides such as `KONTEKS_RELEASE_BASE` and `KONTEKS_RELEASE_PUBKEY_SHA256`
  exist for development (`.env.example`); production values are baked.
