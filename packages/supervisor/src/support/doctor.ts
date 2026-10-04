import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { type DoctorCheck, type DoctorReport } from "@konteks/remote-common";

/**
 * Allowlisted doctor checks: versions, reachability, lease, components,
 * agents, disk, previews. Details carry statuses and
 * revisions — never a path, address, key, lease value, or raw probe output.
 */
interface DoctorInputs {
  now: () => string;
  dataDir: string;
  identity: { instanceId: string | null; administrativeStatus: string };
  lease: { mode: "active" | "drain_only" | "none"; expiresAt: string | null };
  relay: { state: string; lastError: string | null; consecutiveFailures: number };
  transport: "relay" | "https";
  reconciliationComplete: boolean;
  /** Why Core refused the last reconnect, in plain words; absent while nothing was refused. */
  reconciliationRefusal?: string;
  components: Array<{ kind: string; healthStatus: string; version: string }>;
  /** `startFailure`: the agent could not start and is tried again in the background. */
  agents: Array<{ agentId: string; readiness: string; recoveryAction?: string | undefined; startFailure?: string }>;
  /**
   * The agents this installation lists. Another agent reported here (the
   * site's "Not added" Google Antigravity card) is informational: `skip`,
   * never a failure. Absent: every reported agent is checked.
   */
  listedAgents?: readonly string[];
  configRevision: number;
  diskFreeBytes: number;
  minimumDiskBytes: number;
  outboxDepth: number;
  recoveryRequired: number;
  coreSignatureConfigured: boolean;
  /** Session previews: whether the capability is advertised, how many run, and the last failure's time. */
  preview?: { advertised: boolean; running: number; lastFailureAt: string | null };
  /**
   * The QA browser (a connector capability): its Playwright MCP version,
   * the agents whose sessions get it, whether Chrome is installed, the
   * package it comes from and the Node it runs on, or the plain reason there
   * is none.
   */
  browser?: { version: string | null; agents: string[]; chrome: boolean; packageAgent?: string; nodeSource?: "agent_package" | "person"; unavailable?: string };
  /**
   * The person's own OpenCode 2, when this installation lists it: the version and how it was installed, the start self-check, whether
   * it runs or is left out (and why, as a diagnostic id), what it is signed in
   * with (labels and states only), Core's free-models switch, and whether its
   * sessions get the QA browser.
   */
  openCode?: OpenCodeDoctorInputs;
  /**
   * Google Antigravity, when this installation lists it: the version this release pins and the download's state (downloaded from
   * Google, signature checked), the start check, whether it runs, is being
   * updated or is left out (and why), its sign-ins (labels, states, the
   * no-licence reason), a quarantine's line, the organisation's MCP Servers
   * setting as a Gemini Enterprise session showed it, disk used, and whether
   * its sessions get the QA browser. Never a path, the project or a secret.
   */
  antigravity?: AntigravityDoctorInputs;
  /**
   * The release channel the unattended update reads: its host, whether a
   * `KONTEKS_RELEASE_MANIFEST_URL` override replaces the public channel, and the
   * last check's time, error and newer release (a leftover override can point
   * a real connector at a dead local channel).
   */
  updateChannel?: { host: string; override: boolean; lastCheckedAt: string | null; lastError: string | null; available: string | null };
  /**
   * Windows: whether the `konteks-remote` command the MSI installed runs this
   * release's code (`windowsInstalledLauncher`); null without one.
   */
  launcher?: "current" | "older" | null;
}

type CheckDraft = Omit<DoctorCheck, "recoveryActions"> & { recoveryActions?: DoctorCheck["recoveryActions"] };

