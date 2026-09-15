import { randomUUID } from "node:crypto";
import {
  RemoteInstanceError,
  type AssignmentPull, type AssignmentReport,
  type AssignmentRequestOrigin, type AssignmentRequestReference, type AssignmentTransportReply,
  NativeAssignmentResultSchema, NativeAssignmentAckResultSchema, type Clock, type NativeAssignmentResult,
  AssignmentReplyFrameSchema, NativeCoreRequestAckSchema,
  AssignmentReportSchema, ReportAckSchema, jcsDigest, logicalAssignmentResponseDigest, type AssignmentReplyFrame, type JsonValue, type RelayAck,
} from "@konteks/remote-common";
import type { LocalAdmission } from "../state/local-admission.js";
import type { CoreClient } from "../core/client.js";
import type { SupervisorJournal } from "../state/journal.js";
import { allocationReference, type AssignmentRequestRecord, type AssignmentReplyRecordValue } from "../state/assignment-stream.js";
import type { OutboundMessage } from "../transport/transport.js";

export interface AssignmentSenderDeps {
  clock: Clock;
  journal: SupervisorJournal;
  core: Pick<CoreClient, "submitAssignment" | "acknowledgeAssignments">;
  instanceId: () => string;
  workspaceId: () => string;
  runnerIncarnation: () => string;
  /** The applied generation this process is currently operating under. */
  originManifestId: () => string;
  assertOwned: () => void;
  /** Capture once; same process/manifest alone cannot fence lease-authority changes. */
  captureRecoveryAuthority: () => (() => void);
  /** Resolve the original pending admission fence; never recapture current permission. */
  captureClaimAuthority: (admission: LocalAdmission) => (() => void);
}

/**
 * The one durable logical sender for assignment operations (D143).
 *
 * Every request's frame and sequence are frozen BEFORE the first send, so an
 * uncertain outcome replays the same bytes rather than allocating a second
 * identity for one intent. The reply is durably handled before its effect is
 * anyone's to schedule; a transport ACK is not that, and neither is HTTP
 * success. Nothing here starts local work or interprets a domain outcome.
 */
export class AssignmentSender {
  private readonly operationFlights = new Map<string, Promise<void>>();
  constructor(private readonly deps: AssignmentSenderDeps) {}

  private origin(): AssignmentRequestOrigin {
    return { runnerIncarnation: this.deps.runnerIncarnation(), manifestId: this.deps.originManifestId() };
  }

  private scope() {
    return { instanceId: this.deps.instanceId(), workspaceId: this.deps.workspaceId() };
  }

  private capture() {
    const assertRecovery = this.deps.captureRecoveryAuthority();
    const scope = this.scope(), origin = this.origin();
    const assertCurrent = () => {
      assertRecovery(); this.deps.assertOwned();
      if (this.deps.instanceId() !== scope.instanceId || this.deps.workspaceId() !== scope.workspaceId ||
        this.deps.runnerIncarnation() !== origin.runnerIncarnation || this.deps.originManifestId() !== origin.manifestId) {
        throw new RemoteInstanceError("recovery_required", "Assignment continuation belongs to a previous owner generation.");
      }
    };
    assertCurrent(); return { scope, origin, assertCurrent };
  }

  /** Domain send preparation captures this before its first asynchronous write. */
  captureAuthority(): () => void { return this.capture().assertCurrent; }

  /** Exact durable counters advertised during socket handshake; never relay hints. */
  relayCursors(): { channelId: string; to_core: number; to_runtime: number } {
    const captured = this.capture();
    const state = this.deps.journal.assignmentStream.snapshot(captured.scope);
    captured.assertCurrent();
    return { channelId: state.channelId, to_core: state.observedCoreRequestAckSequence, to_runtime: state.nativeConsumedReplySequence };
  }

  /** Caller-owned preparation, above carrier choice. Outstanding pull wins unchanged. */
  async preparePull(body: AssignmentPull): Promise<AssignmentRequestReference> {
    const captured = this.capture();
    const request = await this.deps.journal.assignmentStream.allocatePull({ ...captured.scope,
      runnerIncarnation: captured.origin.runnerIncarnation, origin: captured.origin, issuedAt: this.deps.clock.nowIso(), body }, captured.assertCurrent);
    return allocationReference(request);
  }

  /** Chosen claim and first timestamp come only from the complete admission. */
  async prepareClaim(admission: LocalAdmission, assertAdmissionAuthority: () => void): Promise<AssignmentRequestReference> {
    const captured = this.capture();
    const assertCurrent = () => { captured.assertCurrent(); assertAdmissionAuthority(); };
    assertCurrent();
    const start = this.deps.journal.execution.start(admission.assignmentId, admission.attempt);
    if (!start) throw new RemoteInstanceError("recovery_required", "No complete admission owns claim preparation.");
    const request = await this.deps.journal.assignmentStream.allocateClaim({ admission, origin: captured.origin, issuedAt: start.claimCreatedAt }, assertCurrent);
    return allocationReference(request);
  }

