import type { ConnectedAgentView, RemoteInstanceView } from "@konteks/remote-common";

/** One component's sanitized health, as the heartbeat carries it (native: the in-process agent runner). */
export type ComponentInventory = RemoteInstanceView["components"][number];

/** The sanitized inventory the heartbeat carries; raw probe output never leaves the collector. */
export interface InventorySnapshot {
  components: ComponentInventory[];
  agents: ConnectedAgentView[];
  hostPressure: number;
  activeSessions: number;
  activeTurns: number;
  browserToolAvailable: boolean;
  /**
   * The machine's git version, or `null` when git is not on PATH. The `onboard`
   * role is derived from it (OB6 §1); nothing else reads it.
   */
  gitVersion: string | null;
  diskFreeBytes: number;
}

/** What the heartbeat needs from an inventory source. */
export interface InventorySource {
  collect(): Promise<InventorySnapshot>;
}
