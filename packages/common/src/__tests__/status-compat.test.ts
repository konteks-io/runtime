import { describe, expect, it } from "vitest";
import { SupervisorStatusSchema } from "../control-socket.js";

/** Launchers and connectors from different releases must still read each other's status (7.0.0). */
describe("supervisor status across releases", () => {
  const status = {
    instanceId: "instance-1", workspaceId: "workspace-1", administrativeStatus: "active",
    connectivity: { transport: "relay", relayConnected: true, lastConnectedAt: null, reconciliationComplete: true },
    lease: { mode: "active", expiresAt: null, drainDeadline: null },
    version: { bundle: "0.8.0", protocol: "1", manifestDigest: null, updateAvailable: false, targetBundle: null },
    configRevision: 1,
    components: [{ kind: "agent_runner", version: "0.8.0", healthStatus: "healthy", capabilities: [], lastProbeAt: "2026-09-26T00:00:00.000Z" }],
    roles: [], roleBindings: [],
    utilization: { acceptingWork: true, activeSessions: 0, activeTurns: 0, utilizationRatio: 0 },
    pendingErase: 0, pendingRevocation: false,
    journal: { assignments: 0, outboxDepth: 0, recoveryRequired: 0 },
  };

  it("reads a connector's status with its preview fields, which launchers installed before 7.0.0 require", () => {
    expect(SupervisorStatusSchema.parse({ ...status, previewEnabled: false, previewExposure: null })).toMatchObject({ previewEnabled: false, previewExposure: null });
  });

  it("reads a status without them, and one from a connector rolled back to a release that sent an exposure", () => {
    expect(SupervisorStatusSchema.safeParse(status).success).toBe(true);
    expect(SupervisorStatusSchema.safeParse({ ...status, previewEnabled: false, previewExposure: { port: 3000, grantPresent: false } }).success).toBe(true);
  });
});
