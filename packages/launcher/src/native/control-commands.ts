import { z } from "zod";
import { DoctorReportSchema, PreviewStatusReportSchema, RemoteInstanceError, SupervisorStatusSchema, type ControlLoginEvent } from "@konteks/remote-common";
import type { SupervisorControl } from "../control.js";
import type { Output } from "../output.js";
import { confirm, promptSecret } from "../prompt.js";

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
}

const AgentsSchema = z.object({ agents: z.array(z.record(z.string(), z.unknown())), roles: z.array(z.string()), roleBindings: z.array(z.record(z.string(), z.unknown())) }).strict();

export async function status(context: ControlContext): Promise<void> {
  const value = await context.control.call({ op: "status" }, SupervisorStatusSchema);
  // `lease` is intentionally bearer-redacted by generic output. Publish a
  // separate, explicit public summary; never exempt bearer fields from redaction.
  context.output.result({ ...value, leaseStatus: { mode: value.lease.mode, expiresAt: value.lease.expiresAt, drainDeadline: value.lease.drainDeadline } });
  context.output.table([
    ["instance", value.instanceId ?? "(not activated)"],
    ["status", value.administrativeStatus],
    ["connectivity", `${value.connectivity.transport}${value.connectivity.relayConnected ? " (relay connected)" : ""}${value.connectivity.reconciliationComplete ? "" : " — reconciling"}`],
    ["lease", `${value.lease.mode}${value.lease.expiresAt ? `, expires ${value.lease.expiresAt}` : ""}`],
    ["bundle", `${value.version.bundle} (protocol ${value.version.protocol})${value.version.updateAvailable ? ` — update available: ${value.version.targetBundle}` : ""}`],
    ["roles", value.roles.join(", ") || "(none advertised — log in an agent and tag roles in App/MCP)"],
    ["utilization", `${value.utilization.activeSessions} sessions, ${value.utilization.activeTurns} turns, ratio ${value.utilization.utilizationRatio}${value.utilization.acceptingWork ? "" : " — not accepting work"}`],
    ["components", value.components.map((component) => `${component.kind}=${component.healthStatus}`).join(" ")],
    ["preview", value.previewEnabled ? `running on 127.0.0.1:${value.previewExposure?.port ?? "?"}${value.previewExposure?.grantPresent ? " (a viewer is connected)" : ""}` : "none running"],
    ["journal", `${value.journal.assignments} active, ${value.journal.outboxDepth} queued, ${value.journal.recoveryRequired} recovery required`],
  ]);
}

/** `preview status`: read-only; the per-machine on/off switch lives in Konteks. */
export async function previewStatus(context: ControlContext): Promise<void> {
  const value = await context.control.call({ op: "preview.status" }, PreviewStatusReportSchema);
  context.output.result(value);
  context.output.line(value.capabilityAdvertised
    ? `Previews: served from this computer (at most ${value.maxRunning} at once, each stops after ${value.idleStopMinutes} idle minutes). Switch them off for this computer in Konteks: Customize → Runtimes.`
    : "Previews: not offered (this connector has no relay connection configured).");
  if (value.previews.length === 0) context.output.line("No session preview has run since the connector started.");
  for (const preview of value.previews) {
    context.output.line(`${preview.sessionId}: ${preview.state}${preview.url ? ` at ${preview.url}` : ""}${preview.viewerConnected ? " (a viewer is connected)" : ""}`);
    if (preview.command) context.output.line(`  command: ${preview.command}${preview.explanation ? ` — ${preview.explanation}` : ""}`);
    context.output.line(`  ${preview.message}`);
  }
  if (value.lastFailure) context.output.line(`Last failure (${value.lastFailure.at}): ${value.lastFailure.message}`);
}

export async function agents(context: ControlContext): Promise<void> {
  const value = await context.control.call({ op: "agents" }, AgentsSchema);
  context.output.result(value);
  for (const agent of value.agents as Array<Record<string, string>>) {
    context.output.line(`${agent.agentId}: ${agent.readiness} (${agent.authMode}, scope ${agent.accountScope})${agent.recoveryAction ? ` — ${agent.recoveryAction}` : ""}`);
  }
  context.output.line(`advertised roles: ${value.roles.join(", ") || "(none)"}`);
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
export async function authLogin(context: ControlContext, agentId: string, organization: boolean): Promise<void> {
  const ask = context.confirm ?? ((question: string) => confirm(question, context.input ? { input: context.input } : {}));
  const secret = context.promptSecret ?? ((label: string) => promptSecret({ label, minLength: 1, ...(context.input ? { input: context.input } : {}) }));
  if (organization) {
    const ok = await ask(`Attest that the ${agentId} account you are about to log in is owned by your organization and may serve colleagues' work?`);
    if (!ok) throw new RemoteInstanceError("ownership_promotion_denied", "organization attestation declined; log in without --organization for a personal account");
  }
  const onEvent = (event: ControlLoginEvent): void => {
    switch (event.kind) {
      case "started":
        context.output.line(`login started for ${event.agentId}; follow the prompts from the agent's official tooling`);
        return;
      case "display":
        context.output.line(event.text);
        return;
      case "open_url":
        context.output.line(`open this URL to sign in: ${event.url}${event.userCode ? `\nenter code: ${event.userCode}` : ""}`);
        return;
      case "prompt":
        void secret(event.label)
          .then((text) => context.control.call({ op: "auth.input", loginId: event.loginId, text }, z.unknown()))
          .catch((error: unknown) => context.output.error(error));
        return;
      case "completed":
        context.output.line(`login complete: ${agentId} is ${event.readiness}${organization ? " (organization scope attested)" : ""}`);
        return;
      case "failed":
        context.output.line(`login failed (${event.code}): ${event.message}`);
        return;
    }
  };
  await context.control.call({ op: "auth.login", agentId, organization }, z.object({ loginId: z.string() }), { onEvent, timeoutMs: 20 * 60_000 });
}

export async function authLogout(context: ControlContext, agentId: string): Promise<void> {
  const value = await context.control.call({ op: "auth.logout", agentId }, z.record(z.string(), z.unknown()));
  context.output.result(value);
  context.output.line(`logged out ${agentId}; readiness ${String(value.readiness)}`);
}

/**
 * `git key add [--title]` (ON16, OB6 §4): the runtime generates (or reuses) an
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
