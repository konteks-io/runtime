import { z } from "zod";
import type { CapEnforcementStage } from "@konteks/remote-common";
import type { ParsedProviderRequest, ProviderDialect, RewriteResult } from "./dialects/types.js";

/**
 * Which assignment an agent is currently serving and what output-token cap
 * remains for it. The supervisor binds this when it dispatches and releases it
 * when the attempt ends. A keyed call from an unbound agent has no assignment
 * to observe against and is refused: there is no unmetered path.
 */
export const AssignmentBindingSchema = z
  .object({
    assignmentId: z.string().min(1),
    attempt: z.number().int().positive(),
    /** Remaining output tokens the assignment may still spend. */
    remainingOutputTokens: z.number().int().nonnegative(),
    /** Remaining input allowance for `preflight_block`; absent = not input-capped. */
    remainingInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AssignmentBinding = z.infer<typeof AssignmentBindingSchema>;

export class AssignmentRegistry {
  private readonly bindings = new Map<string, AssignmentBinding>();

  bind(agentId: string, binding: AssignmentBinding): void {
    this.bindings.set(agentId, binding);
  }

  release(agentId: string): void {
    this.bindings.delete(agentId);
  }

  get(agentId: string): AssignmentBinding | null {
    return this.bindings.get(agentId) ?? null;
  }

  /** Called after each observed call so the next cap decision sees the spend. */
  debit(agentId: string, outputTokens: number): void {
    const binding = this.bindings.get(agentId);
    if (!binding) return;
    this.bindings.set(agentId, {
      ...binding,
      remainingOutputTokens: Math.max(0, binding.remainingOutputTokens - outputTokens),
    });
  }
}

export type CapDecision =
  | { kind: "forward"; body: Uint8Array; appliedMaxTokens?: number }
  | { kind: "forward_stream_cut"; body: Uint8Array; cutAtOutputTokens: number }
  | { kind: "block"; reason: "input_exceeds_cap" | "cap_exhausted" };

/**
 * The three-stage cap (`admitProviderCall` stages):
 * - `observe` forwards unchanged and records;
 * - `preflight_block` refuses a call whose input already exceeds the remaining
 *   input allowance or whose output cap is exhausted;
 * - `provider_enforce` additionally rewrites the `max_tokens`-equivalent down
 *   to the remaining cap so the PROVIDER holds the bound; when the dialect
 *   cannot express a rewrite the call streams with a hard cut at the cap —
 *   the reported degraded mode.
 */
export function decideCap(args: {
  stage: CapEnforcementStage;
  dialect: ProviderDialect;
  request: ParsedProviderRequest;
  body: Uint8Array;
  binding: AssignmentBinding;
}): CapDecision {
  const { stage, dialect, request, body, binding } = args;
  if (stage === "observe") return { kind: "forward", body };
  if (binding.remainingOutputTokens <= 0) return { kind: "block", reason: "cap_exhausted" };
  if (
    binding.remainingInputTokens !== undefined &&
    request.estimatedInputTokens !== null &&
    request.estimatedInputTokens > binding.remainingInputTokens
  ) {
    return { kind: "block", reason: "input_exceeds_cap" };
  }
  if (stage === "preflight_block") return { kind: "forward", body };
  const rewritten: RewriteResult | null = dialect.rewriteMaxOutputTokens(body, binding.remainingOutputTokens);
  if (rewritten === null) {
    return { kind: "forward_stream_cut", body, cutAtOutputTokens: binding.remainingOutputTokens };
  }
  return { kind: "forward", body: rewritten.body, appliedMaxTokens: rewritten.appliedMaxTokens };
}
