import type { BoundedJsonValue, RemoteWorkAssignment } from "@konteks/remote-common";

/** The one Konteks-issued secret an agent may receive (D94), in ACP `mcpServers` shape. Never journaled. */
export interface PlatformMcpEntry {
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

/**
 * The definition of the work an assignment names, read from Core for the
 * claimed assignment (`GET …/assignments/:assignmentId/workload`).
 */
export interface WorkloadDefinition {
  assignmentId: string;
  attempt: number;
  kind: RemoteWorkAssignment["kind"];
  workload: BoundedJsonValue;
}
