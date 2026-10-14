/**
 * A Konteks utility turn (an integration read): Core routes the agent's
 * fastest offered model, and the turn runs at the lowest effort that model
 * offers, with extended thinking off. Every choice here comes from the
 * session's own ACP configuration options; nothing is guessed.
 */

interface SelectOption {
  id: string;
  type: string;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

/** Lowest first; values outside this list are never chosen. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function selects(configOptions: unknown): SelectOption[] {
  if (!Array.isArray(configOptions)) return [];
  return configOptions.filter((option): option is SelectOption =>
    typeof option?.id === "string" && option.type === "select");
}

/** Every value of a select, flat or grouped. */
function valuesOf(option: SelectOption): string[] {
  if (!Array.isArray(option.options)) return [];
  return option.options.flatMap((entry: unknown) => {
    const record = entry as { value?: unknown; options?: unknown };
    if (typeof record?.value === "string") return [record.value];
    return Array.isArray(record?.options) ? valuesOf({ ...option, options: record.options }) : [];
  });
}

/** The routed model, when the agent offers it and is not already on it. */
export function routedModelChange(configOptions: unknown, model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const select = selects(configOptions).find(option => option.id === "model");
  if (!select || select.currentValue === model || !valuesOf(select).includes(model)) return undefined;
  return model;
}

/** The lowest effort the current model offers (ACP `thought_level`), when it is not already selected. */
export function lowestEffortChange(configOptions: unknown): { configId: string; value: string } | undefined {
  const select = selects(configOptions).find(option => option.category === "thought_level");
  if (!select) return undefined;
  const offered = new Set(valuesOf(select));
  const lowest = EFFORT_ORDER.find(level => offered.has(level));
  if (lowest === undefined || select.currentValue === lowest) return undefined;
  return { configId: select.id, value: lowest };
}

/** A utility turn's `session/new` `_meta`: Claude's SDK options gain no extended thinking (other agents ignore `claudeCode`). */
export function withUtilityTurnOptions(meta: Record<string, unknown>): Record<string, unknown> {
  const claudeCode = (meta.claudeCode ?? {}) as { options?: Record<string, unknown> };
  return { ...meta, claudeCode: { ...claudeCode, options: { ...claudeCode.options, thinking: { type: "disabled" } } } };
}
