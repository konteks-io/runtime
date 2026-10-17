import { randomUUID } from "node:crypto";
import type { Logger } from "@konteks/remote-common";
import type { RunnerPort, RunnerSessionInput } from "../runner-port.js";
import { closeIntegrationSession, openIntegrationSession, shapeKey, type IntegrationSessionShape, type OpenSessionInput, type OpenedIntegrationSession } from "./opened-session.js";

/** How long a warm session waits for the next read before it is closed. */
export const WARM_SESSION_IDLE_MS = 3 * 60_000;
const OPEN_DEADLINE_MS = 60_000;
const CLOSE_GRACE_MS = 15_000;

interface WarmEntry {
  key: string;
  runner: RunnerPort;
  /** Settles once the session is open (undefined when opening failed). */
  opening: Promise<OpenedIntegrationSession | undefined>;
  opened?: OpenedIntegrationSession;
  timer?: NodeJS.Timeout;
}

/** Why this agent's warm session cannot serve a task of `key` on `runner`; null when it can. */
function missReason(entry: WarmEntry | undefined, key: string, runner: RunnerPort): string | null {
  if (!entry) return "none";
  if (entry.key !== key || entry.runner !== runner) return "other_shape";
  if (!entry.opened) return "opening";
  return runner.adoptSession === undefined ? "not_adoptable" : null;
}

interface WarmDeps {
  instanceId: () => string;
  workspaceRoot: (agentId: string) => string;
  logger: Logger;
  idleMs?: number;
}

/**
 * At most one warm integration session per agent: opened after a read, for
 * the same shape, so the next read skips starting the agent, connecting its
 * connectors and opening a session (~5 s of a ~20 s read, 10-11). It is a
 * new, never-prompted session, so "one gated session per task" still holds;
 * the task that takes it adopts it under its own assignment.
 *
 * It never holds a slot the person's own agent needs: `release(agentId)`
 * closes it first when a session finds every execution slot held, and it is
 * closed after `idleMs` without a read. Every take is logged as a reuse or a
 * miss.
 */
export class WarmIntegrationSessions {
  private readonly byAgent = new Map<string, WarmEntry>();

  constructor(private readonly deps: WarmDeps) {}

  /**
   * The warm session of this shape, adopted for `context`; undefined (a miss)
   * when there is none, it is still opening, or the runner cannot adopt it. A
   * warm session of another shape for the same agent is closed, so its slot
   * is free for the session this task opens instead.
   */
  async take(runner: RunnerPort, shape: IntegrationSessionShape, context: RunnerSessionInput["context"]): Promise<OpenedIntegrationSession | undefined> {
    const entry = this.byAgent.get(shape.agentId);
    const miss = missReason(entry, shapeKey(shape), runner);
    if (miss !== null) {
      this.logTake("missed", shape.agentId, context, miss);
      if (entry) await this.close(shape.agentId, "replaced");
      return undefined;
    }
    this.detach(shape.agentId, entry!);
    const opened = entry!.opened!;
    try {
      runner.adoptSession!(opened.acpSessionRef, context);
    } catch (error) {
      // Say why: every miss on 10-16/17 read only "not_adoptable".
      this.deps.logger.info({ event: "integration.warm_session", outcome: "adopt_refused", agentId: shape.agentId, err: error }, "a warm integration session could not be taken over");
      this.logTake("missed", shape.agentId, context, "not_adoptable");
      await closeIntegrationSession(runner, opened, this.deps.logger, CLOSE_GRACE_MS);
      return undefined;
    }
    this.logTake("reused", shape.agentId, context);
    return opened;
  }

  /** Open a warm session of `shape` for the next read, unless one is already there for this agent. */
  offer(runner: RunnerPort, shape: IntegrationSessionShape): void {
    if (this.byAgent.has(shape.agentId) || runner.adoptSession === undefined) return;
    const input: OpenSessionInput = {
      runner,
      instanceId: this.deps.instanceId(),
      workspaceRoot: this.deps.workspaceRoot(shape.agentId),
      // Replaced by the task's own assignment when a task takes the session.
      context: { instanceId: this.deps.instanceId(), assignmentId: `integration-warm-${randomUUID()}`, attempt: 1, agentId: shape.agentId },
      readinessDeadlineAt: new Date(Date.now() + OPEN_DEADLINE_MS).toISOString(),
      shape,
      logger: this.deps.logger,
    };
    const entry: WarmEntry = { key: shapeKey(shape), runner, opening: Promise.resolve(undefined) };
    entry.opening = openIntegrationSession(input).then(opened => this.opened(shape.agentId, entry, opened), error => {
      this.deps.logger.info({ event: "integration.warm_session", outcome: "open_failed", agentId: shape.agentId, err: error }, "a warm integration session could not be opened");
      if (this.byAgent.get(shape.agentId) === entry) this.byAgent.delete(shape.agentId);
      return undefined;
    });
    this.byAgent.set(shape.agentId, entry);
  }

  /** Close this agent's warm session, for a session that needs its slot; true when one was closed. */
  async release(agentId: string): Promise<boolean> {
    if (!this.byAgent.has(agentId)) return false;
    await this.close(agentId, "slot_needed");
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.byAgent.keys()].map(agentId => this.close(agentId, "stopping")));
  }

  private opened(agentId: string, entry: WarmEntry, opened: OpenedIntegrationSession): OpenedIntegrationSession | undefined {
    if (this.byAgent.get(agentId) !== entry) {
      // Released or replaced while it was opening.
      void closeIntegrationSession(entry.runner, opened, this.deps.logger, CLOSE_GRACE_MS);
      return undefined;
    }
    entry.opened = opened;
    entry.timer = setTimeout(() => void this.close(agentId, "idle"), this.deps.idleMs ?? WARM_SESSION_IDLE_MS);
    entry.timer.unref();
    this.deps.logger.info({ event: "integration.warm_session", outcome: "ready", agentId }, "a warm integration session is ready for the next read");
    return opened;
  }

  private detach(agentId: string, entry: WarmEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    this.byAgent.delete(agentId);
  }

  private async close(agentId: string, reason: string): Promise<void> {
    const entry = this.byAgent.get(agentId);
    if (!entry) return;
    this.detach(agentId, entry);
    const opened = entry.opened ?? await entry.opening;
    if (!opened) return;
    this.deps.logger.info({ event: "integration.warm_session", outcome: "closed", agentId, reason }, "a warm integration session was closed");
    await closeIntegrationSession(entry.runner, opened, this.deps.logger, CLOSE_GRACE_MS);
  }

  private logTake(outcome: "reused" | "missed", agentId: string, context: RunnerSessionInput["context"], reason?: string): void {
    this.deps.logger.info({ event: "integration.warm_session", outcome, agentId, assignmentId: context.assignmentId, ...(reason ? { reason } : {}) },
      outcome === "reused" ? "a read took the warm integration session" : "a read found no warm integration session");
  }
}
