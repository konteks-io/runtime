import { z } from "zod";
import { DoctorReportSchema, PreviewStatusReportSchema, RemoteInstanceError, SupervisorStatusSchema, UpdateChannelReportSchema, type ControlLoginEvent, type UpdateChannelReport } from "@konteks/remote-common";
import type { SupervisorControl } from "../control.js";
import { isHostAgentId } from "@konteks/remote-release";
import { AlreadyToldError, type Output } from "../output.js";
import { confirm, promptLine, promptSecret } from "../prompt.js";
import { outputLocale, setupError, setupLine, setupWords } from "../setup-locale.js";
import { agentName } from "./agent-name.js";

/**
 * The launcher's control-socket commands for the installed native connector
 * (`status`, `agents`, `auth …`, `git key …`, `doctor`, `support`). Each talks
 * to the supervisor over the loopback control socket only; none accepts a
 * general command passthrough.
 */
export interface ControlContext {
  output: Output;
  control: Pick<SupervisorControl, "call">;
  input?: NodeJS.ReadableStream;
  /** Test hooks. */
  confirm?: (question: string) => Promise<boolean>;
  promptSecret?: (label: string) => Promise<string>;
  /** Test hook: a choice typed in the open. */
  promptLine?: (label: string) => Promise<string>;
  /** Run in the window the site opened (KONTEKS_ON_COMPUTER=1): the last line also says the window can close. */
  onComputer?: boolean;
}

const AgentsSchema = z.object({ agents: z.array(z.record(z.string(), z.unknown())), roles: z.array(z.string()), roleBindings: z.array(z.record(z.string(), z.unknown())) }).strict();

/** Where updates come from, and whether they can: an unreadable or overridden channel is said plainly. */
function releaseChannelLine(channel: NonNullable<UpdateChannelReport>): string {
  const where = channel.override ? `${channel.host} (override: KONTEKS_RELEASE_MANIFEST_URL)` : channel.host;
  if (channel.error) return `${where} — cannot be read, no update can arrive: ${channel.error}`;
  return `${where}${channel.lastCheckedAt ? `, checked ${channel.lastCheckedAt}` : ", not checked yet"}`;
}

export async function status(context: ControlContext): Promise<void> {
  const value = await context.control.call({ op: "status" }, SupervisorStatusSchema);
  // A connector from before `update.channel` refuses the op: the line is simply left out.
  const channel = await context.control.call({ op: "update.channel" }, UpdateChannelReportSchema).catch(() => null);
  // `lease` is intentionally bearer-redacted by generic output. Publish a
  // separate, explicit public summary; never exempt bearer fields from redaction.
  context.output.result({ ...value, leaseStatus: { mode: value.lease.mode, expiresAt: value.lease.expiresAt, drainDeadline: value.lease.drainDeadline } });
  context.output.table([
    ["instance", value.instanceId ?? "(not activated)"],
    ["status", value.administrativeStatus],
    ["connectivity", connectivityLine(value.connectivity)],
    ["lease", `${value.lease.mode}${value.lease.expiresAt ? `, expires ${value.lease.expiresAt}` : ""}`],
    ["bundle", bundleLine(value.version)],
    ...(channel ? [["updates", releaseChannelLine(channel)] as [string, string]] : []),
    ["roles", value.roles.join(", ") || "(none advertised — log in an agent and tag roles in App/MCP)"],
    ["utilization", utilizationLine(value.utilization)],
    ["components", value.components.map((component) => `${component.kind}=${component.healthStatus}`).join(" ")],
    ["preview", previewExposureLine(value)],
    ["journal", `${value.journal.assignments} active, ${value.journal.outboxDepth} queued, ${value.journal.recoveryRequired} recovery required`],
  ]);
}

type SupervisorStatus = z.infer<typeof SupervisorStatusSchema>;

function connectivityLine(connectivity: SupervisorStatus["connectivity"]): string {
  return `${connectivity.transport}${connectivity.relayConnected ? " (relay connected)" : ""}${connectivity.reconciliationComplete ? "" : " — reconciling"}`;
}

function bundleLine(version: SupervisorStatus["version"]): string {
  return `${version.bundle} (protocol ${version.protocol})${version.updateAvailable ? ` — update available: ${version.targetBundle}` : ""}`;
}

