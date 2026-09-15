import { jcsDigest, type JsonValue, type RemoteExecutionOperationDisposition } from '@konteks/remote-common';
import type { SupervisorJournal } from './journal.js';

/** Snapshot only this claim's durable admissions into its existing terminal
 * report. No receipt is permission to redispatch, and unknown is not completed. */
export async function terminalOperationDispositions(journal: SupervisorJournal, assignmentId: string, attempt: number,
  claimId: string): Promise<RemoteExecutionOperationDisposition[]> {
  const matching = journal.pendingRequests.all().filter(entry => entry.authorization?.claims.assignmentId === assignmentId &&
    entry.authorization.claims.attempt === attempt && entry.authorization.claims.claimId === claimId);
  if (matching.length > 256) throw new Error('Operation disposition report limit exceeded; retain the unresolved claim');
  const result: RemoteExecutionOperationDisposition[] = [];
  for (const entry of matching) {
    const key = `${entry.acpSessionRef}:${entry.direction}:${entry.id}`;
    await journal.pendingRequests.update(key, current => {
      if (!current?.authorization) throw new Error('Operation admission disappeared');
      if (current.authorization.state === 'admitted' || current.authorization.state === 'dispatch_started') {
        return { ...current, authorization: { ...current.authorization, state: 'interrupted' } };
      }
      return current;
    });
    const authorization = journal.pendingRequests.get(key)!.authorization!;
    const { claims, state, completion } = authorization;
    if (state !== 'completed' && state !== 'denied' && state !== 'interrupted') throw new Error('Operation disposition is not durable');
    result.push({ executionId: claims.executionId, executionRevision: claims.executionRevision, operationId: claims.operationId,
      permitId: claims.permitId, admissionId: claims.admissionId, payloadDigest: claims.payloadDigest, state,
      ...(completion ? { completionDigest: jcsDigest(completion as unknown as JsonValue) } : {}) });
  }
  return result;
}
