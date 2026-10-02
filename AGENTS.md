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
Every session (except a person's direct session, below) gets the connector-local `konteks-result` MCP server with one
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
since opencode-runtime-support CP6), and Google Antigravity (`antigravity`,
fetched by the connector on the person's yes, offered since its CP6, below). Pi is retired: every write or install
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
`AGY_*`/`ANTIGRAVITY_*`, `GITHUB_TOKEN`/`GH_TOKEN` or provider keys. CP2 (spawn): before every
process `prepareToSpawn` (`prepareAntigravityHome`) keeps the private folders
0700, writes `settings.json` from the connector's own sign-in record
(`<credentials>/antigravity/antigravity/sign-in.json`, outside the home, CP3
writes it; none writes `{}`), removes the workspace-trust file and empties
`config/` and `antigravity-cli/skills/`; every `session/new`, `session/load`
and `session/resume` (and model discovery) carries `_meta.agy` with the A4
`enabledTools` allowlist and `disabledTools` (`start_subagent`,
`generate_image`, `ask_question`); `auto_edit`/`yolo` are refused and dropped;
a session not in `default` mode or without a `model` select never reads ready
(`verifyAntigravitySession`); the working copy's `AGENTS.md` (a regular file
inside it) is sent as an embedded resource in a session's first prompt and
again only when it changed (`promptPrelude`, digests in `instructions.json`);
at most two execution processes, a third session waits up to two minutes,
the resident process is kept five minutes, the control process stops after a
minute idle (readiness keeps its `initialize`), stop sweeps anything left with
the private `HOME`; session bootstraps may take 30 s. Its failures are read in
plain words (`classifyBridgeError` for `data.reason` `ge_*`/`admin_controls_*`,
the missing licence naming the Business AI Code API and `gcloud services
enable businessaicode.googleapis.com --project <project id>`;
`antigravityStderrFailure` ends a bootstrap or turn that would open a sign-in
or licence page; `antigravityAgentErrorText` turns quota/model errors the
server writes as its reply into a failed turn). The start check
(`native/antigravity-self-check.ts`) runs one `initialize` in the private home
after the integrity check: `antigravity-acp` at the pinned version, the four
sign-in methods and no gateway, MCP over http, load/resume, embedded context;
drift is `antigravity_unsupported_version`. These seams are generic
`HostAgentRunnerAdapter` fields (`sessionMeta`, `verifySession`,
`promptPrelude`, `processLimits`, `stderrFailure`, `agentErrorText`,
`sweepLeftovers`, `sessionBootstrapTimeoutMs`, and CP3's `wrapSpawn`,
`measureTurn`). CP3 (sign-in, agent-runner `auth/antigravity-auth.ts`):
`auth login antigravity [--api-key | --enterprise --project P --location L]`
(a numbered choice in the open without either). A **Gemini API key** is read
with the launcher's hidden prompt, checked with Google's free model list and
kept 0600 at `<credentials>/antigravity/antigravity/relay/gemini-api-key`
(outside the home; never an argument, environment variable, event or log
line). Every process spawned while the key is the method in use
(`antigravitySpawn`, the adapter's `wrapSpawn`: control, execution and
discovery alike) gets its own relay (`host/antigravity-relay.ts`: 127.0.0.1,
random port and token, only `/{v1,v1beta,v1alpha}/models[/<id>[:generateContent|
:streamGenerateContent|:countTokens]]` forwarded to
`https://generativelanguage.googleapis.com` with the real key, answers
streamed through, `usageMetadata` counted per model; bodies, headers, key and
token never logged) as `GOOGLE_GEMINI_BASE_URL`, and the relay token through
ACP `authenticate {methodId: gemini-api-key, _meta: {"api-key": token}}`.
`measureTurn` reads the relay's span per turn; the session manager reports it
as `pay_per_use`, provider `google`, the path's model, and
`reportedCost` = list-price estimate (`costSource: list_price_estimate`,
`pricingSnapshotId`) only to a 7.1.0 Core (`coreAcceptsRouteBilling`), even
for a failed turn. **Gemini Enterprise** runs ACP `authenticate
oauth-business` on a process of its own (`runGoogleSignIn`, spawned with the
runtime's plain spawn, cwd the private home, `settings.json` held by
`holdAntigravityHomeForSignIn` so nothing rewrites it meanwhile), reads the
server's stderr (`onStderrLine`: the `accounts.google.com` link is relayed as
`open_url`, the loopback licence picker never is; "has no available license";
"sign-in resolved … user_tier="), requires the token file in the private home
(the file store), and writes `sign-in.json` `{method, gcp, tier}` from the
project the server wrote back after its picker. A failed attempt that found
no licence ends with `reason: "no_license"` (runner event, control event,
site report) and marks the record `licence: "none"`; so does a session that
logs it (`antigravityStderrFailure(line, credentialDir)`). Personal Google
sign-in (`oauth-personal`) exists only behind packages'
`ANTIGRAVITY_LOGIN_OPTIONS['google-account'].released` (off): refused, never
advertised. Identity (`antigravityIdentity`): a keyed hash of the method in
use (+ project, location, tier); `credentials[]` active first: Enterprise
(`google`, `sign_in`, `oauth-business`, label `geminiEnterpriseCredentialLabel`,
billing `classifyAgentBilling` with the tier, `needs_sign_in` without its
token, `reason: no_license` only to a 7.1.0 Core) and the key (`api_key`,
`pay_per_use`); nothing in use ready → `not_configured` + `login_locally`;
`tokenUsageObservable` true only on the key. `auth logout antigravity
[--api-key | --enterprise]` runs ACP `logout` where the server offers it,
removes the Enterprise token file and/or the key, keeps the project. The
supervisor starts the site's Gemini Enterprise sign-in from an intent's
`loginOption: gemini-enterprise` + `gcp` (`native/site-login.ts`: Google's
link only, `no_license` to a 7.1.0 Core, `login_failed` to an older one),
advertises `agent-login-antigravity-v1` +
`agent-login-antigravity:gemini-enterprise` (relay up and a desktop; since
CP6 no longer OpenCode's free-models capability: the 7.1 signal is the
generic `core-contract-version-v1`), puts the credential in use's
billing on offered Gemini models (`antigravityOptionBilling`) and
`hostAgentDownload` on the connected agent (`native/antigravity-download.ts`,
7.1 Core only; an Antigravity that cannot start is still reported with it,
one the installation does not list is reported as an unavailable agent reading
`not_downloaded` (the site's "Not added" card with the add command, A20) where
this release pins a copy, and one `agent add` is downloading in the launcher
reads `downloading` from the growing staging file; never a capability). CP4 (governance, below) is built. CP6 (offered,
`antigravityInstallAdapter.offered = true`): `install --agents …,antigravity`
and `agent add antigravity` refuse a computer without a pin first
(`assertFetchable`), then ask `consentText` verbatim (launcher
`native/consent.ts`: a terminal answer, or `--yes` given by the person; a
relaying agent never adds it), fetch while the service keeps running
(`fetchHostAgent` in `native/install.ts`, before `runNativeAgentAdd` drains and
stops it) and record it with no release or reactivation; a listed copy that no
longer verifies is fetched and recorded again by the same command.
Enrollment never detects it (it is fetched, not found) and refuses it in
`install --enroll --agents`. Updates (A17, `native/antigravity-update.ts`): a
load whose record lists Antigravity with another version or a missing folder
parks it with `updating` and a `relocate` that fetches this release's pin on
the person's first yes, runs the start check on it, writes the two record
fields under the installer's lock (deferred to a later start when an
installer holds it) and prunes the other versions; the supervisor starts that
retry at once (`NativeAgentRetry.park(…, { firstDelayMs: 0 })`). Removal
(A18): `agent remove antigravity [--yes]` (launcher `runNativeAgentRemove` →
`removeNativeAgent`) asks once, drains and stops the service, signs out on a
process of its own (`signOutNativeAntigravity`: the adapter's `logout`, ACP
`logout` + token and key removed), drops it from the record, then deletes every
version, `<credentials>/antigravity` and `<workspaces>/antigravity`
(`deleteNativeAntigravity`); only a fetched agent is removable this way.
Onboarding: `agentName` "Google Antigravity", never detected, a listed one is a
host family (not signed in → both `auth login antigravity` forms with the
Business AI Code API command; not started → doctor), and one line offers it to
a person with no agent. Graft wires it as `agents` (the connector delivers
AGENTS.md, A9). `doctor` (`support/doctor.ts` `antigravity`,
`Supervisor.antigravityDoctor`): pinned version, "downloaded from Google,
signature checked", the start check, credentials by label with the no-licence
remedy, the A21 "Terminal auto-execution: Require review" line after a
quarantine (`NativeRunner.quarantineReason`), "Konteks tools unavailable: turn
on MCP Servers in Gemini Enterprise settings" when a Gemini Enterprise session
had its MCP servers dropped (`observeAntigravityAdminLine` on execution
stderr → `<credentials>/antigravity/antigravity/admin-controls.json`, cleared
by an Enterprise sign-in or sign-out or an allowlist keeping ours), disk used,
the QA browser, or why it is left out (not fetched, updating, unsafe copy, no
disk, no pin for this computer). The relay honours `HTTPS_PROXY`/`ALL_PROXY`
and `NO_PROXY` for Google (`openHttpsProxyTunnel`, remote-common
`https-proxy.ts`, shared with the download).

