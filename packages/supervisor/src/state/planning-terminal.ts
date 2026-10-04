import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PlanningControllerDirectivePullResultSchema,
  PlanningControllerTerminalDirectiveSchema,
  SessionToCoreMessageSchema,
  canonicalize,
  type PlanningControllerDirectivePullResult,
  type JsonValue,
  type PlanningControllerTerminalDirective,
  type SessionToCoreMessage,
} from "@konteks/remote-common";
import { LocalAdmissionSchema, type LocalAdmission } from "./local-admission.js";

const id = z.string().min(1).max(256);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

const CursorRecordSchema = z.object({
  kind: z.literal("cursor"), version: z.literal(1), instanceId: id,
  afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const DirectiveRecordSchema = z.object({
  kind: z.literal("directive"), version: z.literal(1), instanceId: id,
  directiveId: id, directiveSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  directiveDigest: sha256Hex, directive: PlanningControllerTerminalDirectiveSchema,
  state: z.enum(["stored", "fenced", "report_durable"]), reportId: id.optional(),
}).strict().superRefine((value, context) => {
  if (value.directive.directiveId !== value.directiveId || value.directive.directiveSequence !== value.directiveSequence ||
      value.directiveDigest !== hex(canonicalize(value.directive as unknown as JsonValue)) ||
      (value.state === "report_durable") !== (value.reportId !== undefined)) {
    context.addIssue({ code: "custom", message: "Directive journal identity is inconsistent" });
  }
});
const TranscriptRecordSchema = z.object({
  kind: z.literal("execution"), version: z.literal(1), admission: LocalAdmissionSchema,
  recoveryEpoch: z.number().int().nonnegative(), sourceSequence: z.number().int().nonnegative(),
  frameCount: z.number().int().nonnegative(), outputFrameCount: z.number().int().nonnegative(),
  executionDigest: sha256Hex, outputDigest: sha256Hex, lastFrameDigest: sha256Hex.nullable(),
  readySeen: z.boolean(), turnCount: z.number().int().nonnegative(), finalRequestId: id.nullable(),
  promptFenced: z.boolean(), directiveId: id.nullable(),
}).strict();

export const PlanningTerminalRecordSchema = z.discriminatedUnion("kind", [CursorRecordSchema, DirectiveRecordSchema, TranscriptRecordSchema]);
export type PlanningTerminalRecord = z.infer<typeof PlanningTerminalRecordSchema>;
type PlanningTranscriptState = z.infer<typeof TranscriptRecordSchema>;
type PlanningDirectiveRecord = z.infer<typeof DirectiveRecordSchema>;

export function planningTerminalRecordKey(record: PlanningTerminalRecord): string {
  if (record.kind === "cursor") return JSON.stringify(["cursor", record.instanceId]);
  if (record.kind === "directive") return JSON.stringify(["directive", record.instanceId, record.directiveId]);
  return JSON.stringify(["execution", record.admission.executionGeneration]);
}

interface PlanningLog {
  readonly revision: number;
  all(): PlanningTerminalRecord[];
  update(key: string, derive: (existing: PlanningTerminalRecord | undefined) => PlanningTerminalRecord): Promise<void>;
  batch(derive: () => PlanningTerminalRecord[]): Promise<void>;
  rewrite(derive: () => PlanningTerminalRecord[] | undefined): Promise<void>;
  clear(): Promise<void>;
}

const digestSeed = (domain: string, admission: LocalAdmission, recoveryEpoch: number): string =>
  hex(`${domain}\0${canonicalize([admission.assignmentId, admission.attempt, admission.claimId, recoveryEpoch] as unknown as JsonValue)}`);
const fold = (domain: string, previous: string, sequence: number, message: SessionToCoreMessage): string =>
  hex(`${domain}\0${previous}\0${sequence}\0${canonicalize(message as unknown as JsonValue)}`);
const equal = (left: unknown, right: unknown): boolean => canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
function hex(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

/** One fsync-owned planning transcript/directive/cursor domain. */
/** The transcript after one more frame from its own execution, in order: session_ready first and only once. */
function appended(existing: PlanningTerminalRecord | undefined, admission: LocalAdmission, message: SessionToCoreMessage): PlanningTranscriptState {
  if (existing?.kind !== "execution" || !equal(existing.admission, admission)) throw new Error("Planning transcript has no exact execution owner");
  const sourceSequence = existing.sourceSequence + 1;
  if (!Number.isSafeInteger(sourceSequence)) throw new Error("Planning transcript sequence exhausted");
  assertReadyOrder(existing.readySeen, message);
  const terminal = (message.kind === "acp_result" || message.kind === "acp_error") && message.method === "session/prompt";
  return {
    ...existing,
    sourceSequence,
    frameCount: existing.frameCount + 1,
    executionDigest: fold("konteks-planning-execution-frame-v1", existing.executionDigest, sourceSequence, message),
    lastFrameDigest: hex(canonicalize(message as unknown as JsonValue)),
    readySeen: true,
    ...outputFold(existing, sourceSequence, message),
    ...(terminal ? { turnCount: existing.turnCount + 1, finalRequestId: message.id } : {}),
  };
}

function assertReadyOrder(readySeen: boolean, message: SessionToCoreMessage): void {
  if (!readySeen && message.kind !== "session_ready") throw new Error("Planning transcript must begin with session_ready");
  if (readySeen && message.kind === "session_ready") throw new Error("Planning transcript cannot contain a second session_ready");
}

function outputFold(existing: PlanningTranscriptState, sourceSequence: number, message: SessionToCoreMessage): Partial<PlanningTranscriptState> {
  if (message.kind === "session_ready") return {};
  return {
    outputFrameCount: existing.outputFrameCount + 1,
    outputDigest: fold("konteks-planning-output-frame-v1", existing.outputDigest, sourceSequence, message),
  };
}

export class PlanningTerminalJournal {
  constructor(private readonly log: PlanningLog) {}

  clear(): Promise<void> { return this.log.clear(); }

  removeAssignment(assignmentId: string): Promise<void> {
    return this.log.rewrite(() => this.log.all().filter(row =>
      row.kind === "cursor" || (row.kind === "directive" ? row.directive.assignmentId !== assignmentId : row.admission.assignmentId !== assignmentId)));
  }

  cursor(instanceId: string): number {
    const record = this.log.all().find(row => row.kind === "cursor" && row.instanceId === instanceId);
    return record?.kind === "cursor" ? record.afterSequence : 0;
  }

  directive(instanceId: string, directiveId: string): PlanningDirectiveRecord | undefined {
    const record = this.log.all().find(row => row.kind === "directive" && row.instanceId === instanceId && row.directiveId === directiveId);
    return record?.kind === "directive" ? structuredClone(record) : undefined;
  }

  pendingDirectives(instanceId: string): PlanningControllerTerminalDirective[] {
    return this.log.all().filter((row): row is PlanningDirectiveRecord => row.kind === "directive" && row.instanceId === instanceId && row.state !== "report_durable")
      .sort((left, right) => left.directiveSequence - right.directiveSequence).map(row => structuredClone(row.directive));
  }

  execution(admission: LocalAdmission): PlanningTranscriptState | undefined {
    const record = this.log.all().find(row => row.kind === "execution" && row.admission.executionGeneration === admission.executionGeneration);
    if (record?.kind === "execution" && !equal(record.admission, admission)) throw new Error("Planning execution admission changed");
    return record?.kind === "execution" ? structuredClone(record) : undefined;
  }

  async start(admissionCandidate: unknown, recoveryEpoch: number): Promise<void> {
    const admission = LocalAdmissionSchema.parse(admissionCandidate);
    const record: PlanningTranscriptState = {
      kind: "execution", version: 1, admission, recoveryEpoch, sourceSequence: 0, frameCount: 0, outputFrameCount: 0,
      executionDigest: digestSeed("konteks-planning-execution-v1", admission, recoveryEpoch),
      outputDigest: digestSeed("konteks-planning-output-v1", admission, recoveryEpoch),
      lastFrameDigest: null, readySeen: false, turnCount: 0, finalRequestId: null, promptFenced: false, directiveId: null,
    };
    await this.log.update(planningTerminalRecordKey(record), existing => {
      if (existing) {
        if (existing.kind !== "execution" || !equal(existing.admission, admission) || existing.recoveryEpoch !== recoveryEpoch) throw new Error("Planning execution already has different durable identity");
        return existing;
      }
      return record;
    });
  }

  async append(admission: LocalAdmission, candidate: unknown): Promise<PlanningTranscriptState> {
    const message = SessionToCoreMessageSchema.parse(candidate);
    const key = JSON.stringify(["execution", admission.executionGeneration]);
    let committed!: PlanningTranscriptState;
    await this.log.update(key, existing => {
      committed = TranscriptRecordSchema.parse(appended(existing, admission, message));
      return committed;
    });
    return structuredClone(committed);
  }


  /** The directive's row: the next sequence, inside the page's high-water, its identity and sequence never reused. */
  private directiveRow(instanceId: string, directive: PlanningControllerTerminalDirective, expected: number, highWater: number): PlanningTerminalRecord {
    if (directive.directiveSequence !== expected || directive.directiveSequence > highWater) throw new Error("Controller directive page has a gap");
    const prior = this.directive(instanceId, directive.directiveId);
    if (prior && !equal(prior.directive, directive)) throw new Error("Controller directive identity was reused");
    this.assertSequenceUnused(instanceId, directive);
    return prior ?? { kind: "directive", version: 1, instanceId, directiveId: directive.directiveId,
      directiveSequence: directive.directiveSequence, directiveDigest: hex(canonicalize(directive as unknown as JsonValue)), directive, state: "stored" };
  }

  private assertSequenceUnused(instanceId: string, directive: PlanningControllerTerminalDirective): void {
    const atSequence = this.log.all().find(row => row.kind === "directive" && row.instanceId === instanceId && row.directiveSequence === directive.directiveSequence);
    if (atSequence?.kind === "directive" && atSequence.directiveId !== directive.directiveId) throw new Error("Controller directive sequence was reused");
  }

  async storePulled(instanceId: string, afterSequence: number, candidate: PlanningControllerDirectivePullResult): Promise<void> {
    const page = PlanningControllerDirectivePullResultSchema.parse(candidate);
    await this.log.batch(() => {
      if (this.cursor(instanceId) !== afterSequence) throw new Error("Controller directive cursor changed");
      const rows: PlanningTerminalRecord[] = page.directives.map((directive, index) => this.directiveRow(instanceId, directive, afterSequence + 1 + index, page.highWater));
      if (page.highWater < afterSequence || (page.directives.length === 0 && page.highWater > afterSequence)) throw new Error("Controller directive high-water is invalid");
      rows.push({ kind: "cursor", version: 1, instanceId, afterSequence: page.directives.at(-1)?.directiveSequence ?? afterSequence });
      return rows;
    });
  }

  async fence(admission: LocalAdmission, candidate: PlanningControllerTerminalDirective): Promise<void> {
    const directive = PlanningControllerTerminalDirectiveSchema.parse(candidate);
    const execution = this.execution(admission);
    const saved = this.directive(admission.instanceId, directive.directiveId);
    if (!execution || !saved || !equal(saved.directive, directive)) throw new Error("Planning directive has no exact durable owner");
    await this.log.batch(() => {
      const current = this.execution(admission), currentDirective = this.directive(admission.instanceId, directive.directiveId);
      if (!current || !currentDirective || !equal(currentDirective.directive, directive) || (current.directiveId && current.directiveId !== directive.directiveId)) throw new Error("Planning directive ownership changed");
      return [
        { ...current, promptFenced: true, directiveId: directive.directiveId },
        currentDirective.state === "stored" ? { ...currentDirective, state: "fenced" } : currentDirective,
      ];
    });
  }

  assertPromptAllowed(admission: LocalAdmission): void {
    const execution = this.execution(admission);
    if (!execution || execution.promptFenced) throw new Error("Planning prompts are fenced");
  }

  async recordReport(instanceId: string, directiveId: string, reportId: string): Promise<void> {
    await this.log.update(JSON.stringify(["directive", instanceId, directiveId]), existing => {
      if (existing?.kind !== "directive" || existing.state === "stored") throw new Error("Planning directive was not fenced");
      if (existing.state === "report_durable") {
        if (existing.reportId !== reportId) throw new Error("Planning directive report changed");
        return existing;
      }
      return { ...existing, state: "report_durable", reportId };
    });
  }
}
