---
title: Await the child exit event after synchronous Windows tree checks
author: Mulia
date: 2026-11-13
branch: fix/antigravity-linux-windows
id: l-ff8e99f4
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
After a captured Windows bridge's retained-owner stop succeeds, allow a bounded event-loop wait for that exact ChildProcess exit notification before asserting leader exit. Keep the independent exit assertion: expiration is still a recovery refusal. Do not infer ChildProcess state from tree absence alone.

## Tried and ruled out
Live Windows Antigravity self-check progressed from tree_exit_unconfirmed to leader_exit_unconfirmed after the creation-time tree fence. The owned probe scope had no surviving node/server/harness executables. Windows identity/tree queries use synchronous subprocesses, so they can confirm kernel exit while Node's queued child-exit callback has not run. A characterization schedules that notification with setImmediate after the retained stop returns; it failed before the bounded observation wait and passes afterward. Immediate boolean checking was the race, while accepting tree absence without any leader notification would weaken the stop contract.

## Watch out
Wait only for the already captured child, remove the temporary listener/timer, and keep no-fallback behavior when the owner fence refuses. This is a stop-notification bound, not a wider ACP startup or model-response deadline. Native sign-in, real model completion and app evidence remain separate gates.

In the code: packages/agent-runner/src/bridge/process.ts observeBridgeLeaderExit and bridgeStopOwner; packages/agent-runner/src/__tests__/bridge-stop-confirmation.test.ts.