function updateChannelCheck(channel: NonNullable<DoctorInputs["updateChannel"]>, leaseMode: DoctorInputs["lease"]["mode"]): CheckDraft {
  const base = { id: "update-channel", title: "Release channel" };
  const where = channel.override ? `override ${channel.host} (KONTEKS_RELEASE_MANIFEST_URL)` : channel.host;
  if (channel.lastError) return { ...base, status: "fail", detail: channelUnreadable(channel, where), recoveryActions: [{ kind: "run_doctor" }] };
  if (channel.override) return { ...base, status: "warn", detail: `${where} replaces the public channel; updates come only from there` };
  // An unattended update installs only the release Konteks accepts, and asking needs a lease.
  const waiting = leaseMode === "none" ? "; automatic updates wait until this computer holds a lease again (`konteks-remote update` works now)" : "";
  const status = waiting ? "warn" : "pass";
  if (!channel.lastCheckedAt) return { ...base, status, detail: `${where}; not checked yet${waiting}` };
  return { ...base, status, detail: `${where}, checked ${channel.lastCheckedAt}${channel.available ? `; ${channel.available} available` : "; nothing newer"}${waiting}` };
}

function channelUnreadable(channel: NonNullable<DoctorInputs["updateChannel"]>, where: string): string {
  return `${where} could not be read: ${channel.lastError}; updates cannot arrive${channel.override ? ". Remove the override from this computer's service environment" : ""}`.slice(0, 1_024);
}

/** What happens next to an agent that is left out: retried in the background, or not any more. */
function retryNote(state: "running" | "retrying" | "given_up"): string {
  return state === "retrying" ? "it is tried again in the background, and the other agents keep running" : "it is no longer retried; restart the connector once it is fixed";
}

/** A refusal's diagnostic id in words, from a table of known ids. */
function describedFailure(table: Readonly<Record<string, string>>, failure: string | undefined): string {
  return failure !== undefined && Object.hasOwn(table, failure) ? table[failure]! : "it could not start (the connector log says why)";
}

export interface AntigravityDoctorInputs {
  state: "running" | "retrying" | "given_up";
  /** The version this connector release pins for this computer; null where Google publishes none. */
  pinnedVersion: string | null;
  /** The download's state (`HostAgentDownload.state`), when it could be read. */
  download?: "not_downloaded" | "downloading" | "ready" | "update_available" | "integrity_failed" | undefined;
  selfCheck: "passed" | "failed" | "not_run";
  /** The refusal's diagnostic id when it is left out (`antigravity_not_fetched`, …). */
  failure?: string | undefined;
  /** A runtime update's new pin is being fetched in the background. */
  updating: boolean;
  credentials: Array<{ label: string; state: string; method?: string | undefined; reason?: string | undefined }>;
  /** Why the tripwire took it out of service, or null. */
  quarantine: string | null;
  /** When a Gemini Enterprise session last had the Konteks MCP servers dropped by the organisation's settings, or null. */
  mcpServersOffAt: string | null;
  /** What the pinned copy takes on disk, when it is downloaded. */
  diskBytes: number | null;
  browser: boolean;
}

/** The Gemini Enterprise quarantine line (antigravity-tool-governance.ts `ANTIGRAVITY_ENTERPRISE_QUARANTINE_MESSAGE`), recognised by its setting. */
const REQUIRE_REVIEW = /Terminal auto-execution to Require review/;

const ANTIGRAVITY_SIGN_IN = "konteks-remote auth login antigravity --api-key, or --enterprise --project <project id>";
const BUSINESS_AI_CODE_API = "turn on the Business AI Code API with `gcloud services enable businessaicode.googleapis.com --project <project id>`, then sign in again with konteks-remote auth login antigravity --enterprise";

const ANTIGRAVITY_FAILURES: Readonly<Record<string, string>> = {
  antigravity_unsafe_install: "the downloaded copy does not match Google's release, so it never runs (konteks-remote agent add antigravity downloads it again)",
  antigravity_no_disk_space: "it needs about 1.2 GB free on this computer to download",
  antigravity_unsupported_platform: "Google publishes no copy of it for this computer yet",
  antigravity_self_check_failed: "its start check could not run",
};