function utilizationLine(utilization: SupervisorStatus["utilization"]): string {
  return `${utilization.activeSessions} sessions, ${utilization.activeTurns} turns, ratio ${utilization.utilizationRatio}${utilization.acceptingWork ? "" : " — not accepting work"}`;
}

function previewExposureLine(value: SupervisorStatus): string {
  if (!value.previewEnabled) return "none running";
  return `running on 127.0.0.1:${value.previewExposure?.port ?? "?"}${value.previewExposure?.grantPresent ? " (a viewer is connected)" : ""}`;
}

/** `preview status`: read-only; the per-machine on/off switch lives in Konteks. */
export async function previewStatus(context: ControlContext): Promise<void> {
  const value = await context.control.call({ op: "preview.status" }, PreviewStatusReportSchema);
  context.output.result(value);
  context.output.line(value.capabilityAdvertised
    ? `Previews: served from this computer (at most ${value.maxRunning} at once, each stops after ${value.idleStopMinutes} idle minutes). Switch them off for this computer in Konteks: Customize → Runtimes.`
    : "Previews: not offered (this connector has no relay connection configured).");
  if (value.previews.length === 0) context.output.line("No session preview is running now.");
  for (const preview of value.previews) {
    for (const line of previewLines(preview)) context.output.line(line);
  }
  if (value.lastFailure) context.output.line(`Last failure (${value.lastFailure.at}): ${value.lastFailure.message}`);
}

function previewLines(preview: z.infer<typeof PreviewStatusReportSchema>["previews"][number]): string[] {
  return [
    `${preview.sessionId}: ${preview.state}${preview.url ? ` at ${preview.url}` : ""}${preview.startedBy === "viewer" ? " (started by a viewer)" : ""}${preview.viewerConnected ? " (a viewer is connected)" : ""}`,
    ...(preview.command ? [`  command: ${preview.command}${preview.explanation ? ` — ${preview.explanation}` : ""}`] : []),
    `  ${preview.message}`,
  ];
}

export async function agents(context: ControlContext): Promise<void> {
  const value = await context.control.call({ op: "agents" }, AgentsSchema);
  context.output.result(value);
  for (const agent of value.agents as Array<Record<string, string>>) {
    if (agent.startFailure) { context.output.line(`${agent.agentId}: could not start (${agent.startFailure}); trying again in the background`); continue; }
    context.output.line(`${agent.agentId}: ${agent.readiness} (${agent.authMode}, scope ${agent.accountScope})${agent.recoveryAction ? ` — ${agent.recoveryAction}` : ""}${downloadNote(agent)}`);
  }
  context.output.line(`advertised roles: ${value.roles.join(", ") || "(none)"}`);
}

/** A fetched agent's download state (Google Antigravity), in words, with the command that changes it. */
function downloadNote(agent: Record<string, unknown>): string {
  const state = (agent.hostAgentDownload as { state?: unknown } | undefined)?.state;
  const add = `konteks-remote agent add ${String(agent.agentId)}`;
  switch (state) {
    case "not_downloaded": return ` — not downloaded (${add})`;
    case "downloading": return " — downloading from Google";
    case "update_available": return " — a newer version is downloaded and used from the next start";
    case "integrity_failed": return ` — does not match Google's release (${add})`;
    default: return "";
  }
}

export async function authStatus(context: ControlContext, agentId?: string): Promise<void> {
  const value = await context.control.call({ op: "auth.status", ...(agentId ? { agentId } : {}) }, z.object({ agents: z.array(z.record(z.string(), z.unknown())) }).strict());
  context.output.result(value);
  for (const agent of value.agents as Array<Record<string, string>>) context.output.line(`${agent.agentId}: ${agent.readiness}, scope ${agent.accountScope}${agent.scopeAttestedAt ? ` (attested ${agent.scopeAttestedAt})` : ""}`);
}

/**
 * `auth login <agent> [--organization]`: the official tooling's interaction is
 * relayed through the supervisor; URLs and device codes are shown clearly,
 * pasted input is read from the terminal and forwarded without echo when the
 * tool asks for a secret. `--organization` records the operator's attestation.
 */
