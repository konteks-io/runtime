import { z } from "zod";
import {
  GatewayCallObservationSchema,
  createLogger,
  type CapEnforcementStage,
  type GatewayCallObservation,
} from "@konteks/remote-common";
import type { ProviderUsage } from "./dialects/types.js";

/**
 * Builds and emits `GatewayCallObservation`s. Provider and model are what was
 * ON THE WIRE (request body/path, response body), never what the agent
 * claimed. Tokens are copied only when the provider reported them; a missing
 * dimension stays absent — unknown is not zero.
 */
export function buildObservation(args: {
  instanceId: string;
  assignmentId: string;
  attempt: number;
  agentId: string;
  provider: string;
  requestModel: string;
  usage: ProviderUsage | null;
  capEnforcement: CapEnforcementStage;
  appliedMaxTokens?: number;
  observedAt: string;
}): GatewayCallObservation {
  const usage = args.usage;
  const observation: GatewayCallObservation = {
    instanceId: args.instanceId,
    assignmentId: args.assignmentId,
    attempt: args.attempt,
    agentId: args.agentId,
    provider: args.provider,
    model: usage?.model ?? args.requestModel,
    inputSemantics: usage?.inputSemantics ?? "unknown",
    capEnforcement: args.capEnforcement,
    moneyBasis: "gateway_priced",
    observedAt: args.observedAt,
  };
  if (usage?.inputTokens !== undefined) observation.inputTokens = usage.inputTokens;
  if (usage?.outputTokens !== undefined) observation.outputTokens = usage.outputTokens;
  if (usage?.cacheReadTokens !== undefined) observation.cacheReadTokens = usage.cacheReadTokens;
  if (usage?.cacheWriteTokens !== undefined) observation.cacheWriteTokens = usage.cacheWriteTokens;
  if (args.appliedMaxTokens !== undefined) observation.appliedMaxTokens = args.appliedMaxTokens;
  return GatewayCallObservationSchema.parse(observation);
}

export const ObservationSinkAckSchema = z.object({ accepted: z.boolean() }).strict();

export interface ObservationSink {
  emit(observation: GatewayCallObservation): Promise<void>;
}

/**
 * Delivers observations to the supervisor's durable outbox over the control
 * network. The gateway holds a small in-memory retry queue; if it overflows or
 * the supervisor stays unreachable, the affected rollup is marked incomplete
 * (visible on /health and in the supervisor's economics facts) — never
 * fabricated as zero.
 */
export class SupervisorObservationSink implements ObservationSink {
  private readonly queue: GatewayCallObservation[] = [];
  private draining = false;
  private incompleteSince: string | null = null;
  private readonly logger = createLogger({ name: "gateway-observations" });

  constructor(
    private readonly options: {
      supervisorUrl: string;
      fetchFn?: typeof fetch;
      maxQueue?: number;
      now?: () => Date;
    },
  ) {}

  get rollupIncompleteSince(): string | null {
    return this.incompleteSince;
  }

  get pending(): number {
    return this.queue.length;
  }

  async emit(observation: GatewayCallObservation): Promise<void> {
    const max = this.options.maxQueue ?? 1_000;
    if (this.queue.length >= max) {
      this.markIncomplete();
      this.queue.shift();
    }
    this.queue.push(observation);
    await this.drain();
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (!next) break;
        const delivered = await this.deliver(next);
        if (!delivered) {
          this.markIncomplete();
          return;
        }
        this.queue.shift();
        if (this.queue.length === 0) this.incompleteSince = null;
      }
    } finally {
      this.draining = false;
    }
  }

  private markIncomplete(): void {
    if (this.incompleteSince === null) {
      this.incompleteSince = (this.options.now ?? (() => new Date()))().toISOString();
      this.logger.warn("observation delivery gap; economics rollup marked incomplete");
    }
  }

  private async deliver(observation: GatewayCallObservation): Promise<boolean> {
    const fetchFn = this.options.fetchFn ?? fetch;
    try {
      const response = await fetchFn(new URL("/internal/observations/gateway", this.options.supervisorUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(observation),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const ack = ObservationSinkAckSchema.safeParse(await response.json().catch(() => null));
      return ack.success && ack.data.accepted;
    } catch {
      return false;
    }
  }
}
