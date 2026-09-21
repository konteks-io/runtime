## User-approved C00 closeout — 2026-09-21

C00 is closed as a user-accepted partial hardening phase; finish only already-active bounded cycles and defer the rest. This directive supersedes conflicting C00 instructions below or in nested guidance. C01 observability (also called C001) may start without completing C00 H01–H10. Repository-wide complexity <=5, exhaustive dead-code/docs audits, Graft setup/freshness, and C00-specific gate/evidence completion are deferred maintenance requirements, not prerequisites for C01. Do not restart hardening or block stabilization on these requirements. Preserve ordinary correctness, security, type/build and focused behavior checks for stabilization changes; retain honest failures and deferred-work evidence. Existing code and tests must not be removed merely to pass a gate. Coordinate ownership handoff before editing files still held by closing workers.

# C00 hardening policy

This repository participates in the ACP C00 hardening gate. Before editing,
read this policy and any applicable nested instructions. Use the pinned Graft
wrapper to inspect the affected subsystem and consumers, then verify its graph
claims against source:

```text
./scripts/hardening/graft build
./scripts/hardening/graft check
```

Keep current documentation and comments accurate. Label proposed requirements
and historical evidence; do not present them as implemented behavior. Prove
cross-repository and dynamic reachability before removing code or tests, and
retain meaningful regression coverage and supported public compatibility.

Every maintained function, method, callback, test helper, and executable
script must have cyclomatic complexity at most five. Characterize existing
behavior before refactoring. Do not weaken checks, add suppressions, or hide
branches to evade the rule.

After a change, run the repository hardening checks and affected consumer
tests, refresh Graft, and report exact results and limitations. A missing tool,
skipped suite, stale graph, or incomplete parser coverage is a failed gate.
