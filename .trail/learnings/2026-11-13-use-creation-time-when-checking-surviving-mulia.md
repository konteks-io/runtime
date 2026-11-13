---
title: Use creation time when checking surviving Windows descendants
author: Mulia
date: 2026-11-13
branch: fix/antigravity-linux-windows
id: l-9340ee85
scope: repo
status: active
src: agent
touches:
  - packages/agent-runner/src/__tests__/bridge-stop-confirmation.test.ts
  - packages/agent-runner/src/bridge/process.ts
  - packages/common/src/__tests__/retained-process-owner.test.ts
  - packages/common/src/retained-process-owner.ts
---

## Decided
Judge Windows descendants against the captured root creation time and each observed parent's birth. ParentProcessId alone is not durable ancestry: Windows reuses numeric PIDs while older orphans retain them. Keep incomplete related timestamps and changed root identities as recovery refusals, not absence. Collect only PID, parent PID and creation time, never process arguments.

## Tried and ruled out
After routing Windows bridge stop through the existing retained tree owner, live Antigravity qualification stopped with tree_exit_unconfirmed even though the controller's exact owned folder had no surviving node/server/harness executable. The previous tree query walked every numeric parent-PID relationship without a birth fence. A deterministic fixture demonstrates the false survivor: a child older than the newly captured root PID plus that old child's descendants. The production tree predicate now excludes that historical branch and still observes current descendants after the root exits. Tests also reject reused roots and missing related creation times. Native model-turn proof remains independent of these fixtures.

## Watch out
Do not convert malformed or incomplete process observations into a successful stop. CIM exposes microseconds while Get-Process can expose a final 100ns digit; the comparison accounts for that representation difference. The stop still requires the verified retained identity and observed leader exit. This changes tree-exit evidence, not permission to kill arbitrary old PIDs.

In the code: packages/common/src/retained-process-owner.ts windowsProcessTreePresent, windowsProcessTreeAlive and windowsStopDeps; packages/common/src/__tests__/retained-process-owner.test.ts. E2E private-scope inspection independently reports owned process residuals without arguments or environment values.