export async function authLogin(context: ControlContext, agentId: string, organization: boolean, which: { provider?: string; method?: string; reuse?: boolean; project?: string; location?: string } = {}): Promise<void> {
  const prompts = loginPrompts(context);
  if (organization) {
    const ok = await prompts.ask(setupWords(context.output, "organizationAttestation", { agent: agentId }));
    if (!ok) throw setupError("ownership_promotion_denied", "organizationDeclined");
  }
  if (agentId === "claude-code") {
    setupLine(context.output, "claudeLoginConnecting");
    setupLine(context.output, "claudeLoginSteps");
    setupLine(context.output, "claudeLoginRecovery");
  }
  const relay = new LoginRelay(context, prompts, agentName(agentId), organization);
  try {
    await context.control.call({ op: "auth.login", agentId, organization, ...which }, z.object({ loginId: z.string() }), { onEvent: event => relay.onEvent(event), signal: relay.interrupted.signal, timeoutMs: 20 * 60_000 });
  } catch (error) {
    if (relay.promptError !== null) throw relay.promptError;
    throw error;
  }
  if (relay.loginFailure !== null) throw relay.failureError(agentId, relay.loginFailure);
}

interface LoginPrompts {
  ask: (question: string) => Promise<boolean>;
  secret: (label: string) => Promise<string>;
  line: (label: string) => Promise<string>;
}

function loginPrompts(context: ControlContext): LoginPrompts {
  const input = { ...(context.input ? { input: context.input } : {}), locale: outputLocale(context.output) };
  return {
    ask: context.confirm ?? ((question: string) => confirm(question, input)),
    secret: context.promptSecret ?? ((label: string) => promptSecret({ label, minLength: 1, ...input })),
    line: context.promptLine ?? ((label: string) => promptLine(label, input)),
  };
}

/** Relays one sign-in's events: lines and links shown, prompts answered, the outcome kept. */
class LoginRelay {
  readonly interrupted = new AbortController();
  promptError: unknown = null;
  loginFailure: Extract<ControlLoginEvent, { kind: "failed" }> | null = null;
  private promptsOpen = 0;
  /** The flow's own last line since the last prompt. */
  private lastLine: string | null = null;
  private readonly inWindow: boolean;

  constructor(private readonly context: ControlContext, private readonly prompts: LoginPrompts, private readonly name: string, private readonly organization: boolean) {
    this.inWindow = context.onComputer ?? process.env.KONTEKS_ON_COMPUTER === "1";
  }

  onEvent(event: ControlLoginEvent): void {
    switch (event.kind) {
      case "started": return this.started(event.agentId);
      case "display":
        this.context.output.line(event.text);
        this.lastLine = event.text;
        return;
      case "open_url":
        setupLine(this.context.output, "signInOpenUrl", { url: event.url, code: event.userCode ? setupWords(this.context.output, "signInEnterCode", { code: event.userCode }) : "" });
        return;
      case "prompt": return this.prompt(event);
      case "completed": return this.completed(event.readiness);
      case "failed":
        this.loginFailure = event;
        return;
    }
  }

  /**
   * An agent the connector asks for itself (a key, a provider) says what to
   * do in its own lines; a start line there would land on the hidden key
   * prompt. Only an agent whose own sign-in takes over gets one, and never
   * over an open prompt.
   */
  private started(agentId: string): void {
    if (!isHostAgentId(agentId) && this.promptsOpen === 0) setupLine(this.context.output, "signInStarting", { name: agentName(agentId) });
  }

  /** A choice (OpenCode's provider) is typed in the open; anything else, an API key included, with the hidden prompt, never echoed. */
  private prompt(event: Extract<ControlLoginEvent, { kind: "prompt" }>): void {
    this.promptsOpen += 1;
    this.lastLine = null;
    void (event.visible === true && !event.secret ? this.prompts.line(event.label) : this.prompts.secret(event.label))
      .finally(() => { this.promptsOpen -= 1; })
      .then((text) => this.context.control.call({ op: "auth.input", loginId: event.loginId, text }, z.unknown()))
      .catch((error: unknown) => { this.promptError = error; this.interrupted.abort(); });
  }

