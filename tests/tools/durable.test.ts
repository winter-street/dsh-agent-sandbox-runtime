import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import { DurableToolCallStore, DurableToolRules } from '../../src/tools/durable.js';
import { ToolRuleEngine, type ToolRuleAction } from '../../src/policy/tool-rules.js';
import { ToolRegistry, type ToolCallReceipt } from '../../src/tools/registry.js';

const stores: RuntimeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'durable-tools-'));
  const store = new RuntimeStore(directory); stores.push(store);
  store.createRun({ runId: 'run', rootSessionId: 'session', budgetScopeKey: 'scope', task: 'test', deadline: Date.now() + 10000, policyVersion: 'v1', inputHash: 'a'.repeat(64) });
  return { store, directory };
}
describe('durable tool calls and local policy', () => {
  it('replays committed results and leaves pending calls unknown after reopening SQLite', async () => {
    const { store, directory } = setup();
    const first = new DurableToolCallStore(store);
    const receipt: ToolCallReceipt = { runId: 'run', callId: 'call', toolName: 'test', argsHash: 'args', inputHash: 'input', requestHash: 'request', location: 'host' };
    expect(await first.claim(receipt)).toEqual({ kind: 'new' });
    await first.complete(receipt, { ...receipt, ok: true, value: { answer: 42 } });
    await first.claim({ ...receipt, callId: 'pending' });
    store.close();
    const reopened = new RuntimeStore(directory); stores.push(reopened);
    const resumed = new DurableToolCallStore(reopened);
    expect(await resumed.claim(receipt)).toMatchObject({ kind: 'result', result: { value: { answer: 42 } } });
    expect(await resumed.claim({ ...receipt, callId: 'pending' })).toEqual({ kind: 'pending' });
    expect(await resumed.claim({ ...receipt, requestHash: 'changed' })).toEqual({ kind: 'conflict' });
  });
  it('rolls back a claim if its corresponding event cannot be committed', async () => {
    const { store } = setup();
    const adapter = new DurableToolCallStore(store);
    const receipt: ToolCallReceipt = { runId: 'run', callId: 'call', toolName: 'test', argsHash: 'args', inputHash: 'input', requestHash: 'request', location: 'host' };
    const fail = vi.spyOn(store, 'appendEvent').mockImplementationOnce(() => { throw new Error('event disk failure'); });
    await expect(adapter.claim(receipt)).rejects.toThrow('event disk failure');
    fail.mockRestore();
    expect(await adapter.claim(receipt)).toEqual({ kind: 'new' });
  });
  it('retains quota, no-progress state and notification deduplication across restart', () => {
    const { store, directory } = setup();
    const engine = new ToolRuleEngine([{ toolName: 'search', warnAt: 2, maxCalls: 5 }]);
    const rules = new DurableToolRules(store, engine);
    const action = (callId: string): ToolRuleAction => ({ callId, toolName: 'search', arguments: { q: 'same' }, inputVersion: 'v1', progressVersion: 'p1' });
    for (const id of ['1', '2']) {
      rules.admit('run', action(id));
      rules.record('run', action(id), { ok: false, errorSignature: '404', progressVersion: 'p1' });
    }
    const before = store.eventsAfter('run').filter(event => event.type === 'tool.policy-notice').length;
    store.close();
    const reopened = new RuntimeStore(directory); stores.push(reopened);
    const resumed = new DurableToolRules(reopened, engine);
    expect(resumed.admit('run', action('3'))).toMatchObject({ allowed: false, reason: 'NO_PROGRESS' });
    resumed.record('run', action('2'), { ok: false, errorSignature: '404', progressVersion: 'p1' });
    expect(reopened.eventsAfter('run').filter(event => event.type === 'tool.policy-notice')).toHaveLength(before);
  });
  it('executes with the durable adapter rather than a memory-only cache', async () => {
    const { store } = setup();
    const registry = new ToolRegistry(new DurableToolCallStore(store));
    registry.register({ name: 'read', description: 'Read fixed data', location: 'host', permissions: [], inputSchema: { type: 'object' }, outputSchema: { type: 'integer' }, timeoutMs: 100, maxOutputBytes: 100, idempotency: 'read-only', retry: { maxAttempts: 1, retryableCodes: [] }, execute: async () => 42 });
    expect(await registry.execute({ runId: 'run', callId: 'call', inputVersion: 'v1', progressVersion: 'p1', grantedPermissions: [] }, 'read', {})).toMatchObject({ ok: true, value: 42 });
    expect(store.eventsAfter('run').map(event => event.type)).toContain('tool.completed');
  });
});
