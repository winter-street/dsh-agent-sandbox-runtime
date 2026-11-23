import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { loadConfig } from '../../src/config.js';
import { RuntimeService, type RuntimeServiceOptions } from '../../src/core/service.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeBudget, FakeClock, FakeSandbox } from '../support/fakes.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function setup(validate?: RuntimeServiceOptions['validate']) {
  const root = mkdtempSync(join(tmpdir(), 'code-repair-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = new FakeClock(1000); let store = new RuntimeStore(join(root, 'db'), clock.now); cleanups.push(() => store.close());
  const artifacts = new ArtifactStore(join(root, 'artifacts')); const sandbox = new FakeSandbox({ clock });
  const budget = new FakeBudget({ scopeKey: 'original-scope', sessionIds: ['root-session'], limitTokens: 50000, clock });
  const config = loadConfig('config/example.json');
  const validator: NonNullable<RuntimeServiceOptions['validate']> = validate ?? (async (_run, records, read) => {
    const passed = records.length === 1 && Buffer.from(await read(records[0]!)).toString() === 'verified';
    return { passed, evidence: { passed, problems: passed ? [] : ['wrong artifact bytes'] } };
  });
  const makeService = () => new RuntimeService(store, artifacts, sandbox, budget, config, { now: clock.now, wait: clock.sleep, validate: validator });
  let service = makeService();
  await service.createRun({ runId: 'repair-run', rootSessionId: 'root-session', budgetScopeKey: budget.scopeKey, task: 'Deliver verified bytes', deadline: 50000, policyVersion: 'test', inputHash: 'a'.repeat(64) });
  const obligationId = store.listSteps('repair-run').find(s => s.kind === 'review')!.stepId;
  const execute = async (stepId: string, options: { exit?: number; bytes?: string; repairOf?: string[]; obligation?: string } = {}) => {
    sandbox.enqueue({ states: [options.exit ? { state: 'FAILED', exitCode: options.exit } : { state: 'SUCCEEDED', exitCode: 0 }],
      collect: { outputs: [{ path: 'result.txt', content: Buffer.from(options.bytes ?? 'verified') }] } });
    return service.executeCode({ runId: 'repair-run', stepId, code: `program_${stepId}()`, inputs: [], obligationId: options.obligation ?? obligationId,
      ...(options.repairOf ? { repairOf: options.repairOf } : {}) });
  };
  return { clock, budget, artifacts, sandbox, config, obligationId, execute,
    get store() { return store; }, get service() { return service; },
    reopen() { store.close(); store = new RuntimeStore(join(root, 'db'), clock.now); service = makeService(); },
  };
}
describe('explicit code repair acceptance and original-state guards', () => {
  it('retains failure history, repairs only the linked obligation, and replays after reopening without new dispatch or duplicate supersession', async () => {
    const t = await setup(); await t.execute('old-script', { exit: 1 });
    const replacement = await t.execute('replacement', { repairOf: ['old-script'] });
    const inspected = await t.service.inspectCodeResult('repair-run', replacement.attemptId);
    expect(inspected).toMatchObject({ validation: { passed: true }, repairedStepIds: ['old-script'] });
    expect(t.store.getStep('old-script')).toMatchObject({ status: 'FAILED', required: false });
    expect(t.store.getStep('replacement')).toMatchObject({ status: 'SUCCEEDED', required: true, obligationId: t.obligationId, repairOf: ['old-script'] });
    t.reopen();
    await t.service.inspectCodeResult('repair-run', replacement.attemptId);
    const replay = await t.execute('replacement', { repairOf: ['old-script'] });
    expect(replay.attemptId).toBe(replacement.attemptId);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(2);
    expect(t.store.eventsAfter('repair-run').filter(e => e.type === 'repair.validated')).toHaveLength(1);
    expect(t.store.eventsAfter('repair-run').filter(e => e.type === 'step.superseded')).toHaveLength(1);
    // The trusted application commits its acceptance separately from execution diagnostics.
    t.store.recordValidation(t.obligationId, inspected.validation!.passed, inspected.validation!.evidence);
    t.service.setDeliveryManifest('repair-run', replay.artifacts.map(a => a.artifactId));
    expect((await t.service.finalize('repair-run', true)).run.status).toBe('SUCCEEDED');
  });
  it.each([{ exit: 0, bytes: 'incorrect' }, { exit: 1, bytes: 'verified' }])('never supersedes a failed source when the replacement is not independently successful: %j', async spec => {
    const t = await setup(); await t.execute('old-script', { exit: 1 });
    const replacement = await t.execute('replacement', { ...spec, repairOf: ['old-script'] });
    await t.service.inspectCodeResult('repair-run', replacement.attemptId);
    expect(t.store.getStep('old-script')).toMatchObject({ status: 'FAILED', required: true });
    expect(t.store.eventsAfter('repair-run').some(e => e.type === 'step.superseded')).toBe(false);
  });
  it('does not clear an unrelated failed step, even after the linked repair independently passes', async () => {
    const t = await setup(); await t.execute('linked-failure', { exit: 1 }); await t.execute('unrelated-failure', { exit: 1 });
    const replacement = await t.execute('replacement', { repairOf: ['linked-failure'] });
    const inspected = await t.service.inspectCodeResult('repair-run', replacement.attemptId);
    t.store.recordValidation(t.obligationId, inspected.validation!.passed, inspected.validation!.evidence);
    expect(t.store.getStep('unrelated-failure')).toMatchObject({ required: true, status: 'FAILED' });
    await expect(t.service.finalize('repair-run', true)).rejects.toThrow('Required work is incomplete');
  });
  it.each(['other-obligation', 'other-run', 'missing', 'success', 'duplicate', 'no-obligation'] as const)('rejects a %s repair claim before sandbox dispatch', async kind => {
    const t = await setup(); await t.execute('old-script', { exit: kind === 'success' ? 0 : 1 });
    let obligationId = t.obligationId; let targets = ['old-script'];
    if (kind === 'other-obligation') {
      obligationId = 'other-acceptance'; t.store.addStep({ stepId: obligationId, runId: 'repair-run', kind: 'review', required: true, inputHash: 'b'.repeat(64), status: 'PENDING', dependencies: [] });
    } else if (kind === 'other-run') {
      await t.service.createRun({ runId: 'another-run', rootSessionId: 'root-session', budgetScopeKey: t.budget.scopeKey, task: 'Another obligation',
        deadline: 50000, policyVersion: 'test', inputHash: 'b'.repeat(64) });
      t.store.addStep({ stepId: 'foreign-step', runId: 'another-run', kind: 'python', required: true, inputHash: 'c'.repeat(64), status: 'FAILED', dependencies: [], obligationId }); targets = ['foreign-step'];
    } else if (kind === 'missing') targets = ['missing-step'];
    else if (kind === 'duplicate') targets = ['old-script', 'old-script'];
    const before = t.sandbox.calls.filter(c => c.method === 'execute').length;
    await expect(t.service.executeCode({ runId: 'repair-run', stepId: 'forged-repair', code: 'repair()', inputs: [], repairOf: targets,
      ...(kind === 'no-obligation' ? {} : { obligationId }) })).rejects.toThrow();
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(before);
    expect(t.store.getStep('forged-repair')).toBeUndefined();
  });
  it.each(['unknown', 'reserved'] as const)('does not commit repair with %s original model usage', async state => {
    const t = await setup(); await t.execute('old-script', { exit: 1 });
    const replacement = await t.execute('replacement', { repairOf: ['old-script'] });
    const reservation = await t.budget.reserve({ scopeKey: t.budget.scopeKey, modelCallId: 'unresolved-model-call', sessionId: 'root-session',
      provider: 'controlled', model: 'controlled', purpose: 'work', estimatedTokens: 100 });
    if (!reservation.allowed) throw new Error('Controlled reservation was unexpectedly denied');
    if (state === 'unknown') { await t.budget.markDispatched(reservation.reservation.reservationId); await t.budget.markUnknown(reservation.reservation.reservationId, 'controlled lost response'); }
    await expect(t.service.inspectCodeResult('repair-run', replacement.attemptId)).rejects.toThrow(state === 'unknown' ? 'reconciled original' : 'settled model');
    expect(t.store.getStep('old-script')?.required).toBe(true);
    expect(t.store.eventsAfter('repair-run').some(e => e.type === 'repair.validated')).toBe(false);
  });
  it.each(['cancel', 'deadline', 'signal', 'pause'] as const)('rejects %s racing with independent repair validation', async action => {
    let entered!: () => void; let finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }); const waiting = new Promise<void>(resolve => { finish = resolve; });
    const t = await setup(async () => { entered(); await waiting; return { passed: true, evidence: { controlled: true } }; });
    await t.execute('old-script', { exit: 1 }); const replacement = await t.execute('replacement', { repairOf: ['old-script'] });
    const controller = new AbortController(); const pending = t.service.inspectCodeResult('repair-run', replacement.attemptId, controller.signal);
    const rejected = expect(pending).rejects.toThrow(); await ready;
    if (action === 'cancel') await t.service.cancelRun('repair-run', 'cancel-race', { reason: 'operator' });
    else if (action === 'deadline') t.clock.advance(50000);
    else if (action === 'signal') controller.abort(new Error('caller aborted'));
    else t.service.pauseForContext('repair-run', 'CONTEXT_REQUIRED_TOO_LARGE');
    finish(); await rejected;
    expect(t.store.getStep('old-script')?.required).toBe(true);
    expect(t.store.eventsAfter('repair-run').some(e => e.type === 'step.superseded')).toBe(false);
  });
  it('rejects unresolved execution and changed replay repair metadata', async () => {
    const t = await setup(); await t.execute('old-script', { exit: 1 });
    const replacement = await t.execute('replacement', { repairOf: ['old-script'] });
    await expect(t.service.executeCode({ runId: 'repair-run', stepId: 'replacement', code: 'program_replacement()', inputs: [], obligationId: t.obligationId })).rejects.toThrow('changed');
    t.store.addStep({ stepId: 'unresolved', runId: 'repair-run', kind: 'python', required: true, inputHash: 'd'.repeat(64), status: 'PENDING', dependencies: [] });
    t.store.createAttempt('repair-run', 'unresolved', 'd'.repeat(64));
    await expect(t.service.inspectCodeResult('repair-run', replacement.attemptId)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.store.getStep('old-script')?.required).toBe(true);
  });
});
