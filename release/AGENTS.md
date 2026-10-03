# Releases, pins and CI

## Purpose

How a runtime release is built, signed and published, and which pins a
release carries. Covers `release/`, `packaging/`, `packages/release/` and
`.github/workflows/`.

## Entry files

- `release/native-agent-builds.json`: Node version, the Claude Code and Codex
  bridge + tooling versions packed into offline agent packages, Graft, and the
  Playwright MCP browser.
- `release/release-policy.json`: protocol range, manifest validity, minimums
  (launcher, Node, memory, disk, OS) and rollback data compatibility; read by
  `scripts/assemble-release-manifest.mjs`.
- `packages/release/src/bridges.ts`: `SUPPORTED_AGENT_BRIDGES` (Claude Code,
  Codex) and `HOST_AGENT_BRIDGES` (dsh, OpenCode, Antigravity: supported
  version ranges and install commands).
- `packages/release/src/fetched-agents.json`: the Antigravity zip pin per
  platform (URL, size, sha256 of the zip and each file, signer).
- `packages/release/src/connector-commands.json`: the commands the connector
  reports to Core and ships as `commands.json`.
- `packaging/debian/control`, `packaging/windows/launcher.wxs`: installer packages.
- `.github/workflows/release.yaml`, `ci.yaml`, `agent-os-proof.yaml`.

## Invariants

- **A `v*` tag is the release.** Pushing `vX.Y.Z` (or `vX.Y.Z-pre`) runs
  `release.yaml`: a build matrix (macOS arm64/amd64 `.pkg`, Windows x64
  `.msi`, Debian amd64/arm64 `.deb`) builds and signs the launcher and stages
  offline agent packages; the release job assembles the native manifest
  (`bundleVersion` = tag without `v`), signs it with `RELEASE_SIGNING_KEY_JWK`,
  verifies it against `KONTEKS_RELEASE_ROOTS_JSON`, writes and signs
  `SHA256SUMS`, bakes `install.sh`, writes `commands.json`, runs
  `release-assets.mjs verify` and creates the GitHub Release. Assets are
  immutable per tag; `releases/latest` is the stable channel.
- The job refuses to run without `KONTEKS_RELEASE_ROOTS_JSON` certifying at
  least one Core control key, `KONTEKS_AGENT_REDISTRIBUTION_APPROVAL_REF`,
  `RELEASE_SIGNING_KEY_JWK` and `RELEASE_KEY_ID`. A connector built without
  roots verifies nothing.
- **Core pins target and minimum separately.** Production Core does not follow
  `latest`; it pins `REMOTE_INSTANCE_TARGET_BUNDLE` and
  `REMOTE_INSTANCE_MINIMUM_BUNDLE` (in Core's helm values). A new release moves
  only the target; the minimum rises later, once no live runtime is below it.
  A runtime below the minimum gets `update_required` and is forced to update
  (`packages/supervisor/src/control/handlers.ts`,
  `mayUpdateWithoutAcceptedRelease` in `packages/supervisor/src/native/update.ts`).
  Procedure: `ci-cd/RELEASE_PROCEDURE.md` (Stage 4, step 7).
- **Pins that move together.**
  - Claude/Codex bridge version: `native-agent-builds.json`, `bridges.ts` and
    the patch script's `version` + hashes (`scripts/AGENTS.md`).
  - Playwright MCP: `native-agent-builds.json` `browser` and
    `BROWSER_MCP_PACKAGE` in `packages/release/src/browser.ts`.
  - The Antigravity pin is bundled into the connector executable, so only a
    runtime release changes it; only `darwin-arm64` is pinned so far.
- `connector-commands.json` must match the launcher's command table
  (`packages/launcher/src/__tests__/connector-commands.test.ts`);
  `release-assets.mjs commands` writes it and `verify` requires it.
- **CI.** `ci.yaml` runs on pull requests and pushes to `main`: lint,
  typecheck, test, AGPL and secret-canary checks, bootstrap syntax checks, and
  Windows jobs (Ed25519 verifier in PowerShell 5.1 and 7, service and process
  tests). Every job runs `scripts/ci-vendored-contracts.mjs` before `npm ci`.
- `agent-os-proof.yaml` (manual, or pushes to `chore/quality-assurance`
  touching runtime paths) runs `scripts/agent-os-proof.mjs` per agent and OS.
  An agent is enabled on an OS only when its job there passes.

## Gotchas

- `scripts/ci-vendored-contracts.mjs` refuses to run outside CI unless given
  `--yes`, and then dirties `package.json` files: never commit that result.
