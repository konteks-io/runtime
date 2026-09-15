import { z } from "zod";
import { RemoteInstanceError, createLogger, type Logger } from "@konteks/remote-common";

/**
 * Supervisor-side client for the gateway admin API on the control network.
 * A key passes through `setKey` in memory only and is never journaled.
 */
export class GatewayClient {
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;

  constructor(private readonly baseUrl: string, fetchFn?: typeof fetch, logger?: Logger) {
    this.fetchFn = fetchFn ?? fetch;
    this.logger = logger ?? createLogger({ name: "gateway-client" });
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
    try {
      const response = await this.fetchFn(new URL(path, this.baseUrl), { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, payload: await response.json().catch(() => null) };
    } catch (error) {
      throw new RemoteInstanceError("gateway_unavailable", "the egress gateway is unreachable", { cause: error, retryable: true, recoveryActions: [{ kind: "run_doctor" }] });
    }
  }

  async setKey(agentId: string, key: string): Promise<void> {
    const result = await this.call("PUT", `/admin/keys/${encodeURIComponent(agentId)}`, { key });
    if (result.status !== 200) throw new RemoteInstanceError("gateway_unavailable", "the gateway did not accept the key");
    this.logger.info({ agentId }, "gateway key set");
  }

  async clearKey(agentId: string): Promise<void> {
    await this.call("DELETE", `/admin/keys/${encodeURIComponent(agentId)}`);
  }

  async applyConfig(config: { capEnforcementStage: "observe" | "preflight_block" | "provider_enforce"; egressAllowlistRevision: string }): Promise<"applied" | "unsupported_revision" | "unavailable"> {
    try {
      const result = await this.call("PUT", "/admin/config", config);
      if (result.status === 200) return "applied";
      if (result.status === 409) return "unsupported_revision";
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async bindAssignment(agentId: string, binding: { assignmentId: string; attempt: number; remainingOutputTokens: number; remainingInputTokens?: number }): Promise<void> {
    await this.call("PUT", `/admin/assignments/${encodeURIComponent(agentId)}`, binding);
  }

  async releaseAssignment(agentId: string): Promise<void> {
    await this.call("DELETE", `/admin/assignments/${encodeURIComponent(agentId)}`).catch(() => undefined);
  }

  async health(): Promise<{ healthy: boolean; keyedAgents: string[]; capEnforcementStage: string; egressAllowlistRevision: string; rollupIncompleteSince: string | null } | null> {
    try {
      const result = await this.call("GET", "/health");
      const parsed = z.object({ healthy: z.boolean(), keyedAgents: z.array(z.string()), capEnforcementStage: z.string(), egressAllowlistRevision: z.string(), rollupIncompleteSince: z.string().nullable() }).passthrough().safeParse(result.payload);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
