import { PlanningControllerTerminalDirectiveSchema, RemoteInstanceError, allEqual, jcsDigest, type AssignmentReport, type Clock, type JsonValue, type PlanningControllerTerminalDirective } from "@konteks/remote-common";
import type { SupervisorJournal } from "../state/journal.js";
import type { ReportSender } from "./report-sender.js";
import type { LocalAdmission } from "../state/local-admission.js";

interface PlanningTerminalDirectiveProcessorOptions {
  clock: Clock; journal: SupervisorJournal; reports: ReportSender;
  instanceId: () => string; runnerIncarnation: () => string; assertOwned: () => void;
  verify: (directive: PlanningControllerTerminalDirective, tenantId: string, instanceId: string) => boolean;
}

type PlanningEntry = NonNullable<ReturnType<SupervisorJournal["assignments"]["get"]>>;
type PlanningTranscript = NonNullable<ReturnType<SupervisorJournal["planning"]["execution"]>>;

/** States in which a planning claim may still take its terminal directive. */
const DIRECTIVE_STATES = ["running", "checkpointed", "terminal_pending_report", "completed"];

/** Core's binding of the directive to its activation, issued by now and not yet expired. */
function assertDirectiveWindow(directive: PlanningControllerTerminalDirective, observedAt: number): void {
  if (directive.executionRef !== directive.activationRef || Date.parse(directive.issuedAt) > observedAt || Date.parse(directive.expiresAt) <= observedAt) {
    throw conflict("Planning directive is expired or malformed");
  }
}

function claimOwned(entry: PlanningEntry, admission: LocalAdmission, directive: PlanningControllerTerminalDirective, owner: { instanceId: string; runnerIncarnation: string }): boolean {
  return entry.kind === "planning" && DIRECTIVE_STATES.includes(entry.state) && allEqual([
    [entry.claimId, directive.claimId],
    [admission.instanceId, owner.instanceId],
    [admission.workspaceId, entry.workspaceId],
    [admission.claimId, directive.claimId],
    [admission.runnerIncarnation, owner.runnerIncarnation],
    [entry.recoveryEpoch, directive.recoveryEpoch],
  ]);
}

/** The local transcript is the execution the directive's evidence names; a prompt terminal also names its output and final request. */
function transcriptMatches(transcript: PlanningTranscript, directive: PlanningControllerTerminalDirective): boolean {
  const evidence = directive.terminalEvidence;
  return allEqual([
    [transcript.recoveryEpoch, directive.recoveryEpoch],
    [transcript.executionDigest, evidence.executionDigest],
    [transcript.turnCount, evidence.turnCount],
  ]) && (evidence.kind !== "prompt_terminal" ||
    (transcript.readySeen && transcript.outputDigest === evidence.outputDigest && transcript.finalRequestId === evidence.finalRequestId));
}

/** Converts only a Core-signed, locally equal planning terminal intent into the claim's terminal report. */
export class PlanningTerminalDirectiveProcessor {
  constructor(private readonly options: PlanningTerminalDirectiveProcessorOptions) {}

  async accept(candidate: unknown): Promise<{ reportId: string }> {
    const directive = PlanningControllerTerminalDirectiveSchema.parse(candidate);
    this.options.assertOwned();
    assertDirectiveWindow(directive, this.options.clock.now());
    const instanceId = this.options.instanceId();
    const { entry, admission } = this.ownedClaim(directive, instanceId);
    this.options.journal.execution.assertAdmission(admission);
    if (!this.options.verify(directive, entry.workspaceId, instanceId)) throw conflict("Planning directive signature is invalid");
    const saved = this.options.journal.planning.directive(instanceId, directive.directiveId);
    if (!saved || jcsDigest(saved.directive as unknown as JsonValue) !== jcsDigest(directive as unknown as JsonValue)) throw conflict("Planning directive was not durably pulled");
    const durable = this.options.reports.reportForControllerDirective(directive.assignmentId, directive.attempt, directive.claimId, directive.directiveId);
    if (durable) {
      await this.options.journal.planning.recordReport(instanceId, directive.directiveId, durable.reportId);
      return { reportId: durable.reportId };
    }
    if (entry.reports.terminalSequence !== undefined) throw conflict("Another terminal report already owns this claim");
    const transcript = this.options.journal.planning.execution(admission);
    if (!transcript || !transcriptMatches(transcript, directive)) throw conflict("Planning directive transcript evidence differs from local execution truth");
    return this.report(instanceId, directive, admission);
  }

  /** The local planning claim and admission this directive must own exactly. */
  private ownedClaim(directive: PlanningControllerTerminalDirective, instanceId: string) {
    const entry = this.options.journal.assignments.get(`${directive.assignmentId}:${directive.attempt}`);
    const admission = this.options.journal.execution.admission(directive.assignmentId, directive.attempt);
    if (!entry || !admission || !claimOwned(entry, admission, directive, { instanceId, runnerIncarnation: this.options.runnerIncarnation() })) {
      throw conflict("Planning directive does not own this local claim");
    }
    return { entry, admission };
  }

  /** Fence the transcript, then submit the directive's terminal result and record its report. */
  private async report(instanceId: string, directive: PlanningControllerTerminalDirective, admission: LocalAdmission): Promise<{ reportId: string }> {
    await this.options.journal.planning.fence(admission, directive);
    this.options.assertOwned(); this.options.journal.execution.assertAdmission(admission);
    const semantic = terminalResult(directive);
    const result = { ...semantic, terminalResultHash: jcsDigest(semantic as unknown as JsonValue) } as NonNullable<AssignmentReport["result"]>;
    const report = await this.options.reports.submit({ assignmentId: directive.assignmentId, attempt: directive.attempt, claimId: directive.claimId,
      draft: { terminal: true, result, controllerDirectiveId: directive.directiveId } });
    await this.options.journal.planning.recordReport(instanceId, directive.directiveId, report.reportId);
    return { reportId: report.reportId };
  }}

type WithoutTerminalHash<T> = T extends unknown ? Omit<T, "terminalResultHash"> : never;
type TerminalSemantic = WithoutTerminalHash<NonNullable<AssignmentReport["result"]>>;
function terminalResult(directive: PlanningControllerTerminalDirective): TerminalSemantic {
  if (directive.decisionClass === "succeeded" || directive.decisionClass === "failed") {
    const structuredOutput = directive.terminalEvidence.kind === "prompt_terminal" ? { version: 1 as const, executionRef: directive.executionRef,
      turnCount: directive.terminalEvidence.turnCount, finalRequestId: directive.terminalEvidence.finalRequestId,
      executionDigest: directive.terminalEvidence.executionDigest, outputDigest: directive.terminalEvidence.outputDigest, decisionDigest: directive.decisionDigest } : undefined;
    return directive.decisionClass === "succeeded" ? { class: "succeeded", ...(structuredOutput ? { structuredOutput } : {}) }
      : { class: "failed", reason: directive.failureReason, ...(structuredOutput ? { structuredOutput } : {}) };
  }
  if (directive.decisionClass === "interrupted") return { class: "interrupted", reason: directive.failureReason };
  return { class: "cancelled", reason: directive.cancelReason };
}
function conflict(message: string): RemoteInstanceError { return new RemoteInstanceError("assignment_conflict", message); }