  private completed(readiness: string): void {
    this.context.output.line(setupWords(this.context.output, readiness === "ready" ? "signInReady" : "signInNotReady", { name: this.name, organization: this.organization ? setupWords(this.context.output, "signInOrganization") : "" }) + (this.inWindow ? setupWords(this.context.output, "closeWindow") : ""));
  }

  /**
   * A connector-asked sign-in ends a failure with one plain line (what is
   * wrong, what to do); a coded second line would only repeat it. A
   * progress line ("Checking the key…") explains nothing, so the error shows.
   */
  failureError(agentId: string, failure: Extract<ControlLoginEvent, { kind: "failed" }>): RemoteInstanceError {
    const last = this.lastLine;
    const told = isHostAgentId(agentId) && last !== null && !last.endsWith("…");
    return told ? new AlreadyToldError("agent_auth_required", failure.message) : new RemoteInstanceError("agent_auth_required", failure.message);
  }
}

export async function authLogout(context: ControlContext, agentId: string, provider?: string, method?: string): Promise<void> {
  const value = await context.control.call({ op: "auth.logout", agentId, ...(provider ? { provider } : {}), ...(method ? { method } : {}) }, z.record(z.string(), z.unknown()));
  context.output.result(value);
  context.output.line(`${agentName(agentId)} is signed out${provider ? ` of ${provider}` : ""} on this computer${value.readiness === "ready" ? "; its other sign-ins stay" : ""}.`);
}

/**
 * `git key add [--title]`: the runtime generates (or reuses) an
 * ed25519 key, registers its PUBLIC half through Core, and writes an SSH config
 * stanza for the managed host. The private half never leaves the machine, which
 * is why this is a launcher command on the trusted machine and not a field in
 * the App.
 */
export async function gitKeyAdd(context: ControlContext, title?: string): Promise<void> {
  const value = await context.control.call(
    { op: "git.key.add", ...(title ? { title } : {}) },
    z.object({ keyRef: z.string(), title: z.string(), fingerprint: z.string(), host: z.string(), sshConfig: z.string() }).strict(),
  );
  context.output.result(value);
  context.output.line(`registered ${value.fingerprint} as "${value.title}" for ${value.host}`);
  context.output.line("the private key stays on this machine and is never shown, uploaded or backed up");
  context.output.line(`to clone managed repositories by hand with the same key, add this line to ~/.ssh/config:\n  Include ${value.sshConfig}`);
}

export async function gitKeyList(context: ControlContext): Promise<void> {
  const value = await context.control.call(
    { op: "git.key.list" },
    z.object({ keys: z.array(z.object({ keyRef: z.string(), title: z.string(), fingerprint: z.string(), createdAt: z.string(), revokedAt: z.string().optional() }).strict()) }).strict(),
  );
  context.output.result(value);
  if (value.keys.length === 0) {
    context.output.line("no managed git key is registered for this runtime; run `konteks-remote git key add`");
    return;
  }
  for (const key of value.keys) context.output.line(`${key.keyRef}: ${key.fingerprint} "${key.title}" (added ${key.createdAt})${key.revokedAt ? ` — revoked ${key.revokedAt}` : ""}`);
}

export async function gitKeyRemove(context: ControlContext, keyRef: string): Promise<void> {
  await context.control.call({ op: "git.key.remove", keyRef }, z.unknown());
  context.output.line(`revoked ${keyRef}; managed repositories no longer accept this runtime's key. Removing the runtime revokes it too.`);
}

export async function doctor(context: ControlContext): Promise<boolean> {
  const report = await context.control.call({ op: "doctor" }, DoctorReportSchema);
  context.output.result(report);
  for (const check of report.checks) {
    context.output.line(`[${check.status.padEnd(4)}] ${check.title}: ${check.detail}${check.recoveryActions.length > 0 ? ` — ${check.recoveryActions.map((action) => action.kind).join(", ")}` : ""}`);
  }
  return report.checks.every((check) => check.status !== "fail");
}

export async function supportBundle(context: ControlContext): Promise<void> {
  const document = await context.control.call({ op: "support.bundle" }, z.record(z.string(), z.unknown()));
  context.output.line("support bundle preview (versions, status, configuration keys, doctor, counters, redacted logs):");
  context.output.line(JSON.stringify(document, null, 2));
}
