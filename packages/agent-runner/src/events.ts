import { z } from "zod";
import { AgentTurnUsageObservationSchema, ConnectedAgentViewSchema } from "@konteks/remote-common";

/**
 * Events the runner streams to the supervisor over its internal WebSocket.
 * ACP payloads are carried as-is from the SDK (they are validated by the
 * supervisor against the vendored ACP schemas before any relay use); nothing
 * here is stdio, a path, or a credential.
 */
const sessionRef = z.string().min(1).max(256);
const requestId = z.string().min(1).max(128);

export const RunnerEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("readiness_changed"), agent: ConnectedAgentViewSchema }).strict(),
  z.object({ kind: z.literal("agent_scope_reset"), agentId: z.string(), previousScope: z.enum(["personal", "organization"]) }).strict(),
  z.object({ kind: z.literal("agent_scope_attested"), agentId: z.string() }).strict(),
  z.object({ kind: z.literal("session_update"), acpSessionRef: sessionRef, params: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal("permission_request"),
      acpSessionRef: sessionRef,
      requestId,
      params: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("elicitation_request"),
      acpSessionRef: sessionRef,
      requestId,
      params: z.unknown(),
    })
    .strict(),
  z.object({ kind: z.literal("elicitation_complete"), acpSessionRef: sessionRef, params: z.unknown() }).strict(),
  z.object({ kind: z.literal("prompt_result"), acpSessionRef: sessionRef, requestId, result: z.unknown() }).strict(),
  z.object({ kind: z.literal("set_mode_result"), acpSessionRef: sessionRef, requestId, result: z.unknown() }).strict(),
  z.object({ kind: z.literal("set_config_option_result"), acpSessionRef: sessionRef, requestId, result: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal("request_error"),
      acpSessionRef: sessionRef,
      requestId,
      method: z.enum(["session/prompt", "session/set_mode", "session/set_config_option"]),
      code: z.number().int(),
      class: z.enum(["cancelled", "provider_failure", "agent_auth_required", "invalid_params", "unknown_request", "malformed_response", "policy_denied", "internal"]),
      message: z.string().max(1_024),
      retryable: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("usage_observation"), acpSessionRef: sessionRef, observation: AgentTurnUsageObservationSchema }).strict(),
  z.object({ kind: z.literal("session_exited"), acpSessionRef: sessionRef, reason: z.enum(["agent_exited", "closed"]) }).strict(),
  z.object({ kind: z.literal("bridge_exited"), code: z.number().int().nullable(), signal: z.string().nullable() }).strict(),
  z
    .object({
      kind: z.literal("login_event"),
      loginId: z.string(),
      event: z.discriminatedUnion("type", [
        z.object({ type: z.literal("display"), text: z.string().max(16_384) }).strict(),
        z.object({ type: z.literal("open_url"), url: z.string().url(), userCode: z.string().max(64).optional() }).strict(),
        z.object({ type: z.literal("prompt"), label: z.string().max(256), secret: z.boolean() }).strict(),
        z.object({ type: z.literal("completed"), readiness: z.string() }).strict(),
        z.object({ type: z.literal("failed"), code: z.string(), message: z.string().max(1_024) }).strict(),
      ]),
    })
    .strict(),
]);
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export type RunnerEventListener = (event: RunnerEvent) => void;

export class RunnerEventBus {
  private readonly listeners = new Set<RunnerEventListener>();

  subscribe(listener: RunnerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: RunnerEvent): void {
    const parsed = RunnerEventSchema.parse(event);
    for (const listener of this.listeners) listener(parsed);
  }
}
