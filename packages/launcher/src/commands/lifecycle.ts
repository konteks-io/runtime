import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DoctorReportSchema, RemoteInstanceError, SupervisorStatusSchema, type ControlLoginEvent } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, type EmbeddedReleaseRoot, type ReleaseManifest } from "@konteks/remote-release";
import { compareSemver } from "@konteks/remote-supervisor";
import { UPDATE_STOP_ORDER, bundleServices, createComposeRunner, pullServices, renderCompose, runnerService, type AgentSelection, type ComposeRunner } from "../compose.js";
import { SupervisorControl } from "../control.js";
import { InstallStateFile } from "../install-state.js";
import type { Output } from "../output.js";
import { detectPlatform, installPaths, volumeDirectories, type HostPlatform, type InstallPaths } from "../paths.js";
import { confirm, promptSecret } from "../prompt.js";
import { fetchReleaseManifest, loadVerifiedReleaseManifest, persistReleaseArtifacts } from "../release-fetch.js";

/**
 * The stable lifecycle commands after install. Each talks to the supervisor
 * over the loopback control socket and/or drives Compose; none accepts a
 * general command passthrough.
 */
export interface LifecycleContext {
  paths: InstallPaths;
  output: Output;
  control: Pick<SupervisorControl, "call">;
  compose: ComposeRunner;
  input?: NodeJS.ReadableStream;
  /** Test hooks. */
  confirm?: (question: string) => Promise<boolean>;
  promptSecret?: (label: string) => Promise<string>;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
  platform?: HostPlatform;
  roots?: readonly EmbeddedReleaseRoot[];
  templatePath?: string;
}

/** Control-only commands are shared by native and historical appliance clients. */
export type ControlContext = Pick<LifecycleContext, "output" | "control" | "input" | "confirm" | "promptSecret">;

export function createContext(root: string, output: Output, overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  const paths = installPaths(root);
  return { paths, output, control: overrides.control ?? new SupervisorControl(paths), compose: overrides.compose ?? createComposeRunner(paths), ...overrides };
}

const AgentsSchema = z.object({ agents: z.array(z.record(z.string(), z.unknown())), roles: z.array(z.string()), roleBindings: z.array(z.record(z.string(), z.unknown())) }).strict();
const DrainStatusSchema = z.object({ draining: z.boolean(), reason: z.string().nullable(), activeAssignments: z.number(), openSessions: z.number() }).strict();

async function installedAgents(context: LifecycleContext): Promise<AgentSelection[]> {
  const state = await new InstallStateFile(context.paths.installState).read();
  if (!state) throw new RemoteInstanceError("install_state_corrupt", "no install state found under the install root; run `konteks-remote install` first", { recoveryActions: [{ kind: "new_activation" }] });
  return state.agents;
}

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
    ["preview", value.previewEnabled ? `ENABLED on local port ${value.previewExposure?.port} (${value.previewExposure?.grantPresent ? "viewer grant active" : "no viewer grant"})` : "disabled"],
    ["journal", `${value.journal.assignments} active, ${value.journal.outboxDepth} queued, ${value.journal.recoveryRequired} recovery required`],
  ]);
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

export async function gatewayKeySet(context: LifecycleContext, agentId: string): Promise<void> {
  const secret = context.promptSecret ?? ((label: string) => promptSecret({ label, minLength: 8, ...(context.input ? { input: context.input } : {}) }));
  const key = await secret(`Provider API key for ${agentId}`);
  await context.control.call({ op: "gateway.key.set", agentId, key }, z.unknown());
  context.output.line(`gateway key set for ${agentId} (held in gateway memory only; set it again after a restart)`);
}

export async function gatewayKeyClear(context: LifecycleContext, agentId: string): Promise<void> {
  await context.control.call({ op: "gateway.key.clear", agentId }, z.unknown());
  context.output.line(`gateway key cleared for ${agentId}`);
}

