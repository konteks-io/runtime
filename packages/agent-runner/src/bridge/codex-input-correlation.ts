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
    if (!record(message) || (message.method !== "item/started" && message.method !== "item/completed") || !record(message.params) || !record(message.params.item)) return message;
    const params = message.params;
    const item = params.item as Record<string, unknown>;
    if (item.type !== "userMessage") return message;
    const known = typeof item.clientId === "string" ? this.inputs.get(item.clientId) : undefined;
    let source: "connector" | "unclassified" = "unclassified";
    if (known && known.threadId === params.threadId && typeof item.id === "string" && (!known.itemId || known.itemId === item.id)) {
      known.itemId = item.id;
      source = "connector";
    }
    // Always overwrite this private extension; never trust provider-supplied attribution.
    return { ...message, params: { ...params, item: { ...item, konteksInputSource: source } } };
  }
}
