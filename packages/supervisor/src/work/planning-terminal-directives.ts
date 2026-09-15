import { PlanningControllerTerminalDirectiveSchema, RemoteInstanceError, jcsDigest, type AssignmentReport, type Clock, type JsonValue, type PlanningControllerTerminalDirective } from "@konteks/remote-common";
import type { SupervisorJournal } from "../state/journal.js";
import type { ReportSender } from "./report-sender.js";

export interface PlanningTerminalDirectiveProcessorOptions {
  clock: Clock; journal: SupervisorJournal; reports: ReportSender;
  instanceId: () => string; runnerIncarnation: () => string; assertOwned: () => void;
  verify: (directive: PlanningControllerTerminalDirective, tenantId: string, instanceId: string) => boolean;
}

/** Converts only a Core-signed, locally equal planning terminal intent into D125. */
export class PlanningTerminalDirectiveProcessor {
  constructor(private readonly options: PlanningTerminalDirectiveProcessorOptions) {}

  async accept(candidate: unknown): Promise<{ reportId: string }> {
    const directive = PlanningControllerTerminalDirectiveSchema.parse(candidate);
    this.options.assertOwned();
    const observedAt = this.options.clock.now();
    if (directive.executionRef !== directive.activationRef || Date.parse(directive.issuedAt) > observedAt || Date.parse(directive.expiresAt) <= observedAt) throw conflict("Planning directive is expired or malformed");
    const instanceId = this.options.instanceId();
    const entry = this.options.journal.assignments.get(`${directive.assignmentId}:${directive.attempt}`);
    const admission = this.options.journal.execution.admission(directive.assignmentId, directive.attempt);
    if (!entry || entry.kind !== "planning" || !["running", "checkpointed", "terminal_pending_report", "completed"].includes(entry.state) || entry.claimId !== directive.claimId || !admission ||
      admission.instanceId !== instanceId || admission.workspaceId !== entry.workspaceId || admission.claimId !== directive.claimId ||
      admission.runnerIncarnation !== this.options.runnerIncarnation() || entry.recoveryEpoch !== directive.recoveryEpoch) throw conflict("Planning directive does not own this local claim");
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
    if (!transcript || transcript.recoveryEpoch !== directive.recoveryEpoch || transcript.executionDigest !== directive.terminalEvidence.executionDigest || transcript.turnCount !== directive.terminalEvidence.turnCount ||
      (directive.terminalEvidence.kind === "prompt_terminal" && (!transcript.readySeen || transcript.outputDigest !== directive.terminalEvidence.outputDigest || transcript.finalRequestId !== directive.terminalEvidence.finalRequestId))) throw conflict("Planning directive transcript evidence differs from local execution truth");
    await this.options.journal.planning.fence(admission, directive);
    this.options.assertOwned(); this.options.journal.execution.assertAdmission(admission);
    const semantic = terminalResult(directive);
    const result = { ...semantic, terminalResultHash: jcsDigest(semantic as unknown as JsonValue) } as NonNullable<AssignmentReport["result"]>;
    const report = await this.options.reports.submit({ assignmentId: directive.assignmentId, attempt: directive.attempt, claimId: directive.claimId,
      draft: { terminal: true, result, controllerDirectiveId: directive.directiveId } });
    await this.options.journal.planning.recordReport(instanceId, directive.directiveId, report.reportId);
    return { reportId: report.reportId };
  }
}

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
