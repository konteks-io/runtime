Follow [HARDENING.md](HARDENING.md): Graft freshness remains required; broader C00 cleanup is deferred.

# Runtime repository guidance

## What this repo is

The native BYOA connector (`konteks-remote`, public repo `konteks-io/runtime`):
installer, launcher, supervisor, ACP bridges, local agent discovery, workspace
management and signed release artifacts. It runs on a person's own computer,
talks outbound to Core (HTTP) and the relay (WebSocket), and drives the local
agents (Claude Code, Codex, DeepSeek Harness `dsh`, OpenCode 2, Google
Antigravity) over ACP. Shared wire contracts come from the sibling `packages`
repo (`@konteks/agent-core`, `@konteks/backstage-plugin-common`).

## Map

- `packages/common/`: shared primitives (logger, Ed25519/JCS, process spawn and
  retained owners, secret files, HTTPS proxy tunnel, Git for Windows lookup).
- `packages/release/`: release model: bridge registry (`src/bridges.ts`),
  signed native manifest and roots, fetched-agent pins
  (`src/fetched-agents.json`), connector commands (`src/connector-commands.json`),
  release CLI (`src/cli.ts`).
- `packages/sysmon/`: host resource signals.
- `packages/agent-runner/`: one process per agent; ACP bridge spawn, host-agent
  adapters, sign-in flows, session manager. See `packages/agent-runner/AGENTS.md`.
- `packages/supervisor/`: the daemon (`src/daemon.ts`, `src/supervisor.ts`): Core
  client, relay, work orchestrator, sessions and tool policy, previews, browser,
  structured results, updates, doctor. See `packages/supervisor/AGENTS.md`,
  `packages/supervisor/src/session/AGENTS.md`, `packages/supervisor/src/integration/AGENTS.md`.
- `packages/launcher/`: the `konteks-remote` CLI (`src/cli.ts`, `src/native/`):
  install, onboard, agent add/remove, service definitions, update transaction.
  See `packages/launcher/AGENTS.md`.
- `scripts/`: release and build tooling, the Claude/Codex bridge patches, CI
  helpers, the agent-on-every-OS proof. See `scripts/AGENTS.md`.
- `bootstrap/`: `install.sh`, `install.ps1` and the agent-facing
  `onboarding.md` / `connect.md` shipped with every release. See `bootstrap/AGENTS.md`.
- `release/`: build pins (`native-agent-builds.json`) and `release-policy.json`;
  with `packaging/` (Debian control, WiX `launcher.wxs`) and
  `.github/workflows/` it makes a release. See `release/AGENTS.md`.
- `vendor/`: the `@konteks` contract tarballs CI and releases install.

## Commands

Node 22 (`.nvmrc`; CI and releases use 22.23.2). From the repo root:

- Install: `npm ci` (CI first runs `node scripts/ci-vendored-contracts.mjs`, see Guardrails).
- Build: `npm run build` (`tsc --build`). Clean: `npm run clean`.
- Typecheck: `npm run typecheck`. Lint: `npm run lint`. Format: `npm run format:check`.
- Test: `npm test` (node:test over `scripts/*.test.mjs`, then `vitest run`).
- Focused test: `npx vitest run --project unit <path/to/file.test.ts>`; one
  package: `npm test -w packages/<name>`.
- Characterization (needs installed agents or Linux): `npm run test:characterization`.
- Full CI gate: `npm run ci:check` (lint, typecheck, test, `check:agpl`, `check:secret-canary`).
- Release CLI: `npm run release:manifest -- <command>` (e.g. `keygen`, `sign-native`, `verify-native`).

## Guardrails

- **Source of truth.** Build, test, package and repair the runtime only here,
  never from the sibling `remote-instance` repo (history only). Protocol names
  (`remote-instance`, `/api/remote-instances`, `konteks-remote`, manifest
  `kind: "connector"`, service label `dev.konteks.remote.<hash>`) are stable;
  do not rename them.
- **Connector file name.** The release file is `konteks-connector(.exe)`
  (`NATIVE_CONNECTOR_FILE`, `packages/release/src/native.ts`). Never hard-code
  it: resolve with `resolveNativeConnectorExecutable` (`packages/launcher/src/native/commands.ts`),
  which also accepts the pre-rename `connector`.
