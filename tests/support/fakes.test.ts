import { describe, expect, it } from 'vitest';
import { FakeBudget, FakeClock, FakeFaults, FakeSandbox } from './fakes.js';
import type { BudgetReservation, ReservationRequest } from '../../src/contracts/budget.js';
import type { ExecutionPolicy, ExecutionRequest } from '../../src/contracts/sandbox.js';

const policy: ExecutionPolicy = {
  image: 'fake-only:no-image-pulled', cpu: 1, memoryMiB: 128, ttlSeconds: 300,
  commandTimeoutMs: 1000, maxLogBytes: 1000, maxOutputBytes: 1000, maxOutputFiles: 10,
  network: { defaultAction: 'deny', allowHosts: [] },
};
async function request(sandbox: FakeSandbox, attemptId = 'attempt-1'): Promise<ExecutionRequest> {
  return { sandbox: await sandbox.create('run-1', policy), runId: 'run-1', stepId: 'step-1', attemptId,
    code: 'This is deliberately invalid Python. No process may run it.', inputs: [], policy };
}
const usage = (total: number) => ({ inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const reservationRequest = (overrides: Partial<ReservationRequest> = {}): ReservationRequest => ({
  scopeKey: 'scope-1', sessionId: 'session-1', modelCallId: 'call-1', provider: 'fake', model: 'fake-model',
  estimatedTokens: 50, purpose: 'work', ...overrides,
});
function reserve(budget: FakeBudget, overrides: Partial<ReservationRequest> = {}): BudgetReservation {
  const result = budget.reserve(reservationRequest(overrides));
  if (!result.allowed) throw new Error(`Expected reservation, got ${result.reason}`);
  return result.reservation;
}

describe('deterministic time and fault boundaries', () => {
  it('keeps clock callbacks bound and advances without wall-clock timers', async () => {
    const clock = new FakeClock(1000); const { now, sleep } = clock;
    await sleep(75); expect(now()).toBe(1075);
    clock.set(2000); expect(clock.advance(10)).toBe(2010);
    expect(() => clock.set(1000)).toThrow('backwards');
    expect(() => clock.advance(-1)).toThrow('nonnegative');
    expect(() => clock.advance(Number.MAX_SAFE_INTEGER)).toThrow('safe integer');
  });

  it('consumes one-shot faults in order and can inspect committed state', () => {
    const faults = new FakeFaults(); const observations: string[] = [];
    faults.failNext('publish.after').onNext('publish.after', () => { observations.push('second'); });
    expect(faults.pending()).toBe(2);
    expect(() => faults.hit('publish.after')).toThrow('Injected');
    faults.hit('publish.after'); faults.hit('publish.after');
    expect(observations).toEqual(['second']); expect(faults.pending('publish.after')).toBe(0);
    expect(faults.hits).toHaveLength(3);
  });
});

describe('fake remote sandbox contract', () => {
  it('consumes queued status, retains the terminal result, and never interprets code', async () => {
    const sandbox = new FakeSandbox({ plans: [{ states: [{ state: 'RUNNING' }, { state: 'SUCCEEDED', exitCode: 0 }],
      collect: { stdout: 'fixture only', outputs: [{ path: 'result.txt', content: Buffer.from('answer') }] } }] });
    const req = await request(sandbox); const ref = await sandbox.execute(req);
    await expect(sandbox.inspect(ref)).resolves.toEqual({ state: 'RUNNING' });
    await expect(sandbox.collect(ref, policy)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    await expect(sandbox.inspect(ref)).resolves.toEqual({ state: 'SUCCEEDED', exitCode: 0 });
    await expect(sandbox.inspect(ref)).resolves.toEqual({ state: 'SUCCEEDED', exitCode: 0 });
    const result = await sandbox.collect(ref, policy);
    expect(result.stdout).toBe('fixture only'); expect(Buffer.from(result.outputs[0]!.content).toString()).toBe('answer');
    expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    result.outputs[0]!.content.fill(0);
    expect(Buffer.from((await sandbox.collect(ref, policy)).outputs[0]!.content).toString()).toBe('answer');
  });

  it('keeps a remote execution after a lost dispatch response and fences another start', async () => {
    const sandbox = new FakeSandbox({ plans: [{ throwAfterDispatch: true }] });
    const req = await request(sandbox);
    await expect(sandbox.execute(req)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(sandbox.executionRefs).toHaveLength(1);
    await expect(sandbox.execute({ ...req, attemptId: 'attempt-2' })).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    const ref = sandbox.executionRefs[0]!;
    await expect(sandbox.inspect(ref)).resolves.toEqual({ state: 'RUNNING' });
    sandbox.setStatus(ref.executionId, { state: 'FAILED', exitCode: 7, error: 'fixture failure' });
    await expect(sandbox.collect(ref, policy)).resolves.toMatchObject({ exitCode: 7 });
  });

  it('distinguishes failure before dispatch from failure after dispatch', async () => {
    const faults = new FakeFaults(); const sandbox = new FakeSandbox({ faults }); const req = await request(sandbox);
    faults.failNext('sandbox.execute.before');
    await expect(sandbox.execute(req)).rejects.toThrow('before'); expect(sandbox.executionRefs).toEqual([]);
    faults.failNext('sandbox.execute.after-dispatch');
    await expect(sandbox.execute(req)).rejects.toThrow('after-dispatch'); expect(sandbox.executionRefs).toHaveLength(1);
  });

  it('does not invent attempt-id deduplication that the remote adapter cannot guarantee', async () => {
    const sandbox = new FakeSandbox(); const req = await request(sandbox);
    const first = await sandbox.execute(req);
    await expect(sandbox.inspect(first)).resolves.toEqual({ state: 'SUCCEEDED', exitCode: 0 });
    const second = await sandbox.execute(req);
    expect(second.executionId).not.toBe(first.executionId);
    expect(second.attemptId).toBe(first.attemptId);
    expect(sandbox.executionRefs).toHaveLength(2);
    // RuntimeStore must prevent unsafe replay; the remote port cannot promise exactly-once.
  });

  it('retains a lost-response fence even after test-only remote reconciliation sees completion', async () => {
    const sandbox = new FakeSandbox({ plans: [{ throwAfterDispatch: true }] }); const req = await request(sandbox);
    await expect(sandbox.execute(req)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    const ref = sandbox.executionRefs[0]!;
    sandbox.setStatus(ref.executionId, { state: 'SUCCEEDED', exitCode: 0 });
    await expect(sandbox.inspect(ref)).resolves.toMatchObject({ state: 'SUCCEEDED' });
    await expect(sandbox.execute({ ...req, attemptId: 'attempt-2' })).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(sandbox.executionRefs).toHaveLength(1);
  });

  it('keeps the adapter execution fence local to one sandbox', async () => {
    const sandbox = new FakeSandbox({ plans: [{ states: [{ state: 'RUNNING' }] }] });
    const req = await request(sandbox); await sandbox.execute(req);
    await expect(sandbox.execute({ ...req, attemptId: 'attempt-2' })).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    const separate = await request(sandbox, 'attempt-2');
    await expect(sandbox.execute(separate)).resolves.toMatchObject({ sandboxId: separate.sandbox.sandboxId });
  });

  it('does not convert unconfirmed cancellation into remote termination', async () => {
    const sandbox = new FakeSandbox({ plans: [{ states: [{ state: 'RUNNING' }], cancelConfirmed: false }] });
    const ref = await sandbox.execute(await request(sandbox));
    await expect(sandbox.cancel(ref)).resolves.toMatchObject({ confirmed: false });
    await expect(sandbox.inspect(ref)).resolves.toEqual({ state: 'RUNNING' });
    sandbox.setCancelConfirmed(ref.executionId, true);
    await expect(sandbox.cancel(ref)).resolves.toEqual({ confirmed: true });
    await expect(sandbox.inspect(ref)).resolves.toEqual({ state: 'CANCELLED' });
  });

  it('holds unknown status until explicitly resolved and survives client replacement', async () => {
    const sandbox = new FakeSandbox({ plans: [{ states: [{ state: 'UNKNOWN', reason: 'status unavailable' }] }] });
    const ref = await sandbox.execute(await request(sandbox));
    const persistedRef = JSON.parse(JSON.stringify(ref)) as typeof ref;
    await expect(sandbox.inspect(persistedRef)).resolves.toMatchObject({ state: 'UNKNOWN' });
    await expect(sandbox.collect(persistedRef, policy)).rejects.toThrow('collectable');
    sandbox.setStatus(ref.executionId, { state: 'SUCCEEDED', exitCode: 0 });
    await expect(sandbox.collect(persistedRef, policy)).resolves.toMatchObject({ exitCode: 0 });
  });

  it('rejects forged identity and collection after confirmed destruction', async () => {
    const sandbox = new FakeSandbox(); const ref = await sandbox.execute(await request(sandbox));
    await expect(sandbox.inspect({ ...ref, runId: 'other-run' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await sandbox.destroy(ref); await sandbox.destroy(ref);
    await expect(sandbox.inspect(ref)).resolves.toMatchObject({ state: 'UNKNOWN' });
    await expect(sandbox.collect(ref, policy)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('fake single-root budget contract', () => {
  it('preserves the root mapping and refuses implicit creation during lookup', () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', sessionIds: ['session-1'] });
    expect(budget.scopeForSession('session-1', { create: false })).toBe('scope-1');
    expect(() => budget.scopeForSession('missing', { create: false })).toThrow('existing');
    expect(budget.scopeForSession('child')).toBe('scope-1');
    expect(() => budget.snapshot('new-root')).toThrow('not bound');
  });

  it('makes admission atomic for two concurrent callers competing for remaining credit', async () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', limitTokens: 100 });
    const results = await Promise.all(['call-1', 'call-2'].map(modelCallId => Promise.resolve().then(() =>
      budget.reserve(reservationRequest({ modelCallId, estimatedTokens: 60 })))));
    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results[1]).toMatchObject({ allowed: false, reason: 'BUDGET_UNAVAILABLE' });
    expect(budget.snapshot('scope-1')).toMatchObject({ reservedTokens: 60, availableTokens: 40 });
  });

  it('keeps work and finalization inside the same global total', () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', limitTokens: 100, finalizeTokens: 20 });
    const work = reserve(budget, { estimatedTokens: 80 });
    expect(budget.reserve(reservationRequest({ modelCallId: 'extra', estimatedTokens: 1 }))).toMatchObject({ allowed: false, reason: 'BUDGET_UNAVAILABLE' });
    const final = reserve(budget, { modelCallId: 'final', purpose: 'finalize', estimatedTokens: 20 });
    budget.markDispatched(work.reservationId); budget.settle(work.reservationId, usage(65));
    budget.markDispatched(final.reservationId); budget.settle(final.reservationId, usage(15));
    expect(budget.snapshot('scope-1')).toMatchObject({ usedTokens: 80, reservedTokens: 0, availableTokens: 20,
      work: { limitTokens: 80, usedTokens: 65, availableTokens: 15 }, finalize: { limitTokens: 20, usedTokens: 15, availableTokens: 5 } });
  });

  it('retains unknown reservations, denies new calls, and accepts late actual usage once', () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', limitTokens: 100 }); const entry = reserve(budget);
    budget.markDispatched(entry.reservationId); budget.markUnknown(entry.reservationId, 'response lost');
    expect(budget.snapshot('scope-1')).toMatchObject({ reservedTokens: 50, unknownCalls: 1, exhausted: true, meteringComplete: false });
    expect(budget.reserve(reservationRequest({ modelCallId: 'new' }))).toMatchObject({ allowed: false, reason: 'USAGE_UNKNOWN' });
    expect(() => budget.releaseUnsent(entry.reservationId, 'cancelled')).toThrow('cannot be refunded');
    budget.settle(entry.reservationId, usage(30)); const cursor = budget.events.length; budget.settle(entry.reservationId, usage(30));
    expect(budget.events).toHaveLength(cursor); expect(budget.reservations[0]).not.toHaveProperty('reason');
    expect(budget.snapshot('scope-1')).toMatchObject({ usedTokens: 30, reservedTokens: 0, unknownCalls: 0, meteringComplete: true });
    expect(() => budget.settle(entry.reservationId, usage(31))).toThrow('Conflicting');
  });

  it('replays identical reservation requests without spending twice and rejects conflicting reuse', () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', limitTokens: 100 }); const first = reserve(budget);
    expect(budget.reserve(reservationRequest())).toMatchObject({ allowed: true, replayed: true, reservation: first });
    expect(() => budget.reserve(reservationRequest({ estimatedTokens: 51 }))).toThrow('Conflicting');
    expect(budget.reservations).toHaveLength(1); expect(budget.snapshot('scope-1').reservedTokens).toBe(50);
  });

  it('releases only known-unsent requests and recovers the concurrency slot', () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', maxConcurrent: 1 }); const first = reserve(budget);
    expect(budget.reserve(reservationRequest({ modelCallId: 'call-2' }))).toMatchObject({ allowed: false, reason: 'CONCURRENT_LIMIT' });
    budget.releaseUnsent(first.reservationId, 'never sent'); budget.releaseUnsent(first.reservationId, 'never sent');
    const next = reserve(budget, { modelCallId: 'call-2' }); budget.markDispatched(next.reservationId);
    expect(() => budget.releaseUnsent(next.reservationId, 'local timeout')).toThrow('cannot be refunded');
    expect(() => budget.settle(first.reservationId, usage(1))).toThrow('dispatched');
  });

  it('records real overage without truncating usage and blocks the next call', () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', limitTokens: 100 }); const entry = reserve(budget, { estimatedTokens: 80 });
    budget.markDispatched(entry.reservationId); budget.settle(entry.reservationId, usage(120));
    expect(budget.snapshot('scope-1')).toMatchObject({ usedTokens: 120, availableTokens: 0, exhausted: true });
    expect(budget.reserve(reservationRequest({ modelCallId: 'next', estimatedTokens: 1 }))).toMatchObject({ allowed: false, reason: 'BUDGET_UNAVAILABLE' });
  });

  it('separates failures before and after accounting commits and exposes stable event replay', () => {
    const faults = new FakeFaults(); const budget = new FakeBudget({ scopeKey: 'scope-1', faults });
    faults.failNext('budget.reserve.before'); expect(() => reserve(budget)).toThrow('before'); expect(budget.events).toEqual([]);
    faults.failNext('budget.reserve.after'); expect(() => reserve(budget)).toThrow('after'); expect(budget.reservations).toHaveLength(1);
    const replay = budget.reserve(reservationRequest()); expect(replay).toMatchObject({ allowed: true, replayed: true });
    const entry = budget.reservations[0]!; budget.markDispatched(entry.reservationId);
    faults.failNext('budget.settle.after'); expect(() => budget.settle(entry.reservationId, usage(10))).toThrow('after');
    budget.settle(entry.reservationId, usage(10)); expect(budget.events.map(event => event.type)).toEqual(['reserve', 'dispatch', 'settle']);
    expect(budget.events[0]!.payload).toEqual({ reservationId: entry.reservationId, request: reservationRequest() });
    expect(budget.eventsAfter(1).map(event => event.cursor)).toEqual([2, 3]);
    expect(() => budget.eventsAfter(4)).toThrow('ahead');
    const exposed = budget.reservations; exposed[0]!.status = 'unknown';
    expect(budget.snapshot('scope-1').unknownCalls).toBe(0);
  });

  it('audits allocation changes and rejects changes with unresolved reservations', () => {
    const budget = new FakeBudget({ scopeKey: 'scope-1', limitTokens: 100 });
    budget.allocate('scope-1', 20, 'retain report credit'); const entry = reserve(budget);
    expect(() => budget.allocate('scope-1', 30, 'change')).toThrow('unresolved');
    budget.releaseUnsent(entry.reservationId, 'not sent'); budget.allocate('scope-1', 30, 'operator adjustment');
    expect(budget.snapshot('scope-1').work.limitTokens).toBe(70);
    expect(() => budget.allocate('scope-1', 101, 'invalid')).toThrow('beyond');
    expect(budget.events.filter(event => event.type === 'allocate')).toHaveLength(2);
  });

  it('distinguishes dispatch-intent write failure from a committed dispatch with a lost acknowledgement', () => {
    const faults = new FakeFaults(); const budget = new FakeBudget({ scopeKey: 'scope-1', faults });
    const entry = reserve(budget);
    faults.failNext('budget.dispatch.before');
    expect(() => budget.markDispatched(entry.reservationId)).toThrow('before');
    expect(budget.reservations[0]?.status).toBe('reserved');
    expect(budget.events.map(event => event.type)).toEqual(['reserve']);
    faults.failNext('budget.dispatch.after');
    expect(() => budget.markDispatched(entry.reservationId)).toThrow('after');
    expect(budget.reservations[0]?.status).toBe('dispatched');
    budget.markDispatched(entry.reservationId);
    expect(budget.events.map(event => event.type)).toEqual(['reserve', 'dispatch']);
    expect(() => budget.releaseUnsent(entry.reservationId, 'caller saw an error')).toThrow('cannot be refunded');
  });

  it('retains an unsettled reservation after a failed usage write so retry can settle exactly once', () => {
    const faults = new FakeFaults(); const budget = new FakeBudget({ scopeKey: 'scope-1', faults });
    const entry = reserve(budget); budget.markDispatched(entry.reservationId);
    faults.failNext('budget.settle.before');
    expect(() => budget.settle(entry.reservationId, usage(10))).toThrow('before');
    expect(budget.snapshot('scope-1')).toMatchObject({ usedTokens: 0, reservedTokens: 50 });
    expect(budget.events.map(event => event.type)).toEqual(['reserve', 'dispatch']);
    budget.settle(entry.reservationId, usage(10)); budget.settle(entry.reservationId, usage(10));
    expect(budget.snapshot('scope-1')).toMatchObject({ usedTokens: 10, reservedTokens: 0 });
    expect(budget.events.map(event => event.type)).toEqual(['reserve', 'dispatch', 'settle']);
  });

  it('keeps trusted purpose local to an asynchronous matching session', async () => {
    const budget = new FakeBudget(); const results = await Promise.all([
      budget.withPurpose('session-1', 'finalize', async () => { await Promise.resolve(); return [budget.purposeForSession('session-1'), budget.purposeForSession('session-2')]; }),
      budget.withPurpose('session-2', 'work', async () => { await Promise.resolve(); return [budget.purposeForSession('session-1'), budget.purposeForSession('session-2')]; }),
    ]);
    expect(results).toEqual([['finalize', 'work'], ['work', 'work']]);
    expect(budget.purposeForSession('session-1')).toBe('work');
  });
});
