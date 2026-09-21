## User-approved C00 closeout — 2026-09-21

C00 is closed as a user-accepted partial hardening phase; finish only already-active bounded cycles and defer the rest. This directive supersedes conflicting C00 instructions below or in nested guidance. C01 observability (also called C001) may start without completing C00 H01–H10. Repository-wide complexity <=5, exhaustive dead-code/docs audits, Graft setup/freshness, and C00-specific gate/evidence completion are deferred maintenance requirements, not prerequisites for C01. Do not restart hardening or block stabilization on these requirements. Preserve ordinary correctness, security, type/build and focused behavior checks for stabilization changes; retain honest failures and deferred-work evidence. Existing code and tests must not be removed merely to pass a gate. Coordinate ownership handoff before editing files still held by closing workers.

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

## C00 hardening

Read and follow [HARDENING.md](HARDENING.md) before maintenance work. Its
pinned Graft workflow and complexity, documentation, deletion-proof, and
verification requirements are mandatory.
