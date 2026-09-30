import { stat } from "node:fs/promises";
import { RemoteInstanceError, type DoctorCheck, type DoctorReport } from "@konteks/remote-common";

/**
 * Allowlisted doctor checks: versions, reachability, lease, components,
 * agents, disk, previews. Details carry statuses and
 * revisions — never a path, address, key, lease value, or raw probe output.
 */
export interface DoctorInputs {
  now: () => string;
  dataDir: string;
  identity: { instanceId: string | null; administrativeStatus: string };
  lease: { mode: "active" | "drain_only" | "none"; expiresAt: string | null };
  relay: { state: string; lastError: string | null; consecutiveFailures: number };
  transport: "relay" | "https";
  reconciliationComplete: boolean;
  components: Array<{ kind: string; healthStatus: string; version: string }>;
  agents: Array<{ agentId: string; readiness: string; recoveryAction?: string | undefined }>;
  configRevision: number;
  diskFreeBytes: number;
  minimumDiskBytes: number;
  outboxDepth: number;
  recoveryRequired: number;
  coreSignatureConfigured: boolean;
  /** Session previews: whether the capability is advertised, how many run, and the last failure's time. */
  preview?: { advertised: boolean; running: number; lastFailureAt: string | null };
  /**
   * The QA browser (a connector capability, O8): its Playwright MCP version,
   * the agents whose sessions get it, whether Chrome is installed, the
   * package it comes from and the Node it runs on, or the plain reason there
   * is none.
   */
  browser?: { version: string | null; agents: string[]; chrome: boolean; packageAgent?: string; nodeSource?: "agent_package" | "person"; unavailable?: string };
  /**
   * The person's own OpenCode 2, when this installation lists it (opencode
   * CP6): the version and how it was installed, the start self-check, whether
   * it runs or is left out (and why, as a diagnostic id), what it is signed in
   * with (labels and states only), Core's free-models switch, and whether its
   * sessions get the QA browser.
   */
  openCode?: OpenCodeDoctorInputs;
  /**
   * Google Antigravity, when this installation lists it (antigravity CP6):
   * the version this release pins and the download's state (downloaded from
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
   * last check's time, error and newer release (RCA 2026-09-30: a leftover
   * override pointed a real connector at a dead local channel and only
   * `update --check` said so).
   */
  updateChannel?: { host: string; override: boolean; lastCheckedAt: string | null; lastError: string | null; available: string | null };
}

