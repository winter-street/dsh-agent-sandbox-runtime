import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/core/approvals.js';
import { runtimeFixture } from '../support/runtime.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
async function setup() { const t = await runtimeFixture(); cleanup.push(t.dispose); return t; }
const approval = { runId: 'run', approvalId: 'approval-1', toolCallId: 'call-1', args: { code: 'print(42)' }, reason: 'Tool soft limit reached', ttlMs: 1000 };
describe('persistent one-use approvals', () => {
  it('persists pause, decision, and consumption across service recreation', async () => {
    const t = await setup(); await t.service.requestApproval(approval);
    expect(t.store.getRun('run').status).toBe('PAUSED_APPROVAL'); expect(t.store.latestCheckpoint('run')).toBeDefined();
    const resumed = new ApprovalService(t.store, t.clock.now);
    const approved = resumed.decide('run', 'approval-1', 'click-1', true);
    expect(resumed.decide('run', 'approval-1', 'click-1', true)).toEqual(approved);
    await t.service.consumeApproval('run', 'approval-1', approval.args);
    expect(t.store.getRun('run').status).toBe('RUNNING');
    await expect(t.service.consumeApproval('run', 'approval-1', approval.args)).rejects.toThrow('unavailable');
  });
  it('refuses changed arguments, changed decisions, and expired permissions', async () => {
    const t = await setup(); await t.service.requestApproval(approval);
    t.service.approvals.decide('run', 'approval-1', 'click-1', true);
    expect(() => t.service.approvals.decide('run', 'approval-1', 'click-1', false)).toThrow('changed');
    await expect(t.service.consumeApproval('run', 'approval-1', { code: 'new' })).rejects.toThrow('parameters');
    t.clock.advance(1000);
    await expect(t.service.consumeApproval('run', 'approval-1', approval.args)).rejects.toThrow('expired');
  });
  it('does not grant budget or reprompt after rejection', async () => {
    const t = await setup(); await t.service.requestApproval(approval);
    t.service.approvals.decide('run', 'approval-1', 'click-1', false);
    expect((await t.service.requestApproval(approval)).status).toBe('rejected');
    expect(t.service.approvals.list('run')).toHaveLength(1);
    expect(t.budget.snapshot('scope').usedTokens).toBe(0);
  });
  it('keeps approval unconsumed when a hard limit fails', async () => {
    const t = await setup(); await t.service.requestApproval(approval);
    t.service.approvals.decide('run', 'approval-1', 'click-1', true);
    await expect(t.service.approvals.consume('run', 'approval-1', approval.args, async () => { throw new Error('budget exhausted'); })).rejects.toThrow('budget');
    expect(t.service.approvals.get('run', 'approval-1').status).toBe('approved');
    expect(t.store.getRun('run').status).toBe('PAUSED_APPROVAL');
  });
  it('one of two racing consumers wins', async () => {
    const t = await setup(); await t.service.requestApproval(approval);
    t.service.approvals.decide('run', 'approval-1', 'click-1', true);
    const results = await Promise.allSettled([1,2].map(() => t.service.consumeApproval('run', 'approval-1', approval.args)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
});
