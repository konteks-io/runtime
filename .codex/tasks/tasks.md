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
Repository: runtime-github-ops, branch feat/ops
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

Status: completed
Repository: runtime-github-ops, supervisor assignment/inventory composition.
Confirmed scope: supported work-kind list and signed Ops advertisement.
Additional characterized scope: native/execution-gate.ts exact assignment
source/kind matching; Operations must use the existing conversation carrier.
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

- [x] Verify required shared contracts and carrier support on GitHub main.
- [x] Characterize and port only missing compatible Ops carrier behavior.
- [x] Run affected focused tests serially; preserve permission/owner gates.

Evidence: source review confirms shared 7.2 Operations uses the existing
conversation source. continuedSession already recognizes it, while isNativeTurn
does not. That predicate owns signed NativeExecutionGate admission and native
end_turn behavior. Graft callers verifies RelayedSession gate creation,
authorized dispatch, runner-event and prompt-result consumers. Operations
must be added there, not implemented as a new source kind.

2026-10-01 characterization: new ops-role.test.ts failed 9/9 before product
edits because operationsCarrierReady is missing. Four other focused files
initially could not import the unbuilt remote-common entry. A narrow common
workspace build exited 1 at control-socket.ts:468: the sibling contract's Zod
4.6.5 schema is incompatible with this runtime's pinned Zod 4.4.3 types.
`npm ls zod --depth=1` proves the sibling resolves its own existing Harness
Zod dependency. This is a local dependency-layout/build blocker, not an Ops
assertion failure or permission to weaken schemas. Preserve sibling state.

After the narrow TypeScript commands emitted local dependency entries (while
still failing their build checks), direct-work passed 2/2 and native execution
gate ran 52 tests: 51 passed, the new Ops prompt case failed execution_fenced.
SourceMatches accepts assistant_execution/conversation and direct/direct_session
but omits operations/conversation. Senior authorized only that exact pairing,
with unchanged signature, permit, identity and session fences; regression
rerun and negative mismatched-source coverage are required before checkpoint.

Compatibility decision: require the signed desired Core contract version >=7.2
before offering Operations. Advertisement and claim-time role checks must
share that version gate plus healthy agent_runner/execution-permit capability
proof. Preserve current code-validation QA, git-version-gated onboarding,
direct work, previews, scoped MCP facade and terminal recovery. Characterize
old/missing version, unhealthy/missing permit carrier, unavailable bound agent,
unsigned Ops prompt rejection and admitted end_turn closure before publication.

### Phase 3: Preserve the controller-owned signed local update path

Status: completed
Repository: runtime-github-ops, launcher E2E smoke CLI and its focused test.
Confirmed scope: packages/launcher/src/e2e/smoke-cli.ts and
packages/launcher/src/__tests__/e2e-smoke-update-cli.test.ts.
Confirmation source: user authorized runtime update for this local validation.

Source evidence:

- E2E UpdateNativeConnector uses update-stage, update-drain,
  update-drain-cancel, update-commit and update-restore on the selected source.
- KONTEKS_E2E_RUNTIME_SOURCE_ROOT accepts an absolute isolated checkout path;
  this preserves the current dirty source and installed runtime identity.
- GitHub smoke CLI lacks the bounded phases; prior verified fix 1ef7eb8
  supplies them. Adapt to current GitHub APIs, not an entire older file.
- Controller requires signed stage before drain, exact predecessor identity,
  observed stop, same-identity health and signed rollback on failed update.

Implementation items:

- [x] Characterize missing test-only update phases.
- [x] Port bounded phases with E2E-only gates and current signed update APIs.
- [x] Run the focused launcher test serially and review identity/restore fences.

Evidence: E2E CLI gate/path characterization passed 2/2; senior focused
native-update.test.ts passed 35/35. Launcher build passed. Exact diff confirms
the CLI delegates signed stage/commit/restore to existing update primitives.
No connector update/drain/restart is performed in this phase.

2026-10-01 test preparation: one dependency install completed successfully
with `npm ci --ignore-scripts --no-audit --no-fund` (186 packages). The Ops
worker holds the first serial focused-test lane; the launcher worker waits.
No install scripts, service restart, signed update or broad suite was run.
Resource snapshot: 8,286 MiB available RAM, 512 MiB free swap and 12 GiB free
disk. Keep tests/builds serial; dependencies alone are not behavior evidence.

### Phase 4: Publish reviewed checkpoint

Status: completed
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

- [x] Review exact diff, focused test results and Graft freshness.
- [x] Commit task-owned source/test/plan files only.
- [x] Push an explicit non-default GitHub ref and create the PR.
- [x] Verify and attach the PR URL; do not merge/release/deploy.

Evidence: 8de75177e69ca249378ff961fd8d10b42d848b6d pushed explicitly to
GitHub feat/ops; PR #24 verified OPEN, draft, base main and exact head.
GitHub CI run 36890971311 is pending, not a claimed pass.

