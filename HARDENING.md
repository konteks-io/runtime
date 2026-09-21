# Maintenance policy

Broad C00 hardening is deferred and does not block ACP stabilization. This policy
supersedes older C00-wide gates in agent guidance; ordinary correctness, security,
build/type and affected-behavior checks remain required.

## Graft freshness — required

Use the repository's pinned wrapper. Before relying on the graph, run
`./scripts/hardening/graft check`; if missing or stale, run
`./scripts/hardening/graft build` and check again. Inspect affected dependencies
and verify graph claims against source. After edits, rebuild as needed and require
a successful freshness check before reporting the change complete. Report parser
or indexing gaps explicitly; a fresh partial graph is not complete usage evidence.
Keep the generated graph cache untracked and use the shared verification scheduler
for graph operations. If tooling is blocked, continue independent work but report
freshness as unverified rather than claiming success.

Keep affected docs/comments accurate, prove supported consumer reachability before
deleting code/tests, and preserve meaningful regression coverage. Repository-wide
complexity cleanup, exhaustive audits and full C00 qualification remain deferred.
