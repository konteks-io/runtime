# Runtime repository guidance

This repository is the canonical implementation source for the customer-owned
native BYOA runtime: installer, launcher, supervisor, ACP bridges, local agent
discovery, workspace management, and signed release artifacts.

The sibling `remote-instance` repository contains architecture, amendments, and
historical proof records only. Never implement, build, test, package, publish,
deploy, or repair the runtime from that checkout. When local E2E needs source
artifacts, it must use this repository. Product/API identifiers such as
`remote-instance`, `/api/remote-instances`, and the `konteks-remote` command are
stable protocol and user-facing names; do not rename them merely because the
source repository is named `runtime`.

Preserve the native-only architecture: this machine runs the connector, ACP
bridges, local agents, and their local authentication. Harness, Validation
Runtime, Assistant, and ai-manager remain cloud services. Reliability and
performance are the primary design constraints. Prefer durable, bounded,
observable recovery and simple ownership over extra coordination layers.

Before production changes, add or update a focused characterization test and
observe its failure or baseline. Run focused tests serially; do not start
multiple Vitest processes or a whole suite during local proof work unless the
user explicitly requests it. Preserve unrelated worktree changes and commit
coherent verified checkpoints.

## Maintenance

Follow [HARDENING.md](HARDENING.md): keep Graft fresh before graph use and
after edits; broader C00 cleanup is deferred.

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
