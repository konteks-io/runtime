import type { NativeSkillSyncClient } from './skill-sync-client.js';
import { discoverLocalSkills, exportLocalSkill } from '../skills/local-skills.js';

/** Inventory is metadata only. Contents leave the machine only for a signed selection. */
export async function exchangeLocalSkills(options: {
  client: Pick<NativeSkillSyncClient, 'reportLocalInventory' | 'pendingLocalExport' | 'assertLocalExport' | 'reportLocalExport'>;
  homes: readonly string[]; now: () => number; assertReady: () => void;
}, signal: AbortSignal): Promise<void> {
  const check = () => { if (signal.aborted) throw new Error('Local Skill exchange stopped'); options.assertReady(); };
  check();
  const skills = await discoverLocalSkills(options.homes);
  check();
  await options.client.reportLocalInventory({ observedAt: new Date(options.now()).toISOString(), skills }, signal);
  check();
  const request = await options.client.pendingLocalExport(signal);
  if (!request) return;
  check(); options.client.assertLocalExport(request);
  let tree = null;
  try { tree = await exportLocalSkill(options.homes, request); }
  catch { /* An immutable selection that changed is explicitly refused. */ }
  check(); options.client.assertLocalExport(request);
  await options.client.reportLocalExport(request, tree, signal);
}
