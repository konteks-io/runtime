# Connector startup, 2026-11-04: what took the 17 minutes

- **Runtime:** 0.20.5
- **Instance:** `802e0f4d`
- **Evidence:** the retained connector log (`connector.log.1`, pino JSON,
  2026-11-04 06:36 to 11-08 00:22 UTC)
- **Scope of this finding:** what the retained log can and cannot separate. It
  is not a reconstruction of unlogged work.

## Result

The second restart of that day is bounded end to end by the log:

- `git.choice` and `browser.connector_ready`: **14:06:59 UTC**
- all agent bridges initialized: **14:07:24 UTC** (25 s after `git.choice`)
- `started`: **14:23:59 UTC**

`git.choice` to `started` is **17 min 0 s**. That interval is dominated by
**startup recovery**, not by capability discovery and not by agent start.

- Recovery, first assignment: **14:07:24 to 14:21:43**, **14 min 19 s**.
  The interval ends with `workspace.checkpoint_retained_locally` for assignment
  `6abc8af9` attempt 1 with `code: capability_unavailable`, followed by
  `retained execution process is gone; reporting the claim interrupted` and the
  first `recovery decision`.
- Recovery, second assignment: **14:21:43 to 14:23:59**, **2 min 16 s**,
  ending with `startup recovery remains pending` and then `started`.
- `model_capability.revalidate` and `cache_miss` do not begin until
  **14:13:56**, eight each. Capability discovery was therefore not running for
  the first seven minutes of the interval and did not hold the start.
- Agent bridges were ready by 14:07:24, so agent start did not hold the start
  either.

The run is **not** dominated by capability discovery, and **not** by agent
start. No other phase is proposed as dominant: the log attributes the interval
to startup recovery.

After `started`, Konteks refused the process (`recovery_refused`) at 14:24:14
and it restarted again; that third start reached `started` at 14:25:26, about
**32 s after `git.choice`**, with no retained recovery work to do.

## The bound inside recovery

Within the first 14 min 19 s the retained log cannot separate:

- the workspace capture,
- the Core upload attempt, and
- the process stop.

Nothing is logged between the bridge-ready line at 14:07:24 and the
`workspace.checkpoint_retained_locally` warning at 14:21:43. The **14 min 19 s
therefore bounds decision 1 end to end, not any one sub-step**. This finding
does not name a dominant recovery sub-step.

## The first restart only bounds

The first restart, after `liveness_lost`, supports a bound and no dominant
phase:

- 13:36:05 `supervisor liveness lost`
- 13:36:24 `shutdown did not end the process; forcing exit`
  (reason `liveness-lost`)
- 13:36:55 `git.choice` and `browser.connector_ready`
- agent bridges initialized 13:37:02 to 13:37:17
- no recovery decision and no `started` were ever logged
- 14:06:04 `shutdown did not end the process; forcing exit` (SIGTERM, the CLI
  restart)

That is **29 min 9 s from `git.choice` to the forced exit**, with neither a
recovery decision nor `started` logged. Discovery was also failing from 13:51
(`bridge did not answer initialize within 60000ms`, `ACP model discovery
session deadline elapsed`), the heartbeat was abandoned at 13:52:57 and
`lease.lane_overrun` was logged at 13:54:39. The evidence cannot separate
recovery from discovery for this run, so **no dominant phase is asserted for
it**; it supports only the 29-minute bound.

## What changes in this delivery

Startup now times its own phases from one recorder
(`packages/supervisor/src/reconnect/startup-phases.ts`):

- each phase logs `startup.phase` with `phase`, `phaseMs` and `sinceStartMs`;
- an open recovery step logs `startup.phase_running` every 30 s naming the
  phase, the step and both elapsed values, so a wait like the observed
  14 min 19 s is no longer silent;
- the promotion logs `startup.timings` with the bounded summary;
- the same summary is written into the `last-exit.json` ledger entry for a
  non-zero exit.

`relay_connected` is logged when the relay actually connects, which is after
`started`; startup is not reordered to match the ticket's enumeration.
