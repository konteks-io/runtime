import { anthropicDialect } from "./anthropic.js";
import { deepseekDialect } from "./deepseek.js";
import { googleDialect } from "./google.js";
import { openAiDialect } from "./openai.js";
import type { ProviderDialect, ProviderId } from "./types.js";

export const DIALECTS: Readonly<Record<ProviderId, ProviderDialect>> = Object.freeze({
  anthropic: anthropicDialect,
  openai: openAiDialect,
  google: googleDialect,
  deepseek: deepseekDialect,
});

export function dialectFor(provider: string): ProviderDialect | undefined {
  return (DIALECTS as Record<string, ProviderDialect | undefined>)[provider];
}

export * from "./types.js";
export { anthropicDialect, openAiDialect, googleDialect, deepseekDialect };
