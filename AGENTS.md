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

The connector's file in a release folder is `konteks-connector(.exe)`
(`NATIVE_CONNECTOR_FILE` in `packages/release/src/native.ts`), because people
see it in their process list. Never hard-code a connector file name: resolve it
with `resolveNativeConnectorExecutable`, which also accepts the pre-rename
`connector` that older releases, older launchers and rollbacks leave behind.
The manifest's `kind: "connector"` and the service label
`dev.konteks.remote.<hash>` are protocol, not file names; do not rename them.

Preserve the native-only architecture: this machine runs the connector, ACP
bridges, local agents, and their local authentication. Harness, Validation
Runtime, Assistant, and ai-manager remain cloud services. Reliability and
performance are the primary design constraints. Prefer durable, bounded,
observable recovery and simple ownership over extra coordination layers.

The appliance (the Docker Compose remote instance with its gateway, browser
tool, preview forwarder and runner images) is retired and deleted; the
supervisor accepts only `SUPERVISOR_DEPLOYMENT_KIND=native_connector` and
runners only `agent_local_subscription`. Do not reintroduce Compose, images,
`gateway_keyed` or a local component server.

Session previews are native (packages 7.0.0 `preview.dev_server`): the
supervisor runs at most one dev server per session in that session's
worktree (`packages/supervisor/src/preview/`), on a loopback port it picks,
with an allow-listed environment, and serves the relay channel
`preview:<sessionId>` through an in-process forwarder that may dial ONLY that
port. Agents reach it through the connector-local `konteks-preview` MCP server
(`preview_start`/`preview_status`/`preview_stop`, no arguments). The per-machine
on/off switch is Core's (`PUT /api/remote-instances/:instanceId/preview`); do
not add a local one. Do not restore the preview Compose service, the `preview`
work kind or a separate forwarder process.

