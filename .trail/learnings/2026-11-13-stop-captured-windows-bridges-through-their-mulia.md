---
title: Stop captured Windows bridges through their verified tree owner
author: Mulia
date: 2026-11-13
branch: fix/antigravity-linux-windows
id: l-931fb2eb
scope: repo
status: active
src: agent
touches:
  - packages/agent-runner/src/__tests__/bridge-stop-confirmation.test.ts
  - packages/agent-runner/src/bridge/process.ts
  - packages/common/src/retained-process-owner.ts
---

## Decided
A bridge with a captured Windows retained owner stops through the existing retained-owner API. That API rechecks the kernel creation identity and uses descendant-tree termination. Keep the leader-exit observation afterward, and propagate owner-fence failures without falling back to a direct PID kill. POSIX bridges retain their leader-first process-group path.

## Tried and ruled out
The generic process-group helper intentionally reports no POSIX group on Windows and only kills the leader there. Using it for a captured Windows bridge leaves native descendants outside that stop contract. A failing bridge-stop characterization proved that the Windows retained-owner path was never called; the regression now verifies both tree-owner delegation and refusal without a fallback kill. Live Windows Antigravity qualification separately observed successful sign-in/model discovery followed by EBUSY cleanup. That observation motivates investigation but alone does not prove this stop defect caused every earlier timeout or model failure.

## Watch out
An owner fence is authority, not an inconvenience to bypass. Failed identity capture remains a separate recovery condition. A stop is not tool/MCP quiescence evidence, and a source test is not a signed-in Windows model-turn or full app result. Retain failure evidence and verify those live boundaries independently.

In the code: packages/agent-runner/src/bridge/process.ts bridgeStopOwner; packages/common/src/retained-process-owner.ts stopRetainedProcessOwner; packages/agent-runner/src/__tests__/bridge-stop-confirmation.test.ts.
