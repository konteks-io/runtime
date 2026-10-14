import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@konteks/remote-common";
import type { RunnerPort, RunnerSessionInput } from "../runner-port.js";
import { StructuredResultToolServer } from "../structured-result/result-tool-server.js";

type SessionContext = RunnerSessionInput["context"];

/** What an integration session admits: the same shape is the same session, whichever task takes it. */
export interface IntegrationSessionShape {
  agentId: string;
  admission: NonNullable<RunnerSessionInput["integration"]>;
  /** E2E only: the synthetic provider served as the session's own MCP server. */
  fixture?: { name: string; url: string };
}

/**
 * One integration session's own resources: its empty private folder, its
 * `konteks-result` tool and the agent's new ACP session, admitting exactly
 * the shape's sources. Nothing in it belongs to a task until a task takes it.
 */
export interface OpenedIntegrationSession {
  readonly shape: IntegrationSessionShape;
  readonly acpSessionRef: string;
  readonly cwd: string;
  readonly resultTools: StructuredResultToolServer;
  /** The MCP servers the session itself serves (its own result tool, and an E2E fixture). */
  readonly sessionServers: ReadonlySet<string>;
}

/** The identity of a shape: an agent, the sources it admits and the utility model. */
export function shapeKey(shape: IntegrationSessionShape): string {
  const { admission } = shape;
  return JSON.stringify([shape.agentId, admission.accountConnectors, [...admission.admittedMcpServerNames].sort(),
    admission.utility?.model ?? null, shape.fixture?.url ?? null]);
}

export interface OpenSessionInput {
  runner: RunnerPort;
  instanceId: string;
  workspaceRoot: string;
  context: SessionContext;
  readinessDeadlineAt: string;
  shape: IntegrationSessionShape;
  logger: Logger;
}

/** A new session of `shape`: folder, result tool and ACP session; everything is undone when any step fails. */
export async function openIntegrationSession(input: OpenSessionInput): Promise<OpenedIntegrationSession> {
  const cwd = await mkdtemp(join(input.workspaceRoot, ".integration-"));
  const resultTools = new StructuredResultToolServer({ logger: input.logger, context: { assignmentId: input.context.assignmentId, attempt: input.context.attempt } });
  try {
    await chmod(cwd, 0o700);
    const resultServer = await resultTools.start();
    const mcpServers: RunnerSessionInput["mcpServers"] = [{ type: "http", ...resultServer }];
    const fixture = input.shape.fixture;
    if (fixture) mcpServers.push({ type: "http", name: fixture.name, url: fixture.url, headers: [] });
    const created = await input.runner.createSession({ context: input.context, readinessDeadlineAt: input.readinessDeadlineAt, cwd, mcpServers,
      integration: input.shape.admission });
    return { shape: input.shape, acpSessionRef: created.acpSessionRef, cwd, resultTools, sessionServers: new Set(mcpServers.map(server => server.name)) };
  } catch (error) {
    await resultTools.close().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Whether `work` settled within `ms`; it keeps running either way. */
export async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); timer.unref(); });
  const done = await Promise.race([work.then(() => true, () => true), timeout]);
  clearTimeout(timer);
  return done;
}

/** Close the ACP session (bounded), the result tool and the private folder. */
export async function closeIntegrationSession(runner: RunnerPort, opened: OpenedIntegrationSession, logger: Logger, graceMs: number): Promise<void> {
  const closing = runner.closeSession(opened.acpSessionRef).catch(error => logger.warn({ err: error }, "integration session close failed"));
  if (!(await settledWithin(closing, graceMs))) logger.warn({ acpSessionRef: opened.acpSessionRef }, "integration session close still running; going on without waiting for it");
  await opened.resultTools.close().catch(() => undefined);
  await rm(opened.cwd, { recursive: true, force: true }).catch(() => undefined);
}