  async prepareReport(body: AssignmentReport, outbox: { id: string; key: string; group: string; order: number }, retryAfter?: AssignmentRequestReference): Promise<AssignmentRequestReference> {
    const captured = this.capture();
    const request = await this.deps.journal.assignmentStream.allocateOperation({ ...captured.scope, kind: "report", operationId: randomUUID(),
      runnerIncarnation: captured.origin.runnerIncarnation, origin: captured.origin, issuedAt: this.deps.clock.nowIso(), body,
      report: { reportId: outbox.id, key: outbox.key, group: outbox.group, order: outbox.order }, ...(retryAfter ? { retryAfter } : {}) }, captured.assertCurrent);
    return allocationReference(request);
  }

  /** Requeue immutable intents, not new work. Missing domain outbox is not disposal. */
  scheduleRetained(send: (message: OutboundMessage) => void): void {
    const { scope, origin, assertCurrent } = this.capture();
    for (const request of this.deps.journal.assignmentStream.unresolvedRequests(scope)) {
      assertCurrent();
      // The existing flight already holds its original owner through handoff.
      // Re-resolving after Work retired pending maps would fence valid bootstrap.
      if (this.operationFlights.has(JSON.stringify([scope, allocationReference(request)]))) continue;
      if (request.frame.origin.runnerIncarnation !== origin.runnerIncarnation || request.frame.origin.manifestId !== origin.manifestId) {
        throw new RemoteInstanceError("recovery_required", "Retained operation belongs to another origin; explicit recovery is required.");
      }
      const assertClaim = request.admission ? this.deps.captureClaimAuthority(request.admission) : () => undefined;
      assertClaim();
      send({ channel: "assignment", channelId: request.frame.channelId, body: request.frame.body,
        assignmentRequest: allocationReference(request), assignmentFrame: request.frame });
      assertCurrent(); assertClaim();
    }
  }

  /** A stored reference is identity, never independent permission to replay it. */
  deliverAllocated(reference: AssignmentRequestReference, apply: (body: AssignmentTransportReply["body"]) => Promise<void>, assertCarrier: () => void = () => undefined): Promise<void> {
    const original = this.capture();
    const captured = { ...original, assertCurrent: () => { original.assertCurrent(); assertCarrier(); } };
    captured.assertCurrent();
    const request = this.deps.journal.assignmentStream.request(captured.scope, reference.requestSequence);
    if (!request || jcsDigest(allocationReference(request)) !== jcsDigest(reference)) throw new RemoteInstanceError("recovery_required", "Retained request reference changed.");
    if (!request.admission) this.deps.journal.assignmentStream.operation(captured.scope, reference);
    const key = JSON.stringify([captured.scope, reference]);
    const existing = this.operationFlights.get(key);
    if (existing) return existing;
    const run = request.admission ? this.deliverClaim(reference, captured, apply) : this.deliverOperation(reference, captured, apply);
    this.operationFlights.set(key, run);
    void run.finally(() => { if (this.operationFlights.get(key) === run) this.operationFlights.delete(key); }).catch(() => undefined);
    return run;
  }

  /**
   * Socket carrier acceptance joins the exact logical reply to the same journal
   * owner used by HTTPS. The relay epoch authenticates this hop but never enters
   * the durable response digest. Returning means the receipt and its domain
   * handoff are durable; lengthy execution bootstrap may continue independently.
   */
  async acceptRelayed(frameInput: AssignmentReplyFrame, apply: (body: AssignmentTransportReply["body"]) => Promise<void>, assertCarrier: () => void = () => undefined): Promise<number> {
    const parsed = AssignmentReplyFrameSchema.parse(frameInput);
    const { connectionEpoch: _epoch, ...frame } = parsed;
    const original = this.capture();
    const assertCurrent = () => { original.assertCurrent(); assertCarrier(); };
    assertCurrent();
    const reference: AssignmentRequestReference = {
      requestSequence: frame.body.requestSequence,
      requestDigest: frame.body.requestDigest,
      requestKind: frame.body.requestKind,
    };
    const request = this.deps.journal.assignmentStream.request(original.scope, reference.requestSequence);
    if (!request || jcsDigest(allocationReference(request)) !== jcsDigest(reference) || request.frame.channelId !== frame.channelId) {
      throw new RemoteInstanceError("registration_mismatch", "Relayed reply names another retained assignment request.");
    }
    await this.deps.journal.assignmentStream.acceptReply({
      schemaVersion: 2, instanceId: request.instanceId, workspaceId: request.workspaceId,
      request: reference,
      response: { sequence: frame.seq, digest: logicalAssignmentResponseDigest(frame) },
      frame,
    }, assertCurrent);
    assertCurrent();
    await this.deliverAllocated(reference, apply, assertCarrier);
    assertCurrent();
    return this.deps.journal.assignmentStream.snapshot(original.scope).nativeConsumedReplySequence;
  }