Build-unblock scope confirmed 2026-10-01: native/activation.ts and its focused
native-activation.test.ts only. Shared RemotePlatformSchema accepts generic
linux wire OS, but GitHub native API/release target matrix declares macos,
windows, debian. nativePlatform('linux') intentionally returns debian, and the
existing native-service test verifies that Linux host mapping. Explicitly
reject out-of-matrix enrollment OS before reading a code or creating private
state; preserve Linux-host/debian behavior, signed artifacts and lineage.
Characterize the rejection first; no casts or broad platform migration.

## Checklist

- [x] Verify GitHub account, fetch latest main, preserve dirty checkout.
- [x] Create isolated GitHub-main-based worktree (now branch feat/ops).
- [x] Complete characterized scoped MCP port.
- [x] Complete characterized Ops carrier compatibility.
- [x] Complete characterized controller-owned E2E signed update compatibility.
- [x] Publish verified GitHub PR.

## Decisions

- GitHub supersedes Gitea for runtime only. Other repositories are unchanged.
- User requested feature naming: branch feat/ops and PR title
  feat(runtime): Operations mode support. GitHub branch rename automatically
  closed the old head's PR #22; replacement draft PR #24 is open, targets main
  and preserves exact checkpoint be64f12. The older local feat/ops ref at
  46cda86 is preserved as archive/feat-ops-before-github-20261001.
- Maximum two workers; serialized focused tests, no broad suite/install wave.
- Do not weaken runtime identity, signed-artifact or permission checks.
- Preserve the active E2E occurrence, estimate and installed bundle.

## Evidence

- 2026-10-01 checkpoint review: launcher TypeScript build exited 0 after the
  narrow parsed-OS guard. Independent native execution-gate test passed 53/53;
  native-update test passed 35/35. Scoped ESLint and diff check passed.
  Graft wiring check passed; optional deep meaning layer remains absent.
  See evidence/runtime-ops-checkpoint-2026-10-01.md. No installed update or
  Engineering proposal recovery is inferred from these source checks.
- 2026-10-01 user clarified the Codex upgrade should be cherry-picked, not
  reimplemented. PR #23 exact head 47859b4 shares base 80a724d. Three source
  commits cherry-picked cleanly with -x onto feat/ops as eed382d, a8a211a,
  4def064. Bundle pin changes only Codex 0.153.4 -> 0.159.0; ACP stays 1.10.0.
  Focused available-commands.test.ts passed 7/7, single worker, 1.42 seconds.
  No installed-artifact, authenticated model or browser success is inferred.
- Local file-dependency isolation (`npm install --install-links --ignore-scripts
  --package-lock=false --no-audit --no-fund`) completed; manifests and lockfile
  unchanged, sibling tree clean. Shared Zod mismatch disappeared on the next
  supervisor build. Two remaining baseline errors concern parsed platform OS
  linux versus the existing macos/windows/debian native API; build still fails.
  Do not deploy emitted output or cast away the platform contract.
- Ops focused proof now totals 81 assertions: role10, work-kinds5, direct2,
  heartbeat11, native gate53. Null is fail-closed. Launcher gates/path2 passed
  after genuine unknown-update-stage characterization. Scoped Ops lint passed.
- Version checkpoint 4def064 is pushed and verified as PR #24 exact head;
  remaining Ops/launcher edits are still local, not installed or published.
- GitHub main: 80a724defb0fb44c2690004c4be888159b9c3255.
- Original runtime HEAD: 1ef7eb803b2cae0c9e919b04cbc544668f12716b.
- Existing GitHub PRs #21 and #14 are separate work, not this migration.
- 2026-10-01 scoped MCP checkpoint: patch v7; focused tests 10/10;
  exact diff and Graft freshness pass. No release build/installation or
  end-to-end recovery is claimed from this unit proof.
- Published checkpoint be64f12 as open draft GitHub PR #22 to main:
  https://github.com/konteks-io/runtime/pull/22. CI run 36885134712 completed
  successfully for exact head be64f129172662e8261a85d948ad25d306bf58ab.
  This proves that checkpoint's CI only, not the pending Ops carrier changes
  or the preserved platform's Engineering proposal/PR journey.
- Current PR after the requested rename: https://github.com/konteks-io/runtime/pull/24.
  Verified OPEN, draft, head feat/ops, base main, head SHA unchanged be64f12.

## Closeout

Source migration checkpoint published through draft PR #24 at 8de7517.
The installed connector is not updated; costed proposal and the complete
Ops-to-Engineering-to-PR journey remain unproved and remain the active parent
E2E goal. A local offline Codex 0.159.0 artifact is being built from this
checkpoint under ignored E2E private state; no public release is authorized.
