import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";
import {
  AgentSkillReadObservationSchema,
  type AgentSkillReadObservation,
} from "@konteks/backstage-plugin-common/remote-instance-internal";

export type ManagedSkillReadTarget = {
  skillId: string;
  version: string;
  skillFile: string;
};

export type SkillReadAuthorityContext = Pick<
  AgentSkillReadObservation,
  | "instanceId"
  | "agentId"
  | "executionId"
  | "sessionId"
  | "assignmentId"
  | "attempt"
  | "claimId"
  | "recoveryEpoch"
  | "readyRevision"
  | "runnerIncarnation"
  | "acpSessionRef"
  | "executionRevision"
  | "leaseSetId"
> & { turnId: string };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isReadCall(update: RecordValue): boolean {
  if (typeof update.kind === "string" && update.kind.toLowerCase() === "read") return true;
  return [update.name, update.title].some((value) => {
    const name = text(value)?.toLowerCase();
    if (!name) return false;
    const first = name.split(/\s+/, 1)[0]!;
    return /(?:^|[._/: -])read(?:[._ -]?file)?$/u.test(first);
  });
}

function requestedInputFile(rawInput: unknown): string | undefined {
  const input = record(rawInput);
  if (!input) return undefined;
  const records = [input, record(input?.arguments), record(input?.args)].filter(
    (value): value is RecordValue => value !== undefined,
  );
  for (const candidate of records) {
    for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
      const value = text(candidate[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function requestedLocationFile(locations: unknown): string | undefined {
  if (!Array.isArray(locations)) return undefined;
  for (const location of locations) {
    const value = text(record(location)?.path);
    if (value) return value;
  }
  return undefined;
}

function requestedFile(update: RecordValue): string | undefined {
  return requestedInputFile(update.rawInput) ?? requestedLocationFile(update.locations);
}

function terminalStatus(status: unknown): "completed" | "failed" | "other" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled" || status === "canceled") return "failed";
  return "other";
}

function completedCallKey(authority: SkillReadAuthorityContext, toolCallId: string): string {
  return `${authority.executionId}\0${authority.turnId}\0${toolCallId}`;
}

/** Counts only a completed, structured file-read call for an exact staged Skill file. */
export class ManagedSkillReadTracker {
  private readonly targets = new Map<string, ManagedSkillReadTarget>();
  private readonly pending = new Map<string, ManagedSkillReadTarget>();
  private readonly completedCalls = new Set<string>();
  private readonly loadedSkills = new Set<string>();
  private invalidTargetCount = 0;

  constructor(
    private readonly cwd: string,
    targets: readonly ManagedSkillReadTarget[],
    private readonly catalogRevision?: string,
  ) {
    for (const target of targets) {
      if (!target.skillId || !/^\d+\.\d+\.\d+$/u.test(target.version) || !target.skillFile) {
        this.invalidTargetCount += 1;
        continue;
      }
      const file = normalize(resolve(target.skillFile));
      if (this.targets.has(file)) {
        this.invalidTargetCount += 1;
        continue;
      }
      this.targets.set(file, target);
    }
  }

  /** A Skill-bearing turn is ready only after every exact staged version was read under current authority. */
  allRequiredSkillsLoaded(): boolean {
    return this.invalidTargetCount === 0 && this.loadedSkills.size === this.targets.size;
  }

  /** Stable owner revision is usable only after every non-empty required set was read. */
  loadedCatalogRevision(): string | null {
    return this.targets.size > 0 && this.allRequiredSkillsLoaded() ? this.catalogRevision ?? null : null;
  }

  /** Before load proof exists, permission is limited to reading one exact required staged Skill file. */
  isRequiredSkillRead(candidate: unknown): boolean {
    const request = record(candidate);
    const toolCall = record(request?.toolCall) ?? request;
    if (!toolCall || !isReadCall(toolCall)) return false;
    const file = requestedFile(toolCall);
    return file !== undefined && this.targetFor(file) !== undefined;
  }

  observe(
    candidate: unknown,
    authority: SkillReadAuthorityContext | null,
    observedAt: string,
  ): AgentSkillReadObservation | null {
    const update = record(candidate);
    if (!update) return null;
    const callId = text(update.toolCallId);
    if (!callId || (authority && this.completedCalls.has(completedCallKey(authority, callId)))) return null;
    if (update.sessionUpdate === "tool_call")
      return this.started(update, callId, authority, observedAt);
    if (update.sessionUpdate !== "tool_call_update") return null;
    return this.finished(update, callId, authority, observedAt);
  }

  private started(
    update: RecordValue,
    callId: string,
    authority: SkillReadAuthorityContext | null,
    observedAt: string,
  ): AgentSkillReadObservation | null {
    if (!isReadCall(update)) return null;
    const file = requestedFile(update);
    if (!file) return null;
    const target = this.targetFor(file);
    if (!target) return null;
    if (terminalStatus(update.status) === "completed")
      return this.complete(callId, target, authority, observedAt);
    this.pending.set(callId, target);
    return null;
  }

  private finished(
    update: RecordValue,
    callId: string,
    authority: SkillReadAuthorityContext | null,
    observedAt: string,
  ): AgentSkillReadObservation | null {
    const target = this.pending.get(callId);
    if (!target) return null;
    const status = terminalStatus(update.status);
    if (status === "other") return null;
    this.pending.delete(callId);
    if (status !== "completed") return null;
    return this.complete(callId, target, authority, observedAt);
  }

  private targetFor(file: string): ManagedSkillReadTarget | undefined {
    try {
      return this.targets.get(normalize(resolve(this.cwd, file)));
    } catch {
      return undefined;
    }
  }

  private complete(
    toolCallId: string,
    target: ManagedSkillReadTarget,
    authority: SkillReadAuthorityContext | null,
    observedAt: string,
  ): AgentSkillReadObservation | null {
    this.pending.delete(toolCallId);
    if (!authority) return null;
    const eventId = `skill-read-${createHash("sha256")
      .update(
        [authority.executionId, authority.turnId, toolCallId, target.skillId, target.version].join(
          "\0",
        ),
      )
      .digest("hex")}`;
    const parsed = AgentSkillReadObservationSchema.safeParse({
      ...authority,
      kind: "skill_read_completed",
      eventId,
      toolCallId,
      capabilityId: target.skillId,
      version: target.version,
      observedAt,
    });
    if (!parsed.success) return null;
    this.completedCalls.add(completedCallKey(authority, toolCallId));
    this.loadedSkills.add(target.skillId);
    return parsed.data;
  }
}