  /** A socket ACK loses only its hop epoch before the durable stream records it. */
  async observeRelayedRequestAck(ack: RelayAck, assertCarrier: () => void = () => undefined): Promise<void> {
    const captured = this.capture();
    const assertCurrent = () => { captured.assertCurrent(); assertCarrier(); };
    const { connectionEpoch: _epoch, ...logical } = ack;
    const candidate = NativeCoreRequestAckSchema.parse(logical);
    await this.deps.journal.assignmentStream.observeCoreRequestAck(captured.scope, candidate, assertCurrent);
    await this.deps.journal.assignmentStream.retire(captured.scope, assertCurrent);
  }

  private async deliverOperation(reference: AssignmentRequestReference, captured: ReturnType<AssignmentSender["capture"]>, apply: (body: AssignmentTransportReply["body"]) => Promise<void>): Promise<void> {
    const { scope, origin, assertCurrent } = captured;
    const operation = this.deps.journal.assignmentStream.operation(scope, reference);
    const request = this.deps.journal.assignmentStream.request(scope, reference.requestSequence);
    if (!request || request.frame.origin.runnerIncarnation !== origin.runnerIncarnation || request.frame.origin.manifestId !== origin.manifestId) {
      throw new RemoteInstanceError("recovery_required", "Retained operation requires qualified origin or effect recovery.");
    }
    if (operation.effect.state === "applied") return;
    let receipt = this.deps.journal.assignmentStream.operationReply(scope, reference);
    const cleanupOnly = operation.effect.state === "applying";
    if (cleanupOnly && (!receipt || !this.savedTerminalMatches(request, receipt))) {
      throw new RemoteInstanceError("recovery_required", "Uncertain domain effect has no exact durable terminal ACK evidence.");
    }
    if (!receipt) {
      await this.exchange(request, assertCurrent);
      assertCurrent(); receipt = this.deps.journal.assignmentStream.operationReply(scope, reference);
    }
    if (!receipt) throw new RemoteInstanceError("recovery_required", "Operation reply was not durably accepted.");
    if (!cleanupOnly && !await this.deps.journal.assignmentStream.beginOperationEffect(scope, reference, assertCurrent)) return;
    assertCurrent();
    if (cleanupOnly && !this.savedTerminalMatches(request, receipt)) throw new RemoteInstanceError("recovery_required", "Saved terminal evidence changed before cleanup.");
    await apply(receipt.frame.body.body);
    assertCurrent();
    await this.deps.journal.assignmentStream.finishOperationEffect(scope, reference, assertCurrent);
  }

  /** Only the existing idempotent terminal-ACK cleanup may resume an applying effect. */
  private savedTerminalMatches(request: AssignmentRequestRecord, receipt: AssignmentReplyRecordValue): boolean {
    const report = AssignmentReportSchema.safeParse(request.frame.body);
    const ack = ReportAckSchema.safeParse(receipt.frame.body.body);
    if (!report.success || !report.data.terminal || !ack.success || (ack.data.outcome !== "accepted" && ack.data.outcome !== "duplicate")) return false;
    const body = report.data, result = ack.data;
    const entry = this.deps.journal.assignments.get(`${body.assignmentId}:${body.attempt}`);
    const saved = entry?.reports.terminalAck;
    return !!entry && entry.claimId === body.claimId && !!saved && result.assignmentId === body.assignmentId && result.attempt === body.attempt &&
      result.claimId === body.claimId && result.acknowledged.reportId === body.reportId && result.acknowledged.reportSequence === body.reportSequence &&
      result.terminalSequence === body.reportSequence && entry.reports.terminalSequence === body.reportSequence &&
      jcsDigest(saved as JsonValue) === jcsDigest(result as JsonValue);
  }