The QA browser is Playwright MCP (`@playwright/mcp`, pinned in
`release/native-agent-builds.json` `browser` and `BROWSER_MCP_PACKAGE` in
`packages/release/src/browser.ts`; bump both together), bundled into the
Claude Code and Codex offline agent packages with the connector's launcher
(`packages/agent-runner/src/bridge/browser-{mcp,launcher,tools}.ts`, copied to
`konteks/` in the package). It is a connector capability (opencode O8), not
an agent feature: `resolveConnectorBrowser` (`supervisor/src/native/browser-capability.ts`)
runs once at supervisor start and takes the copy in an installed Claude Code
(first) or Codex package, on that package's Node, then the other package's,
then the person's own Node (`locatePersonNode` in `dsh-installation.ts`: the
Node dsh already runs on, PATH, the usual places; Node 20+ for Playwright);
`withConnectorBrowser` hands it as `RUNNER_BROWSER` to every runner whose own
package has none (dsh, OpenCode), and Claude Code and Codex keep their own
(`runnerBrowser`: own package first). No package or no Node: no browser for
anyone, a plain doctor line, and no `browser_tool` capability (the component
advertises it while the browser exists and previews can run). `NativeRunner`
adds it as a stdio ACP MCP server
(`konteks-browser`) for every session that has a preview (`BROWSER_WORK_KINDS`
= `PREVIEW_WORK_KINDS`: delivery, validation, qa and assistant_execution, which
is how a QA-mode conversation runs); `RelayedSession` gives each such session a
`PreviewBrowserGateway` (`preview/browser-gateway.ts`), the browser's HTTP
proxy, which admits only that session's running preview origin. Chromium
proxies loopback too (Playwright forces `<-loopback>`), so the gateway is the
boundary; `--allowed-origins` is only a second layer (Playwright says it is
not a security boundary). The gateway also admits origins Core issued for the
session (`PreviewBrowserGateway.grant`): Core's answer to the QA tool
`platform__quality-assurance__environment_open` carries
`browserAccess: {sessionId, origins[{origin, expiresAt}]}` (a signed-in cloud
preview, or a registered application), and `McpCapabilityFacade` reads it from
that one tool's JSON answer as it relays it (`onBrowserAccess`; same session,
http(s) origins only, external https only, expiry capped at a day) and hands
it to the session's gateway. Never add another way to grant an origin: the
agent must not be able to widen the list with its own input. A registered
application's host must not resolve to this computer (the CONNECT dials the
checked address). The launcher keeps `--allowed-origins` in step: before each
tool call it reads `GET <gateway>/.konteks/browser-origins`
(`KONTEKS_BROWSER_ORIGINS_URL`) and, when the set changed and nothing is in
flight, restarts Playwright MCP with loopback plus those origins, replaying
the agent's `initialize` (Playwright reads the flag once per context). Never pass `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`,
and never npx it at runtime. dsh's governance admits `mcp__konteks-browser__*`
only on a session given the browser and never a hidden tool
(`isDeniedBrowserTool`); OpenCode reaches it through Code Mode
(`tools["konteks-browser"].<tool>(…)`: `RelayedSession` adds the name to the
session's servers so the gate and the tools line know it), and OpenCode's own
built-in browser stays denied (`browser`). The gateway's CONNECT and upgrade
sockets get an `error` listener before anything else: Chrome resets refused
ones, and an unhandled reset ends the connector process.

Structured results go through a tool (`packages/supervisor/src/structured-result/`).
Every session gets the connector-local `konteks-result` MCP server with one
tool, `submit_result` (generic, permissive definition while no turn asks). A
prompt whose LAST text block ends with agent-core's structured-output contract
(`readStructuredOutputContract`: the `## Required structured output` heading
and a fenced JSON Schema) binds that schema to the tool
(`StructuredResultToolServer.bind`): the server sends
`notifications/tools/list_changed` on the agent's event stream and waits up to
2 s for a re-read (`toolDefinition: schema`, Claude Code); an agent that does
not re-read (Codex 0.144, `toolDefinition: generic`, remembered per session)
gets the schema in the prompt line instead. The contract block is replaced by
one line (`RESULT_TOOL_LINE`). Calls are validated with Ajv (Ajv2020 for a
draft 2020-12 schema), a mismatch answers with each problem's path, the first
valid call wins. At the turn's `prompt_result`: the tool value
(`source: tool`), else a valid fenced/JSON result in the agent's message text
(`fence`), else ONE follow-up prompt in the same ACP session
(`RESULT_FOLLOW_UP`, request id `<id>#konteks-result-follow-up`, never sent to
Core; its usage is summed into the original completion) whose result is
`follow_up`; the original request's completion then carries
`structuredOutput: { source, value }` (packages 7.0.0, additive). Never move
the schema into a `session/prompt` request field: the native operation permit
signs the parsed request's digest and an older connector strips unknown
fields. dsh governance admits `mcp__konteks-result__*` like the preview tools.

Supported agents are Claude Code (`claude-code`), Codex (`codex`) and the
person's own DeepSeek Harness (`dsh`) and OpenCode 2 (`opencode`, offered
since opencode-runtime-support CP6); Google Antigravity (`antigravity`) is
registered and fetched but not offered yet (below). Pi is retired: every write or install
refuses it with `retiredAgentMessage` from `@konteks/backstage-plugin-common`,
while stored values stay readable (a `native-runtime.json` still listing it
loads without it through `parseNativeRuntimeRecord`, with a logged warning).
Since packages 7.1.0 `opencode` is no longer a retired id: a pre-7.0.0 record
naming the old bundled OpenCode reads as the person's own OpenCode 2 (O13).

