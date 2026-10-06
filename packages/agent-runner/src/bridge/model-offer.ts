import { z } from "zod";
import { RemoteInstanceError } from "@konteks/remote-common";

const value = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Cf}\p{Cs}]+$/u);
const entry = z.object({ value });
const optionSchema = z.object({
  type: z.literal("select"),
  currentValue: value,
  options: z.array(z.union([entry, z.object({ options: z.array(entry).max(4096) })])).max(4096),
  _meta: z.object({ konteksModelOffer: z.unknown().optional() }).passthrough().optional(),
});
const provenanceSchema = z
  .object({
    source: z.literal("codex-model-list.v1"),
    offeredValues: z.array(value).min(1).max(4096),
    defaultValue: value.nullable(),
  })
  .strict();
const refused = () =>
  new RemoteInstanceError("agent_unavailable", "The agent did not provide a usable model offer.", {
    diagnostic: "model_discovery_refused",
  });

export interface ModelOffer {
  values: ReadonlySet<string>;
  /** The current model only when offered, otherwise a confirmed explicit default. */
  currentValue: string | null;
  /** A fallback may use only this confirmed default, never the first listed value. */
  defaultValue: string | null;
}

function exactValues(options: z.infer<typeof optionSchema>["options"]): Set<string> {
  const values = options.flatMap((option) =>
    "value" in option ? [option.value] : option.options.map((nested) => nested.value),
  );
  const unique = new Set(values);
  if (values.length > 4096 || values.length !== unique.size) throw refused();
  return unique;
}

function rawModelOffer(marker: unknown, values: Set<string>, current: string): ModelOffer {
  const parsed = provenanceSchema.safeParse(marker);
  if (!parsed.success) throw refused();
  const raw = parsed.data;
  const offered = new Set(raw.offeredValues);
  if (
    offered.size !== raw.offeredValues.length ||
    raw.offeredValues.some((value) => !values.has(value))
  )
    throw refused();
  if (raw.defaultValue !== null && !offered.has(raw.defaultValue)) throw refused();
  return {
    values: offered,
    currentValue: offered.has(current) ? current : raw.defaultValue,
    defaultValue: raw.defaultValue,
  };
}

/** One complete ACP select; signed Codex bridges must attest their raw list. */
export function readModelOffer(option: unknown, requireRaw = false): ModelOffer {
  const parsed = optionSchema.safeParse(option);
  if (!parsed.success) throw refused();
  const values = exactValues(parsed.data.options);
  const marker = parsed.data._meta?.konteksModelOffer;
  if (requireRaw || marker !== undefined)
    return rawModelOffer(marker, values, parsed.data.currentValue);
  if (!values.has(parsed.data.currentValue)) throw refused();
  return { values, currentValue: parsed.data.currentValue, defaultValue: parsed.data.currentValue };
}
