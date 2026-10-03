import { expect, it, vi } from 'vitest';
import type { RemoteExecutionAuthorityView, AgentSkillReadObservation } from '@konteks/remote-common';
import { SkillReadEmitter } from '../skills/read-emitter.js';

const capabilityId = '7db42743-32df-4990-ad5d-6f5433f872fc';
const authority = { instanceId: 'runtime', agentId: 'codex', executionId: 'execution', sessionId: 'session',
  assignmentId: 'assignment', attempt: 1, claimId: 'claim', recoveryEpoch: 0, readyRevision: 1,
  runnerIncarnation: 'runner', acpSessionRef: 'acp', executionRevision: 1, leaseSetId: 'lease', turnRef: 'turn' } as RemoteExecutionAuthorityView;
const read = { sessionUpdate: 'tool_call', kind: 'read', toolCallId: 'read', status: 'completed', locations: [{ path: '/verified/SKILL.md' }] };
function fixture(verifyRead = vi.fn(async () => true)) {
  const submit = vi.fn(async (_event: AgentSkillReadObservation) => undefined);
  const current = vi.fn((): RemoteExecutionAuthorityView | null => authority);
  const emitter = new SkillReadEmitter({ targets: [{ skillId: capabilityId, version: '1.0.1', skillFile: '/verified/SKILL.md' }],
    cwd: '/verified', authority: current, verifyRead, coreNow: () => Date.parse('2026-10-03T07:00:00Z'), submit });
  return { emitter, submit, current };
}
it('emits one fenced read without local paths and starts a fresh tracker for the next execution', async () => {
  const f = fixture();
  await f.emitter.observe(read); await f.emitter.observe(read);
  expect(f.submit).toHaveBeenCalledTimes(1);
  const event = f.submit.mock.calls[0]![0] as unknown as Record<string, unknown>;
  expect(event).toMatchObject({ kind: 'skill_read_completed', capabilityId, executionId: 'execution', turnId: 'turn', observedAt: '2026-10-03T07:00:00.000Z' });
  expect(JSON.stringify(event)).not.toContain('/verified');
  f.current.mockReturnValue({ ...authority, executionId: 'next', turnRef: 'next-turn' });
  await f.emitter.observe(read);
  expect(f.submit).toHaveBeenCalledTimes(2);
});
it('retries an exact completed event after durable enqueue fails', async () => {
  const f = fixture(); f.submit.mockRejectedValueOnce(new Error('disk full'));
  await expect(f.emitter.observe(read)).rejects.toThrow('disk full');
  await f.emitter.observe(read);
  expect(f.submit.mock.calls[0]).toEqual(f.submit.mock.calls[1]);
});
it('does not attribute an unowned read to a later execution', async () => {
  const f = fixture(); f.current.mockReturnValue(null);
  await f.emitter.observe(read);
  expect(f.submit).not.toHaveBeenCalled();
});

it('refuses a managed read whose file or version fails completion-time verification', async () => {
 const verify = vi.fn(async () => false); const f = fixture(verify);
 await f.emitter.observe(read);
 expect(verify).toHaveBeenCalledWith(expect.objectContaining({ capabilityId, version: '1.0.1', toolCallId: 'read' }));
 expect(f.submit).not.toHaveBeenCalled();
});
it('rechecks original execution ownership after asynchronous file verification', async () => {
 const verify = vi.fn(async () => { f.current.mockReturnValue(null); return true; });
 const f = fixture(verify);
 await f.emitter.observe(read);
 expect(f.submit).not.toHaveBeenCalled();
});