export async function previewEnable(context: LifecycleContext, port: number): Promise<void> {
  const exposure = await context.control.call({ op: "preview.enable", port }, z.record(z.string(), z.unknown()));
  context.output.result(exposure);
  context.output.line(`preview ENABLED: local port ${port} is mapped onto the governed preview channel for authenticated App viewers holding a preview grant. No public URL exists. Disable with \`konteks-remote preview disable\`.`);
}

export async function previewDisable(context: LifecycleContext): Promise<void> {
  await context.control.call({ op: "preview.disable" }, z.unknown());
  context.output.line("preview disabled");
}

export async function doctor(context: ControlContext): Promise<boolean> {
  const report = await context.control.call({ op: "doctor" }, DoctorReportSchema);
  context.output.result(report);
  for (const check of report.checks) {
    context.output.line(`[${check.status.padEnd(4)}] ${check.title}: ${check.detail}${check.recoveryActions.length > 0 ? ` — ${check.recoveryActions.map((action) => action.kind).join(", ")}` : ""}`);
  }
  return report.checks.every((check) => check.status !== "fail");
}

/** Container logs for the appliance services only; agent credential volumes and gateway memory have no log form. */
export async function logs(context: LifecycleContext, since: string): Promise<void> {
  if (!/^\d{1,5}[smh]$/.test(since)) throw new RemoteInstanceError("temporarily_unavailable", "--since must look like 15m, 2h, or 90s");
  const result = await context.compose.run(["logs", "--no-color", "--since", since, "--tail", "2000", "supervisor", "gateway", "sysmon", "preview-forwarder", "browser-tool"], { timeoutMs: 60_000 });
  for (const line of result.stdout.split("\n")) if (line) context.output.line(line);
}

export async function supportBundle(context: ControlContext): Promise<void> {
  const document = await context.control.call({ op: "support.bundle" }, z.record(z.string(), z.unknown()));
  context.output.line("support bundle preview (versions, status, configuration keys, doctor, counters, redacted logs):");
  context.output.line(JSON.stringify(document, null, 2));
}

async function waitForDrain(context: LifecycleContext, reason: "update" | "remove"): Promise<void> {
  const sleep = context.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = context.now ?? Date.now;
  await context.control.call({ op: "drain", reason }, z.unknown());
  const deadline = now() + 15 * 60_000;
  for (;;) {
    const drain = await context.control.call({ op: "drain.status" }, DrainStatusSchema);
    if (drain.activeAssignments === 0 && drain.openSessions === 0) return;
    if (now() > deadline) throw new RemoteInstanceError("active_work", "active work did not finish within the drain window; retry later", { recoveryActions: [{ kind: "retry" }] });
    context.output.line(`waiting for ${drain.activeAssignments} assignment(s) and ${drain.openSessions} session(s) to finish…`);
    await sleep(10_000);
  }
}

/**
 * `update`: verify the new manifest → drain (zero claims, no open session
 * channel) → backup → pull by digest without replacing the healthy stack →
 * stop in declared order → start the candidate (component-owned migrations
 * run at start) → re-probe agents → health gates → commit, or roll back and
 * stay drained. Agent credential volumes are never touched.
 */
