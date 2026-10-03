import { posix, win32 } from 'node:path';

export interface ManagedSkillReadTarget {
  skillId: string;
  version: string;
  /** Exact verified staged/discovery file. Never transmitted in usage events. */
  skillFile: string;
}
export interface CompletedSkillRead {
  toolCallId: string;
  capabilityId: string;
  version: string;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);

/** Per-execution ACP tracker. Availability, instruction injection, shell command
 * text, searches and failed reads are not usage. Only the bridge's completed
 * read operation at an exact locally verified managed file is eligible.
 * Core still owns execution admission and deduplication of emitted records.
 */
export class SkillReadTracker {
  private readonly files = new Map<string, Omit<CompletedSkillRead, 'toolCallId'>>();
  private readonly pending = new Map<string, Map<string, Omit<CompletedSkillRead, 'toolCallId'>>>();
  private readonly terminal = new Set<string>();
  private saturated = false;
  private readonly path: typeof posix;
  constructor(targets: readonly ManagedSkillReadTarget[], private readonly cwd: string, platform: NodeJS.Platform = process.platform) {
    this.path = platform === 'win32' ? win32 : posix;
    if (!text(cwd) || !this.path.isAbsolute(cwd) || targets.length > 512) throw new Error('Invalid managed Skill read inventory');
    for (const target of targets) {
      if (!text(target.skillFile) || !this.path.isAbsolute(target.skillFile) || this.path.basename(target.skillFile) !== 'SKILL.md' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.skillId) ||
        !text(target.version, 64)) throw new Error('Invalid managed Skill read target');
      const key = this.key(target.skillFile);
      const prior = this.files.get(key);
      if (prior && (prior.capabilityId !== target.skillId || prior.version !== target.version)) throw new Error('Ambiguous managed Skill read target');
      this.files.set(key, { capabilityId: target.skillId, version: target.version });
    }
  }
  private key(value: string): string {
    const result = this.path.resolve(this.cwd, value);
    return this.path === win32 ? result.toLowerCase() : result;
  }
  observe(input: unknown): CompletedSkillRead[] {
    const update = record(input);
    if (this.saturated || !update || !['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || !text(update.toolCallId, 256)) return [];
    const id = update.toolCallId;
    if (this.terminal.has(id)) return [];
    const finished = ['completed', 'failed', 'cancelled'].includes(String(update.status));
    if (update.kind !== undefined && update.kind !== 'read') this.pending.delete(id);
    else if (update.kind === 'read' || this.pending.has(id)) {
      // ACP updates with locations replace the prior location snapshot.
      const selected = update.locations === undefined
        ? this.pending.get(id) ?? new Map<string, Omit<CompletedSkillRead, 'toolCallId'>>()
        : new Map<string, Omit<CompletedSkillRead, 'toolCallId'>>();
      const locations = Array.isArray(update.locations) ? update.locations : [];
      // Malformed/unbounded provider locations are never read as inventory.
      if (locations.length <= 512) for (const location of locations) {
        const file = record(location)?.path;
        if (!text(file)) continue;
        const skill = this.files.get(this.key(file));
        if (skill) selected.set(JSON.stringify([skill.capabilityId, skill.version]), skill);
      }
      this.pending.set(id, selected);
      if (this.pending.size > 512) { this.saturated = true; this.pending.clear(); return []; }
    }
    if (!finished) return [];
    const selected = this.pending.get(id);
    this.pending.delete(id);
    this.terminal.add(id);
    // Never evict a seen id and count its replay as another read.
    if (this.terminal.size >= 4096) this.saturated = true;
    return update.status === 'completed' && selected ? [...selected.values()].map(skill => ({ toolCallId: id, ...skill })) : [];
  }
}
