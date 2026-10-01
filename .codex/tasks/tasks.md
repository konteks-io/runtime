# Task: Migrate the required Ops runtime repairs onto GitHub main

## Goal

Use GitHub `konteks-io/runtime` as the runtime update, push and PR target.
Preserve current GitHub runtime behavior, security boundaries and the existing
dirty E2E runtime checkout. Port the missing Ops repairs, validate focused
regressions serially, and publish a task-branch PR without merge or release.
This migration alone does not prove the Ops-to-Engineering business journey.

## Phase Plan

### Phase 1: Scoped MCP refresh on continued Codex sessions

Status: completed
Repository: runtime-github-ops, branch codex/ops-runtime-github
Confirmed scope: scripts/codex-acp-live-user-patch.mjs and its focused test.
Confirmation source: user selected GitHub as runtime target on 2026-10-01.

Source evidence:

- GitHub main 80a724d includes patch v6 with title and tool-terminal recovery.
- Existing Ops fix fdf29fe refreshes only connector-scoped MCP server names
  on resume; that filter is absent from the GitHub v6 source.
- The upstream artifact is pinned to codex-acp 1.10.0 and its exact SHA256;
  preserve fail-closed version/hash and unique-anchor checks.

Implementation items:

- [x] Add and observe the failing scoped-resume regression.
- [x] Port only the scoped filter, retaining all GitHub v6 functionality.
- [x] Run node --test scripts/codex-acp-live-user-patch.test.mjs serially.

Evidence: worker observed missing-export characterization failure, then 10/10
focused tests passed. Senior exact-diff review and independent same-file test
also passed 10/10 (60 ms). Hash/version gate and newer title/tool-terminal
behavior are unchanged. Post-edit Graft freshness and git diff --check pass.

### Phase 2: Operations carrier compatibility

Status: in_progress
Repository: runtime-github-ops, supervisor assignment/inventory composition.
Confirmed scope: supported work-kind list and signed Ops advertisement.
Confirmation source: existing source fixes 90dcef3 and ffb9434.

Source evidence:

- GitHub supervisor ALL_KINDS omits operations, while preserving onboarding,
  repository_relocation and direct; those newer kinds must not be removed.
- Existing Ops fix ffb9434 spans inventory roles, heartbeat, supervisor,
  orchestrator and ops-role.test.ts. Its current GitHub compatibility needs
  characterization before any port.
- GitHub report-sender already settles native ACP terminal dispositions and
  includes newer conflict recovery; do not replace it with older 31c084a.

Implementation items:

- [ ] Verify required shared contracts and carrier support on GitHub main.
- [ ] Characterize and port only missing compatible Ops carrier behavior.
- [ ] Run affected focused tests serially; preserve permission/owner gates.

Evidence: pending compatibility characterization.

### Phase 3: Publish reviewed checkpoint

Status: pending
Repository: runtime-github-ops, GitHub konteks-io/runtime.
Confirmed scope: non-default branch push and PR to main.
Confirmation source: user explicitly authorized push and PR, GitHub-only.

Source evidence:

- SSH and gh API authenticate as vani-rf.
- GitHub main 80a724d and old branch share merge base 820d193, but differ by
  260 GitHub-only and 615 old-branch-only commits; whole-branch publication
  would include unrelated changes.
- New worktree begins clean at GitHub main; old checkout remains untouched.

Implementation items:

- [ ] Review exact diff, focused test results and Graft freshness.
- [ ] Commit task-owned source/test/plan files only.
- [ ] Push an explicit non-default GitHub ref and create the PR.
- [ ] Verify and attach the PR URL; do not merge/release/deploy.

Evidence: pending.

## Checklist

- [x] Verify GitHub account, fetch latest main, preserve dirty checkout.
- [x] Create isolated GitHub-main-based codex/ops-runtime-github worktree.
- [x] Complete characterized scoped MCP port.
- [ ] Complete characterized Ops carrier compatibility.
- [ ] Publish verified GitHub PR.

## Decisions

- GitHub supersedes Gitea for runtime only. Other repositories are unchanged.
- Maximum two workers; serialized focused tests, no broad suite/install wave.
- Do not weaken runtime identity, signed-artifact or permission checks.
- Preserve the active E2E occurrence, estimate and installed bundle.

## Evidence

- GitHub main: 80a724defb0fb44c2690004c4be888159b9c3255.
- Original runtime HEAD: 1ef7eb803b2cae0c9e919b04cbc544668f12716b.
- Existing GitHub PRs #21 and #14 are separate work, not this migration.
- 2026-10-01 scoped MCP checkpoint: patch v7; focused tests 10/10;
  exact diff and Graft freshness pass. No release build/installation or
  end-to-end recovery is claimed from this unit proof.

## Closeout

Open. No PR, deployment, costed proposal or end-to-end completion is claimed.
