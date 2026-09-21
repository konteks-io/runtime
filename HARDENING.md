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

## Agent integration setup

Resolve Graft from PATH (`command -v graft` in POSIX shells, `Get-Command graft`
in PowerShell). MCP launches `graft mcp`; the repository wrapper uses the same
PATH executable. Native init-generated hook helpers use Node/npm package
resolution without a baked machine-specific installation path.

Install the agreed Graft version (currently 0.18.0) with your package manager,
then run `graft init --agents agents claude --no-build --no-global --no-statusline`
for repository wiring. Preserve other hooks/MCP servers. Keep telemetry disabled,
`GRAFT_NO_REFRESH=1` on hooks/MCP, and Graft's Stop hook disabled so freshness
build/check remains explicitly scheduled. Reapply these settings after init;
set generated helpers' BAKED fallback to null to keep installation paths portable.
