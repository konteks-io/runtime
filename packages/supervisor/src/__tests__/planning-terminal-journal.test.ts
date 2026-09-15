import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SupervisorJournal } from "../state/journal.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "planning-terminal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const admission = {
  instanceId: "instance-1", workspaceId: "tenant-1", runnerIncarnation: "runner-1",
  assignmentId: "assignment-1", attempt: 1, claimId: "claim-1", agentId: "codex",
  executionGeneration: "generation-1", openedAt: "2026-09-08T00:00:00.000Z",
};
const ready = {
  kind: "session_ready" as const, assignmentId: "assignment-1", acpSessionRef: "acp-1",
  resumed: false, agentId: "codex", capabilities: { forkSession: false, sessionResume: false },
};
const update = {
  kind: "acp" as const, method: "session/update" as const,
  params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "plan" } } },
};
const result = {
  kind: "acp_result" as const, id: "request-1", method: "session/prompt" as const,
  result: { stopReason: "end_turn" },
};
const terminalEvidence = {
  kind: "prompt_terminal" as const, turnCount: 1, finalRequestId: "request-1",
  executionDigest: "a".repeat(64), outputDigest: "b".repeat(64),
};
const directive = {
  version: 1 as const, directiveId: "directive-1", directiveSequence: 1,
  activationRef: "activation-1", executionRef: "activation-1",
  assignmentId: "assignment-1", attempt: 1, claimId: "claim-1", recoveryEpoch: 0,
  terminalEvidence, decisionClass: "succeeded" as const, decisionDigest: "c".repeat(64),
  issuedAt: "2026-09-08T00:00:00.000Z", expiresAt: "2026-09-08T00:05:00.000Z", signature: "AA",
};

it("durably folds the exact contiguous planning transcript without retaining message bodies", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  await journal.planning.start(admission, 0);
  expect(await journal.planning.append(admission, ready)).toMatchObject({ sourceSequence: 1, turnCount: 0, readySeen: true });
  expect(await journal.planning.append(admission, update)).toMatchObject({ sourceSequence: 2, turnCount: 0 });
  const folded = await journal.planning.append(admission, result);
  expect(folded).toMatchObject({ sourceSequence: 3, turnCount: 1, finalRequestId: "request-1" });
  expect(folded.executionDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(folded.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(journal.planning.execution(admission))).not.toContain("plan");

  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.planning.execution(admission)).toEqual(folded);
});

it("stores a contiguous directive page and advances its cursor in the same durable batch", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  await journal.planning.storePulled("instance-1", 0, { version: 1, directives: [directive], highWater: 1 });
  expect(journal.planning.cursor("instance-1")).toBe(1);
  expect(journal.planning.directive("instance-1", "directive-1")?.directive).toEqual(directive);

  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(reopened.planning.cursor("instance-1")).toBe(1);
  await reopened.planning.storePulled("instance-1", 1, { version: 1, directives: [], highWater: 1 });
  await expect(reopened.planning.storePulled("instance-1", 0, { version: 1, directives: [{ ...directive, decisionDigest: "d".repeat(64) }], highWater: 1 })).rejects.toThrow();
});

it("fences prompts durably before remembering the report and rejects changed directive replay", async () => {
  const journal = new SupervisorJournal(dir); await journal.load();
  await journal.planning.start(admission, 0);
  await journal.planning.storePulled("instance-1", 0, { version: 1, directives: [directive], highWater: 1 });
  await journal.planning.fence(admission, directive);
  expect(() => journal.planning.assertPromptAllowed(admission)).toThrow();
  await journal.planning.recordReport("instance-1", "directive-1", "report-1");

  const reopened = new SupervisorJournal(dir); await reopened.load();
  expect(() => reopened.planning.assertPromptAllowed(admission)).toThrow();
  expect(reopened.planning.directive("instance-1", "directive-1")).toMatchObject({ state: "report_durable", reportId: "report-1" });
  await expect(reopened.planning.storePulled("instance-1", 1, { version: 1, directives: [{ ...directive, directiveSequence: 2, decisionDigest: "d".repeat(64) }], highWater: 2 })).rejects.toThrow();
});
