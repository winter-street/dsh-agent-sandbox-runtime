import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import type { BudgetEventReceipt } from '../../src/contracts/budget.js';
import { BudgetReceiptSynchronizer } from '../../src/adapters/budget/receipts.js';

const stores: RuntimeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-receipts-'));
  const store = new RuntimeStore(dir, () => 1000); stores.push(store);
  store.createRun({ runId: 'run', rootSessionId: 'root', budgetScopeKey: 'scope', task: 'analysis', deadline: 5000, policyVersion: 'v1', inputHash: 'a'.repeat(64) });
  const receipts: BudgetEventReceipt[] = [];
  const budget = { eventsAfter: async (cursor: number) => structuredClone(receipts.filter(r => r.cursor > cursor)) };
  const sync = new BudgetReceiptSynchronizer(store, budget, 'local-ledger-id');
  const add = (id: string, scope = 'scope', type = 'reserve') => {
    receipts.push({ cursor: receipts.length + 1, eventId: id, scopeKey: scope, type,
      payload: { reservationId: `reservation-${id}`, request: { modelCallId: `model-${id}` } } });
  };
  return { store, dir, budget, receipts, sync, add };
}
describe('durable budget notification replay', () => {
  it('replays missed notifications, skips other roots and never stores a second balance', async () => {
    const s = setup(); s.add('a'); s.add('other', 'other-scope'); s.add('b', 'scope', 'settle');
    expect(await s.sync.sync('run')).toEqual({ cursor: 3, imported: 2, scanned: 3 });
    expect(await s.sync.sync('run')).toEqual({ cursor: 3, imported: 0, scanned: 0 });
    const events = s.store.eventsAfter('run').filter(e => e.type === 'budget.receipt');
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('other-scope');
    expect(JSON.stringify(s.store.listComponentState('run', 'budget-receipt'))).not.toMatch(/usedTokens|availableTokens|reservedTokens/);
    expect(events[0]?.payload).toMatchObject({ modelCallId: 'model-a', reservationId: 'reservation-a' });
  });
  it('restores cursor after real SQLite close/reopen and applies only newly arrived receipts', async () => {
    const s = setup(); s.add('a'); await s.sync.sync('run'); s.store.close(); s.add('b');
    const reopened = new RuntimeStore(s.dir, () => 1000); stores.push(reopened);
    const replay = new BudgetReceiptSynchronizer(reopened, s.budget, 'local-ledger-id');
    expect(await replay.sync('run')).toEqual({ cursor: 2, imported: 1, scanned: 1 });
    expect(reopened.eventsAfter('run').filter(e => e.type === 'budget.receipt')).toHaveLength(2);
  });
  it('rolls back receipt, trace and cursor together when persistence fails', async () => {
    const s = setup(); s.add('a');
    const append = vi.spyOn(s.store, 'appendEvent').mockImplementationOnce(() => { throw new Error('injected write failure'); });
    await expect(s.sync.sync('run')).rejects.toThrow('injected write failure');
    append.mockRestore();
    expect(s.store.listComponentState('run', 'budget-receipt')).toHaveLength(0);
    expect(s.store.listComponentState('run', 'budget-cursor')).toHaveLength(0);
    expect(await s.sync.sync('run')).toMatchObject({ imported: 1 });
  });
  it('deduplicates equal event identities and rejects conflicting duplicates without advancing', async () => {
    const s = setup(); s.add('a'); s.add('a');
    expect(await s.sync.sync('run')).toMatchObject({ cursor: 2, imported: 1 });
    s.add('a'); s.receipts[2]!.payload = { conflicting: true };
    await expect(s.sync.sync('run')).rejects.toThrow('conflicting content');
    expect(s.store.listComponentState<{ cursor: number }>('run', 'budget-cursor')[0]?.cursor).toBe(2);
  });
  it('rejects cursor gaps and out-of-order delivery', async () => {
    const s = setup(); s.add('a'); s.receipts[0]!.cursor = 2;
    await expect(s.sync.sync('run')).rejects.toThrow('cursor gap');
    expect(s.store.listComponentState('run', 'budget-cursor')).toHaveLength(0);
  });
  it('detects truncated or replaced ledger anchors instead of silently resetting replay', async () => {
    const s = setup(); s.add('a'); await s.sync.sync('run');
    s.receipts[0]!.payload = { changed: true };
    await expect(s.sync.sync('run')).rejects.toThrow('anchor changed');
    s.receipts.splice(0);
    await expect(s.sync.sync('run')).rejects.toThrow('anchor changed');
  });
  it('coalesces concurrent sync callers into one replay transaction', async () => {
    const s = setup(); s.add('a');
    const [a, b] = await Promise.all([s.sync.sync('run'), s.sync.sync('run')]);
    expect(a).toEqual(b);
    expect(s.store.eventsAfter('run').filter(e => e.type === 'budget.receipt')).toHaveLength(1);
  });
});