/** Why Google Antigravity is left out, in words and without a path or a link (doctor output). */
function antigravityFailure(input: AntigravityDoctorInputs): string {
  if (input.failure === "antigravity_not_fetched") {
    return input.updating ? "it is being downloaded from Google again" : "it is not downloaded to this computer (konteks-remote agent add antigravity downloads it after you say yes)";
  }
  if (input.failure === "antigravity_unsupported_version") {
    return input.updating && input.pinnedVersion
      ? `this connector release runs ${input.pinnedVersion}, which is being downloaded from Google and checked before it is used`
      : "this connector release runs another version (konteks-remote agent add antigravity downloads it after you say yes)";
  }
  return describedFailure(ANTIGRAVITY_FAILURES, input.failure);
}

function antigravityCheck(input: AntigravityDoctorInputs): CheckDraft {
  const version = input.pinnedVersion ? `Google Antigravity ${input.pinnedVersion}` : "Google Antigravity";
  if (input.quarantine !== null) return antigravityQuarantined(input.quarantine, version);
  if (input.state !== "running") {
    return { ...ANTIGRAVITY_CHECK, status: "fail", detail: `${version} is not running Konteks work: ${antigravityFailure(input)}; ${retryNote(input.state)}`, recoveryActions: antigravityRecovery(input.failure) };
  }
  const usable = input.credentials.some(credential => credential.state === "ready");
  const mcpOff = enterpriseMcpOff(input);
  return {
    ...ANTIGRAVITY_CHECK,
    status: usable && !mcpOff ? "pass" : "warn",
    detail: antigravityDetail(input, version, mcpOff).join("; "),
    ...(usable ? {} : { recoveryActions: [{ kind: "login_agent", agentId: "antigravity" }] }),
  };
}

const ANTIGRAVITY_CHECK = { id: "antigravity", title: "Google Antigravity" };

function antigravityQuarantined(quarantine: string, version: string): CheckDraft {
  return { ...ANTIGRAVITY_CHECK, status: "fail",
    detail: REQUIRE_REVIEW.test(quarantine)
      ? `${version} was taken out of service. Needs your organisation's Require review setting: in Gemini Enterprise, Settings, AI developer tools, set "Terminal auto-execution: Require review", then restart the connector. ${quarantine}`
      : `${version} was taken out of service: ${quarantine}`,
    recoveryActions: [{ kind: "run_doctor" }] };
}

function antigravityRecovery(failure: string | undefined): DoctorCheck["recoveryActions"] {
  if (failure === "antigravity_no_disk_space") return [{ kind: "free_disk" as const, agentId: "antigravity" }];
  return failure === "antigravity_unsupported_platform" ? [] : [{ kind: "install_backend" as const, agentId: "antigravity" }];
}

/** A Gemini Enterprise sign-in in use whose session showed the organisation's MCP Servers setting off. */
function enterpriseMcpOff(input: AntigravityDoctorInputs): boolean {
  const first = input.credentials[0];
  return first?.method === "oauth-business" && first.state === "ready" && input.mcpServersOffAt !== null;
}

function antigravityCredential(credential: AntigravityDoctorInputs["credentials"][number]): string {
  if (credential.state === "ready") return credential.label;
  return credential.reason === "no_license" ? `${credential.label} (no licence found: ${BUSINESS_AI_CODE_API})` : `${credential.label} (needs sign-in)`;
}

function antigravitySignIns(input: AntigravityDoctorInputs): string {
  return input.credentials.length === 0 ? `not signed in (${ANTIGRAVITY_SIGN_IN})` : `signed in with ${input.credentials.map(antigravityCredential).join(", ")}`;
}

function antigravityDetail(input: AntigravityDoctorInputs, version: string, mcpOff: boolean): string[] {
  return [
    input.download === "ready" || input.download === undefined ? `${version}, downloaded from Google, signature checked` : version,
    input.selfCheck === "passed" ? "start check passed" : "start check not run yet",
    antigravitySignIns(input),
    ...(mcpOff ? [`Konteks tools unavailable: turn on MCP Servers in Gemini Enterprise settings (seen in a session at ${input.mcpServersOffAt}); until then results come back as text`] : []),
    ...(input.download === "update_available" ? ["a newer version is downloaded and is used from the next start"] : []),
    ...(input.diskBytes !== null ? [`${Math.round(input.diskBytes / 1_000_000)} MB on disk`] : []),
    input.browser ? "its sessions get the QA browser" : "no QA browser for its sessions",
  ];
}

