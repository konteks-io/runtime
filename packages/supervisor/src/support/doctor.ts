import { stat } from "node:fs/promises";
import { RemoteInstanceError, type DoctorCheck, type DoctorReport } from "@konteks/remote-common";

/**
 * Allowlisted doctor checks: versions, reachability, lease, components,
 * gateway posture, agents, disk, preview exposure. Details carry statuses and
 * revisions — never a path, address, key, lease value, or raw probe output.
 */
export interface DoctorInputs {
  deploymentKind?: "appliance" | "native_connector";
  now: () => string;
  dataDir: string;
  identity: { instanceId: string | null; administrativeStatus: string };
  lease: { mode: "active" | "drain_only" | "none"; expiresAt: string | null };
  relay: { state: string; lastError: string | null; consecutiveFailures: number };
  transport: "relay" | "https";
  reconciliationComplete: boolean;
  components: Array<{ kind: string; healthStatus: string; version: string }>;
  agents: Array<{ agentId: string; readiness: string; recoveryAction?: string | undefined }>;
  gateway: { healthy: boolean; capEnforcementStage: string; egressAllowlistRevision: string; rollupIncompleteSince: string | null } | null;
  configRevision: number;
  expectedAllowlistRevision: string;
  diskFreeBytes: number;
  minimumDiskBytes: number;
  preview: { enabled: boolean; port: number | null; grantPresent: boolean };
  outboxDepth: number;
  recoveryRequired: number;
  coreSignatureConfigured: boolean;
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
  if (inputs.deploymentKind !== "native_connector") push({
    id: "gateway",
    title: "Egress gateway",
    status: inputs.gateway ? (inputs.gateway.healthy ? (inputs.gateway.egressAllowlistRevision === inputs.expectedAllowlistRevision ? "pass" : "warn") : "fail") : "fail",
    detail: inputs.gateway ? `stage ${inputs.gateway.capEnforcementStage}, allowlist ${inputs.gateway.egressAllowlistRevision}${inputs.gateway.rollupIncompleteSince ? `, rollup incomplete since ${inputs.gateway.rollupIncompleteSince}` : ""}` : "gateway unreachable; keyed agents cannot reach providers",
  });
  push({ id: "core-control-key", title: "Core control signing key", status: inputs.coreSignatureConfigured ? "pass" : "fail", detail: inputs.coreSignatureConfigured ? "release root certifies a Core control key" : "no Core control key in the embedded release roots; directives will be rejected", ...(inputs.coreSignatureConfigured ? {} : { recoveryActions: [{ kind: "update" }] }) });
  for (const agent of inputs.agents) {
    push({ id: `agent-${agent.agentId}`, title: `Agent ${agent.agentId}`, status: agent.readiness === "ready" ? "pass" : agent.readiness === "not_configured" ? "warn" : "fail", detail: `readiness ${agent.readiness}`, ...(agent.readiness === "not_configured" || agent.readiness === "reconnect_required" ? { recoveryActions: [{ kind: "login_agent", agentId: agent.agentId }] } : {}) });
  }
  push({ id: "disk", title: "Free disk", status: inputs.diskFreeBytes >= inputs.minimumDiskBytes ? "pass" : "fail", detail: `${Math.round(inputs.diskFreeBytes / 1024 ** 3)} GiB free`, ...(inputs.diskFreeBytes >= inputs.minimumDiskBytes ? {} : { recoveryActions: [{ kind: "free_disk" }] }) });
  push({ id: "preview", title: "Preview exposure", status: inputs.preview.enabled ? "warn" : "pass", detail: inputs.preview.enabled ? `preview ENABLED on local port ${inputs.preview.port}; ${inputs.preview.grantPresent ? "a viewer grant is active" : "no viewer grant"}` : "preview disabled" });
  push({ id: "outbox", title: "Durable outbox", status: inputs.outboxDepth === 0 ? "pass" : "warn", detail: `${inputs.outboxDepth} item(s) awaiting Core acknowledgement` });
  push({ id: "recovery", title: "Recovery required", status: inputs.recoveryRequired === 0 ? "pass" : "warn", detail: `${inputs.recoveryRequired} assignment(s) need recovery` });
  push({ id: "config", title: "Desired configuration", status: inputs.configRevision > 0 ? "pass" : "warn", detail: `revision ${inputs.configRevision}` });
  return { checks, generatedAt: inputs.now() };
}

export function assertDoctorHasNoSecrets(report: DoctorReport): void {
  const text = JSON.stringify(report);
  if (/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(text)) {
    throw new RemoteInstanceError("local_io_failure", "doctor report would contain a path");
  }
}
