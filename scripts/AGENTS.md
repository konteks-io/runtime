# Build, release and bridge-patch scripts

## Purpose

Node scripts that build the connector and offline agent packages, patch the
Claude and Codex ACP bridges, assemble and sign releases, and run CI helpers
and the agent-on-every-OS proof. Most are called from `.github/workflows/`
(`release/AGENTS.md`).

## Entry files

- Bridge patches: `claude-acp-settings-patch.mjs` (+ `claude-instruction-scope.mjs`,
  copied into the bridge as `konteks-instruction-scope.mjs`),
  `codex-acp-live-user-patch.mjs`, `konteks-session-prefix.mjs`. Applied only by
  `build-offline-agent.mjs`, which writes `konteks/claude-acp-provenance.json`
  and `konteks/codex-acp-provenance.json` into the package.
- Build: `build-launcher.mjs`, `sign-launcher.mjs`, `build-offline-agent.mjs`,
  `build-offline-tool.mjs` (Graft), `offline-agent-files.mjs`.
- Release: `release-assets.mjs` (`stage`, `collect`, `commands`, `verify`,
  `notes`), `native-artifact-index.mjs`, `assemble-release-manifest.mjs`,
  `launcher-checksums.mjs`, `sign-checksums.mjs`, `bake-bootstrap.mjs`,
  `publish-release.mjs`.
- CI: `ci-vendored-contracts.mjs`, `check-agpl.mjs`, `check-secret-canary.mjs`.
- Proof and probes: `agent-os-proof.mjs` (+ `agent-os-proof/` scripted model),
  `probe-*.mjs`, `codex-acp-terminal-reconciliation.integration.mjs`.
- `export-public.mjs`: legacy mirror into a separate public checkout (drops
  every `.md` except `THIRD_PARTY_NOTICES.md`, regenerates the lockfile).
- `hardening/graft`: the pinned Graft wrapper (`HARDENING.md`).
- Tests run by `npm test`: `offline-agent-files`, `codex-acp-live-user-patch`,
  `claude-acp-settings-patch`, `claude-instruction-scope` (+ `.integration`),
  `bootstrap-install` (`*.test.mjs`).

## Invariants

- **Bridge patches are pinned to exact upstream bytes.** Each patch carries an
  `id`, the bridge `version` and the sha256 of every upstream file it edits:
  - Claude: `id: "konteks-claude-project-settings-v5"`, version `0.75.1`,
    `hashes` for `acp-agent.js`, `settings.js`, `session-titles.js`.
  - Codex: `id: "konteks-codex-acp-live-user-v9"`, version `1.10.0`,
    `upstreamSha256` for the bridge entry.
  A mismatch throws ("requires review of this upstream artifact") and every
  anchor must match exactly once. Bumping a bridge in
  `release/native-agent-builds.json` and `packages/release/src/bridges.ts`
  means: read the new upstream files, re-check every anchor and what it
  enforces, then update `version`, the hashes and the `id` together, and
  extend the patch tests. Never relax a hash check to get a build through.
- What the patches enforce is security, not convenience: the Claude bridge
  loads only `settingSources: ["project"]` (none for an integration session),
  `strictMcpConfig`, hooks disabled and claude.ai connectors off
  (`hardenClaudeSession`), and names the tool in
  `toolCall._meta.claudeCode.toolName`; the Codex patch turns the person's and
  trusted projects' MCP servers off per thread and admits only
  `admittedMcpServerNames` for an integration session.
- The Claude bridge prints an `instruction_scope version=N ...` marker that the
  runner parses (`packages/agent-runner/src/bridge/instruction-scope-observer.ts`);
  change both together.
- Patches run at build time only. Never mutate an installed, signed artifact.
- `ci-vendored-contracts.mjs` only rewrites manifests in the CI working tree;
  run it locally only with `--yes`, and never commit the result.
- `bake-bootstrap.mjs` refuses a release whose signing key differs from the
  key pinned in both `bootstrap/install.sh` and `bootstrap/install.ps1`.

## Gotchas

- `agent-os-proof.mjs` covers `claude-code`, `codex`, `dsh` and `opencode`
  only; it needs `npm run build` first, and Claude/Codex also need
  `--package <tgz> --artifact <json>` from a release build.
