import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateModelTokens } from '../../src/adapters/harness/model-policy.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { loadConfig } from '../../src/config.js';
import { FinalizationCoordinator, type FinalReportPort } from '../../src/core/finalize.js';
import { RuntimeService } from '../../src/core/service.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeBudget, FakeSandbox } from '../support/fakes.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function setup(finalizeTokens = 500, valid = true) {
  const directory = mkdtempSync(join(tmpdir(), 'finalization-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RuntimeStore(join(directory, 'database'));
  cleanups.push(() => store.close());
  const budget = new FakeBudget({ scopeKey: 'scope', sessionIds: ['root'], limitTokens: 1000, finalizeTokens });
  const service = new RuntimeService(store, new ArtifactStore(join(directory, 'artifacts')), new FakeSandbox(), budget,
    loadConfig('config/example.json'), { validate: async () => ({ passed: valid, evidence: { testFixtureOnly: true } }) });
  await service.createRun({ runId: 'run', rootSessionId: 'root', budgetScopeKey: 'scope', task: 'controlled finalization',
    deadline: Date.now() + 60_000, policyVersion: 'budget-policy-v1', inputHash: 'a'.repeat(64) });
  const request = (text = 'report'): GenerateOptions => ({ provider: 'controlled', model: 'controlled', sessionId: SessionId('root'), maxTokens: 64,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })] });
  const meter = (prepared: Readonly<GenerateOptions>, purpose: 'work' | 'finalize' = 'finalize', unknown = false) => {
    const reservation = budget.reserve({ scopeKey: 'scope', modelCallId: 'report-call', sessionId: 'root', provider: prepared.provider,
      model: prepared.model, purpose, estimatedTokens: estimateModelTokens(prepared) });
    if (!reservation.allowed) throw new Error(`Fixture refused: ${reservation.reason}`);
    budget.markDispatched(reservation.reservation.reservationId);
    if (unknown) budget.markUnknown(reservation.reservation.reservationId, 'injected fixture disconnect');
    else budget.settle(reservation.reservation.reservationId, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  };
  const port: FinalReportPort = { prepare: vi.fn(() => request()), generate: vi.fn(async prepared => { meter(prepared); return 'Optional prose'; }) };
  return { store, budget, service, request, meter, port };
}

