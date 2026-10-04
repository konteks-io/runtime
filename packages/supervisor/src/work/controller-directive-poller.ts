import { createLogger, type Logger } from "@konteks/remote-common";
import type { CoreClient } from "../core/client.js";
import type { SupervisorJournal } from "../state/journal.js";
import type { PlanningTerminalDirectiveProcessor } from "./planning-terminal-directives.js";

interface ControllerDirectivePollerOptions { core: CoreClient; journal: SupervisorJournal; processor: PlanningTerminalDirectiveProcessor;
  instanceId: () => string; runnerIncarnation: () => string; canPoll: () => boolean; logger?: Logger; }
export class ControllerDirectivePoller {
  private running = false; private flight: Promise<void> | null = null; private timer: NodeJS.Timeout | null = null; private pollAbort: AbortController | null = null; private readonly logger: Logger;
  constructor(private readonly options: ControllerDirectivePollerOptions) { this.logger = options.logger ?? createLogger({ name: "planning-terminal-poller" }); }
  start(): void { if (!this.running) { this.running = true; this.schedule(0); } }
  async stop(): Promise<void> { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; this.pollAbort?.abort(); await this.flight; }
  private schedule(delay: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null;
      const task = this.tick().catch(error => {
        if (!this.running && error instanceof Error && "code" in error && error.code === "operation_interrupted") return;
        this.logger.warn({ err: error }, "planning directive pull failed; retaining durable cursor");
      });
      this.flight = task;
      void task.finally(() => { if (this.flight === task) this.flight = null; this.schedule(1_000); }); }, delay);
    this.timer.unref();
  }
  private async tick(): Promise<void> {
    if (!this.polling()) return;
    const instanceId = this.options.instanceId(), runnerIncarnation = this.options.runnerIncarnation();
    if (!await this.acceptAll(this.options.journal.planning.pendingDirectives(instanceId))) return;
    const afterSequence = this.options.journal.planning.cursor(instanceId);
    const page = await this.pull(instanceId, afterSequence, runnerIncarnation);
    if (!this.polling() || instanceId !== this.options.instanceId() || runnerIncarnation !== this.options.runnerIncarnation()) return;
    await this.options.journal.planning.storePulled(instanceId, afterSequence, page);
    await this.acceptAll(page.directives);
  }

  private polling(): boolean { return this.running && this.options.canPoll(); }

  /** Accept each directive in order while polling continues; false once it stopped. */
  private async acceptAll(directives: readonly Parameters<PlanningTerminalDirectiveProcessor["accept"]>[0][]): Promise<boolean> {
    for (const directive of directives) {
      if (!this.polling()) return false;
      await this.options.processor.accept(directive);
    }
    return true;
  }

  private async pull(instanceId: string, afterSequence: number, runnerIncarnation: string) {
    const controller = new AbortController();
    this.pollAbort = controller;
    try {
      return await this.options.core.pullControllerDirectives(instanceId, { version: 1, afterSequence, runnerIncarnation, maxItems: 32, waitSeconds: 20 }, controller.signal);
    } finally {
      if (this.pollAbort === controller) this.pollAbort = null;
    }
  }}
