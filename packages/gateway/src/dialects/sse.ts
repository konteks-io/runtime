/**
 * Incremental server-sent-events parser. Emits each event's `data` payload
 * (joined with newlines per the SSE spec) and the optional `event` name. The
 * gateway parses usage from the stream it forwards without buffering the
 * response.
 */
export interface SseEvent {
  event: string | null;
  data: string;
}

export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private pendingEvent: string | null = null;
  private pendingData: string[] = [];

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    if (line === "") {
      if (this.pendingData.length > 0) {
        this.onEvent({ event: this.pendingEvent, data: this.pendingData.join("\n") });
      }
      this.pendingEvent = null;
      this.pendingData = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.pendingEvent = value;
    else if (field === "data") this.pendingData.push(value);
  }
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
