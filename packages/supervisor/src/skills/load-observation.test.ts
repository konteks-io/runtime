import { describe, expect, it } from "vitest";
import { ManagedSkillReadTracker } from "./load-observation.js";

const skill = {
  skillId: "abf086ab-74ae-4a7c-9204-7a77852f50e7",
  version: "1.2.3",
  skillFile: "/private/skills/code-review/SKILL.md",
};

const authority = {
  instanceId: "instance",
  agentId: "codex",
  executionId: "execution",
  sessionId: "session",
  assignmentId: "assignment",
  attempt: 1,
  claimId: "claim",
  recoveryEpoch: 0,
  readyRevision: 1,
  runnerIncarnation: "runner",
  acpSessionRef: "acp-session",
  executionRevision: 1,
  leaseSetId: "lease-set",
  turnId: "turn",
};

describe("managed Skill read observations", () => {
  it.each([{ offset: 10 }, { limit: 1 }, { start_line: 2, end_line: 3 }, { startLine: 2, endLine: 3 }, { line_start: 2, line_end: 3 }])(
    "does not count a partial Skill read as completed loading: %j",
    range => {
      const tracker = new ManagedSkillReadTracker("/private/work", [skill]);
      expect(tracker.observe({ sessionUpdate: "tool_call", toolCallId: "partial", kind: "read", status: "completed", rawInput: { path: skill.skillFile, ...range } }, authority, "2026-10-18T00:00:00.000Z")).toBeNull();
      expect(tracker.allRequiredSkillsLoaded()).toBe(false);
    },
  );

  it("does not infer a verified read from a display title", () => {
    const tracker = new ManagedSkillReadTracker("/private/work", [skill]);
    const call = { sessionUpdate: "tool_call", toolCallId: "title-only", title: "read_file", status: "completed", rawInput: { path: skill.skillFile } };
    expect(tracker.isRequiredSkillRead({ toolCall: call })).toBe(false);
    expect(tracker.observe(call, authority, "2026-10-18T00:00:00.000Z")).toBeNull();
    expect(tracker.allRequiredSkillsLoaded()).toBe(false);
  });

  it.each([null, { ...authority, turnId: "previous-turn" }, { ...authority, runnerIncarnation: "previous-runner" }])(
    "does not complete a read begun without the same verified authority: %j",
    startedAuthority => {
      const tracker = new ManagedSkillReadTracker("/private/work", [skill]);
      tracker.observe({ sessionUpdate: "tool_call", toolCallId: "read", kind: "read", status: "in_progress", rawInput: { path: skill.skillFile } }, startedAuthority, "2026-10-18T00:00:00.000Z");
      expect(tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" }, authority, "2026-10-18T00:00:01.000Z")).toBeNull();
      expect(tracker.allRequiredSkillsLoaded()).toBe(false);
    },
  );

  it("returns a catalog load proof only after every exact required Skill file is read", () => {
    const revision = `sha256:${"a".repeat(64)}`;
    const second = { ...skill, skillId: "8c928cc2-5e58-4e27-8425-6f1ad40265ea", skillFile: "/private/skills/second/SKILL.md" };
    const tracker = new ManagedSkillReadTracker("/private/work", [skill, second], revision);
    const complete = (toolCallId: string, target: typeof skill) => {
      tracker.observe({ sessionUpdate: "tool_call", toolCallId, kind: "read", status: "in_progress", rawInput: { path: target.skillFile } }, authority, "2026-10-14T00:00:00.000Z");
      tracker.observe({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" }, authority, "2026-10-14T00:00:01.000Z");
    };

    expect(tracker.loadedCatalogRevision()).toBeNull();
    complete("read-one", skill);
    expect(tracker.loadedCatalogRevision()).toBeNull();
    complete("read-two", second);
    expect(tracker.loadedCatalogRevision()).toBe(revision);
  });

  it("counts one completed read of the exact staged SKILL.md and deduplicates terminal updates", () => {
    const tracker = new ManagedSkillReadTracker("/private/work", [skill]);
    expect(tracker.allRequiredSkillsLoaded()).toBe(false);
    expect(
      tracker.observe(
        {
          sessionUpdate: "tool_call",
          toolCallId: "read-1",
          kind: "read",
          status: "in_progress",
          rawInput: { file_path: skill.skillFile },
        },
        authority,
        "2026-10-13T00:00:00.000Z",
      ),
    ).toBeNull();

    const observation = tracker.observe(
      { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" },
      authority,
      "2026-10-13T00:00:01.000Z",
    );
    expect(observation).toMatchObject({
      ...authority,
      kind: "skill_read_completed",
      toolCallId: "read-1",
      capabilityId: skill.skillId,
      version: skill.version,
      observedAt: "2026-10-13T00:00:01.000Z",
    });
    expect(observation?.eventId).toMatch(/^skill-read-[a-f0-9]{64}$/u);
    expect(tracker.allRequiredSkillsLoaded()).toBe(true);
    expect(
      tracker.observe(
        { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" },
        authority,
        "2026-10-13T00:00:02.000Z",
      ),
    ).toBeNull();
  });

  it("deduplicates retries per turn but counts distinct reads when an agent reuses a tool id", () => {
    const tracker = new ManagedSkillReadTracker("/private/work", [skill]);
    const read = (toolCallId: string, turnId: string) => tracker.observe(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        kind: "read",
        status: "completed",
        rawInput: { path: skill.skillFile },
      },
      { ...authority, turnId },
      `2026-10-14T00:00:0${turnId.endsWith("b") ? "1" : "0"}.000Z`,
    );

    const first = read("read", "turn-a");
    expect(first).not.toBeNull();
    expect(read("read", "turn-a")).toBeNull();
    const secondLoad = read("read-2", "turn-a");
    const reusedId = read("read", "turn-b");

    expect(secondLoad).not.toBeNull();
    expect(reusedId).not.toBeNull();
    expect(new Set([first?.eventId, secondLoad?.eventId, reusedId?.eventId]).size).toBe(3);
  });

  it("does not count failed reads, injected instructions, or unrelated files", () => {
    const tracker = new ManagedSkillReadTracker("/private/work", [skill]);
    tracker.observe(
      {
        sessionUpdate: "tool_call",
        toolCallId: "failed",
        name: "read_file",
        status: "in_progress",
        rawInput: { path: skill.skillFile },
      },
      authority,
      "2026-10-13T00:00:00.000Z",
    );
    expect(
      tracker.observe(
        { sessionUpdate: "tool_call_update", toolCallId: "failed", status: "failed" },
        authority,
        "2026-10-13T00:00:01.000Z",
      ),
    ).toBeNull();
    expect(
      tracker.observe(
        {
          sessionUpdate: "tool_call",
          toolCallId: "other",
          kind: "read",
          status: "completed",
          rawInput: { arguments: { path: "/private/work/README.md" } },
        },
        authority,
        "2026-10-13T00:00:02.000Z",
      ),
    ).toBeNull();
    expect(
      tracker.observe(
        {
          sessionUpdate: "tool_call",
          toolCallId: "command",
          kind: "execute",
          title: "cat",
          status: "completed",
          rawInput: { path: skill.skillFile },
        },
        authority,
        "2026-10-13T00:00:03.000Z",
      ),
    ).toBeNull();
    expect(
      tracker.observe(
        {
          sessionUpdate: "tool_call",
          toolCallId: "unknown-authority",
          kind: "read",
          status: "completed",
          rawInput: { filePath: skill.skillFile },
        },
        null,
        "2026-10-13T00:00:04.000Z",
      ),
    ).toBeNull();
    expect(tracker.allRequiredSkillsLoaded()).toBe(false);
  });

  it("requires every valid staged version and exposes only exact required reads before proof", () => {
    const second = {
      ...skill,
      skillId: "8c928cc2-5e58-4e27-8425-6f1ad40265ea",
      skillFile: "/private/skills/security/SKILL.md",
    };
    const tracker = new ManagedSkillReadTracker("/private/work", [skill, second]);
    expect(
      tracker.isRequiredSkillRead({
        toolCall: { kind: "read", rawInput: { file_path: skill.skillFile } },
      }),
    ).toBe(true);
    expect(
      tracker.isRequiredSkillRead({
        toolCall: { kind: "read", locations: [{ path: skill.skillFile }] },
      }),
    ).toBe(true);
    expect(
      tracker.isRequiredSkillRead({
        toolCall: { kind: "read", rawInput: { file_path: "/private/work/README.md" } },
      }),
    ).toBe(false);
    expect(
      tracker.isRequiredSkillRead({ toolCall: { kind: "execute", rawInput: { command: "cat" } } }),
    ).toBe(false);
    tracker.observe(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        kind: "read",
        status: "completed",
        rawInput: { file_path: skill.skillFile },
      },
      authority,
      "2026-10-13T00:00:00.000Z",
    );
    expect(tracker.allRequiredSkillsLoaded()).toBe(false);
    tracker.observe(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-2",
        kind: "read",
        status: "completed",
        rawInput: { file_path: second.skillFile },
      },
      authority,
      "2026-10-13T00:00:01.000Z",
    );
    expect(tracker.allRequiredSkillsLoaded()).toBe(true);
  });

  it("keeps malformed or conflicting required targets permanently unproven", () => {
    const tracker = new ManagedSkillReadTracker("/private/work", [
      skill,
      { ...skill, version: "latest" },
      { ...skill, skillId: "different-skill" },
    ]);
    tracker.observe(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        kind: "read",
        status: "completed",
        rawInput: { file_path: skill.skillFile },
      },
      authority,
      "2026-10-13T00:00:00.000Z",
    );
    expect(tracker.allRequiredSkillsLoaded()).toBe(false);
  });
});
