import { SecretTextStream, type SessionToCoreMessage } from "@konteks/remote-common";

function textUpdate(message: SessionToCoreMessage): { identity: string; text: string } | undefined {
  if (message.kind !== "acp" || message.method !== "session/update") return undefined;
  const update = message.params.update;
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return undefined;
  return { identity: `${message.params.sessionId}:${update.messageId ?? ""}`, text: update.content.text };
}

function withText(message: SessionToCoreMessage, text: string): SessionToCoreMessage {
  if (message.kind !== "acp" || message.method !== "session/update") return message;
  return { ...message, params: { ...message.params, update: { ...message.params.update, content: { type: "text", text } } } } as SessionToCoreMessage;
}

/** Buffer only an unfinished credential candidate. Every emitted frame still
 * passes through the existing schema, activity and path redaction gates.
 */
export class SecretTextRelay {
  private readonly stream = new SecretTextStream();
  private template: SessionToCoreMessage | undefined;
  private identity: string | undefined;

  messages(message: SessionToCoreMessage): SessionToCoreMessage[] {
    const text = textUpdate(message);
    if (text === undefined) return this.nonText(message);
    const previous = this.identity !== undefined && this.identity !== text.identity ? this.finish() : [];
    this.identity = text.identity;
    this.template = message;
    const output = this.stream.push(text.text);
    return output.length === 0 ? previous : [...previous, withText(message, output)];
  }

  private nonText(message: SessionToCoreMessage): SessionToCoreMessage[] {
    if ((message.kind === "acp_result" || message.kind === "acp_error") && message.method === "session/prompt") return [...this.finish(), message];
    const tail = this.stream.interrupt();
    return this.template && tail.length > 0 ? [withText(this.template, tail), message] : [message];
  }

  private finish(): SessionToCoreMessage[] {
    const tail = this.stream.finish();
    const template = this.template;
    this.template = undefined;
    this.identity = undefined;
    return template && tail.length > 0 ? [withText(template, tail)] : [];
  }
}
