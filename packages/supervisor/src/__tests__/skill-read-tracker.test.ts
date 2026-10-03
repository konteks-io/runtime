import { describe, expect, it } from 'vitest';
import { SkillReadTracker } from '../skills/read-tracker.js';
const skill = { skillId: '7db42743-32df-4990-ad5d-6f5433f872fc', version: '1.0.1', skillFile: '/cache/pinned/SKILL.md' };
const call = { sessionUpdate: 'tool_call', toolCallId: 'read-1', kind: 'read', status: 'in_progress', locations: [{ path: skill.skillFile }] };
const done = { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' };
describe('managed Skill completed read tracker', () => {
  it('counts only completion and retains exact file identity across partial updates', () => {
    const tracker = new SkillReadTracker([skill], '/work');
    expect(tracker.observe(call)).toEqual([]);
    expect(tracker.observe(done)).toEqual([{ toolCallId: 'read-1', capabilityId: skill.skillId, version: skill.version }]);
    expect(tracker.observe(done)).toEqual([]);
    expect(tracker.observe({ ...call, status: 'completed' })).toEqual([]);
  });
  it('supports an initially complete read and deduplicates repeated file locations', () => {
    const tracker = new SkillReadTracker([skill], '/work');
    expect(tracker.observe({ ...call, status: 'completed', locations: [...call.locations, ...call.locations] })).toHaveLength(1);
  });
  it.each(['failed', 'cancelled'])('never counts a %s read or a later replay of it', status => {
    const tracker = new SkillReadTracker([skill], '/work'); tracker.observe(call);
    expect(tracker.observe({ ...done, status })).toEqual([]);
    expect(tracker.observe(done)).toEqual([]);
  });
  it.each(['execute', 'edit', 'search', 'other'])('does not infer a read from %s activity', kind => {
    const tracker = new SkillReadTracker([skill], '/work');
    expect(tracker.observe({ ...call, kind, status: 'completed' })).toEqual([]);
  });
  it('ignores personal files, catalog/instruction messages, directory reads and references', () => {
    const tracker = new SkillReadTracker([skill], '/work');
    for (const path of ['/home/personal/SKILL.md', '/cache/pinned', '/cache/pinned/references/guide.md']) {
      expect(tracker.observe({ ...call, toolCallId: path, status: 'completed', locations: [{ path }] })).toEqual([]);
    }
    expect(tracker.observe({ sessionUpdate: 'agent_message_chunk', content: { text: skill.skillFile } })).toEqual([]);
  });
  it('matches relative and Windows discovery paths without emitting a local path', () => {
    const unix = new SkillReadTracker([{ ...skill, skillFile: '/work/skills/SKILL.md' }], '/work');
    expect(unix.observe({ ...call, status: 'completed', locations: [{ path: 'skills/SKILL.md' }] })).toHaveLength(1);
    const windows = new SkillReadTracker([{ ...skill, skillFile: 'C:\\Users\\Person\\skills\\SKILL.md' }], 'C:\\work', 'win32');
    const result = windows.observe({ ...call, status: 'completed', locations: [{ path: 'c:/users/person/skills/SKILL.md' }] });
    expect(result).toEqual([{ toolCallId: 'read-1', capabilityId: skill.skillId, version: skill.version }]);
    expect(JSON.stringify(result)).not.toContain('Users');
  });
  it('does not count an intended read when the completed operation reports a different file', () => {
    const tracker = new SkillReadTracker([skill], '/work'); tracker.observe(call);
    expect(tracker.observe({ ...done, locations: [{ path: '/personal/SKILL.md' }] })).toEqual([]);
  });
  it('refuses ambiguous managed file identities and malformed updates', () => {
    expect(() => new SkillReadTracker([skill, { ...skill, version: '2.0.0' }], '/work')).toThrow();
    const tracker = new SkillReadTracker([skill], '/work');
    for (const value of [null, {}, { ...call, toolCallId: '' }, { ...call, locations: [{ path: 1 }], status: 'completed' }]) expect(tracker.observe(value)).toEqual([]);
  });
});
