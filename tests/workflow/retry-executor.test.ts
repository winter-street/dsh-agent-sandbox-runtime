/** Actual RuntimeService/SQLite/artifact storage; all budget, time and sandbox calls are explicit fakes. */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { RuntimeError } from '../../src/contracts/runtime.js';
import { DurableRetryExecutor, type RetryExecutorOptions } from '../../src/workflow/retry-executor.js';
import { RetryController } from '../../src/workflow/retry.js';
import { runtimeFixture } from '../support/runtime.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) dispose(); });
const bounds = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 };
const input = () => ({ runId: 'run', stepId: 'step', code: 'print(42)', inputs: [{ path: 'input.txt', content: Buffer.from('original') }] });
async function setup(options: Partial<RetryExecutorOptions> = {}) {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  const settings = { ...bounds, now: t.clock.now, wait: t.clock.sleep, ...options };
  const executor = new DurableRetryExecutor(t.service, settings);
  return { ...t, settings, executor };
}
function success(t: Awaited<ReturnType<typeof setup>>) {
  t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
    stdout: '42', outputs: [{ path: 'result.json', content: Buffer.from('{"answer":42}') }],
  } });
}
function exhaust(t: Awaited<ReturnType<typeof setup>>, unknown = false) {
  const reserve = t.budget.reserve({ scopeKey: 'scope', modelCallId: 'budget-pressure', sessionId: 'root',
    provider: 'fake', model: 'fake', purpose: 'work', estimatedTokens: 100000 });
  if (!reserve.allowed) throw new Error('Fake reservation setup failed');
  if (unknown) {
    t.budget.markDispatched(reserve.reservation.reservationId);
    t.budget.markUnknown(reserve.reservation.reservationId, 'explicit fake missing usage');
  }
}