- **Native only.** The supervisor accepts only
  `SUPERVISOR_DEPLOYMENT_KIND=native_connector` and runners only
  `agent_local_subscription`. Do not reintroduce Compose, images,
  `gateway_keyed` or a local component server.
- **Pi is retired.** Installs and `agent add` refuse it with
  `retiredAgentMessage` (`@konteks/backstage-plugin-common`); a stored record
  naming it still loads without it (`parseNativeRuntimeRecord`).
- **Core contract gating.** New wire fields and work kinds go only to a Core
  that signs `coreContractVersion` high enough into the desired configuration
  (`coreContractAtLeast`; `direct` from 7.1, `integration` from 7.3 in
  `packages/supervisor/src/work/accepted-kinds.ts`). Never infer it from
  another field; an older Core refuses a pull naming an unknown kind.
- **Vendored contracts.** Workspaces link `file:../packages/...`; the root
  `konteksContracts` names the version of `vendor/konteks-*-<ver>.tgz`, and CI
  and `release.yaml` run `scripts/ci-vendored-contracts.mjs` to point the links
  at those tarballs before `npm ci`. Refresh: `npm pack` each contract package
  from the built `packages` checkout into `vendor/`, delete the old tarballs,
  bump `konteksContracts`; never regenerate the whole lockfile.
- **Releases are tag-driven.** Pushing a `v*` tag (`vX.Y.Z`) runs
  `.github/workflows/release.yaml`, which builds, signs and publishes an
  immutable GitHub Release; `releases/latest` is the stable channel every
  connector follows. Details: `release/AGENTS.md`.
- **Bridge patches need review on every bump.** The Claude and Codex ACP
  bridges are patched at build time against pinned upstream hashes
  (`konteks-claude-project-settings-v5` in `scripts/claude-acp-settings-patch.mjs`,
  `konteks-codex-acp-live-user-v9` in `scripts/codex-acp-live-user-patch.mjs`).
  A bridge version bump must re-review the upstream files and update id,
  version and hashes together. Details: `scripts/AGENTS.md`.
- **Core moves only the target, never the minimum, on a release.** Core's
  `version_policy` carries `targetBundle` and `minimumSupportedBundle`; a
  runtime below the minimum is refused and forced to update
  (`packages/supervisor/src/control/handlers.ts`, `native/update.ts`). Raising
  the minimum together with the target cuts off every live older runtime; the
  two-step pin is in `ci-cd/RELEASE_PROCEDURE.md` (Stage 4, step 7).
- **Release channel overrides are per process.** Test overrides
  (`KONTEKS_RELEASE_MANIFEST_URL`, `NODE_EXTRA_CA_CERTS`) go on ONE process;
  never `launchctl setenv` or a shell profile, which silently points the
  owner's real connector at a dead local channel. `status` and `doctor` report
  an active override.
- **No AGPL code, no secret literals.** `scripts/check-agpl.mjs` refuses
  Shellular (AGPL-3.0) code (design reading only, see `THIRD_PARTY_NOTICES.md`);
  `scripts/check-secret-canary.mjs` refuses canary markers and credential-shaped
  literals in anything that ships. Agent keys are never an argument, event or
  log line (`packages/agent-runner/AGENTS.md`).
- **Tests.** Before a production change, add or update a focused
  characterization test and observe its failure or baseline. Run focused tests
  serially; never several Vitest processes or a whole suite during local proof
  work unless asked.

## Where to look

- The Graft graph (below) for any "where/how/who calls" question.
- `HARDENING.md`: maintenance policy (Graft freshness).
- `README.md`: install, day-to-day commands, agent setup, release trust.
- Nested `AGENTS.md` files listed in the Map.
- No HTTP API spec lives here: wire contracts are in the sibling `packages`
  repo; the connector's own command list is `packages/release/src/connector-commands.json`.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `./scripts/hardening/graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `./scripts/hardening/graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `./scripts/hardening/graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `./scripts/hardening/graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `./scripts/hardening/graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `./scripts/hardening/graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `./scripts/hardening/graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
