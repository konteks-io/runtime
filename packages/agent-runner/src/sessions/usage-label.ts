import { remoteMoneyBasisFor, type ConnectedAgentCredential } from "@konteks/remote-common";
import { classifyAgentBilling, credentialKindFor } from "@konteks/backstage-plugin-common/known-models";
import type { TurnUsageLabel } from "./manager.js";

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