describe('durable code retry composition with explicitly fake remote ports', () => {
  it('keeps an unknown creation blocked when a remote sandbox appears after an empty observation and restart', async () => {
    const t = await setup();
    const remoteCreate = t.sandbox.create.bind(t.sandbox);
    let lateCreate: (() => ReturnType<typeof remoteCreate>) | undefined;
    const create = vi.spyOn(t.sandbox, 'create').mockImplementation(async (runId, policy) => {
      lateCreate = () => remoteCreate(runId, policy);
      throw new Error('fake create response timed out while remote work continues');
    });
    await expect(t.executor.executeCode(input())).rejects.toThrow('response timed out');
    expect(t.sandbox.sandboxRefs).toHaveLength(0);
    const attemptId = t.store.listAttempts('run')[0]!.attemptId;
    t.store.close();

    const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanup.push(() => reopened.close());
    const service = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now, wait: t.clock.sleep });
    const executor = new DurableRetryExecutor(service, t.settings);
    await service.recover('run');
    expect(reopened.getRun('run').status).toBe('RECOVERY_REQUIRED');
    await expect(executor.executeCode(input())).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(lateCreate).toBeDefined();

    const lateSandbox = await lateCreate!();
    expect(t.sandbox.sandboxRefs).toEqual([lateSandbox]);
    await service.recover('run');
    expect((await service.cancelRun('run', 'cancel-late-create', { reason: 'test' })).status).toBe('RECOVERY_REQUIRED');
    await t.sandbox.destroy(lateSandbox);
    await service.recover('run');
    await expect(service.finalize('run', false)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    await expect(executor.executeCode(input())).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(0);
    expect(reopened.listAttempts('run')).toMatchObject([{ attemptId, status: 'UNKNOWN', errorCode: 'SANDBOX_CREATE_UNKNOWN' }]);
    expect(reopened.getRun('run').status).toBe('RECOVERY_REQUIRED');
  });

  it('blocks an accepted creation with a lost response across recovery, cancellation and retry', async () => {
    const t = await setup();
    t.sandbox.faults.failNext('sandbox.create.after', new Error('response lost'));
    await expect(t.executor.executeCode(input())).rejects.toThrow('response lost');
    expect(t.sandbox.sandboxRefs).toHaveLength(1);
    expect(t.store.listAttempts('run')[0]).toMatchObject({ status: 'UNKNOWN', errorCode: 'SANDBOX_CREATE_UNKNOWN', sandboxId: null });
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', failure: 'unknown' });
    await t.service.recover('run');
    await expect(t.service.finalize('run', false)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect((await t.service.cancelRun('run', 'cancel-unknown-create', { reason: 'test' })).status).toBe('RECOVERY_REQUIRED');
    await expect(t.executor.executeCode(input())).rejects.toThrow();
    expect(t.sandbox.calls.filter(call => call.method === 'create')).toHaveLength(1);
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(0);
    const orphan = t.sandbox.sandboxRefs[0]!;
    expect(orphan.runId).toBe('run');
    await t.sandbox.destroy(orphan);
    expect(t.sandbox.sandboxRefs).toHaveLength(0);
    expect(t.store.listAttempts('run')[0]?.status).toBe('UNKNOWN');
  });
  it('creates distinct persisted attempts after a proven unsent failure and replays committed artifacts once', async () => {
    const t = await setup(); success(t);
    t.sandbox.faults.failNext('sandbox.create.before', new Error('fake create failure'));
    const result = await t.executor.executeCode(input());
    const attempts = t.store.listAttempts('run');
    expect(attempts.map(a => [a.attemptNo, a.status, a.errorCode])).toEqual([
      [1, 'FAILED', 'SANDBOX_CREATE_FAILED'], [2, 'SUCCEEDED', null],
    ]);
    expect(attempts[0]).toMatchObject({ sandboxId: null, executionId: null, workDir: null, sandboxCreateEvidence: 'adapter-confirmed-unsent-v1' });
    expect(attempts[0]?.attemptId).not.toBe(attempts[1]?.attemptId);
    expect(result.stdout).toBe('42'); expect(result.artifacts).toHaveLength(1);
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'done', dispatchNo: 2, attemptNo: 2,
      attemptId: result.attemptId, binding: { budgetScopeKey: 'scope', deadline: 100000, rootSessionId: 'root' } });
    expect(t.sandbox.calls.filter(c => c.method === 'create').map(c => c.timestamp)).toEqual([1000, 1100]);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    const replacement = new DurableRetryExecutor(t.service, t.settings);
    expect(await replacement.executeCode(input())).toEqual(result);
    expect(t.store.listAttempts('run')).toHaveLength(2);
    expect(t.store.eventsAfter('run').filter(e => e.type === 'tool.finished')).toHaveLength(1);
    expect(t.store.eventsAfter('run').filter(e => e.type === 'retry.execution_committed')).toHaveLength(1);
    expect(t.budget.snapshot('scope').usedTokens).toBe(0);
  });

  it('preserves classified backoff, counters and scope after actually closing and reopening SQLite', async () => {
    const t = await setup(); let first = true;
    const interrupted = new DurableRetryExecutor(t.service, { ...t.settings, wait: async () => {
      if (first) { first = false; t.clock.advance(40); throw new Error('local wait interrupted'); }
    } });
    t.sandbox.faults.failNext('sandbox.create.before');
    await expect(interrupted.executeCode(input())).rejects.toThrow('local wait interrupted');
    expect(interrupted.state('run', 'step')).toMatchObject({ phase: 'waiting', dispatchNo: 1, attemptNo: 1 });
    t.store.close();
    const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanup.push(() => reopened.close());
    const service = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now, wait: t.clock.sleep });
    const delays: number[] = [];
    const replacement = new DurableRetryExecutor(service, { ...t.settings, wait: async ms => { delays.push(ms); t.clock.advance(ms); } });
    success(t);
    const result = await replacement.executeCode(input());
    expect(delays).toEqual([60]);
    expect(reopened.listAttempts('run').map(a => a.attemptNo)).toEqual([1, 2]);
    expect(replacement.state('run', 'step')).toMatchObject({ phase: 'done', dispatchNo: 2, attemptId: result.attemptId,
      binding: { budgetScopeKey: 'scope', deadline: 100000 } });
    reopened.close();
    const again = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanup.push(() => again.close());
    const againService = new RuntimeService(again, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now });
    expect(await new DurableRetryExecutor(againService, t.settings).executeCode(input())).toEqual(result);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('does not redispatch a persisted waiting retry if the historical attempt has no unsent evidence', async () => {
    const t = await setup();
    const interrupted = new DurableRetryExecutor(t.service, { ...t.settings, wait: async () => { throw new Error('local wait interrupted'); } });
    t.sandbox.faults.failNext('sandbox.create.before');
    await expect(interrupted.executeCode(input())).rejects.toThrow('local wait interrupted');
    const [attempt] = t.store.listAttempts('run');
    expect(interrupted.state('run', 'step')).toMatchObject({ phase: 'waiting', dispatchNo: 1, attemptId: attempt!.attemptId });
    const { sandboxCreateEvidence, ...historicalAttempt } = attempt!;
    expect(sandboxCreateEvidence).toBe('adapter-confirmed-unsent-v1');
    t.store.close();

    const directory = join(t.directory, 'db');
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    try {
      db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify(historicalAttempt), historicalAttempt.attemptId);
    } finally { db.close(); }

    const reopened = new RuntimeStore(directory, t.clock.now); cleanup.push(() => reopened.close());
    const service = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now, wait: t.clock.sleep });
    const replacement = new DurableRetryExecutor(service, t.settings);
    await expect(replacement.executeCode(input())).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(reopened.listAttempts('run')).toEqual([historicalAttempt]);
    expect(replacement.state('run', 'step')).toMatchObject({ phase: 'waiting', dispatchNo: 1 });
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(0);
  });

  it('replays a committed service result when a crash leaves only the wrapper intent pending', async () => {
    const t = await setup(); success(t);
    const write = t.store.setComponentState.bind(t.store);
    const fault = vi.spyOn(t.store, 'setComponentState').mockImplementation((runId, namespace, key, data) => {
      if (namespace === 'retry-executor' && (data as { phase?: string }).phase === 'done') throw new Error('fake local completion write crash');
      return write(runId, namespace, key, data);
    });
    await expect(t.executor.executeCode(input())).rejects.toThrow('completion write crash');
    expect(t.executor.state('run', 'step')?.phase).toBe('pending');
    expect(t.store.listAttempts('run')[0]?.status).toBe('SUCCEEDED');
    fault.mockRestore();
    const replacement = new DurableRetryExecutor(t.service, t.settings);
    expect((await replacement.executeCode(input())).stdout).toBe('42');
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    expect(replacement.state('run', 'step')?.phase).toBe('done');
  });

  it('turns an error after the actual service commit into replay without another dispatch', async () => {
    const t = await setup(); success(t);
    const service = new RuntimeService(t.store, t.service.artifacts, t.sandbox, t.budget, t.service.config,
      { now: t.clock.now, wait: t.clock.sleep, fault: point => { if (point === 'after-commit') throw new Error('fake local postcommit crash'); } });
    const result = await new DurableRetryExecutor(service, t.settings).executeCode(input());
    expect(result.stdout).toBe('42');
    expect(t.store.listAttempts('run')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('claims once across different executor and service objects before asynchronous admission', async () => {
    const t = await setup(); success(t);
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const snapshot = t.budget.snapshot.bind(t.budget);
    // Explicitly fake budget await; both executors still use actual RuntimeService objects.
    const port = { ...t.budget, scopeForSession: t.budget.scopeForSession.bind(t.budget), snapshot: async (scope: string) => { await gate; return snapshot(scope); },
      reserve: t.budget.reserve.bind(t.budget), markDispatched: t.budget.markDispatched.bind(t.budget), settle: t.budget.settle.bind(t.budget),
      releaseUnsent: t.budget.releaseUnsent.bind(t.budget), markUnknown: t.budget.markUnknown.bind(t.budget), eventsAfter: t.budget.eventsAfter.bind(t.budget) };
    const firstService = new RuntimeService(t.store, t.service.artifacts, t.sandbox, port, t.service.config, { now: t.clock.now });
    const secondService = new RuntimeService(t.store, t.service.artifacts, t.sandbox, port, t.service.config, { now: t.clock.now });
    const first = new DurableRetryExecutor(firstService, t.settings).executeCode(input());
    try {
      await expect(new DurableRetryExecutor(secondService, t.settings).executeCode(input())).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
      expect(t.store.listAttempts('run')).toHaveLength(0);
      expect(t.sandbox.calls).toHaveLength(0);
    } finally { unblock(); }
    expect((await first).stdout).toBe('42');
    expect(t.store.listAttempts('run')).toHaveLength(1);
    expect(t.store.eventsAfter('run').filter(e => e.type === 'retry.execution_intent')).toHaveLength(1);
  });

  it('blocks pending intents after an unsent outcome if classification did not commit', async () => {
    const t = await setup();
    t.sandbox.faults.failNext('sandbox.create.before');
    const write = t.store.setComponentState.bind(t.store);
    const fault = vi.spyOn(t.store, 'setComponentState').mockImplementation((runId, namespace, key, data) => {
      if (namespace === 'retry-executor' && (data as { phase?: string }).phase === 'waiting') throw new Error('fake local classification crash');
      return write(runId, namespace, key, data);
    });
    await expect(t.executor.executeCode(input())).rejects.toThrow('classification crash');
    fault.mockRestore();
    expect(t.executor.state('run', 'step')?.phase).toBe('pending');
    expect(t.store.listAttempts('run')[0]).toMatchObject({ status: 'FAILED', errorCode: 'SANDBOX_CREATE_FAILED' });
    await expect(new DurableRetryExecutor(t.service, t.settings).executeCode(input())).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(1);
  });

  it.each(['budget', 'unknown-usage'] as const)('does not retry %s rejected before an actual attempt exists', async kind => {
    const t = await setup(); exhaust(t, kind === 'unknown-usage');
    await expect(t.executor.executeCode(input())).rejects.toBeInstanceOf(RuntimeError);
    expect(t.store.listAttempts('run')).toHaveLength(0);
    expect(t.sandbox.calls).toHaveLength(0);
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', dispatchNo: 1, failure: 'budget', attemptId: null });
    await expect(new DurableRetryExecutor(t.service, t.settings).executeCode(input())).rejects.toThrow('explicit action');
  });

  it('does not trust a retryable exception without a corresponding persisted unsent attempt', async () => {
    const t = await setup();
    t.budget.faults.failNext('budget.snapshot.before', new RuntimeError('BUDGET_UNAVAILABLE', 'fake admission unavailable', { retryable: true }));
    await expect(t.executor.executeCode(input())).rejects.toThrow('admission unavailable');
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', failure: 'budget', attemptId: null });
    expect(t.store.listAttempts('run')).toHaveLength(0); expect(t.sandbox.calls).toHaveLength(0);
  });

  it('does not retry invalid code rejected before admission', async () => {
    const t = await setup();
    await expect(t.executor.executeCode({ ...input(), code: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', failure: 'invalid-input', attemptId: null });
    expect(t.store.listAttempts('run')).toHaveLength(0); expect(t.sandbox.calls).toHaveLength(0);
  });

  it('does not retry accepted-but-unacknowledged fake dispatches', async () => {
    const t = await setup(); t.sandbox.enqueue({ throwAfterDispatch: true });
    await expect(t.executor.executeCode(input())).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.store.listAttempts('run')[0]).toMatchObject({ attemptNo: 1, status: 'UNKNOWN' });
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', failure: 'unknown' });
    await expect(new DurableRetryExecutor(t.service, t.settings).executeCode(input())).rejects.toThrow('explicit action');
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    expect(t.sandbox.executionRefs).toHaveLength(1);
  });

  it('replays an explicitly reconciled unknown result on the same attempt without redispatch', async () => {
    const t = await setup(); success(t); let once = true;
    const service = new RuntimeService(t.store, t.service.artifacts, t.sandbox, t.budget, t.service.config,
      { now: t.clock.now, wait: t.clock.sleep, fault: point => { if (point === 'after-publish' && once) { once = false; throw new Error('fake local publication crash'); } } });
    const executor = new DurableRetryExecutor(service, t.settings);
    await expect(executor.executeCode(input())).rejects.toThrow('publication crash');
    expect(executor.state('run', 'step')).toMatchObject({ phase: 'blocked', failure: 'unknown' });
    expect(t.store.listAttempts('run')[0]).toMatchObject({ status: 'UNKNOWN' });
    await service.recover('run');
    expect((await new DurableRetryExecutor(service, t.settings).executeCode(input())).stdout).toBe('42');
    expect(t.store.listAttempts('run')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    expect(executor.state('run', 'step')).toMatchObject({ phase: 'done', failure: null });
  });

  it('rejects damaged committed artifacts instead of redispatching successful code', async () => {
    const t = await setup(); success(t);
    const result = await t.executor.executeCode(input());
    writeFileSync(join(t.service.artifacts.rootDir, 'runs', 'run', 'attempts', result.attemptId, 'files', 'result.json'), 'corrupted');
    await expect(new DurableRetryExecutor(t.service, t.settings).executeCode(input())).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(t.store.listAttempts('run')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('returns script failures as committed results and never blindly retries them', async () => {
    const t = await setup(); t.sandbox.enqueue({ states: [{ state: 'FAILED', exitCode: 2 }], collect: { stderr: 'fake script error' } });
    const first = await t.executor.executeCode(input()); expect(first.exitCode).toBe(2);
    expect(await new DurableRetryExecutor(t.service, t.settings).executeCode(input())).toEqual(first);
    expect(t.store.listAttempts('run')[0]).toMatchObject({ status: 'FAILED', errorCode: 'SCRIPT_FAILED' });
    expect(t.store.listAttempts('run')).toHaveLength(1);
  });

  it('stops at the configured attempt bound with capped exponential backoff', async () => {
    const t = await setup({ maxAttempts: 4 });
    for (let n = 0; n < 4; n++) t.sandbox.faults.failNext('sandbox.create.before', new Error('fake create failure'));
    await expect(t.executor.executeCode(input())).rejects.toThrow('fake create failure');
    expect(t.sandbox.calls.filter(c => c.method === 'create').map(c => c.timestamp)).toEqual([1000, 1100, 1250, 1400]);
    expect(t.store.listAttempts('run').map(a => a.attemptNo)).toEqual([1, 2, 3, 4]);
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', dispatchNo: 4 });
    await expect(new DurableRetryExecutor(t.service, t.settings).executeCode(input())).rejects.toThrow('explicit action');
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(4);
  });

  it('does not begin another attempt when backoff would cross the original deadline', async () => {
    const t = await setup(); t.clock.set(99950);
    t.sandbox.faults.failNext('sandbox.create.before', new Error('fake create near deadline'));
    await expect(t.executor.executeCode(input())).rejects.toThrow('fake create near deadline');
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', dispatchNo: 1, binding: { deadline: 100000 } });
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(1);
  });

  it.each(['cancel', 'pause', 'deadline'] as const)('rechecks %s after waiting and sends no further code', async change => {
    const t = await setup(); t.sandbox.faults.failNext('sandbox.create.before');
    const control = new AbortController();
    const executor = new DurableRetryExecutor(t.service, { ...t.settings, wait: async ms => {
      if (change === 'cancel') control.abort(new Error('cancelled during fake wait'));
      else if (change === 'pause') t.store.transitionRun('run', 'PAUSED_BUDGET');
      else t.clock.set(100000);
      if (change !== 'deadline') t.clock.advance(ms);
    } });
    await expect(executor.executeCode(input(), control.signal)).rejects.toBeInstanceOf(Error);
    expect(t.store.listAttempts('run')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(0);
  });

  it('does not dispatch when already cancelled and does not retry remote cancellation', async () => {
    const t = await setup(); const signal = AbortSignal.abort(new Error('already cancelled'));
    await expect(t.executor.executeCode(input(), signal)).rejects.toThrow('already cancelled');
    expect(t.executor.state('run', 'step')).toBeUndefined();
    t.sandbox.enqueue({ states: [{ state: 'CANCELLED' }] });
    await expect(t.executor.executeCode(input())).rejects.toThrow('Remote execution cancelled');
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', failure: 'cancelled' });
    expect(t.store.listAttempts('run')).toHaveLength(1);
  });

  it('classifies cancellation arriving with a creation failure as cancelled rather than retryable', async () => {
    const t = await setup(); const control = new AbortController();
    t.sandbox.faults.onNext('sandbox.create.before', () => { control.abort(); throw new Error('fake creation failed during cancellation'); });
    await expect(t.executor.executeCode(input(), control.signal)).rejects.toThrow('creation failed');
    expect(t.executor.state('run', 'step')).toMatchObject({ phase: 'blocked', failure: 'cancelled', dispatchNo: 1 });
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(1);
  });

  it('lets only one reconstructed contender claim the next generation after shared backoff', async () => {
    const t = await setup(); success(t); t.sandbox.faults.failNext('sandbox.create.before');
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstExecutor = new DurableRetryExecutor(t.service, { ...t.settings, wait: async () => { entered(); await gate; } });
    const first = firstExecutor.executeCode(input()).then(() => undefined, error => error as Error);
    await waiting;
    const service = new RuntimeService(t.store, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now, wait: t.clock.sleep });
    try { expect((await new DurableRetryExecutor(service, t.settings).executeCode(input())).stdout).toBe('42'); }
    finally { release(); }
    expect(await first).toMatchObject({ code: 'CONFLICT' });
    expect(t.store.listAttempts('run').map(a => a.attemptNo)).toEqual([1, 2]);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('rechecks insufficient budget during retry admission without a new sandbox attempt', async () => {
    const t = await setup(); t.sandbox.faults.failNext('sandbox.create.before');
    const executor = new DurableRetryExecutor(t.service, { ...t.settings, wait: async ms => { exhaust(t); t.clock.advance(ms); } });
    await expect(executor.executeCode(input())).rejects.toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
    expect(t.store.listAttempts('run')).toHaveLength(1);
    expect(executor.state('run', 'step')).toMatchObject({ phase: 'blocked', dispatchNo: 2, attemptNo: 2, failure: 'budget', attemptId: null });
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(1);
  });

  it.each(['input', 'bounds', 'runtime-config', 'scope', 'deadline'] as const)('rejects changed %s bindings without resetting retry state', async change => {
    const t = await setup(); t.sandbox.faults.failNext('sandbox.create.before');
    const interrupted = new DurableRetryExecutor(t.service, { ...t.settings, wait: async () => { throw new Error('fake local interruption'); } });
    await expect(interrupted.executeCode(input())).rejects.toThrow('local interruption');
    const previous = interrupted.state('run', 'step')!;
    const request = input();
    if (change === 'input') request.inputs[0]!.content = Buffer.from('different');
    if (change === 'runtime-config') t.service.config.sandbox.cpu = 2;
    if (change === 'scope' || change === 'deadline') t.store.setComponentState('run', 'retry-executor', 'step',
      { ...previous, binding: { ...previous.binding, ...(change === 'scope' ? { budgetScopeKey: 'another-scope' } : { deadline: 200000 }) } });
    const replacement = new DurableRetryExecutor(t.service, { ...t.settings, ...(change === 'bounds' ? { maxAttempts: 4 } : {}) });
    await expect(replacement.executeCode(request)).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(replacement.state('run', 'step')?.dispatchNo).toBe(1);
    expect(t.store.listAttempts('run')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(1);
  });

  it('refuses corrupt retry state and unbound historical attempts', async () => {
    const t = await setup();
    t.store.setComponentState('run', 'retry-executor', 'step', { version: 99 });
    await expect(t.executor.executeCode(input())).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    await t.service.executeCode({ ...input(), stepId: 'unbound-step' });
    await expect(t.executor.executeCode({ ...input(), stepId: 'unbound-step' })).rejects.toThrow('no retry execution binding');
    expect(t.store.listAttempts('run')).toHaveLength(1);
  });

  it('binds retry controller state to the execution generation rather than resetting a mismatched controller', async () => {
    const t = await setup(); t.sandbox.faults.failNext('sandbox.create.before');
    const interrupted = new DurableRetryExecutor(t.service, { ...t.settings, wait: async () => { throw new Error('interrupt'); } });
    await expect(interrupted.executeCode(input())).rejects.toThrow('interrupt');
    const key = t.store.eventsAfter('run').find(e => e.type === 'retry.dispatch_intent')!.payload as { key: string };
    const state = new RetryController(t.store, bounds, t.clock.now).state('run', key.key);
    t.store.setComponentState('run', 'retry', key.key, { ...state, attempts: 2 });
    await expect(new DurableRetryExecutor(t.service, t.settings).executeCode(input())).rejects.toThrow('history differ');
    expect(t.store.listAttempts('run')).toHaveLength(1);
  });

  it('protects immutable input bytes across retry waits', async () => {
    const t = await setup(); const request = input(); t.sandbox.faults.failNext('sandbox.create.before');
    const executor = new DurableRetryExecutor(t.service, { ...t.settings, wait: async ms => {
      request.code = 'changed by caller'; request.inputs[0]!.content.fill(0); t.clock.advance(ms);
    } });
    await executor.executeCode(request);
    const sent = t.sandbox.calls.find(c => c.method === 'execute')!.args[0] as { code: string; inputs: Array<{ path: string; content: Uint8Array }> };
    expect(sent.code).toBe('print(42)'); expect(Buffer.from(sent.inputs[0]!.content).toString()).toBe('original');
  });
});