Google Antigravity (`antigravity`, antigravity-runtime-support) is the first
FETCHED host agent (`hostInstall.launch: "fetched"`): nobody installs it; on
the person's yes (`HostAgentInstallAdapter.consentText` / `fetch`) the
connector downloads Google's official `antigravity-acp` zip from the URL this
release pins in `packages/release/src/fetched-agents.json` (per platform: URL,
zip size and sha256, every unpacked file's size and sha256, the registry's
command and arguments, the signer; bundled into the connector executable, so
only a runtime release changes a pin; only `darwin-arm64` is pinned so far)
into `<root>/agents/antigravity/<version>-<platform>/` (folders 0700, files
0755, never on PATH, never under `credentials/`). `native/fetched-archive.ts`
is the generic half (HTTPS download of exactly the pinned bytes with proxy
variables through a CONNECT tunnel, a zip reader that refuses zip64, spanned
or encrypted archives, absolute or `..` paths, links and duplicates, `codesign
-R` with the pinned Team ID / Authenticode, free disk);
`native/antigravity-installation.ts` the Antigravity half (consent line A20,
1.5 GB free or refused, staging in the connector folder, one rename into
place, re-verification on `locate`, every load and every start with hashes
cached per file identity; diagnostics `antigravity_not_fetched`,
`antigravity_unsupported_version`, `antigravity_unsafe_install`,
`antigravity_no_disk_space`, `antigravity_unsupported_platform`; remove and
prune). `locate` and `runnerSettings` take the connector root
(`HostAgentInstallContext`); the install record keeps `antigravityVersion` and
`antigravityRoot`; the runner gets `RUNNER_NATIVE_ANTIGRAVITY_ROOT`. Every
Antigravity execution gets `antigravityEnvironment` (agent-runner
`host/antigravity.ts`, on the shared `allowListEnvironment` of
`host/allow-list-environment.ts` that OpenCode uses too): the host-agent
allow-list, `HOME`/`GEMINI_HOME` in `<credentials>/antigravity/antigravity/home`,
`AGY_ACP_FORCE_FILE_STORAGE=1`, and (API key, CP3) only a loopback
`GOOGLE_GEMINI_BASE_URL`; never `GEMINI_*`, `GOOGLE_*`, `CLOUDSDK_*`, other
`AGY_*`/`ANTIGRAVITY_*`, `GITHUB_TOKEN`/`GH_TOKEN` or provider keys. It is NOT
offered (`antigravityInstallAdapter.offered = false`) until its CP3 and CP4:
the CLI does not list it, install and `agent add` refuse it, enrollment never
detects it, a stored record drops it, and its runner refuses to spawn, sign in
or start (after re-verifying the copy).

