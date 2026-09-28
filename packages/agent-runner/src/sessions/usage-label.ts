import { remoteMoneyBasisFor, type ConnectedAgentCredential } from "@konteks/remote-common";
import { classifyAgentBilling, credentialKindFor, estimateListPriceCostMicros, geminiListPriceUsage, listPriceSnapshotId, recogniseNativeModel } from "@konteks/backstage-plugin-common/known-models";
import type { TurnUsageLabel } from "./manager.js";
import type { GeminiModelUsage } from "../host/antigravity-relay.js";

/**
 * How one turn's usage is labelled (opencode-runtime-support O7, closes dsh
 * D5): by how the route's provider BILLS, `classifyAgentBilling` with the
 * credential kind the machine holds for it. Claude Code and Codex turns stay
 * `unavailable_local_subscription`; an OpenCode turn follows its model's
 * provider (`openai/…` through a ChatGPT sign-in is a subscription, through a
 * key pay-per-use; Zen and Go by provider); a DeepSeek Harness turn is its
 * DeepSeek key. A pay-per-use turn names its provider (and model) and is
 * reported only to a Core that takes it; otherwise, or when the provider is
 * unknown, it is not reported at all (null), never as a subscription.
 */
export function turnUsageLabel(input: {
  agentId: string;
  /** The session's current model value (OpenCode: `provider/model`). */
  modelValue: string | undefined;
  credentials: readonly ConnectedAgentCredential[] | undefined;
  coreAcceptsRouteBilling: boolean;
}): TurnUsageLabel | null {
  const { agentId } = input;
  let providerId: string | undefined;
  let model: string | undefined;
  if (agentId === "opencode") {
    const value = input.modelValue?.trim();
    const slash = value?.indexOf("/") ?? -1;
    if (!value || slash <= 0) return null;
    providerId = value.slice(0, slash).toLowerCase();
    model = value.slice(slash + 1);
  } else if (agentId === "dsh") {
    providerId = "deepseek";
  }
  const credential = agentId === "opencode" ? credentialKindFor(input.credentials, providerId) : undefined;
  const basis = remoteMoneyBasisFor(classifyAgentBilling({ agentId, ...(providerId ? { providerId } : {}), ...(credential ? { credential } : {}) }));
  if (basis === "unavailable_local_subscription") return { moneyBasis: basis };
  if (!input.coreAcceptsRouteBilling || !providerId) return null;
  return { moneyBasis: "pay_per_use", provider: providerId, ...(model ? { model: model.slice(0, 256) } : {}) };
}

/**
 * A turn's tokens and money measured outside the agent (Google Antigravity
 * with a Gemini API key: its relay counted Google's `usageMetadata`, A7/A8).
 * Always pay-per-use on the person's own key; the cost, when present, is an
 * estimate at the catalogue's list price, never a provider-reported amount.
 */
export interface MeasuredTurn {
  provider: string;
  /** The model Google was asked for (the request path), without a thinking level. */
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cacheReadTokens: number;
  /** Absent when any model the turn used has no catalogue price: unknown, never zero. */
  estimate?: { amountMicros: number; pricingSnapshotId: string };
}

/**
 * One Antigravity turn on a Gemini API key, from what its relay counted per
 * model (largest first): the tokens summed, the model that did most of the
 * work named, and the list-price estimate summed per model
 * (`geminiListPriceUsage` × the catalogue price, packages CP5). The estimate
 * names the price of the named model; it is left out when any model is
 * unpriced, so a partial sum never reads as the whole cost.
 */
export function geminiMeasuredTurn(usages: readonly GeminiModelUsage[]): MeasuredTurn | null {
  if (usages.length === 0) return null;
  let prompt = 0, candidates = 0, thoughts = 0, cached = 0, toolUse = 0, total = 0;
  let amountMicros: number | undefined = 0;
  for (const { model, usage } of usages) {
    prompt += usage.promptTokenCount; candidates += usage.candidatesTokenCount; thoughts += usage.thoughtsTokenCount;
    cached += usage.cachedContentTokenCount; toolUse += usage.toolUsePromptTokenCount; total += usage.totalTokenCount;
    const price = recogniseNativeModel("antigravity", model).model?.price;
    const cost = estimateListPriceCostMicros(price, geminiListPriceUsage(usage));
    amountMicros = amountMicros === undefined || cost === undefined ? undefined : amountMicros + cost;
  }
  const main = usages[0]!.model;
  const known = recogniseNativeModel("antigravity", main).model;
  const turn: MeasuredTurn = {
    provider: "google",
    model: main.slice(0, 256),
    inputTokens: prompt + toolUse,
    outputTokens: candidates,
    thoughtTokens: thoughts,
    cacheReadTokens: cached,
    totalTokens: total > 0 ? total : prompt + toolUse + candidates + thoughts,
  };
  if (amountMicros !== undefined && known && amountMicros <= 1_000_000_000_000) turn.estimate = { amountMicros, pricingSnapshotId: listPriceSnapshotId(known) };
  return turn;
}
