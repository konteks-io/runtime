# Third-party notices

## bb (github.com/get-bb/bb) — MIT License

Copyright (c) 2026 Michael Yong

Parts of this repository adapt engineering from the `bb` codebase under the
MIT License. The code was adapted, not forked: names follow Konteks terms,
bb-only product concepts (threads, plugin slots, bb config, account pools)
were dropped, and the contract's own grants/proofs/leases/epochs/acks remain
the authority. The MIT notice above applies to the adapted portions of the
files listed below.

| This repository | Adapted from bb | What was kept |
|---|---|---|
| `packages/common/src/process.ts` | `packages/process-utils/` | subprocess-tree spawn/kill lifecycle, process-group handling, timeout/kill escalation |
| `packages/common/src/backoff.ts` | `packages/tunnel-client/src/reconnect.ts` | exponential backoff with jitter and connected-duration reset |
| `packages/supervisor/src/relay/relay-client.ts` | `apps/host-daemon/connect-tunnel/`, `packages/tunnel-client/src/session.ts`, `headers.ts` | single-socket client shape, attempt fencing, handshake-then-stream ordering, reconnect scheduling |
| `packages/supervisor/src/daemon.ts` | `apps/host-daemon/` (daemon lifecycle, signal handling, command dispatch structure) | startup/shutdown ordering, signal-driven drain, structured command handling; Konteks additionally waits for in-flight startup before cleanup and coalesces readiness for concurrent starts |
| `packages/supervisor/src/control/handlers.ts` | `packages/host-daemon-contract/` (`protocol.ts`, `commands.ts`) | versioned closed command-handler structure and typed dispatch |
| `packages/agent-runner/src/bridge/process.ts` | `packages/process-utils/`, `apps/host-daemon/` | bridge process spawn over stdio, environment rebuild, orderly termination |
| `packages/agent-runner/src/auth/login-flow.ts` | `plugins/account-pool/src/oauth-login.ts`, `codex-device-login.ts` | device-flow / OAuth interaction model (display, open-URL + user code, prompt, completion) |
| `packages/launcher/src/native/service.ts` | `apps/server/src/assets/install-machine.sh` | user-scoped launchd/systemd service layout, XML and unit escaping, persistent restart; translated to typed commands, with Konteks-specific paths and an additional Windows adapter |
| `packages/release/src/native.ts` | `apps/host-daemon/src/protocol-self-update.ts` | stage a host-only artifact before replacing the running host; Konteks requires an independently trusted signed manifest, bounded streaming and mandatory digest verification |
| `packages/supervisor/src/__tests__/daemon.test.ts` | `apps/host-daemon/src/daemon.test.ts` | startup/cleanup characterization cases ported to Konteks's ordered shutdown steps |
| `packages/supervisor/src/skills/staging.ts` | `apps/host-daemon/src/injected-skills.ts` | private temporary full-catalog staging and atomic commit; Konteks adds live authority, scope/digest binding, full cache revalidation and bounded safe reads |
| `packages/supervisor/src/skills/session-inputs.ts` | `packages/provider-bridge-acp/src/session-params.ts` | skill-root file instructions passed locally to ACP; Konteks makes selected skills required, keeps metadata as data, and revalidates before prompts |
| `packages/supervisor/src/native/claude-executable.ts`, `packages/agent-runner/src/bridge/spec.ts` (personal Claude profile) | `plugins/provider-claude-code/src/bridge/session-options.ts`, `provider-maintenance.ts` | installed Claude Code CLI discovery order (override, PATH, per-user, Homebrew/system) and reuse of the operator's own login instead of a vendored CLI; Konteks adds ownership/writability checks and binds the path at install time |
| `packages/supervisor/src/relay/channel-mux.ts` (stall liveness) | `apps/host-daemon/src/server-connection.ts`, `apps/server/src/constants.ts` | reconnect on silence (no inbound traffic past a liveness window), never on a late acknowledgement from a busy peer; Konteks keeps per-channel replay buffers and a doubling backoff |
| `packages/supervisor/src/work/orchestrator.ts` (channel handoff, idle reaper), `packages/agent-runner/src/sessions/manager.ts` (`releaseSealed`) | `packages/provider-bridge-acp/src/bridge/bridge.ts` (`startAgentSession`, `releaseSession`, load-or-fresh fallback), `packages/agent-runtime/src/runtime.ts`, `apps/host-daemon/src/app.ts` (idle reaper) | stop a thread's existing session before starting another, release without faking an interruption, continue in a fresh session when the previous one cannot be restored, release sessions idle for 30 minutes; Konteks journals each stop and proves the process group exited |
| `packages/supervisor/src/session/workspace-tool-policy.ts` | `plugins/provider-claude-code/src/interactive-contract.ts` (runtime permission policy → agent permission mode) | answer ordinary agent permission requests by a runtime policy instead of asking a human per call; Konteks keeps the hosted bash blocklist and workspace-confined file changes |
| `packages/supervisor/src/session/permissions.ts` (`registerDeferral`), `packages/supervisor/src/session/relayed-session.ts` (`deferToHuman`) | `apps/host-daemon/src/server-client.ts` (`registerInteractiveRequest`), `apps/host-daemon/src/interactive-request-registry.ts` (`registerAndWait`) | register a pending interaction with the server before waiting on a human, retrying only transient failures (100 ms to 2 s, 5 retries), binding the registered record to the exact request, and failing the agent's request when registration never succeeds |

```
MIT License

Copyright (c) 2026 Michael Yong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Not used

The native continuation inspected bb at commit
`dba32a469fd820ff6106715db0aaf6ed297d79a5`. Its product server, enrollment
credentials, plugin UI, and provider-specific product policy are not imported.
Further extraction candidates and deliberate security differences are tracked
in `proof/BB-REUSE.md`.

`shellular-org/*` repositories are AGPL-3.0-only and were consulted for
design only (descriptor shape, ACP client structure, CLI flow); no source
from them enters this repository. `npm run check:agpl` guards this.

## Runtime dependencies

- `@agentclientprotocol/sdk` 1.4.0 — Apache-2.0
- `@agentclientprotocol/claude-agent-acp` 0.75.1 — Apache-2.0 (bundled in the `claude-code` offline agent package)
- `@agentclientprotocol/codex-acp` 1.10.0 — Apache-2.0 (bundled in the `codex` offline agent package)
- `ws`, `zod`, `pino`, `commander` — see each package's licence