Agents used from the person's own installation (`HOST_AGENT_BRIDGES` in
`packages/release/src/bridges.ts`: dsh, and OpenCode 2 as `opencode`) never
get a branch of their own in generic code. Each has a runner-side
`HostAgentRunnerAdapter` (`packages/agent-runner/src/host/`: launch, private
home and environment, overlay/config writer, sign-in, identity, reported
version) and an install-side `HostAgentInstallAdapter`
(`packages/supervisor/src/native/host-agents.ts`: locate, install-record
fields, re-verify on every load, start self-check, `offered`). A host agent
whose adapter is not `offered` is refused on install and `agent add`, never
detected at enrollment, and dropped from a stored record like a retired one
(both are offered today). A listed host agent the load cannot find or verify
(`prerequisite_missing` from its locator: removed, OpenCode 1 over it, out of
range) does not fail `loadNativeInstallation`: it is returned in
`unavailableAgents` with a `relocate()` (`nativeHostRunnerConfig`), and the
supervisor parks it with `NativeAgentRetry`, building its runner when a retry
re-locates it (`parkUnavailableHostAgent`); OpenCode's `runnerSettings` also
searches again when its recorded executable no longer verifies. OpenCode 2 is
registered (binary launch mode, `>=2.0.18 <3.0.0`) and located by
`opencode-installation.ts`; `openCodeInstallKind` names how it was installed
for doctor (never the path), and doctor's `opencode` check
(`support/doctor.ts`, fed by `Supervisor.openCodeDoctor` and
`NativeRunner.hostInstallation`) reports version, install, self-check,
credential labels, free models and the QA browser, or the plain reason it is
left out (diagnostic ids only; no path or link). Onboarding
(`launcher/native/onboard.ts`) detects it (`detectAgentFamilies`), names
OpenCode 1 with the homepage command (`detectOpenCodeProblem`), asks for
`auth login opencode [--reuse]` (`personalOpenCodeDataExists`, existence
only), and says `agent add` or `doctor` when an installed host agent is not
running. Every
OpenCode execution, `--version` and `debug` included, gets the allow-list
environment of `openCodeEnvironment` (never `GITHUB_TOKEN`, `GH_TOKEN` or any
other credential or inherited `OPENCODE_*` variable) plus Konteks' own
settings (`openCodeKonteksSettings`: the locked config from
`renderOpenCodeKonteksConfig` as `OPENCODE_CONFIG_CONTENT`,
`OPENCODE_CONFIG_PROJECT_DISABLE=1`, `OPENCODE_FILEWATCHER_DISABLE=1`), in a
private home under `<credentials>/opencode`. Each OpenCode execution process
serves exactly one working copy (`HostAgentRunnerAdapter.bindWorkingCopy`):
its `XDG_CONFIG_HOME` is `config/<hash of the path>`, whose
`opencode/AGENTS.md` links to the working copy's own (a copy refreshed before
each prompt where symlinks are refused; never a file outside the working
copy), and the runtime never parks such a process for another session (MCP
servers are process-wide in OpenCode). The control process (discovery,
sign-in) uses `config/control`, which carries no instructions. Runner start
runs `opencode-self-check.ts`: `opencode debug agents` in the private home on
a private service port, asserting every agent ends with the Konteks rules and
that `plan`/`title` are off (a fresh service first lists OpenCode's default
agents for about a second, so the listing is read until it is in force or has
stayed unchanged for 5 s), and stopping any background service of the
private home before and after (only processes whose environment names it;
the person's own service is never touched). Drift reads
`opencode_unsupported_installation`.

OpenCode's tool governance (CP4) is the runtime's own, as dsh's: every
`session/request_permission` of an OpenCode or dsh session goes through
`hostToolGovernance` (`supervisor/src/session/host-tool-governance.ts`) and
then the unchanged `EvaluatorPolicyResponder` + `createWorkspaceToolPolicy()`.
`OpenCodeToolGovernance` (`opencode-tool-governance.ts`) names the tool from
the call's FIRST `tool_call` title (a subagent's `<childSessionId>:<callId>`
calls, titled `<subagent>: <tool>`, are judged the same), requires the
request's input to match what the call reported, and rebuilds it: shell →
the command (and a shell folder outside the working copy is refused);
edit/write/patch → every `files[].file`/path resolved against the working copy,
all inside it; `.env` reads refused; subagents and todo lists allowed; web
fetches as for Claude/Codex; uncorrelated, unknown or mismatched → refused.
MCP tools are reachable only through Code Mode (`execute`), which runs a whole
code block after one ask: `opencode-code-mode.ts` parses it with acorn (a
supervisor dependency, MIT) and approves only `[const|let x =] await
tools["<server>"].<tool>(<literal args>)` statements and a final `return`,
for this session's own MCP server names; `rawOutput.metadata.toolCalls` must
then list only approved calls (an unasked `tools.search` lookup is fine).
`allow_always` is never offered to policy or a person (OpenCode would store it
in its database and stop asking). The tripwire (`observe`) fires on a gated
tool that completes unasked, an unapproved Code Mode call, or an unasked read
of `.env` or outside the working copy: the turn is cancelled and
`runner.quarantine` takes OpenCode out of service on this connector (the other
agents keep running). `canonicalizeAcpToolActivity` names OpenCode tools from
the first title and a Code Mode block as the Konteks tool it calls. An OpenCode
session's first prompt carries one line with the accepted form
(`opencode-prompt.ts`), and its result-tool lines name
`await tools["konteks-result"].submit_result({ ... })`. The runner refuses
OpenCode's `plan` mode (`HostAgentRunnerAdapter.refusedSessionModes`: on
`set_mode`, `set_config_option`, an admitted session configuration, and in
what is reported), and every bridge client answers `fs/*` and `terminal/*`
with "method not found". Found live on 2.0.18 (CP4): Code Mode asks at a
block's FIRST MCP call, not before the block runs, and never for its own
tools: the built-in browser and OpenCode's own `tools.opencode.*`
(`session_move` moves the session to another folder) ran unasked, so the
locked config denies them by their permission names (`browser`,
`opencode_*`; `browser.*`/`opencode.*` do not match), which drops them from
the catalogue, and the self-check asserts both. Code Mode's `fetch` also
runs unasked and cannot be removed short of denying `execute` (which would
drop every MCP tool): it is treated as the web fetch the policy allows every
agent and never trips; this is the one thing Konteks cannot judge beforehand.

