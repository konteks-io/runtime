import { INTEGRATION_TASK_LIMITS } from "@konteks/backstage-plugin-common";

interface CallTiming {
  tool: string;
  /** When the agent asked the gate for this call, in ms after the prompt. */
  askedMs: number;
  /** When the connector saw the call end, in ms after the prompt. */
  doneMs?: number;
}

/**
 * Where an integration turn's time goes, in ms after the prompt was sent:
 * when the agent asked for each provider call the gate allowed, when that
 * call ended, and when the result was handed in. The gaps between them are
 * the agent's own thinking; the spans are the provider. Only tool names and
 * times, never arguments or results.
 */
export class TurnTiming {
  private promptAt: number | null = null;
  private readonly calls = new Map<string, CallTiming>();
  private resultMs: number | undefined;

  constructor(private readonly now: () => number) {}

  prompted(): void {
    this.promptAt = this.now();
  }

  asked(toolCallId: string, tool: string): void {
    if (this.calls.has(toolCallId) || this.calls.size >= INTEGRATION_TASK_LIMITS.maxToolCalls) return;
    this.calls.set(toolCallId, { tool, askedMs: this.sincePrompt() });
  }

  ended(toolCallId: string): void {
    const call = this.calls.get(toolCallId);
    if (call && call.doneMs === undefined) call.doneMs = this.sincePrompt();
  }

  submitted(): void {
    this.resultMs ??= this.sincePrompt();
  }

  fields(): { calls: CallTiming[]; resultMs?: number } {
    return { calls: [...this.calls.values()], ...(this.resultMs !== undefined ? { resultMs: this.resultMs } : {}) };
  }

  private sincePrompt(): number {
    return this.promptAt === null ? 0 : this.now() - this.promptAt;
  }
}