describe('trusted bounded finalization coordinator', () => {
  it('zero finalize credit directly selects the template without preparing or calling a model', async () => {
    const s = await setup(0);
    const before = s.budget.snapshot('scope');
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', false);
    expect(result).toMatchObject({ reportReason: 'zero-allocation', run: { status: 'COMPLETED_PARTIAL' } });
    expect(result.report).toContain('Partial delivery');
    expect(s.port.prepare).not.toHaveBeenCalled(); expect(s.port.generate).not.toHaveBeenCalled();
    expect(s.budget.snapshot('scope')).toEqual(before);
  });
  it('paused runs keep model calls disabled and can explicitly return a partial template', async () => {
    const s = await setup(); s.store.transitionRun('run', 'PAUSED_BUDGET');
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', false);
    expect(result).toMatchObject({ reportReason: 'run-not-active', run: { status: 'COMPLETED_PARTIAL' } });
    expect(s.port.generate).not.toHaveBeenCalled();
  });
  it('estimates complete input plus output and automatically falls back when the request cannot fit', async () => {
    const s = await setup(); s.port.prepare = vi.fn(() => s.request('large input '.repeat(300)));
    const before = s.budget.snapshot('scope');
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', false);
    expect(result.reportReason).toBe('request-too-large');
    expect(s.port.generate).not.toHaveBeenCalled(); expect(s.budget.snapshot('scope')).toEqual(before);
  });
  it('accepts only one metered finalize call and preserves independent required validation', async () => {
    const s = await setup();
    s.port.generate = vi.fn(async prepared => {
      expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.messages)).toBe(true);
      s.meter(prepared); return 'Optional prose';
    });
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', true);
    expect(result).toMatchObject({ reportReason: 'generated', modelReport: 'Optional prose', run: { status: 'SUCCEEDED' } });
    expect(result.report).toContain('All registered required steps passed.');
    expect(s.budget.snapshot('scope')).toMatchObject({ limitTokens: 1000, usedTokens: 15, finalize: { usedTokens: 15 } });
    expect(s.budget.calls.filter(call => call.method === 'reserve')).toHaveLength(1);
    expect(s.budget.calls.filter(call => call.method === 'settle')).toHaveLength(1);
    expect(s.budget.calls.filter(call => call.method === 'allocate')).toHaveLength(0);
  });
  it('failed independent acceptance blocks optional model spending and cannot be overridden by prose', async () => {
    const s = await setup(500, false);
    await expect(new FinalizationCoordinator(s.service, s.port).finalize('run', true)).rejects.toThrow('acceptance validation failed');
    expect(s.store.getRun('run').status).toBe('RUNNING');
    await expect(new FinalizationCoordinator(s.service, s.port).finalize('run', true)).rejects.toThrow();
    expect(s.port.prepare).not.toHaveBeenCalled(); expect(s.port.generate).not.toHaveBeenCalled();
  });
  it('unknown usage before finalization never invokes a model or claims complete success', async () => {
    const s = await setup(); s.meter(s.request(), 'work', true);
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', true);
    expect(result).toMatchObject({ reportReason: 'unknown-usage', run: { status: 'COMPLETED_PARTIAL' } });
    expect(s.port.generate).not.toHaveBeenCalled(); expect(s.budget.snapshot('scope').unknownCalls).toBe(1);
  });
  it('blocks optional spending when independently accepted artifacts still have failed required work', async () => {
    const s = await setup();
    s.store.addStep({ stepId: 'failed-required', runId: 'run', kind: 'python', required: true, inputHash: 'b'.repeat(64), status: 'FAILED', dependencies: [] });
    const before = s.budget.snapshot('scope');
    await expect(new FinalizationCoordinator(s.service, s.port).finalize('run', true)).rejects.toThrow('Required work is incomplete');
    expect(s.port.prepare).not.toHaveBeenCalled(); expect(s.port.generate).not.toHaveBeenCalled();
    expect(s.budget.snapshot('scope')).toEqual(before);
    expect(s.store.getStep('failed-required')).toMatchObject({ required: true, status: 'FAILED' });
  });
  it('blocks optional spending while an execution remains unresolved', async () => {
    const s = await setup();
    s.store.addStep({ stepId: 'pending-optional', runId: 'run', kind: 'python', required: false, inputHash: 'b'.repeat(64), status: 'PENDING', dependencies: [] });
    s.store.createAttempt('run', 'pending-optional', 'c'.repeat(64));
    await expect(new FinalizationCoordinator(s.service, s.port).finalize('run', true)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(s.port.prepare).not.toHaveBeenCalled(); expect(s.port.generate).not.toHaveBeenCalled();
  });
  it('a model interruption retains unknown reservation and uses a partial template without retrying', async () => {
    const s = await setup();
    s.port.generate = vi.fn(async prepared => { s.meter(prepared, 'finalize', true); throw new Error('private provider error'); });
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', true);
    expect(result).toMatchObject({ reportReason: 'unknown-usage', run: { status: 'COMPLETED_PARTIAL' } });
    expect(JSON.stringify(result)).not.toContain('private provider error');
    expect(s.budget.snapshot('scope')).toMatchObject({ unknownCalls: 1, usedTokens: 0 });
    await expect(new FinalizationCoordinator(s.service, s.port).finalize('run', true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(s.port.generate).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'work-purpose'] as const)('refuses %s accounting proof even if the port returns successful prose', async proof => {
    const s = await setup(); s.port.generate = vi.fn(async prepared => { if (proof === 'work-purpose') s.meter(prepared, 'work'); return 'unverified prose'; });
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', true);
    expect(result).toMatchObject({ reportReason: 'unverified-accounting', run: { status: 'COMPLETED_PARTIAL' } });
    expect(result.modelReport).toBeUndefined();
  });
  it('persisted report intent blocks an optional resend after coordinator reconstruction', async () => {
    const s = await setup();
    s.store.setComponentState('run', 'finalization', 'report-attempt', { schemaVersion: 1, status: 'started', requestHash: 'a'.repeat(64) });
    const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', true);
    expect(result).toMatchObject({ reportReason: 'previous-attempt', run: { status: 'COMPLETED_PARTIAL' } });
    expect(s.port.generate).not.toHaveBeenCalled();
  });
  it('concurrent coordinator instances cannot dispatch two report requests', async () => {
    const s = await setup();
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    s.port.generate = vi.fn(async prepared => { started(); await gate; s.meter(prepared); return 'one report'; });
    const first = new FinalizationCoordinator(s.service, s.port).finalize('run', false);
    await ready;
    await expect(new FinalizationCoordinator(s.service, s.port).finalize('run', false)).rejects.toMatchObject({ code: 'CONFLICT' });
    finish(); await first; expect(s.port.generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['tools', []], ['toolChoice', 'required'], ['retry', 3], ['signal', new AbortController().signal],
    ['purpose', 'compaction'], ['hiddenCallback', undefined],
  ])('rejects runtime extra %s before dispatch, including fields JSON serialization would erase', async (key, value) => {
    const s = await setup();
    s.port.prepare = () => ({ ...s.request(), [key as string]: value });
    await expect(new FinalizationCoordinator(s.service, s.port).finalize('run', true)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(s.port.generate).not.toHaveBeenCalled();
    expect(s.budget.reservations).toHaveLength(0);
    expect(s.store.getComponentState('run', 'finalization', 'report-attempt')).toBeUndefined();
  });
  it.each(['missing-call-id', 'wrong-session', 'cross-scope-dispatch', 'conflicting-call-id', 'reordered-cursor', 'duplicate-event-id'] as const)(
    'rejects inconsistent %s receipt proof rather than accepting unrelated prose', async defect => {
      const s = await setup(); const original = s.budget.eventsAfter.bind(s.budget);
      vi.spyOn(s.budget, 'eventsAfter').mockImplementation(after => {
        const receipts = original(after);
        const reserve = receipts.find(event => event.type === 'reserve')!;
        const dispatch = receipts.find(event => event.type === 'dispatch')!;
        const settle = receipts.find(event => event.type === 'settle')!;
        const details = reserve.payload.request as Record<string, unknown>;
        if (defect === 'missing-call-id') delete details.modelCallId;
        if (defect === 'wrong-session') details.sessionId = 'another-session';
        if (defect === 'cross-scope-dispatch') dispatch.scopeKey = 'another-scope';
        if (defect === 'conflicting-call-id') dispatch.payload = { ...dispatch.payload, modelCallId: 'another-call' };
        if (defect === 'reordered-cursor') settle.cursor = reserve.cursor;
        if (defect === 'duplicate-event-id') settle.eventId = reserve.eventId;
        return receipts;
      });
      const result = await new FinalizationCoordinator(s.service, s.port).finalize('run', true);
      expect(result).toMatchObject({ reportReason: 'unverified-accounting', run: { status: 'COMPLETED_PARTIAL' } });
      expect(result.modelReport).toBeUndefined(); expect(s.port.generate).toHaveBeenCalledTimes(1);
    });
  it.each(['PAUSED_BUDGET', 'RECOVERY_REQUIRED', 'CANCELLING', 'CANCELLED', 'FAILED', 'RUNNING'] as const)(
    'preserves %s reached during the model await and does not finalize stale success or partial output', async state => {
      const s = await setup();
      let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
      let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
      s.port.generate = vi.fn(async prepared => { started(); await gate; s.meter(prepared); return 'late report'; });
      const finalize = vi.spyOn(s.service, 'finalize');
      const pending = new FinalizationCoordinator(s.service, s.port).finalize('run', true);
      await ready;
      if (state === 'CANCELLED') await s.service.cancelRun('run', 'cancel-during-report', { reason: 'test cancellation' });
      else if (state === 'RUNNING') { s.store.transitionRun('run', 'PAUSED_BUDGET'); s.store.transitionRun('run', 'RUNNING'); }
      else s.store.transitionRun('run', state);
      finish();
      await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(s.store.getRun('run').status).toBe(state);
      expect(finalize).not.toHaveBeenCalled();
      expect(s.store.eventsAfter('run').some(event => event.type === 'finalization.report_outcome')).toBe(false);
      expect(s.budget.snapshot('scope').finalize.usedTokens).toBe(15);
      expect(s.port.generate).toHaveBeenCalledTimes(1);
    });
  it('rechecks state after an asynchronous budget read before preparing or dispatching a model', async () => {
    const s = await setup(); const before = s.budget.snapshot('scope');
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(s.service.budget, 'snapshot').mockImplementationOnce(async () => { await gate; return before; });
    const pending = new FinalizationCoordinator(s.service, s.port).finalize('run', true);
    await s.service.cancelRun('run', 'cancel-before-prepare', { reason: 'test cancellation' });
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(s.store.getRun('run').status).toBe('CANCELLED');
    expect(s.port.prepare).not.toHaveBeenCalled(); expect(s.port.generate).not.toHaveBeenCalled();
  });
});