OpenCode's sign-ins (CP3) are OpenCode's own commands, run by
`auth/opencode-auth.ts` in the private home with the allow-list environment
and the private home as working folder (`openCodeCommandContext`); the
connector never opens OpenCode's database. `opencode api --standalone
integration.list` says what can be signed in (methods and their forms; a
field with no default and no choice leaves that method to the person's own
OpenCode); `opencode auth list --standalone --format json` says what is.
`konteks-remote auth login opencode [--provider X] [--method Y] [--reuse]`
asks for the provider in the open (a `prompt` event with `visible: true`,
read by `promptLine`; the reviewed subscriptions first), then runs `opencode
auth login <provider> --method <id> [--answer k=v] --standalone`: a
subscription's link and device code are relayed (`splitTerminalOutput` turns
OpenCode's in-place redraws into lines); an API key is asked for with the
launcher's hidden prompt and typed into OpenCode's OWN key prompt on a
pseudo-terminal (`openCodePtyCommand`: `script(1)` behind `cat |`, macOS and
Linux; Windows refuses key entry for now), never an argument, environment
variable, event or log line, and any output line carrying it is dropped.
OpenCode 2.0.18 stores a key without checking it. `--reuse` (and a one-time
offer, remembered in `<credentials>/opencode/reuse-offered`) lists the
person's own OpenCode sign-ins through its own `auth list` after a yes; 2.0.18
has no export, so they sign in again here. `auth logout opencode [--provider
X]` runs `auth logout <provider> <credential id>` per credential. The site
starts only the reviewed device or machine-browser options
(`OPENCODE_LOGIN_OPTIONS`; the intent's `loginOption`, echoed in every report,
`native/site-login.ts`); the connector advertises `agent-login-opencode-v1`
plus `agent-login-opencode:<option>` per option its OpenCode offers (browser
ones only with a desktop) and `opencode-free-models-v1`.

OpenCode's identity is a keyed fingerprint over (provider, method, credential
id) from `auth list`; the connected agent reports `credentials[]` (plain
label, `sign_in`/`api_key`, method, `billing` from `classifyAgentBilling`,
state; `needs_sign_in` after a turn's auth failure). With nothing signed in it
reads "Needs sign-in" unless Core's desired configuration switches on Zen's
free models (`openCodeFreeModelsEnabled`, applied to runners as
`HostAgentSettings`). While off, `opencode/*-free` models are not offered,
never reported as current, refused as a choice and moved off at session
start. A turn's money basis follows how its route's provider bills
(`sessions/usage-label.ts`): pay-per-use turns name provider and model and
carry the `usage_update.cost` delta (USD micros; unknown, never zero, when
none was reported); subscription turns stay `unavailable_local_subscription`;
dsh's key turns are pay-per-use. Pay-per-use turns and offered-option
`billing` go only to a 7.1.0 Core, recognised by the presence of
`openCodeFreeModelsEnabled` in its desired configuration. With an OpenCode
Console sign-in in the private home, `acp`'s session catalogue is the
account's (plan listed, a config-declared provider absent) while the
permission rules, the project lock and `debug agents`' resolved agents stay
ours; Konteks declares no providers in config and refuses plan itself
(opencode-runtime-support proof/CP3.md).

Every installed native agent reports the models it offers (System One §6a,
KM6; `ModelCapabilitySnapshotProducer`): an agent whose release carries a
reviewed signed mapping (`REVIEWED_NATIVE_MODEL_IDENTITIES`) reports under it,
and every other one (or one whose mapping expired) under its fixed unsigned
catalogue authority (`catalogueModelAuthority`, config `model`); Core resolves
identity, tier and price from its own known-model catalogue. Each snapshot
carries every option's value, name and group (`exactSelect` in
`bridge/model-capability.ts`); malformed entries are skipped, and above 128
values the known models come first (the current value is always kept) instead
of the report failing. Discovery is re-read every
`DEFAULT_MODEL_CAPABILITY_TTL_MS` (5 min) and at once on a sign-in change (the
account fingerprint keys the cache). The signed mapping is no longer needed
for a new model; keep it only for aliases that move.

Before production changes, add or update a focused characterization test and
observe its failure or baseline. Run focused tests serially; do not start
multiple Vitest processes or a whole suite during local proof work unless the
user explicitly requests it. Preserve unrelated worktree changes and commit
coherent verified checkpoints.

## Maintenance

Follow [HARDENING.md](HARDENING.md): keep Graft fresh before graph use and
after edits; broader C00 cleanup is deferred.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `./scripts/hardening/graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `./scripts/hardening/graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `./scripts/hardening/graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `./scripts/hardening/graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `./scripts/hardening/graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `./scripts/hardening/graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `./scripts/hardening/graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
