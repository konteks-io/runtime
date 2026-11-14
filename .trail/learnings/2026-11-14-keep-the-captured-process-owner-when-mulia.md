---
title: Keep the captured process owner when ACP initialization fails
author: Mulia
date: 2026-11-14
branch: fix/antigravity-linux-windows
id: l-cc32ce6c
scope: repo
status: active
src: agent
touches:
  - packages/agent-runner/src/__tests__/bridge-stop-confirmation.test.ts
  - packages/agent-runner/src/bridge/process.ts
---

## Decided
ACP initialization failure and protocol mismatch stop through the bridge's already captured stop owner, just like later shutdown. A Windows retained owner must run its verified descendant-tree cleanup and independently observe leader exit. An owner-fence refusal replaces a retryable initialization error with recovery_required.

## Tried and ruled out
The normal Windows bridge stop had been repaired, but initializeBridge still called the generic leader-first process-group helper directly. A timeout regression failed because the captured Windows owner was never called; it passes after sharing the same stop owner. Live Antigravity startup repeatedly timed out and left many PyInstaller extraction folders. That evidence motivates this cleanup repair but does not prove the repair makes Antigravity start within 60 seconds or completes an App model turn.

## Watch out
Do not fall back to a PID kill after an owner-fence refusal. Do not treat absent processes as tool/MCP quiescence. Guest cache cleanup requires separate ownership, inactivity and reparse-point checks.

In the code: packages/agent-runner/src/bridge/process.ts initializeBridge; packages/agent-runner/src/__tests__/bridge-stop-confirmation.test.ts.
