import { AgentSkillReadObservationSchema, jcsDigest, type AgentSkillReadObservation,
  type RemoteExecutionAuthorityView, type RemoteDeliveryExecutionAuthorityView } from '@konteks/remote-common';
import { SkillReadTracker, type ManagedSkillReadTarget, type CompletedSkillRead } from './read-tracker.js';

type Authority = RemoteExecutionAuthorityView | RemoteDeliveryExecutionAuthorityView;
const fences = ['instanceId', 'agentId', 'executionId', 'sessionId', 'assignmentId', 'attempt', 'claimId',
  'recoveryEpoch', 'readyRevision', 'runnerIncarnation', 'acpSessionRef', 'executionRevision', 'leaseSetId'] as const;

/** Only completed verified reads become usage; durable enqueue precedes removal
 * from this bounded retry buffer. The callback never waits for HTTP delivery.
 */
export class SkillReadEmitter {
  private executionId: string | null = null;
  private tracker: SkillReadTracker | null = null;
  private readonly pending = new Map<string, AgentSkillReadObservation>();
  constructor(private readonly options: { targets: readonly ManagedSkillReadTarget[]; cwd: string;
    authority: () => Authority | null; coreNow: () => number;
    verifyRead?: (read: CompletedSkillRead) => Promise<boolean>;
    submit: (event: AgentSkillReadObservation) => Promise<void> }) {}

  async observe(update: unknown): Promise<void> {
    const authority = this.options.authority();
    if (authority) {
      if (authority.executionId !== this.executionId) {
        this.tracker = new SkillReadTracker(this.options.targets, this.options.cwd);
        this.executionId = authority.executionId;
      }
      for (const read of this.tracker!.observe(update)) {
        // Discovery links can change during a read. Their caller verifies the
        // exact retained tree/version before this event is attributed.
        if (this.options.verifyRead && !await this.options.verifyRead(read)) continue;
        const current = this.options.authority();
        if (!current || fences.some(field => current[field] !== authority[field])) continue;
        const eventId = `skill-read-${jcsDigest([authority.executionId, read.toolCallId, read.capabilityId, read.version])}`;
        if (!this.pending.has(eventId)) {
          if (this.pending.size >= 512) throw new Error('Skill read retry buffer is full');
          const event = AgentSkillReadObservationSchema.parse({
            ...Object.fromEntries(fences.map(field => [field, authority[field]])), ...read,
            kind: 'skill_read_completed', eventId,
            turnId: 'deliveryIdentity' in authority ? authority.deliveryIdentity.invocationId : authority.turnRef,
            observedAt: new Date(this.options.coreNow()).toISOString(),
          });
          this.pending.set(eventId, event);
        }
      }
    }
    for (const [id, event] of this.pending) {
      await this.options.submit(event);
      this.pending.delete(id);
    }
  }
}