Activation install without `--agents` (D116, `native/install.ts`
`findOrOfferAgents`, launcher `native/agent-setup.ts`): agents are detected
like enrollment (`detectNativeAgents`) and none is required; a missing Claude
Code or Codex is offered before the code prompt (`setupAgent`), Claude Code
only through `claudeCodeInstaller` (Anthropic's `install.ps1`/`install.sh`,
run in the person's terminal), Codex by creating its profile folder for the
shipped CLI; no TTY or `--json` never asks or downloads. After `start`,
`closeAgentSetup` runs `auth login` for what was set up, offers it once for a
found agent without a sign-in, and prints which agents are ready and one
command for each other. `agent add claude-code|codex` does the same through
`ensurePersonalAgent` before stopping anything, and adds from the installed
release itself when it is the same digest (no newer release needed). An
explicit `--agents` list stays strict. A record with no agents loads and
starts (`verifyInstalledNativeBridges` accepts an empty runner list). On
Windows, a yes to Claude Code without Git for Windows (remote-common
`findGitForWindows`: `CLAUDE_CODE_GIT_BASH_PATH`, git.exe on PATH,
`%ProgramFiles%\Git`, `%LOCALAPPDATA%\Programs\Git`) asks once to run
`winget install --id Git.Git -e --source winget`; a no, no winget or a failure
is one line with git-scm.com's download page. The Claude bridge gets
`CLAUDE_CODE_GIT_BASH_PATH` from the same lookup at every spawn, and the
install records that git.exe when PATH does not have it yet.

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
a private service port, asserting every agent ends with the Konteks rules
(followed by nothing but `deny` rules: since 2.0.21 OpenCode appends its own
`browser * deny` after the configuration; any later `allow` or `ask` is drift)
and that `plan`/`title` are off (a fresh service first lists OpenCode's default
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

Google Antigravity's tool governance (antigravity-runtime-support CP4, A4 and
A21) sits behind the same seam: `hostToolGovernance("antigravity")` is
`AntigravityToolGovernance` (`supervisor/src/session/antigravity-tool-governance.ts`).
A request must match the `tool_call` it names (title, kind, command, files,
`_meta.mcp`) and is rebuilt for the unchanged policy: `run_command` →
`rawInput.CommandLine` (a `Cwd` outside the working copy refused, and a
command naming the private home, `~`, `$HOME`, `$GEMINI_HOME`, `.gemini` or
the token files, refused by name: the server counts its own `GEMINI_HOME` as
workspace, so neither its scoping nor an organisation's "Outside file access:
Deny" keeps a command out of it); `create_file`/`edit_file`/… → every
`content[].path`, `locations[].path` and `rawInput.TargetFile`, all inside the
working copy; `read_url_content`/`search_web` (live: kind `search`, `query`)
→ a web fetch; an asked read (an organisation's "Always ask") → inside the
working copy only; MCP (`call_mcp_tool`: `_meta.mcp {server, tool}`) → only
this session's own `konteks-platform`/`konteks-preview`/`konteks-result`, and
`konteks-browser` only on a session given the QA browser (never a hidden
browser tool); the workspace-trust question ("Do you trust the authors of this
workspace…", before a repository's `.agents/hooks.json` runs) → always "Don't
Trust"; `invoke_subagent`, other subagent tools and unknown tools → refused.
`allow_always` is stripped before anything sees the request (Antigravity
offers it on a key, and on Enterprise for web search). The session tells the
governance every final answer (`HostToolGovernance.answered`, from policy or
a person), because the server reports the work of an ALLOWED
request as a separate call of its own (`<conversationId>:<n>`, `Running
edit_file`, snake_case input; the `create_file` request then ends "failed",
"approved but never executed"): such a report is paired with an allowed
request for the same file or command and uses it once. The tripwire trips on
a subagent tool (or the admin browser subagent's `chrome-devtools`) in any
`tool_call`; a command, file change, MCP call or unknown tool that completed
with no allowed request (a subagent's command, a refused request run anyway);
and a read outside the working copy (its private home included). A command
that never asked is marked (`HostToolBypass.unaskedCommand`) and, when the
credential in use (the runner's first reported credential) is Gemini
Enterprise, the quarantine line names the organisation's setting (A21:
"Your organisation's Gemini Enterprise settings let Antigravity run commands
without asking. Ask your Google Cloud admin to set Terminal auto-execution to
Require review, then restart the connector.";
`HostToolGovernance.quarantineMessageFor`); otherwise "Google Antigravity ran
a tool without Konteks' approval. Update the connector, then restart it."
An Antigravity session's first prompt names `call_mcp_tool` with its own
servers (`antigravity-prompt.ts`, the same words as the Assistant's hint and
`konteks-platform`), its result lines name `submit_result` through
`call_mcp_tool`, activity names its tools in plain words and an MCP call as the
Konteks tool it calls, and the runner refuses a prompt that starts with its
own `/plan` or `/logout` (`HostAgentRunnerAdapter.refusedPromptCommands`).
Found live (CP4): a Gemini Enterprise organisation with "MCP Servers" off
drops the session's MCP servers (no `call_mcp_tool`), so results come back
through the fenced fallback; on a Gemini API key reads of the private home run
unasked (the tripwire fires), reads elsewhere outside the working copy are
refused by the server.

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
`billing` go only to a 7.1 Core, recognised by the Core wire-contract version
Core signs into the desired configuration (`coreContractVersion`, read with
`coreContractAtLeast(…, "7.1")` in `Supervisor.applyHostSettings`) for a
connector advertising `core-contract-version-v1`, which the `agent_runner`
component always does (`native/inventory.ts`); no fallback on
`openCodeFreeModelsEnabled`, OpenCode's own switch. With an OpenCode
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

The runtime view (runtime-view CP2, packages 7.1.0 fold-in). **Learnt slash
commands (R19):** the runner's `SessionManager` hands every
`available_commands_update` to `onAvailableCommands` (and still forwards it on
the session stream unchanged); `AvailableCommandsStore`
(`agent-runner/src/sessions/available-commands.ts`) keeps the latest per agent,
normalized with packages' `normalizeAvailableCommands` minus the adapter's
`refusedPromptCommands` (Antigravity's `plan`, `logout`), in
`<RUNNER_CREDENTIAL_DIR>/available-commands.json` (0600, re-dated at most
hourly when unchanged, a refused name dropped again on load), and the
connected agent reports it as `availableCommands` + `availableCommandsLearntAt`
only while `coreAcceptsRouteBilling` (a 7.1 Core). **Supported agents (R21):**
`native/supported-agents.ts` projects all five agents on every heartbeat
(`supportedAgents`, only to a 7.1 Core, left out until the first detection
ended): a listed agent from its runner (`ready`; `needs_sign_in`, or
`sign_in_expired` when `NativeRunner.signInLost()` says a turn's auth failed or
a held credential needs signing in again; else `failed`) or from why it is
left out (`*_not_found` → `not_installed`, `*_unsupported_version` →
`unsupported_version` with the version the refusal names,
`antigravity_not_fetched` → `not_added`, `antigravity_unsupported_platform` →
`not_supported_on_this_os`, else `failed`); an agent the installation does not
list from `NotAddedAgentsDetector`, the locators onboarding uses (Claude's
executable and Codex's profile by file checks, dsh's package manifest,
OpenCode's manifest or one scrubbed `--version`, Antigravity's pin), run in
the background on the agent retry cadence (a minute, doubling to fifteen, back
to a minute on a change), never on the heartbeat path; `supportedRange` from
`bridges.ts`, install commands from `bridges.ts` (host agents) or the official
installers (Claude Code, Codex). **Direct work (R11, R13, R14, R16):** `direct`
is in `ALL_KINDS`, asked for in the pull only from a 7.1 Core.
`work/continued-session.ts` names what a direct prompt shares with an
Assistant turn (`continuedSession`: logical session, turn, `acpSessionRef`
continuation; `isNativeTurn`: Core's per-operation permits, one prompt per
assignment, closed at `end_turn`) and what sets it apart
(`isDirectAssignment`): `RelayedSession` puts no skills line or OpenCode /
Antigravity tools line before the person's text, redeems no platform
capability even when named, mounts no preview, browser or `konteks-result`
tool (a direct turn ends on `end_turn`), loads the agent's own transcript on a
restore, and judges file changes against the session's own folder
(`policyRoot()`; Konteks's own kinds keep the workspace root); the input
preparer stages no organization skill (`prepareDirectSessionInputs`), refuses
a repository selection and uses the session's stable private folder.
Host-agent governance, the blocked-command list, refused modes and commands
and sign-in declines are unchanged. **Connector commands (R20):**
`packages/release/src/connector-commands.json` (checked against
`createNativeProgram` by `launcher/src/__tests__/connector-commands.test.ts`:
every command, argument and option exists, and every command a person runs is
listed) travels inside the connector executable; `connectorCommandsManifest`
(`release/src/connector-commands.ts`) gives it the installed bundle version
(null, so left out, when it would not parse), and the heartbeat carries it as
`connectorCommands` (only to a 7.1 Core) on the first heartbeat Core accepts
from each runner incarnation and again only when it changes (Core keeps the
latest). It is also written with the release version as `commands.json` by
`release-assets.mjs commands`, shipped by the release job and required by
`verify`. There is no
`preview enable/disable` command: that switch is Core's.

Connector self-recovery (RCA 2026-09-30, `~/Projects/refactory/rca/`):
- A lapsed lease is never renewed in a running process (heartbeats and the
  relay both need a live one; only the startup reconnect, proved with the
  machine key, mints a new one). The liveness watchdog therefore asks the
  service manager to restart once the lease is gone and Core, reachable, has
  answered the 30 s configuration poll with 401/403 for two minutes
  (`leaseLapseNeedsRestart` in `heartbeat/liveness.ts`); only after a
  successful start, never for a revoked or suspended runtime.
- The unattended update installs only the release Core accepts, which needs a
  lease, except for a runtime Core refused as below its minimum (a
  `version_policy` or a refused startup reconnect, `update_required`): it
  installs the strictly newer signed release from the channel, at or above the
  minimum Core named (`mayUpdateWithoutAcceptedRelease`). The coordinator is
  built on demand (`ensureUpdates`), not only after a successful start.
- An update whose stop is not confirmed in time starts the unchanged release
  again once the OS no longer runs it.
- `serve` rewrites an existing service definition that differs from what the
  serving release renders (`keepServiceOnOwnDefinition`): the install
  launcher is never replaced and an updater is the previous release, so
  service-level changes (the log file) otherwise arrive late or never.
  Rewriting the file is not enough (RCA 2026-10-01: after an operator
  `konteks-remote update`, launchd ran the new release from the install
  launcher's plist, stdout and stderr on /dev/null, and KeepAlive respawns and
  `kickstart -k` reuse that loaded copy). When the service manager runs this
  very process and its loaded definition is not this one (just rewritten, a
  launch agent with no `stdout path` or another `program`, or systemd's
  `NeedDaemonReload=yes`), `serve` has it reload before starting anything:
  launchd by `bootout` + `bootstrap` from a detached `/bin/sh` whose output is
  appended to `logs/connector.log`, systemd by `daemon-reload` + `--no-block
  restart`. The service manager keeps owning the one supervisor; a foreground
  `serve` is never restarted; one reload per definition per 10 minutes
  (`supervisor/service-reload.json`), and a `serve` not stopped within 60 s
  starts anyway. Windows only rewrites the task file: `start` re-registers it.
- After the shared Codex owner starts, app-servers that older releases of this
  installation left on other sockets are ended once idle (or unreachable)
  (`reapStrayServers`); nothing outside `<root>/releases/` is touched.
- A repository role session (every review turn of a task reuses one QA
  delivery session, continuing the last completed turn's live ACP session)
  survives a turn that ends unfinished (production 2026-10-01: a cancelled
  review continuation blocked every later review with `recovery_required`
  / `local_execution_unprovable`, restart or not). When a `harness_delivery`
  session closes for any reason but `completed`, the orchestrator waits for
  the session's own close, proves the exact process gone with
  `stopRetainedExecution` and marks the execution `stopping` →
  `process_stopped` → `interrupted_unqualified` (`retireAfterClose`, the
  retained recovery stop's sequence). The next turn naming the completed turn
  then starts a fresh ACP session through
  `canStartFreshAfterRecoveredHarnessContinuation` once Core acknowledged the
  terminal report. Journals left behind by older releases (the continuation
  still `opened`) heal at the next turn's handoff
  (`retireUnfinishedHarnessContinuation`): only with a terminal, acknowledged
  claim, no local owner (session, bootstrap, dispatch, channel, recovery
  stop) and a proven process stop; otherwise the refusal stands. Generated
  changes in the working copy are kept; only the agent's in-session history
  is lost. Predecessor turns are matched by `invocationId` and
  `dispatchGeneration` only (`turnIdentity`), never their own nested
  predecessor.
- `doctor` has a `update-channel` line (unreadable channel fails, a
  `KONTEKS_RELEASE_MANIFEST_URL` override warns, no lease warns that updates
  wait), and `status` shows it through the separate `update.channel` op (never
  a new status field: older launchers parse `status` strictly).
- A native turn survives Core being slow or unreachable (D110,
  `native/execution-gate.ts`). An unanswered execution-lease renewal retries
  with backoff (1 s doubling to 30 s, no attempt cap) and the running agent
  keeps going; once the lease has lapsed only new dispatch waits for Core's
  next fresh check. The agent stops only when Core answers (`execution_fenced`,
  a denial, a durable revision fence), never on a timeout; a check lease that
  expired in transit is asked for again. `CoreClient.executionSigningKeys`
  serves the last key set Core confirmed (up to `SIGNING_KEY_STALE_MAX_MS`,
  never for an unknown key id) while its key endpoint fails, backing off
  between refreshes, and admission retries its keys while the permit is
  valid instead of dropping the relay socket. Each decision logs one line
  (`execution.renewal_retry_scheduled`, `execution.signing_keys_refresh_failed`,
  `execution.admission_keys_unavailable`).

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
