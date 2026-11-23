import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import { EntityIndex, type EntityFact } from '../../src/context/entities.js';
const stores: RuntimeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'entity-index-'));
  const store = new RuntimeStore(directory); stores.push(store);
  for (const runId of ['a', 'b']) store.createRun({ runId, rootSessionId: runId, budgetScopeKey: `scope-${runId}`, task: 'find device', deadline: Date.now() + 10000, policyVersion: 'v1', inputHash: 'a'.repeat(64) });
  let valid = true;
  const validator = { verify: (runId: string, ref: { id: string }) => valid && ref.id.startsWith(runId), verifyModelReceipt: (_run: string, _scope: string, event: string) => event === 'settled-event' };
  const index = new EntityIndex(store, validator);
  index.setInputVersion('a', 'v1'); index.setInputVersion('b', 'v1');
  const fact: EntityFact = { runId: 'a', entityId: 'device-7', type: 'device', label: 'Charger Seven', attributes: { alertCount: 3 }, inputVersion: 'v1', evidence: [{ kind: 'input', id: 'a-input', version: 'v1', locator: 'row:7', contentHash: 'a'.repeat(64) }], extraction: { kind: 'deterministic' } };
  return { store, directory, index, fact, validator, invalidate: () => { valid = false; } };
}
describe('source-linked entity index', () => {
  it('returns ranked facts and evidence only from the requested run/input version', () => {
    const { index, fact } = setup(); index.put(fact);
    expect(index.query('a', { inputVersion: 'v1', terms: ['charger'], types: ['device'] })).toMatchObject([{ fact: { entityId: 'device-7', evidence: [{ locator: 'row:7' }] }, score: 1 }]);
    expect(index.query('b', { inputVersion: 'v1' })).toEqual([]);
    expect(() => index.put({ ...fact, runId: 'b' })).toThrow(/evidence/);
  });
  it('invalidates earlier generations when data changes, even if an old version label returns', () => {
    const { index, fact } = setup(); index.put(fact);
    index.setInputVersion('a', 'v2');
    expect(index.query('a', { inputVersion: 'v2' })).toEqual([]);
    expect(() => index.query('a', { inputVersion: 'v1' })).toThrow(/stale/);
    index.setInputVersion('a', 'v1');
    expect(index.query('a', { inputVersion: 'v1' })).toEqual([]);
  });
  it('requires verified budget receipts for model extraction and hides stale evidence', () => {
    const { index, fact, invalidate } = setup();
    expect(() => index.put({ ...fact, extraction: { kind: 'model', budgetScopeKey: 'scope-b', ledgerEventId: 'settled-event' } })).toThrow(/settlement/);
    expect(() => index.put({ ...fact, extraction: { kind: 'model', budgetScopeKey: 'scope-a', ledgerEventId: 'invented' } })).toThrow(/settlement/);
    index.put({ ...fact, extraction: { kind: 'model', budgetScopeKey: 'scope-a', ledgerEventId: 'settled-event' } });
    invalidate();
    expect(index.query('a', { inputVersion: 'v1' })).toEqual([]);
  });
  it('reopens the same evidence-linked index without duplicating records/events', () => {
    const { store, directory, index, fact, validator } = setup(); index.put(fact); index.put(fact);
    const events = store.eventsAfter('a').filter(event => event.type === 'entity.upserted'); expect(events).toHaveLength(1);
    store.close();
    const reopened = new RuntimeStore(directory); stores.push(reopened);
    expect(new EntityIndex(reopened, validator).query('a', { inputVersion: 'v1' })[0]?.fact).toEqual(fact);
  });
});