export interface OpenCodeDoctorInputs {
  state: "running" | "retrying" | "given_up";
  version: string | null;
  installKind: string | null;
  selfCheck: "passed" | "failed" | "not_run";
  /** The refusal's diagnostic id when it is left out (`opencode_unsupported_version`, …). */
  failure?: string | undefined;
  credentials: Array<{ label: string; state: string }>;
  freeModels: boolean;
  browser: boolean;
}

/** Why OpenCode is left out, in words and without a path or a link (doctor output). */
const OPENCODE_FAILURES: Readonly<Record<string, string>> = {
  opencode_not_found: "OpenCode 2 is no longer installed where this computer found it; install it again from opencode.ai",
  opencode_unsupported_version: "the installed OpenCode is a version Konteks does not support (OpenCode 1, for example); install OpenCode 2 from opencode.ai",
  opencode_unsafe_install: "its installation can be changed by other users; reinstall it for this user only",
  opencode_unsupported_installation: "this OpenCode does not keep the Konteks settings; install a supported OpenCode 2 from opencode.ai",
  opencode_self_check_failed: "its Konteks settings check could not run",
};

function openCodeCheck(input: OpenCodeDoctorInputs): CheckDraft {
  const version = input.version ? `OpenCode ${input.version}${installedHow(input.installKind)}` : "OpenCode";
  if (input.state !== "running") {
    return { id: "opencode", title: "OpenCode", status: "fail", detail: `${version} is not running Konteks work: ${describedFailure(OPENCODE_FAILURES, input.failure)}; ${retryNote(input.state)}`, recoveryActions: [{ kind: "install_backend", agentId: "opencode" }] };
  }
  const usable = input.credentials.some(credential => credential.state === "ready") || input.freeModels;
  return {
    id: "opencode", title: "OpenCode",
    status: usable ? "pass" : "warn",
    detail: openCodeDetail(input, version).join("; "),
    ...(usable ? {} : { recoveryActions: [{ kind: "login_agent", agentId: "opencode" }] }),
  };
}

const OPENCODE_INSTALLS: Readonly<Record<string, string>> = {
  "another location": ", installed in a custom location",
  "homepage installer": ", installed with OpenCode's homepage installer",
};

function installedHow(installKind: string | null): string {
  if (installKind === null) return "";
  return Object.hasOwn(OPENCODE_INSTALLS, installKind) ? OPENCODE_INSTALLS[installKind]! : `, installed with ${installKind}`;
}

function openCodeDetail(input: OpenCodeDoctorInputs, version: string): string[] {
  const signIns = input.credentials.length === 0
    ? "not signed in to any provider (konteks-remote auth login opencode)"
    : `signed in with ${input.credentials.map(credential => credential.state === "ready" ? credential.label : `${credential.label} (needs sign-in)`).join(", ")}`;
  return [
    version,
    input.selfCheck === "passed" ? "Konteks settings check passed" : "Konteks settings not checked yet",
    signIns,
    input.freeModels ? "OpenCode Zen free models on" : "OpenCode Zen free models off",
    input.browser ? "its sessions get the QA browser" : "no QA browser for its sessions",
  ];
}

export async function runDoctor(inputs: DoctorInputs): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  for (const check of DOCTOR_CHECKS) {
    for (const found of await check(inputs)) checks.push({ recoveryActions: [], ...found });
  }
  return { checks, generatedAt: inputs.now() };
}

type DoctorCheckFn = (inputs: DoctorInputs) => CheckDraft[] | Promise<CheckDraft[]>;

async function dataRootCheck(inputs: DoctorInputs): Promise<CheckDraft[]> {
  let info: Stats;
  try {
    info = await stat(inputs.dataDir);
  } catch {
    return [{ id: "data-root", title: "Restricted data root", status: "fail", detail: "data root is missing", recoveryActions: [{ kind: "new_activation" }] }];
  }
  const permissive = process.platform !== "win32" && (info.mode & 0o077) !== 0;
  return [{ id: "data-root", title: "Restricted data root", status: permissive ? "fail" : "pass", detail: permissive ? "data root is readable by other users" : "data root permissions are restricted", ...(permissive ? { recoveryActions: [{ kind: "run_doctor" }] } : {}) }];
}

