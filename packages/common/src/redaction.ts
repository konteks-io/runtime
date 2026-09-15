/**
 * Redaction by construction. Every sink that could carry operator-visible or
 * Core-visible text (logs, doctor output, support bundles, error messages) runs
 * through these helpers. The patterns are deliberately broad: a false positive
 * costs a masked value, a false negative costs a leaked credential.
 */

const SECRET_KEY_PATTERN =
  /(?:^|[_.-])(?:token|secret|password|passwd|credential|api[_-]?key|activation[_-]?code|private[_-]?key|lease|grant|authorization|cookie|set-cookie|x-api-key)(?:$|[_.-])/i;

const BEARER_PATTERN = /\b(bearer)\s+[a-z0-9._~+/=-]{8,}/gi;
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-ant-[a-z0-9_-]{8,}/gi, // Anthropic
  /\bsk-(?:proj-)?[a-z0-9_-]{16,}/gi, // OpenAI / DeepSeek style
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWS compact
  /\bkxrp_[A-Za-z0-9_-]{4,}/g, // Konteks provisioning credential
];

export const REDACTED = "[redacted]";

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactText(text: string): string {
  let out = text.replace(BEARER_PATTERN, (_match, bearer: string) => `${bearer} ${REDACTED}`);
  for (const pattern of API_KEY_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // The planted canaries are scrubbed too: a sink that only detects them
  // would still print the one string every audit greps for.
  for (const canary of Object.values(SECRET_CANARIES)) {
    out = out.split(canary).join(REDACTED);
  }
  return out;
}

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

/**
 * Deep-redacts any value: secret-named keys are masked wholesale, string
 * values are pattern-scrubbed. Non-JSON values are stringified first so an
 * Error's message cannot smuggle a key past the scrubber.
 */
export function redactValue(value: unknown, depth = 0): JsonLike {
  if (depth > 16) return REDACTED;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: { [key: string]: JsonLike } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactValue(entry, depth + 1);
    }
    return out;
  }
  return redactText(String(value));
}

/**
 * The canary suite plants these exact strings into every sink and asserts
 * they never come out. They are obviously fake but shaped like real secrets so
 * the same patterns that protect production catch them.
 */
export const SECRET_CANARIES = Object.freeze({
  anthropicKey: "sk-ant-api03-CANARY0000000000000000000000",
  openAiKey: "sk-proj-CANARY000000000000000000000000",
  googleKey: "AIzaCANARY00000000000000000000000000",
  bearer: "Bearer CANARY.access.token.0000000000",
  activationCode: "KR-CANARY-ACT-000000",
});

export function containsCanary(text: string): boolean {
  return Object.values(SECRET_CANARIES).some((canary) => text.includes(canary));
}
