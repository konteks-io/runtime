/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Every digest and signature in the contract is computed over JCS bytes (D125),
 * so two implementations produce the same signature. Numbers use the ES
 * `Number::toString` serialization that `JSON.stringify` already implements;
 * object members sort by UTF-16 code units; whitespace is absent.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS cannot serialize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareUtf16);
  const members = keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`);
  return `{${members.join(",")}}`;
}

function compareUtf16(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = a.charCodeAt(index) - b.charCodeAt(index);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/**
 * Removes members before canonicalization — used to strip proof members
 * (`PROOF_MEMBERS`) so a body digest never depends on its own proof.
 */
export function withoutMembers<T extends { [key: string]: JsonValue }>(
  value: T,
  members: readonly string[],
): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!members.includes(key)) out[key] = entry;
  }
  return out;
}

export const PROOF_MEMBERS = ["replicaAuth", "proof", "keyProof", "relayAuth"] as const;
