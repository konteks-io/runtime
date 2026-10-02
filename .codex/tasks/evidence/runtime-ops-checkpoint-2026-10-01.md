# Runtime Ops source checkpoint — 2026-10-01

Repository: runtime-github-ops; branch feat/ops; base GitHub main 80a724d.
Scope: Operations work-kind/version gating, ready permit-capable role
advertisement, signed conversation-turn admission, controller-only local
update phases, and a characterized native release-matrix guard.

## Verified checks

- Worker characterization: Ops role 9/9 failed before implementation;
  native Ops prompt failed execution_fenced before exact conversation pairing.
- Focused worker checks: Ops roles 10/10, supported work kinds 5/5,
  direct work 2/2, heartbeat 11/11, native execution gate 53/53.
- Native activation 16/16; Linux host-to-Debian mapping 16/16 unchanged.
- E2E update CLI 2/2: gate and fixed private path/symlink refusal.
- Senior independent native-execution-gate.test.ts: 53/53, 2.00 seconds.
- Senior independent native-update.test.ts: 35/35, 2.60 seconds.
  An initial invocation rejected unsupported --minWorkers before test execution;
  corrected command used --maxWorkers=1. No broad suite ran.
- npm run build --workspace @konteks/remote-launcher: exit 0, tsc --build.
- Scoped ESLint over all changed source/test files: exit 0.
- git diff --check: exit 0; Graft wiring freshness: OK.

## Preserved boundaries

Ops is advertised only with signed Core >=7.2, a healthy agent_runner with
execution-permits-v1 and a ready connected bound agent. Existing direct,
onboarding, relocation, QA, preview and terminal recovery are retained.
Admission permits operations only through the exact conversation carrier;
signature, session, turn and execution identity fences remain intact.
Update phases are E2E-gated with fixed private roots, bounded drain,
verified signed manifests, predecessor identity and existing update locks.
Generic wire OS linux is refused at this build's three-target release matrix;
actual Linux hosts still map to the established Debian artifact target.

## Proof limits / next action

These are source/build checks, not installation or browser/E2E proof. Preserve
the original dirty runtime checkout and existing connector identity. Publish
only task-owned files through draft GitHub PR #24, then prepare a signed local
artifact and use the E2E controller update boundary. Reconcile the original
Engineering action rather than submitting a duplicate estimate or approval.
The ordinary proposal, separate approval, delivery and reciprocal PR lineage
remain acceptance requirements.
