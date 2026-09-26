/**
 * Model selectors reviewed against the agent bridges shipped by the native
 * release. Transport selectors stay local to the bridge; Core receives only
 * the canonical provider/model identity used for routing and separation.
 *
 * An agent absent from this table deliberately publishes no model authority.
 */
export const REVIEWED_NATIVE_MODEL_IDENTITIES = {
  "claude-code": [
    { value: "default", canonicalProviderId: "anthropic", canonicalModelId: "claude-opus-5[1m]" },
    { value: "opus[1m]", canonicalProviderId: "anthropic", canonicalModelId: "claude-opus-5[1m]" },
    { value: "claude-fable-5-1[1m]", canonicalProviderId: "anthropic", canonicalModelId: "claude-fable-5-1" },
    { value: "sonnet", canonicalProviderId: "anthropic", canonicalModelId: "claude-sonnet-5" },
    { value: "haiku", canonicalProviderId: "anthropic", canonicalModelId: "claude-haiku-4-5-20251001" },
  ],
  codex: [
    { value: "gpt-5.6-sol", canonicalProviderId: "openai", canonicalModelId: "gpt-5.6-sol" },
  ],
  // The person's own DeepSeek Harness ships no bridge artifact: its mapping is
  // bound to the agent and the versions this runtime supports (hostInstall).
  dsh: [
    { value: '["deepseek-official","deepseek-flash"]', canonicalProviderId: "deepseek", canonicalModelId: "deepseek-flash" },
    { value: '["deepseek-official","deepseek-v4-pro"]', canonicalProviderId: "deepseek", canonicalModelId: "deepseek-v4-pro" },
  ],
} as const;

export type ReviewedNativeAgentId = keyof typeof REVIEWED_NATIVE_MODEL_IDENTITIES;

export function reviewedNativeModelIdentities(agentId: string) {
  return REVIEWED_NATIVE_MODEL_IDENTITIES[agentId as ReviewedNativeAgentId];
}
