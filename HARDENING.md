# Hardening rules

These rules keep this repository small, predictable and true to its code.
They apply to every change, by people and agents alike. A change that breaks
one is not finished.

## Standing rules

1. **No dead code.**
   - Delete what no production path reaches: unused exports, functions,
     files, branches, flags, config keys, routes, scripts and dependencies.
   - Code reached only by its own tests is dead. Delete it together with
     those tests.
   - Before deleting, prove there is no consumer: Graft `callers` plus a
     search of the repositories that import this one.
2. **Cyclomatic complexity of 8 at most** per function and method, enforced
   by the ESLint `complexity` rule as an error.
   - Split by responsibility: early returns, lookup tables, small named
     helpers.
   - Never with `eslint-disable`.
3. **Reusable code, within its domain.**
   - One well-named function, hook or module does a job that several places
     need.
   - Reuse stays inside its domain. Cross-cutting needs (errors, ids, time,
     logging) use the repository's existing shared module or `@konteks/*`.
   - No catch-all utils module, and no abstraction for a single caller.
4. **The code is the source of truth.**
   - Markdown is limited to `README.md`, `AGENTS.md`, `CLAUDE.md`,
     `CHANGELOG.md`, this file and API specs.
   - Proofs, plans, contracts, reports and journals do not live in the
     repository.
5. **Coherence: the code wins.**
   - No stale references in comments.
   - When a comment and the code disagree, fix the comment, never the
     behaviour.
   - Comments describe today's code, not its history.
   - Names say what things do now.
6. **Design patterns where they make the code more predictable.**
   - Use strategy or lookup table, adapter, repository, factory or a small
     state machine when it clarifies the shape.
   - Solve the same problem the same way across the repository, preferring
     the pattern it already uses.
   - No ceremony.

## What a change must not break

- **Contracts:** HTTP routes and their shapes, wire schemas, CLI commands,
  and config keys still read in production.
- **Migrations:** applied migrations are never edited, renamed or deleted.
- **Tests:** a live path's tests may be simplified, never removed.

## Graft (required before relying on the graph)

- **Wrapper:** use the repository's own wrapper, `./scripts/hardening/graft`.
  It pins this repository's `graft/` index and keeps telemetry off.
- **Freshness:** run `./scripts/hardening/graft check`. If the index is
  stale, run `./scripts/hardening/graft build`, without `--deep`.
- **Queries:**
  - `callers <symbol>`: who uses a symbol. Tests count as callers, so a
    symbol with only test callers is dead.
  - `map`: hotspots.
  - `grep <regex>`: matches grouped by enclosing symbol.
  - `skeleton <file>`: a file's API surface.
  - `blast`: what a diff touches.
- **Trust:** verify graph claims against the source. A fresh partial graph is
  not complete usage evidence.
- **Index:** `graft/` is generated and untracked. Rebuild it after large
  deletions or moves.

## Checks

CI (`.github/workflows/ci.yaml`) is the gate. Run the same commands locally
from the repository root:

- **Lint:** `npm run lint` (ESLint over `packages/*/src`, with
  `complexity: ["error", 8]` in every package). The only rule exception is
  `no-control-regex`, scoped in `eslint.config.js` to the five files that
  strip or refuse terminal escapes and control bytes on purpose.
- **Script complexity:** `npm run lint` does not cover `scripts/`; check it
  with `npx eslint --no-config-lookup --rule '{"complexity":["error",8]}' scripts`.
  Three functions stay above 8 because the bridge patches inline their source
  into the pinned bridges (`konteksPrefixedName`, `missingCodexToolTerminals`,
  `konteksAdmittedMcpServerNames`); change them only with a patch review.
- **Typecheck and build:** `npm run typecheck` (`tsc --build`, which also
  emits `packages/*/dist`).
- **Tests:** `npm test` runs the `node --test` script suites, then Vitest.
  On a memory-constrained machine run Vitest with one worker and only the
  files you touched: `npx vitest run --maxWorkers=1 <files>`.
- **Script checks:** `npm run check:agpl`, `npm run check:secret-canary`,
  `sh -n bootstrap/install.sh`.
- **Bridge patch fixtures:** `scripts/claude-acp-settings-patch.test.mjs` and
  `scripts/codex-acp-live-user-patch.test.mjs` also check the pinned bridge
  files when `CLAUDE_ACP_FIXTURE_DIR` / `CODEX_ACP_FIXTURE_DIR` point at
  pristine bridge dists. Their replacement strings, ids and reviewed hashes
  are pinned to upstream text: change comments and surrounding code only.
- **Characterization:** `npm run test:characterization` needs installed agents
  or a Linux host and is opt-in.

Release, bootstrap and install files (`scripts/release*`,
`scripts/build-*.mjs`, `bootstrap/`, `vendor/*.tgz`, `.github/workflows/*`)
are read by CI and by installers on Windows, macOS and Linux: keep their
behaviour and paths. The relay wire protocol, the work protocol with Core,
the integration gate and the supervisor's state files on disk keep their
shape.
