import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixedClock, jcsDigest, type AssignmentReport } from "@konteks/remote-common";
import { SupervisorJournal } from "../state/journal.js";
import { PlanningTerminalDirectiveProcessor } from "../work/planning-terminal-directives.js";
import type { ReportSender } from "../work/report-sender.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "planning-processor-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const now = "2026-09-08T00:00:00.000Z";
const admission = { instanceId: "instance-1", workspaceId: "tenant-1", runnerIncarnation: "runner-1", assignmentId: "assignment-1", attempt: 1, claimId: "claim-1", agentId: "codex", executionGeneration: "generation-1", openedAt: now };
const entry = {
  assignmentId: "assignment-1", attempt: 1, claimId: "claim-1", claimedAt: now, kind: "planning" as const,
  placementId: "placement-1", workspaceId: "tenant-1", agentId: "codex", state: "running" as const,
  recoveryEpoch: 0, reports: { nextSequence: 1, durableWatermark: 0 }, evidenceUpload: "structured_only" as const,
  expiresAt: "2026-09-08T01:00:00.000Z", latestResumeAt: "2026-09-08T01:00:00.000Z", updatedAt: now,
};
const ready = { kind: "session_ready" as const, assignmentId: "assignment-1", acpSessionRef: "acp-1", resumed: false, agentId: "codex", capabilities: { forkSession: false, sessionResume: false } };
const result = { kind: "acp_result" as const, id: "request-1", method: "session/prompt" as const, result: { stopReason: "end_turn" } };

async function fixture() {
  const journal = new SupervisorJournal(dir); await journal.load();
  await journal.assignments.put(entry);
  await journal.execution.admit(admission, () => undefined);
  await journal.planning.start(admission, 0);
  await journal.planning.append(admission, ready);
  const transcript = await journal.planning.append(admission, result);
  const directive = {
    version: 1 as const, directiveId: "directive-1", directiveSequence: 1,
    activationRef: "activation-1", executionRef: "activation-1", assignmentId: "assignment-1", attempt: 1, claimId: "claim-1", recoveryEpoch: 0,
    terminalEvidence: { kind: "prompt_terminal" as const, turnCount: 1, finalRequestId: "request-1", executionDigest: transcript.executionDigest, outputDigest: transcript.outputDigest },
    decisionClass: "succeeded" as const, decisionDigest: "c".repeat(64), issuedAt: now, expiresAt: "2026-09-08T00:05:00.000Z", signature: "AA",
  };
  await journal.planning.storePulled("instance-1", 0, { version: 1, directives: [directive], highWater: 1 });
  let durable: { reportId: string; result: NonNullable<AssignmentReport["result"]> } | undefined;
  const submit = vi.fn(async ({ draft }: { draft: { result: NonNullable<AssignmentReport["result"]> } }) => {
    durable = { reportId: "report-1", result: draft.result };
    return { reportId: "report-1" };
  });
  const reports = { submit, reportForControllerDirective: vi.fn(() => durable) } as unknown as ReportSender;
  const processor = new PlanningTerminalDirectiveProcessor({ clock: new FixedClock(Date.parse(now)), journal, reports,
    instanceId: () => "instance-1", runnerIncarnation: () => "runner-1", assertOwned: () => undefined, verify: () => true });
  return { journal, directive, processor, submit };
}

it("fences before one exact directive-bound report and replays its durable identity", async () => {
  const f = await fixture();
  await expect(f.processor.accept(f.directive)).resolves.toEqual({ reportId: "report-1" });
  expect(() => f.journal.planning.assertPromptAllowed(admission)).toThrow();
  const draft = f.submit.mock.calls[0]![0].draft;
  expect(draft).toMatchObject({ terminal: true, controllerDirectiveId: "directive-1", result: {
    class: "succeeded", structuredOutput: { version: 1, executionRef: "activation-1", turnCount: 1,
      finalRequestId: "request-1", executionDigest: f.directive.terminalEvidence.executionDigest,
      outputDigest: f.directive.terminalEvidence.outputDigest, decisionDigest: "c".repeat(64) },
  } });
  expect(draft.result.terminalResultHash).toBe(jcsDigest({ class: "succeeded", structuredOutput: draft.result.structuredOutput }));
  await expect(f.processor.accept(f.directive)).resolves.toEqual({ reportId: "report-1" });
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it("rejects mismatched local digests before fencing or reporting", async () => {
  const f = await fixture();
  const changed = { ...f.directive, terminalEvidence: { ...f.directive.terminalEvidence, executionDigest: "d".repeat(64) } };
  await expect(f.processor.accept(changed)).rejects.toThrow();
  expect(() => f.journal.planning.assertPromptAllowed(admission)).not.toThrow();
  expect(f.submit).not.toHaveBeenCalled();
});