export async function update(context: LifecycleContext, options: { coreUrl: string; relayUrl: string | null; release?: ReleaseManifest; fetchFn?: typeof fetch }): Promise<"updated" | "current" | "rolled_back"> {
  const roots = context.roots ?? EMBEDDED_RELEASE_ROOTS;
  const now = context.now ?? Date.now;
  const current = await loadVerifiedReleaseManifest(context.paths.releaseManifest, roots, now());
  const next = options.release ?? (await fetchReleaseManifest({ roots, ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}), now }));
  if (compareSemver(next.bundleVersion, current.bundleVersion) <= 0) {
    context.output.line(`already on ${current.bundleVersion}; nothing to update`);
    return "current";
  }
  if (compareSemver(current.bundleVersion, next.minimumSupportedBundle) < 0) {
    throw new RemoteInstanceError("update_required", `bundle ${current.bundleVersion} is older than ${next.bundleVersion}'s minimum supported bundle (${next.minimumSupportedBundle}); follow the release's forward-recovery procedure`, { recoveryActions: [{ kind: "contact_support" }] });
  }
  if (compareSemver(current.bundleVersion, next.rollback.compatibleDataFrom) < 0) {
    throw new RemoteInstanceError("update_required", `component data from ${current.bundleVersion} is not compatible with ${next.bundleVersion} (compatible from ${next.rollback.compatibleDataFrom})`, { recoveryActions: [{ kind: "contact_support" }] });
  }
  const forwardOnly = next.migrations.some((migration) => !migration.backwardCompatible);
  if (forwardOnly) {
    context.output.line("warning: this update declares a non-backward-compatible migration; automatic rollback is NOT available and the manifest's forward-recovery procedure applies");
    const ask = context.confirm ?? ((question: string) => confirm(question, context.input ? { input: context.input } : {}));
    if (!(await ask("Continue without automatic rollback?"))) throw new RemoteInstanceError("update_required", "update declined", { recoveryActions: [{ kind: "retry" }] });
  }

  await waitForDrain(context, "update");
  const backupDir = await backup(context, { includeCredentials: false });
  const platform = context.platform ?? detectPlatform();
  const agents = await installedAgents(context);
  const render = (release: ReleaseManifest): Promise<unknown> => renderCompose({ release, paths: context.paths, coreUrl: options.coreUrl, relayUrl: options.relayUrl, agents, platform, bundleVersion: release.bundleVersion }, context.templatePath);

  // Pull the candidate by digest while the current stack keeps running.
  await render(next);
  await pullServices(context.compose, bundleServices(agents), async (service) => context.output.line(`pulled ${service}`));
  const stop = await context.compose.run(["stop", ...UPDATE_STOP_ORDER, ...agents.map((agent) => runnerService(agent.agentId, agent.authMode))], { timeoutMs: 10 * 60_000 });
  if (stop.code !== 0) throw new RemoteInstanceError("temporarily_unavailable", "the running stack could not be stopped cleanly", { recoveryActions: [{ kind: "run_doctor" }] });

  const up = await context.compose.run(["up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", String(next.healthGates.startupTimeoutSeconds)], { timeoutMs: (next.healthGates.startupTimeoutSeconds + 60) * 1_000 });
  let healthy = up.code === 0;
  if (healthy) healthy = await agentProbeGate(context, next.healthGates.agentProbeTimeoutSeconds);
  if (healthy) {
    try {
      healthy = await doctor(context);
    } catch {
      healthy = false;
    }
  }
  if (!healthy) {
    if (forwardOnly) {
      throw new RemoteInstanceError("temporarily_unavailable", `update to ${next.bundleVersion} failed its health gates after a forward-only migration; apply the manifest's forward-recovery procedure (backup at ${backupDir})`, { recoveryActions: [{ kind: "contact_support" }] });
    }
    context.output.line("update health gate failed; rolling back to the previous bundle and staying drained");
    await render(current);
    await context.compose.run(["stop", ...UPDATE_STOP_ORDER, ...agents.map((agent) => runnerService(agent.agentId, agent.authMode))], { timeoutMs: 10 * 60_000 });
    await context.compose.run(["up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", String(current.healthGates.startupTimeoutSeconds)], { timeoutMs: (current.healthGates.startupTimeoutSeconds + 60) * 1_000 });
    throw new RemoteInstanceError("temporarily_unavailable", `update to ${next.bundleVersion} rolled back; the runtime stays drained. Recovery reference: ${backupDir}`, { recoveryActions: [{ kind: "run_doctor" }, { kind: "contact_support" }] });
  }
  await persistReleaseArtifacts(context.paths, next, roots);
  context.output.line(`updated to ${next.bundleVersion}; agent credential volumes untouched — run \`konteks-remote agents\` to confirm readiness (a bridge upgrade that invalidated a login shows reconnect_required)`);
  return "updated";
}

