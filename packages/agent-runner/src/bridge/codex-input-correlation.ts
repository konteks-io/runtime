import { randomUUID } from "node:crypto";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Connection-local correlation, not authentication or a durable cloud turn.
 * Unknown/replayed inputs remain unclassified, including after restart/eviction.
 * Register before sending: notifications may precede the turn/start response.
 */
export class CodexInputCorrelation {
  private readonly inputs = new Map<string, { threadId: string; itemId?: string }>();

  outgoing(message: unknown): unknown {
    if (!record(message) || (message.method !== "turn/start" && message.method !== "turn/steer") || !record(message.params)) return message;
    const params = message.params;
    if (typeof params.threadId !== "string" || !Array.isArray(params.input)) return message;
    const inputId = randomUUID();
    this.inputs.set(inputId, { threadId: params.threadId });
    if (this.inputs.size > 4096) this.inputs.delete(this.inputs.keys().next().value!);
    return { ...message, params: { ...params, clientUserMessageId: inputId } };
  }

  incoming(message: unknown): unknown {
    const item = userMessageItem(message);
    if (!item) return message;
    const params = item.params;
    const source = this.claims(params.threadId, item.item) ? "connector" : "unclassified";
    // Always overwrite this private extension; never trust provider-supplied attribution.
    return { ...item.message, params: { ...params, item: { ...item.item, konteksInputSource: source } } };
  }

  /** Whether this user message is the connector's own input on its thread (binding its item id on first sight). */
  private claims(threadId: unknown, item: Record<string, unknown>): boolean {
    const known = typeof item.clientId === "string" ? this.inputs.get(item.clientId) : undefined;
    if (!known || known.threadId !== threadId || typeof item.id !== "string") return false;
    if (known.itemId && known.itemId !== item.id) return false;
    known.itemId = item.id;
    return true;
  }
}

/** An `item/started` or `item/completed` notification carrying a user message. */
function userMessageItem(message: unknown): { message: Record<string, unknown>; params: Record<string, unknown>; item: Record<string, unknown> } | null {
  if (!record(message) || (message.method !== "item/started" && message.method !== "item/completed")) return null;
  const params = message.params;
  if (!record(params) || !record(params.item) || params.item.type !== "userMessage") return null;
  return { message, params, item: params.item };
}
