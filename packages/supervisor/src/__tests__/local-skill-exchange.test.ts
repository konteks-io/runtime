import { expect, it, vi } from 'vitest';
import { exchangeLocalSkills } from '../native/local-skill-exchange.js';

function fixture() {
  const client = { reportLocalInventory: vi.fn().mockResolvedValue(undefined),
    pendingLocalExport: vi.fn().mockResolvedValue(null), assertLocalExport: vi.fn(),
    reportLocalExport: vi.fn().mockResolvedValue(undefined) };
  const assertReady = vi.fn();
  return { client, assertReady, homes: [], now: () => 0 };
}
it('reports bounded metadata without exporting unsolicited contents', async () => {
  const f = fixture();
  await exchangeLocalSkills(f, new AbortController().signal);
  expect(f.client.reportLocalInventory).toHaveBeenCalledWith({ observedAt: '1970-01-01T00:00:00.000Z', skills: [] }, expect.any(AbortSignal));
  expect(f.client.reportLocalExport).not.toHaveBeenCalled();
});
it('refuses unavailable selections with null and checks authority before delivery', async () => {
  const f = fixture(); const request = { localId: 'missing', treeDigest: 'changed' };
  f.client.pendingLocalExport.mockResolvedValue(request);
  await exchangeLocalSkills(f, new AbortController().signal);
  expect(f.client.assertLocalExport).toHaveBeenCalledTimes(2);
  expect(f.client.reportLocalExport).toHaveBeenCalledWith(request, null, expect.any(AbortSignal));
});
it('does not deliver a result after ownership is lost', async () => {
  const f = fixture(); f.client.pendingLocalExport.mockImplementation(async () => {
    f.assertReady.mockImplementation(() => { throw new Error('ownership lost'); });
    return { localId: 'missing' };
  });
  await expect(exchangeLocalSkills(f, new AbortController().signal)).rejects.toThrow('ownership lost');
  expect(f.client.reportLocalExport).not.toHaveBeenCalled();
});
it('does no network work when already cancelled', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await expect(exchangeLocalSkills(f, abort.signal)).rejects.toThrow('stopped');
  expect(f.client.reportLocalInventory).not.toHaveBeenCalled();
});