function identityCheck(inputs: DoctorInputs): CheckDraft[] {
  const registered = inputs.identity.instanceId;
  return [{ id: "identity", title: "Instance identity", status: registered ? "pass" : "fail", detail: registered ? `instance registered (${inputs.identity.administrativeStatus})` : "no instance identity; run install", ...(registered ? {} : { recoveryActions: [{ kind: "new_activation" }] }) }];
}

function leaseCheck({ lease }: DoctorInputs): CheckDraft[] {
  const status = lease.mode === "active" ? "pass" : lease.mode === "drain_only" ? "warn" : "fail";
  return [{ id: "lease", title: "Work lease", status, detail: lease.mode === "none" ? "no valid lease" : `lease mode ${lease.mode}${lease.expiresAt ? `, expires ${lease.expiresAt}` : ""}` }];
}

function relayCheck({ relay, transport }: DoctorInputs): CheckDraft[] {
  const connected = relay.state === "connected";
  const status = connected ? "pass" : transport === "https" ? "warn" : "fail";
  return [{ id: "relay", title: "Relay connection", status, detail: connected ? "one outbound WSS connected" : `relay ${relay.state}${relay.lastError ? ` (${relay.lastError})` : ""}; transport ${transport}` }];
}

function reconciliationCheck(inputs: DoctorInputs): CheckDraft[] {
  const complete = inputs.reconciliationComplete;
  return [{ id: "reconciliation", title: "Reconciliation", status: complete ? "pass" : "warn", detail: complete ? "reconciled with Core" : inputs.reconciliationRefusal ?? "waiting for Core reconciliation; no new work until it completes" }];
}

function componentChecks(inputs: DoctorInputs): CheckDraft[] {
  return inputs.components.map(component => ({ id: `component-${component.kind}`, title: `Component ${component.kind}`, status: healthCheckStatus(component.healthStatus), detail: `${component.healthStatus} (version ${component.version})` }));
}

function healthCheckStatus(health: string): DoctorCheck["status"] {
  if (health === "healthy") return "pass";
  return health === "degraded" ? "warn" : "fail";
}

function coreKeyCheck(inputs: DoctorInputs): CheckDraft[] {
  const configured = inputs.coreSignatureConfigured;
  return [{ id: "core-control-key", title: "Core control signing key", status: configured ? "pass" : "fail", detail: configured ? "release root certifies a Core control key" : "no Core control key in the embedded release roots; directives will be rejected", ...(configured ? {} : { recoveryActions: [{ kind: "update" }] }) }];
}

function agentChecks(inputs: DoctorInputs): CheckDraft[] {
  return inputs.agents.map(agent => agentCheck(agent, inputs.listedAgents));
}

function agentCheck(agent: DoctorInputs["agents"][number], listed: readonly string[] | undefined): CheckDraft {
  const base = { id: `agent-${agent.agentId}`, title: `Agent ${agent.agentId}` };
  if (listed && !listed.includes(agent.agentId)) return { ...base, status: "skip", detail: "not added on this computer" };
  const needsSignIn = agent.readiness === "not_configured" || agent.readiness === "reconnect_required";
  return { ...base, status: agentStatus(agent.readiness), detail: agent.startFailure ? `could not start (${agent.startFailure}); trying again in the background` : `readiness ${agent.readiness}`, ...(needsSignIn ? { recoveryActions: [{ kind: "login_agent", agentId: agent.agentId }] } : {}) };
}

function agentStatus(readiness: string): DoctorCheck["status"] {
  if (readiness === "ready") return "pass";
  return readiness === "not_configured" ? "warn" : "fail";
}

