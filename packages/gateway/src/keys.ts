/**
 * In-memory provider keys, one per gateway-keyed agent. `gateway key set`
 * delivers a key over the loopback control socket → supervisor → gateway admin
 * API on the control network; it is stamped onto outbound provider requests
 * and exists nowhere else: no disk, no Vault, no Core, no relay, no log, no
 * backup. A restart empties the vault by construction.
 */
export class KeyVault {
  private readonly keys = new Map<string, string>();

  set(agentId: string, key: string): void {
    this.keys.set(agentId, key);
  }

  clear(agentId: string): boolean {
    return this.keys.delete(agentId);
  }

  clearAll(): void {
    this.keys.clear();
  }

  has(agentId: string): boolean {
    return this.keys.has(agentId);
  }

  /** Returns the key for stamping; callers must never log or persist it. */
  use(agentId: string): string | null {
    return this.keys.get(agentId) ?? null;
  }

  keyedAgentIds(): string[] {
    return [...this.keys.keys()].sort();
  }

  /** Serialization deliberately exposes only which agents are keyed. */
  toJSON(): { keyedAgents: string[] } {
    return { keyedAgents: this.keyedAgentIds() };
  }
}