  private async deliverClaim(reference: AssignmentRequestReference, captured: ReturnType<AssignmentSender["capture"]>, apply: (body: AssignmentTransportReply["body"]) => Promise<void>): Promise<void> {
    const { scope, origin } = captured;
    const request = this.deps.journal.assignmentStream.request(scope, reference.requestSequence);
    if (!request?.admission || request.frame.origin.runnerIncarnation !== origin.runnerIncarnation || request.frame.origin.manifestId !== origin.manifestId) throw new RemoteInstanceError("recovery_required", "Claim requires its original admitted generation.");
    const start = this.deps.journal.execution.start(request.admission.assignmentId, request.admission.attempt);
    if (start?.claimEffect?.state === "applied") return;
    if (start?.claimEffect?.state === "applying") throw new RemoteInstanceError("recovery_required", "Uncertain claim handoff requires recovery.");
    const assertClaim = this.deps.captureClaimAuthority(request.admission);
    const assertCurrent = () => { captured.assertCurrent(); assertClaim(); };
    assertCurrent();
    let receipt = this.deps.journal.assignmentStream.replyForRequest(scope, reference);
    if (!receipt) {
      await this.exchange(request, assertCurrent);
      assertCurrent(); receipt = this.deps.journal.assignmentStream.replyForRequest(scope, reference);
    }
    if (!receipt) throw new RemoteInstanceError("recovery_required", "Claim reply was not durably accepted.");
    if (!await this.deps.journal.assignmentStream.beginClaimEffect(scope, reference, assertCurrent)) return;
    assertCurrent(); await apply(receipt.frame.body.body); assertCurrent();
    await this.deps.journal.assignmentStream.finishClaimEffect(scope, reference, assertCurrent);
  }

  /**
   * Send the frozen frame, then durably handle its correlated reply before
   * returning it. A gap or a retired slot is a local history problem: neither
   * is a business outcome and neither may be answered by resequencing.
   */
  private async exchange(request: AssignmentRequestRecord, assertOriginal = this.deps.assertOwned): Promise<AssignmentTransportReply["body"]> {
    assertOriginal();
    const received = await this.deps.core.submitAssignment(request.instanceId, request.frame);
    assertOriginal();
    const parsed = NativeAssignmentResultSchema.safeParse(received);
    if (!parsed.success) throw new RemoteInstanceError("registration_mismatch", "Reply has inconsistent logical frame identity.");
    const result: NativeAssignmentResult = parsed.data;
    if (result.disposition === "sequence_gap") {
      throw new RemoteInstanceError("assignment_sequence_gap", `Core expects request ${result.expectedSequence} before this one.`);
    }
    if (result.disposition === "replay_retired") {
      throw new RemoteInstanceError("recovery_required", "The retained request was retired; local transport history cannot be replayed.");
    }
    if (result.frame.channelId !== request.frame.channelId || result.frame.body.requestSequence !== request.frame.seq || result.frame.body.requestDigest !== request.digest) {
      throw new RemoteInstanceError("registration_mismatch", "Reply correlates to another request.");
    }
    const accepted = await this.deps.journal.assignmentStream.acceptReply({
      schemaVersion: 2, instanceId: request.instanceId, workspaceId: request.workspaceId,
      request: { requestSequence: request.frame.seq, requestDigest: request.digest, requestKind: result.frame.body.requestKind },
      response: { sequence: result.response.sequence, digest: result.response.digest }, frame: result.frame,
    }, assertOriginal);
    return accepted.frame.body.body;
  }

  /**
   * Attest what this process has durably observed and consumed. Core retires
   * only a contiguous request prefix whose own replies are covered, so a lost
   * acknowledgement costs retention rather than correctness.
   */
  async acknowledge(): Promise<void> {
    const assertRecovery = this.deps.captureRecoveryAuthority();
    const scope = this.scope(), origin = this.origin();
    const assertOriginal = () => {
      assertRecovery(); this.deps.assertOwned();
      if (this.deps.instanceId() !== scope.instanceId || this.deps.workspaceId() !== scope.workspaceId ||
        this.deps.runnerIncarnation() !== origin.runnerIncarnation || this.deps.originManifestId() !== origin.manifestId) {
        throw new RemoteInstanceError("recovery_required", "Assignment ACK continuation belongs to a previous owner generation.");
      }
    };
    assertOriginal();
    const state = this.deps.journal.assignmentStream.snapshot(scope);
    // Zero-prefix housekeeping needs no artificial request allocation.
    const result = await this.deps.core.acknowledgeAssignments(scope.instanceId, {
      observedRequestAckSequence: state.observedCoreRequestAckSequence,
      consumedReplySequence: state.nativeConsumedReplySequence,
    });
    assertOriginal();
    const accepted = NativeAssignmentAckResultSchema.parse(result);
    if (accepted.instanceId !== scope.instanceId || accepted.channelId !== state.channelId) {
      throw new RemoteInstanceError("registration_mismatch", "Core ACK names another assignment stream.");
    }
    // CoreClient matched the exact proof nonce before returning this carrier.
    // Only its explicit ACK advances observation; no reply/counter infers it.
    await this.deps.journal.assignmentStream.observeCoreRequestAck(scope, accepted.requestAck, assertOriginal);
    await this.deps.journal.assignmentStream.retire(scope, assertOriginal);
    assertOriginal();
  }
}