function diskCheck(inputs: DoctorInputs): CheckDraft[] {
  const enough = inputs.diskFreeBytes >= inputs.minimumDiskBytes;
  return [{ id: "disk", title: "Free disk", status: enough ? "pass" : "fail", detail: `${Math.round(inputs.diskFreeBytes / 1024 ** 3)} GiB free`, ...(enough ? {} : { recoveryActions: [{ kind: "free_disk" }] }) }];
}

function queueChecks(inputs: DoctorInputs): CheckDraft[] {
  return [
    { id: "outbox", title: "Durable outbox", status: inputs.outboxDepth === 0 ? "pass" : "warn", detail: `${inputs.outboxDepth} item(s) awaiting Core acknowledgement` },
    { id: "recovery", title: "Recovery required", status: inputs.recoveryRequired === 0 ? "pass" : "warn", detail: `${inputs.recoveryRequired} assignment(s) need recovery` },
  ];
}

function previewCheck(inputs: DoctorInputs): CheckDraft[] {
  if (!inputs.preview) return [];
  const { advertised, running, lastFailureAt } = inputs.preview;
  return [{ id: "preview", title: "Session previews",
    status: !advertised || lastFailureAt ? "warn" : "pass",
    detail: !advertised
      ? "preview capability not advertised (no relay configured), so nobody can open this computer's previews"
      : `preview capability advertised; ${running} preview(s) running${lastFailureAt ? `; the last preview failed to start at ${lastFailureAt} (see konteks-remote preview status)` : ""}` }];
}

/** The Node the QA browser runs on, in words; null when unknown. */
function browserNode(packageAgent: string | undefined, nodeSource: string | undefined): string | null {
  const packageName = packageAgent === "claude-code" ? "Claude Code" : packageAgent === "codex" ? "Codex" : null;
  if (nodeSource === "person") return "your own Node";
  return packageName ? `the Node in the ${packageName} package` : null;
}

function browserCheck(inputs: DoctorInputs): CheckDraft[] {
  if (!inputs.browser) return [];
  const { version, agents, chrome, packageAgent, nodeSource, unavailable } = inputs.browser;
  const node = browserNode(packageAgent, nodeSource);
  return [{ id: "browser", title: "QA browser",
    status: version === null ? "warn" : "pass",
    detail: version === null
      ? unavailable ?? "no QA browser on this computer, so QA and validator sessions check work without opening one"
      : `Playwright MCP ${version} for ${agents.join(", ")}${node ? `; runs on ${node}` : ""}; ${chrome ? "uses the installed Google Chrome" : "no Google Chrome, so Playwright's Chromium is installed on first use"}; reaches only the session's preview` }];
}

function agentFamilyChecks(inputs: DoctorInputs): CheckDraft[] {
  return [
    ...(inputs.openCode ? [openCodeCheck(inputs.openCode)] : []),
    ...(inputs.antigravity ? [antigravityCheck(inputs.antigravity)] : []),
  ];
}

function channelCheck(inputs: DoctorInputs): CheckDraft[] {
  return inputs.updateChannel ? [updateChannelCheck(inputs.updateChannel, inputs.lease.mode)] : [];
}

function launcherCheck(inputs: DoctorInputs): CheckDraft[] {
  if (inputs.launcher !== "older") return [];
  return [{ id: "launcher", title: "konteks-remote command", status: "warn", detail: "konteks-remote is from an older installer and runs its old code, not this release's. Update it once: run the Windows install line with -Update in place of -ActivationId." }];
}

function configCheck(inputs: DoctorInputs): CheckDraft[] {
  return [{ id: "config", title: "Desired configuration", status: inputs.configRevision > 0 ? "pass" : "warn", detail: `revision ${inputs.configRevision}` }];
}

/** Every check, in the order the report lists them. */
const DOCTOR_CHECKS: readonly DoctorCheckFn[] = [
  dataRootCheck, identityCheck, leaseCheck, relayCheck, reconciliationCheck, componentChecks, coreKeyCheck, agentChecks,
  diskCheck, queueChecks, previewCheck, browserCheck, agentFamilyChecks, channelCheck, launcherCheck, configCheck,
];