/** Re-probe every agent after a candidate starts; an agent whose login the upgrade invalidated shows `reconnect_required` and is reported, not silently fixed. */
async function agentProbeGate(context: LifecycleContext, timeoutSeconds: number): Promise<boolean> {
  const sleep = context.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = context.now ?? Date.now;
  const deadline = now() + timeoutSeconds * 1_000;
  for (;;) {
    try {
      const value = await context.control.call({ op: "agents" }, AgentsSchema);
      const probed = value.agents as Array<Record<string, string>>;
      if (probed.every((agent) => agent.readiness !== "unknown" && agent.readiness !== "probing")) {
        for (const agent of probed) {
          if (agent.readiness === "reconnect_required") context.output.line(`agent ${agent.agentId} needs a fresh login after this update (reconnect_required): run \`konteks-remote auth login ${agent.agentId}\``);
        }
        return true;
      }
    } catch {
      // supervisor not answering yet
    }
    if (now() > deadline) return false;
    await sleep(5_000);
  }
}

/** Backup excludes leases, activation material, the instance key by default, gateway memory, and agent credential volumes unless explicitly requested. */
export async function backup(context: LifecycleContext, options: { includeCredentials: boolean; includeInstanceKey?: boolean }): Promise<string> {
  const stamp = new Date(context.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-");
  const target = join(context.paths.backups, stamp);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const excludes = ["lease.json", "provisioning.json", "control.token"];
  if (!options.includeInstanceKey) excludes.push("instance-key.jwk");
  await cp(context.paths.supervisorData, join(target, "supervisor"), { recursive: true, filter: (source) => !excludes.some((name) => source.endsWith(name)) });
  await cp(join(context.paths.harnessData, "data"), join(target, "harness"), { recursive: true }).catch(() => undefined);
  await cp(join(context.paths.validationData, "data"), join(target, "validation-runtime"), { recursive: true }).catch(() => undefined);
  if (options.includeCredentials) {
    context.output.line("including agent credential volumes in this backup at your explicit request; store it encrypted");
    await cp(join(context.paths.root, "credentials"), join(target, "credentials"), { recursive: true }).catch(() => undefined);
  }
  context.output.line(`backup written to ${target}`);
  return target;
}

/**
 * `uninstall`: drain, revoke in Core (or record a pending revocation when Core
 * is unreachable), stop, preserve a dated backup. `--purge` is a separate
 * explicit destructive action that shows exact paths first and only proceeds
 * once revocation is recorded.
 */
export async function uninstall(context: LifecycleContext, options: { purge: boolean }): Promise<void> {
  let revoked = false;
  try {
    await waitForDrain(context, "remove");
    await context.control.call({ op: "revoke.pending" }, z.unknown());
    revoked = true;
  } catch {
    context.output.line("Core or the supervisor is unreachable: services will stop and data is preserved locally, but you must revoke/remove this runtime in the Konteks App or MCP");
  }
  await backup(context, { includeCredentials: false });
  await context.compose.run(["down", "--remove-orphans"], { timeoutMs: 10 * 60_000 });
  if (!options.purge) {
    context.output.line(`stopped; data preserved under ${context.paths.root} (backups in ${context.paths.backups}). ${revoked ? "Complete removal in the Konteks App or MCP." : "Revocation is pending: revoke this runtime in the Konteks App or MCP."}`);
    return;
  }
  const state = await new InstallStateFile(context.paths.installState).read();
  const targets = [...new Set(volumeDirectories(context.paths, (state?.agents ?? []).map((agent) => agent.agentId)).map((dir) => dir.path)), context.paths.stores, join(context.paths.root, "credentials"), context.paths.composeDir];
  context.output.line("purge will permanently delete:");
  for (const target of targets) context.output.line(`  ${target}`);
  const ask = context.confirm ?? ((question: string) => confirm(question, context.input ? { input: context.input } : {}));
  const ok = await ask("Delete component data AND agent credential volumes now? This cannot be undone.");
  if (!ok) {
    context.output.line("purge cancelled; data preserved");
    return;
  }
  await context.compose.run(["down", "--volumes", "--remove-orphans"], { timeoutMs: 10 * 60_000 });
  for (const target of targets) await rm(target, { recursive: true, force: true });
  await rm(context.paths.installState, { force: true });
  context.output.line("purged");
}