function updateChannelCheck(channel: NonNullable<DoctorInputs["updateChannel"]>, leaseMode: DoctorInputs["lease"]["mode"]): Omit<DoctorCheck, "recoveryActions"> & { recoveryActions?: DoctorCheck["recoveryActions"] } {
  const base = { id: "update-channel", title: "Release channel" };
  const where = channel.override ? `override ${channel.host} (KONTEKS_RELEASE_MANIFEST_URL)` : channel.host;
  if (channel.lastError) return { ...base, status: "fail", detail: `${where} could not be read: ${channel.lastError}; updates cannot arrive${channel.override ? ". Remove the override from this computer's service environment" : ""}`.slice(0, 1_024), recoveryActions: [{ kind: "run_doctor" }] };
  if (channel.override) return { ...base, status: "warn", detail: `${where} replaces the public channel; updates come only from there` };
  // An unattended update installs only the release Konteks accepts, and asking needs a lease.
  const waiting = leaseMode === "none" ? "; automatic updates wait until this computer holds a lease again (`konteks-remote update` works now)" : "";
  if (!channel.lastCheckedAt) return { ...base, status: waiting ? "warn" : "pass", detail: `${where}; not checked yet${waiting}` };
  return { ...base, status: waiting ? "warn" : "pass", detail: `${where}, checked ${channel.lastCheckedAt}${channel.available ? `; ${channel.available} available` : "; nothing newer"}${waiting}` };
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
  /** A runtime update's new pin is being fetched in the background (A17). */
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

/** The A21 quarantine line (antigravity-tool-governance.ts `ANTIGRAVITY_ENTERPRISE_QUARANTINE_MESSAGE`), recognised by its setting. */
const REQUIRE_REVIEW = /Terminal auto-execution to Require review/;

const ANTIGRAVITY_SIGN_IN = "konteks-remote auth login antigravity --api-key, or --enterprise --project <project id>";
const BUSINESS_AI_CODE_API = "turn on the Business AI Code API with `gcloud services enable businessaicode.googleapis.com --project <project id>`, then sign in again with konteks-remote auth login antigravity --enterprise";

/** Why Google Antigravity is left out, in words and without a path or a link (doctor output). */
function antigravityFailure(input: AntigravityDoctorInputs): string {
  switch (input.failure) {
    case "antigravity_not_fetched":
      return input.updating ? "it is being downloaded from Google again" : "it is not downloaded to this computer (konteks-remote agent add antigravity downloads it after you say yes)";
    case "antigravity_unsupported_version":
      return input.updating && input.pinnedVersion
        ? `this connector release runs ${input.pinnedVersion}, which is being downloaded from Google and checked before it is used`
        : "this connector release runs another version (konteks-remote agent add antigravity downloads it after you say yes)";
    case "antigravity_unsafe_install":
      return "the downloaded copy does not match Google's release, so it never runs (konteks-remote agent add antigravity downloads it again)";
    case "antigravity_no_disk_space":
      return "it needs about 1.2 GB free on this computer to download";
    case "antigravity_unsupported_platform":
      return "Google publishes no copy of it for this computer yet";
    case "antigravity_self_check_failed":
      return "its start check could not run";
    default:
      return "it could not start (the connector log says why)";
  }
}

function antigravityCheck(input: AntigravityDoctorInputs): Omit<DoctorCheck, "recoveryActions"> & { recoveryActions?: DoctorCheck["recoveryActions"] } {
  const base = { id: "antigravity", title: "Google Antigravity" };
  const version = input.pinnedVersion ? `Google Antigravity ${input.pinnedVersion}` : "Google Antigravity";
  if (input.quarantine !== null) {
    const enterprise = REQUIRE_REVIEW.test(input.quarantine);
    return { ...base, status: "fail",
      detail: enterprise
        ? `${version} was taken out of service. Needs your organisation's Require review setting: in Gemini Enterprise, Settings, AI developer tools, set "Terminal auto-execution: Require review", then restart the connector. ${input.quarantine}`
        : `${version} was taken out of service: ${input.quarantine}`,
      recoveryActions: [{ kind: "run_doctor" }] };
  }
  if (input.state !== "running") {
    const next = input.state === "retrying" ? "it is tried again in the background, and the other agents keep running" : "it is no longer retried; restart the connector once it is fixed";
    const action = input.failure === "antigravity_no_disk_space" ? [{ kind: "free_disk" as const, agentId: "antigravity" }]
      : input.failure === "antigravity_unsupported_platform" ? []
        : [{ kind: "install_backend" as const, agentId: "antigravity" }];
    return { ...base, status: "fail", detail: `${version} is not running Konteks work: ${antigravityFailure(input)}; ${next}`, recoveryActions: action };
  }
  const ready = input.credentials.filter(credential => credential.state === "ready");
  const named = (credential: AntigravityDoctorInputs["credentials"][number]) => credential.state === "ready" ? credential.label
    : credential.reason === "no_license" ? `${credential.label} (no licence found: ${BUSINESS_AI_CODE_API})` : `${credential.label} (needs sign-in)`;
  const signIns = input.credentials.length === 0 ? `not signed in (${ANTIGRAVITY_SIGN_IN})` : `signed in with ${input.credentials.map(named).join(", ")}`;
  const enterpriseInUse = input.credentials[0]?.method === "oauth-business" && input.credentials[0]?.state === "ready";
  const mcpOff = enterpriseInUse && input.mcpServersOffAt !== null;
  const usable = ready.length > 0;
  return {
    ...base,
    status: usable && !mcpOff ? "pass" : "warn",
    detail: [
      input.download === "ready" || input.download === undefined ? `${version}, downloaded from Google, signature checked` : version,
      input.selfCheck === "passed" ? "start check passed" : "start check not run yet",
      signIns,
      ...(mcpOff ? [`Konteks tools unavailable: turn on MCP Servers in Gemini Enterprise settings (seen in a session at ${input.mcpServersOffAt}); until then results come back as text`] : []),
      ...(input.download === "update_available" ? ["a newer version is downloaded and is used from the next start"] : []),
      ...(input.diskBytes !== null ? [`${Math.round(input.diskBytes / 1_000_000)} MB on disk`] : []),
      input.browser ? "its sessions get the QA browser" : "no QA browser for its sessions",
    ].join("; "),
    ...(usable ? {} : { recoveryActions: [{ kind: "login_agent", agentId: "antigravity" }] }),
  };
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
const OPENCODE_FAILURES: Record<string, string> = {
  opencode_not_found: "OpenCode 2 is no longer installed where this computer found it; install it again from opencode.ai",
  opencode_unsupported_version: "the installed OpenCode is a version Konteks does not support (OpenCode 1, for example); install OpenCode 2 from opencode.ai",
  opencode_unsafe_install: "its installation can be changed by other users; reinstall it for this user only",
  opencode_unsupported_installation: "this OpenCode does not keep the Konteks settings; install a supported OpenCode 2 from opencode.ai",
  opencode_self_check_failed: "its Konteks settings check could not run",
};

function openCodeCheck(input: OpenCodeDoctorInputs): Omit<DoctorCheck, "recoveryActions"> & { recoveryActions?: DoctorCheck["recoveryActions"] } {
  const how = input.installKind === null ? "" : input.installKind === "another location" ? ", installed in a custom location" : input.installKind === "homepage installer" ? ", installed with OpenCode's homepage installer" : `, installed with ${input.installKind}`;
  const version = input.version ? `OpenCode ${input.version}${how}` : "OpenCode";
  if (input.state !== "running") {
    const why = (input.failure && OPENCODE_FAILURES[input.failure]) ?? "it could not start (the connector log says why)";
    const next = input.state === "retrying" ? "it is tried again in the background, and the other agents keep running" : "it is no longer retried; restart the connector once it is fixed";
    return { id: "opencode", title: "OpenCode", status: "fail", detail: `${version} is not running Konteks work: ${why}; ${next}`, recoveryActions: [{ kind: "install_backend", agentId: "opencode" }] };
  }
  const ready = input.credentials.filter(credential => credential.state === "ready");
  const signIns = input.credentials.length === 0
    ? "not signed in to any provider (konteks-remote auth login opencode)"
    : `signed in with ${input.credentials.map(credential => credential.state === "ready" ? credential.label : `${credential.label} (needs sign-in)`).join(", ")}`;
  const usable = ready.length > 0 || input.freeModels;
  return {
    id: "opencode", title: "OpenCode",
    status: usable ? "pass" : "warn",
    detail: [
      version,
      input.selfCheck === "passed" ? "Konteks settings check passed" : "Konteks settings not checked yet",
      signIns,
      input.freeModels ? "OpenCode Zen free models on" : "OpenCode Zen free models off",
      input.browser ? "its sessions get the QA browser" : "no QA browser for its sessions",
    ].join("; "),
    ...(usable ? {} : { recoveryActions: [{ kind: "login_agent", agentId: "opencode" }] }),
  };
}

export async function runDoctor(inputs: DoctorInputs): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const push = (check: Omit<DoctorCheck, "recoveryActions"> & { recoveryActions?: DoctorCheck["recoveryActions"] }): void => {
    checks.push({ recoveryActions: [], ...check });
  };

  try {
    const info = await stat(inputs.dataDir);
    const permissive = process.platform !== "win32" && (info.mode & 0o077) !== 0;
    push({ id: "data-root", title: "Restricted data root", status: permissive ? "fail" : "pass", detail: permissive ? "data root is readable by other users" : "data root permissions are restricted", ...(permissive ? { recoveryActions: [{ kind: "run_doctor" }] } : {}) });
  } catch {
    push({ id: "data-root", title: "Restricted data root", status: "fail", detail: "data root is missing", recoveryActions: [{ kind: "new_activation" }] });
  }

  push({ id: "identity", title: "Instance identity", status: inputs.identity.instanceId ? "pass" : "fail", detail: inputs.identity.instanceId ? `instance registered (${inputs.identity.administrativeStatus})` : "no instance identity; run install", ...(inputs.identity.instanceId ? {} : { recoveryActions: [{ kind: "new_activation" }] }) });
  push({ id: "lease", title: "Work lease", status: inputs.lease.mode === "active" ? "pass" : inputs.lease.mode === "drain_only" ? "warn" : "fail", detail: inputs.lease.mode === "none" ? "no valid lease" : `lease mode ${inputs.lease.mode}${inputs.lease.expiresAt ? `, expires ${inputs.lease.expiresAt}` : ""}` });
  push({ id: "relay", title: "Relay connection", status: inputs.relay.state === "connected" ? "pass" : inputs.transport === "https" ? "warn" : "fail", detail: inputs.relay.state === "connected" ? "one outbound WSS connected" : `relay ${inputs.relay.state}${inputs.relay.lastError ? ` (${inputs.relay.lastError})` : ""}; transport ${inputs.transport}` });
  push({ id: "reconciliation", title: "Reconciliation", status: inputs.reconciliationComplete ? "pass" : "warn", detail: inputs.reconciliationComplete ? "reconciled with Core" : "waiting for Core reconciliation; no new work until it completes" });
  for (const component of inputs.components) {
    push({ id: `component-${component.kind}`, title: `Component ${component.kind}`, status: component.healthStatus === "healthy" ? "pass" : component.healthStatus === "degraded" ? "warn" : "fail", detail: `${component.healthStatus} (version ${component.version})` });
  }
  push({ id: "core-control-key", title: "Core control signing key", status: inputs.coreSignatureConfigured ? "pass" : "fail", detail: inputs.coreSignatureConfigured ? "release root certifies a Core control key" : "no Core control key in the embedded release roots; directives will be rejected", ...(inputs.coreSignatureConfigured ? {} : { recoveryActions: [{ kind: "update" }] }) });
  for (const agent of inputs.agents) {
    push({ id: `agent-${agent.agentId}`, title: `Agent ${agent.agentId}`, status: agent.readiness === "ready" ? "pass" : agent.readiness === "not_configured" ? "warn" : "fail", detail: `readiness ${agent.readiness}`, ...(agent.readiness === "not_configured" || agent.readiness === "reconnect_required" ? { recoveryActions: [{ kind: "login_agent", agentId: agent.agentId }] } : {}) });
  }
  push({ id: "disk", title: "Free disk", status: inputs.diskFreeBytes >= inputs.minimumDiskBytes ? "pass" : "fail", detail: `${Math.round(inputs.diskFreeBytes / 1024 ** 3)} GiB free`, ...(inputs.diskFreeBytes >= inputs.minimumDiskBytes ? {} : { recoveryActions: [{ kind: "free_disk" }] }) });
  push({ id: "outbox", title: "Durable outbox", status: inputs.outboxDepth === 0 ? "pass" : "warn", detail: `${inputs.outboxDepth} item(s) awaiting Core acknowledgement` });
  push({ id: "recovery", title: "Recovery required", status: inputs.recoveryRequired === 0 ? "pass" : "warn", detail: `${inputs.recoveryRequired} assignment(s) need recovery` });
  if (inputs.preview) {
    const { advertised, running, lastFailureAt } = inputs.preview;
    push({ id: "preview", title: "Session previews",
      status: !advertised || lastFailureAt ? "warn" : "pass",
      detail: !advertised
        ? "preview capability not advertised (no relay configured), so nobody can open this computer's previews"
        : `preview capability advertised; ${running} preview(s) running${lastFailureAt ? `; the last preview failed to start at ${lastFailureAt} (see konteks-remote preview status)` : ""}` });
  }
  if (inputs.browser) {
    const { version, agents, chrome, packageAgent, nodeSource, unavailable } = inputs.browser;
    const packageName = packageAgent === "claude-code" ? "Claude Code" : packageAgent === "codex" ? "Codex" : null;
    const node = nodeSource === "person" ? "your own Node" : packageName ? `the Node in the ${packageName} package` : null;
    push({ id: "browser", title: "QA browser",
      status: version === null ? "warn" : "pass",
      detail: version === null
        ? unavailable ?? "no QA browser on this computer, so QA and validator sessions check work without opening one"
        : `Playwright MCP ${version} for ${agents.join(", ")}${node ? `; runs on ${node}` : ""}; ${chrome ? "uses the installed Google Chrome" : "no Google Chrome, so Playwright's Chromium is installed on first use"}; reaches only the session's preview` });
  }
  if (inputs.openCode) push(openCodeCheck(inputs.openCode));
  if (inputs.antigravity) push(antigravityCheck(inputs.antigravity));
  if (inputs.updateChannel) push(updateChannelCheck(inputs.updateChannel, inputs.lease.mode));
  push({ id: "config", title: "Desired configuration", status: inputs.configRevision > 0 ? "pass" : "warn", detail: `revision ${inputs.configRevision}` });
  return { checks, generatedAt: inputs.now() };
}

export function assertDoctorHasNoSecrets(report: DoctorReport): void {
  const text = JSON.stringify(report);
  if (/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(text)) {
    throw new RemoteInstanceError("local_io_failure", "doctor report would contain a path");
  }
}
