import {
  DirectModelSelectionSchema,
  DirectModelSelectionPolicySchema,
  RemoteInstanceError,
  type DirectModelSelection,
  type DirectModelSelectionPolicy,
} from "@konteks/remote-common";
import { readModelOffer, type ModelOffer } from "../bridge/model-offer.js";

interface DirectModelConfig {
  sessionConfig?: Record<string, string>;
  modelSelectionPolicy?: DirectModelSelectionPolicy;
  modelSelection?: DirectModelSelection;
}

const unavailable = () =>
  new RemoteInstanceError(
    "agent_unavailable",
    "The agent did not offer a usable admitted model selection. Refresh its model capabilities and retry.",
    {
      diagnostic: "direct_model_selection_unavailable",
    },
  );
/** The complete session offer, never a truncated discovery cache or a menu. */
function actualSelect(configOptions: unknown, configId: string, requireRaw: boolean): ModelOffer {
  if (!Array.isArray(configOptions) || configOptions.length > 512) throw unavailable();
  const matches = configOptions.filter((entry) => entry?.id === configId);
  if (matches.length !== 1) throw unavailable();
  const category = matches[0]?.category;
  if (category !== undefined && category !== "model") throw unavailable();
  return readModelOffer(matches[0], requireRaw);
}

function matchesRetainedPolicy(args: DirectModelConfig, receipt: DirectModelSelection): boolean {
  const policy = DirectModelSelectionPolicySchema.safeParse(args.modelSelectionPolicy);
  if (!policy.success || policy.data.configId !== receipt.configId) return false;
  return retainedPolicyMatches(policy.data, receipt, args.sessionConfig?.[receipt.configId]);
}

function retainedPolicyMatches(
  policy: DirectModelSelectionPolicy,
  receipt: DirectModelSelection,
  admitted: string | undefined,
): boolean {
  if (policy.kind === "same_agent_default")
    return receipt.resolution === "agent_default" && admitted === undefined;
  return (
    receipt.resolution !== "agent_default" &&
    [policy.requestedValue, admitted].every((value) => value === receipt.requestedValue)
  );
}

/** A Core-retained receipt permits confirmation of its exact pin, never another substitution. */
function retainedSelection(args: DirectModelConfig): DirectModelSelection | undefined {
  if (args.modelSelection === undefined) return undefined;
  const parsed = DirectModelSelectionSchema.safeParse(args.modelSelection);
  if (!parsed.success) throw unavailable();
  const receipt = parsed.data;
  const admitted = args.sessionConfig?.[receipt.configId];
  const matched =
    args.modelSelectionPolicy === undefined
      ? admitted === receipt.effectiveValue
      : matchesRetainedPolicy(args, receipt);
  if (!matched) throw unavailable();
  return receipt;
}

/** Decide only from session/new|load|resume before any configuration or prompt is sent. */
export function prepareDirectModelSelection(
  args: DirectModelConfig,
  configOptions: unknown,
  requireRaw = false,
): DirectModelSelection | undefined {
  const retained = retainedSelection(args);
  if (retained) {
    // Some live resumes report no configuration; the setter must echo and still offer the exact durable pin.
    if (
      configOptions !== undefined &&
      !actualSelect(configOptions, retained.configId, requireRaw).values.has(
        retained.effectiveValue,
      )
    )
      throw unavailable();
    return retained;
  }
  if (args.modelSelectionPolicy === undefined) return undefined;
  return newModelSelection(args, configOptions, requireRaw);
}

/** A synthetic current-value echo is not evidence that the agent still offers the pinned model. */
export function assertConfirmedDirectModelSelection(
  selection: DirectModelSelection | undefined,
  configOptions: unknown,
  confirmed: ReadonlyMap<string, string>,
  requireRaw = false,
): void {
  if (!selection || !confirmed.has(selection.configId)) return;
  if (
    !actualSelect(configOptions, selection.configId, requireRaw).values.has(
      selection.effectiveValue,
    )
  )
    throw unavailable();
}

function newModelSelection(
  args: DirectModelConfig,
  configOptions: unknown,
  requireRaw: boolean,
): DirectModelSelection {
  const policy = DirectModelSelectionPolicySchema.parse(args.modelSelectionPolicy);
  if (args.sessionConfig?.[policy.configId] !== policy.requestedValue) throw unavailable();
  const actual = actualSelect(configOptions, policy.configId, requireRaw);
  if (policy.kind === "same_agent_default") {
    if (actual.defaultValue === null) throw unavailable();
    return {
      configId: policy.configId,
      effectiveValue: actual.defaultValue,
      resolution: "agent_default",
    };
  }
  const effectiveValue = actual.values.has(policy.requestedValue)
    ? policy.requestedValue
    : actual.defaultValue;
  if (effectiveValue === null) throw unavailable();
  return {
    configId: policy.configId,
    requestedValue: policy.requestedValue,
    effectiveValue,
    resolution: effectiveValue === policy.requestedValue ? "requested" : "default_if_unoffered",
  };
}
