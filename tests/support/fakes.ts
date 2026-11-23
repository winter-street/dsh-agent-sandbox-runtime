/** Deterministic test doubles. These never run code, start containers or call a model. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { normalizeUsage } from '../../src/contracts/budget.js';
import type { BudgetAllocation, BudgetControlPort, BudgetEventReceipt, BudgetPurpose, BudgetReservation, BudgetSnapshot, NormalizedUsage, ReservationDecision, ReservationRequest } from '../../src/contracts/budget.js';
import type { CancelResult, CollectedExecution, ExecutionPolicy, ExecutionRef, ExecutionRequest, ExecutionStatus, SandboxPort, SandboxRef } from '../../src/contracts/sandbox.js';
import { SandboxCreateUnsentError } from '../../src/contracts/sandbox.js';
import { RuntimeError } from '../../src/contracts/runtime.js';

const clone = <T>(value: T): T => structuredClone(value);
function count(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}
function nonempty(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
}

/** sleep advances logical time immediately; it never waits for the wall clock. */
export class FakeClock {
  private current: number;
  constructor(initialMs = 0) { count(initialMs, 'initialMs'); this.current = initialMs; }
  readonly now = (): number => this.current;
  advance(ms: number): number { count(ms, 'duration'); count(this.current + ms, 'time'); this.current += ms; return this.current; }
  set(ms: number): void { count(ms, 'time'); if (ms < this.current) throw new TypeError('Fake time cannot move backwards'); this.current = ms; }
  readonly sleep = async (ms: number): Promise<void> => { this.advance(ms); };
}

/** One-shot synchronous injection at explicit boundaries; callbacks may inspect state. */
export class FakeFaults {
  readonly hits: string[] = [];
  private readonly actions = new Map<string, Array<() => void>>();
  onNext(point: string, callback: () => void): this {
    const queue = this.actions.get(point) ?? []; queue.push(callback); this.actions.set(point, queue); return this;
  }
  failNext(point: string, error: Error = new Error(`Injected failure at ${point}`)): this {
    return this.onNext(point, () => { throw error; });
  }
  hit(point: string): void { this.hits.push(point); this.actions.get(point)?.shift()?.(); }
  pending(point?: string): number {
    return point === undefined ? [...this.actions.values()].reduce((sum, queue) => sum + queue.length, 0) : this.actions.get(point)?.length ?? 0;
  }
}
export interface FakeCall { method: string; args: unknown[]; timestamp: number }
export interface FakeExecutionPlan {
  states?: ExecutionStatus[];
  collect?: Partial<Omit<CollectedExecution, 'execution'>>;
  throwAfterDispatch?: boolean | Error;
  cancelConfirmed?: boolean;
}
interface ExecutionEntry {
  ref: ExecutionRef;
  status: ExecutionStatus;
  states: ExecutionStatus[];
  result: Partial<Omit<CollectedExecution, 'execution'>>;
  cancelConfirmed: boolean;
}

export class FakeSandbox implements SandboxPort {
  readonly calls: FakeCall[] = [];
  readonly faults: FakeFaults;
  private readonly clock: FakeClock;
  private readonly plans: FakeExecutionPlan[] = [];
  private readonly sandboxes = new Map<string, SandboxRef>();
  private readonly executions = new Map<string, ExecutionEntry>();
  private readonly destroyed = new Set<string>();
  private readonly uncertain = new Set<string>();
  private sequence = 0;
  constructor(options: { clock?: FakeClock; faults?: FakeFaults; plans?: FakeExecutionPlan[] } = {}) {
    this.clock = options.clock ?? new FakeClock(); this.faults = options.faults ?? new FakeFaults();
    for (const plan of options.plans ?? []) this.enqueue(plan);
  }
  get executionRefs(): ExecutionRef[] { return [...this.executions.values()].map(value => clone(value.ref)); }
  get sandboxRefs(): SandboxRef[] { return [...this.sandboxes.values()].filter(value => !this.destroyed.has(value.sandboxId)).map(value => clone(value)); }
  enqueue(plan: FakeExecutionPlan): this {
    if (plan.states?.length === 0) throw new TypeError('A status queue cannot be empty');
    this.plans.push(clone(plan)); return this;
  }
  setStatus(executionId: string, status: ExecutionStatus): void {
    const entry = this.getExecution(executionId); entry.status = clone(status); entry.states = [];
  }
  setCancelConfirmed(executionId: string, confirmed: boolean): void { this.getExecution(executionId).cancelConfirmed = confirmed; }
  private log(method: string, ...args: unknown[]): void { this.calls.push({ method, args: clone(args), timestamp: this.clock.now() }); }
  private getExecution(id: string): ExecutionEntry {
    const entry = this.executions.get(id); if (!entry) throw new RuntimeError('NOT_FOUND', `Fake execution ${id} was not dispatched`); return entry;
  }
  private resolve(ref: ExecutionRef): ExecutionEntry {
    const entry = this.getExecution(ref.executionId);
    if (!isDeepStrictEqual(entry.ref, ref)) throw new RuntimeError('CONFLICT', 'Fake execution identity mismatch');
    return entry;
  }
  async create(runId: string, policy: ExecutionPolicy): Promise<SandboxRef> {
    this.log('create', runId, policy);
    try { this.faults.hit('sandbox.create.before'); }
    catch (error) { throw new SandboxCreateUnsentError(error instanceof Error ? error.message : String(error)); }
    const ref = { runId, sandboxId: `fake-sandbox-${++this.sequence}` };
    this.sandboxes.set(ref.sandboxId, ref); this.faults.hit('sandbox.create.after'); return clone(ref);
  }
  async execute(request: ExecutionRequest): Promise<ExecutionRef> {
    this.log('execute', request); this.faults.hit('sandbox.execute.before');
    const sandbox = this.sandboxes.get(request.sandbox.sandboxId);
    if (!sandbox || this.destroyed.has(sandbox.sandboxId)) throw new RuntimeError('NOT_FOUND', 'Fake sandbox is absent');
    if (sandbox.runId !== request.runId || request.sandbox.runId !== request.runId) throw new RuntimeError('CONFLICT', 'Sandbox run mismatch');
    if (this.uncertain.has(sandbox.sandboxId)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Prior fake dispatch response is unresolved');
    if ([...this.executions.values()].some(value => value.ref.sandboxId === sandbox.sandboxId && !this.destroyed.has(value.ref.sandboxId)
      && ['RUNNING', 'UNKNOWN'].includes(value.status.state))) throw new RuntimeError('EXECUTION_UNKNOWN', 'Existing fake execution must be resolved first');
    const plan = this.plans.shift() ?? {};
    const states: ExecutionStatus[] = clone(plan.states ?? [plan.throwAfterDispatch ? { state: 'RUNNING' } : { state: 'SUCCEEDED', exitCode: 0 }]);
    const ref: ExecutionRef = { ...sandbox, executionId: `fake-execution-${++this.sequence}`, attemptId: request.attemptId,
      workDir: `/tmp/agent-runtime/${request.runId}/${request.attemptId}` };
    this.executions.set(ref.executionId, { ref, status: states[0]!, states, result: clone(plan.collect ?? {}), cancelConfirmed: plan.cancelConfirmed ?? true });
    try {
      this.faults.hit('sandbox.execute.after-dispatch');
      if (plan.throwAfterDispatch) throw plan.throwAfterDispatch instanceof Error ? plan.throwAfterDispatch : new RuntimeError('EXECUTION_UNKNOWN', 'Fake remote accepted execution but response was lost');
    } catch (error) {
      // Like the real adapter, missing start confirmation fences this sandbox.
      // Test-only access to executionRefs does not resolve the caller's lost response.
      this.uncertain.add(sandbox.sandboxId);
      throw error;
    }
    return clone(ref);
  }
  async inspect(ref: ExecutionRef): Promise<ExecutionStatus> {
    this.log('inspect', ref); this.faults.hit('sandbox.inspect.before');
    const entry = this.resolve(ref);
    if (this.destroyed.has(ref.sandboxId)) return { state: 'UNKNOWN', reason: 'Fake sandbox was destroyed' };
    entry.status = entry.states.shift() ?? entry.status;
    this.faults.hit('sandbox.inspect.after'); return clone(entry.status);
  }
  async cancel(ref: ExecutionRef): Promise<CancelResult> {
    this.log('cancel', ref); this.faults.hit('sandbox.cancel.before');
    const entry = this.resolve(ref);
    if (this.destroyed.has(ref.sandboxId)) return { confirmed: true };
    if (!entry.cancelConfirmed) return { confirmed: false, reason: 'Fake cancellation was requested but not confirmed' };
    if (['RUNNING', 'UNKNOWN'].includes(entry.status.state)) { entry.status = { state: 'CANCELLED' }; entry.states = []; }
    this.faults.hit('sandbox.cancel.after'); return { confirmed: true };
  }
  async collect(ref: ExecutionRef, policy: ExecutionPolicy): Promise<CollectedExecution> {
    this.log('collect', ref, policy); this.faults.hit('sandbox.collect.before');
    const entry = this.resolve(ref);
    if (this.destroyed.has(ref.sandboxId)) throw new RuntimeError('NOT_FOUND', 'Cannot collect a destroyed sandbox');
    if (entry.status.state !== 'SUCCEEDED' && entry.status.state !== 'FAILED') throw new RuntimeError('EXECUTION_UNKNOWN', 'Fake execution is not collectable');
    const result: CollectedExecution = { execution: clone(ref), stdout: '', stderr: '', outputs: [], logsTruncated: false,
      exitCode: entry.status.exitCode, ...clone(entry.result) };
    if (result.exitCode !== entry.status.exitCode) throw new RuntimeError('CONFLICT', 'Fake result exit code differs from status');
    this.faults.hit('sandbox.collect.after'); return result;
  }
  async destroy(ref: SandboxRef): Promise<void> {
    this.log('destroy', ref); this.faults.hit('sandbox.destroy.before');
    const found = this.sandboxes.get(ref.sandboxId);
    if (!found || found.runId !== ref.runId) throw new RuntimeError('NOT_FOUND', 'Fake sandbox identity is unknown');
    this.destroyed.add(ref.sandboxId); this.faults.hit('sandbox.destroy.after');
  }
}

const zeroUsage = (): NormalizedUsage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
const usageTotal = (usage: NormalizedUsage): number => Object.values(usage).reduce((sum, value) => sum + value, 0);
const unresolved = (reservation: BudgetReservation): boolean => ['reserved', 'dispatched', 'unknown'].includes(reservation.status);
const allocation = (limitTokens: number, usedTokens: number, reservedTokens: number): BudgetAllocation =>
  ({ limitTokens, usedTokens, reservedTokens, availableTokens: Math.max(0, limitTokens - usedTokens - reservedTokens) });

/** One in-memory root ledger for core tests; the real plugin owns production accounting. */
export class FakeBudget implements BudgetControlPort {
  readonly calls: FakeCall[] = [];
  readonly faults: FakeFaults;
  readonly scopeKey: string;
  readonly limitTokens: number;
  private readonly clock: FakeClock;
  private readonly maxConcurrent: number;
  private finalizeTokens: number;
  private readonly sessions: Set<string>;
  private readonly entries = new Map<string, BudgetReservation>();
  private readonly receipts: BudgetEventReceipt[] = [];
  private readonly purposeContext = new AsyncLocalStorage<{ sessionId: string; purpose: BudgetPurpose; modelCallId?: string }>();
  constructor(options: { scopeKey?: string; limitTokens?: number; finalizeTokens?: number; maxConcurrent?: number; sessionIds?: string[]; clock?: FakeClock; faults?: FakeFaults } = {}) {
    this.scopeKey = options.scopeKey ?? 'fake-root'; this.limitTokens = options.limitTokens ?? 10000;
    this.finalizeTokens = options.finalizeTokens ?? 0; this.maxConcurrent = options.maxConcurrent ?? Number.MAX_SAFE_INTEGER;
    nonempty(this.scopeKey, 'scopeKey'); count(this.limitTokens, 'limitTokens'); count(this.finalizeTokens, 'finalizeTokens'); count(this.maxConcurrent, 'maxConcurrent');
    if (this.finalizeTokens > this.limitTokens || this.maxConcurrent === 0) throw new TypeError('Invalid fake budget allocation or concurrency');
    this.sessions = new Set(options.sessionIds ?? []); for (const session of this.sessions) nonempty(session, 'sessionId');
    this.clock = options.clock ?? new FakeClock(); this.faults = options.faults ?? new FakeFaults();
  }
  get reservations(): BudgetReservation[] { return [...this.entries.values()].map(clone); }
  get events(): BudgetEventReceipt[] { return clone(this.receipts); }
  private log(method: string, ...args: unknown[]): void { this.calls.push({ method, args: clone(args), timestamp: this.clock.now() }); }
  private checkScope(scopeKey: string): void { if (scopeKey !== this.scopeKey) throw new RuntimeError('NOT_FOUND', 'Fake budget scope is not bound'); }
  private get(id: string): BudgetReservation { const reservation = this.entries.get(id); if (!reservation) throw new RuntimeError('NOT_FOUND', 'Unknown fake reservation'); return reservation; }
  private emit(type: string, payload: Record<string, unknown>): void {
    const cursor = this.receipts.length + 1;
    this.receipts.push({ cursor, eventId: `fake-budget-event-${cursor}`, scopeKey: this.scopeKey, type, payload: clone(payload) });
  }
  scopeForSession(sessionId: string, options: { create?: boolean } = {}): string {
    this.log('scopeForSession', sessionId, options); nonempty(sessionId, 'sessionId');
    if (!this.sessions.has(sessionId)) {
      if (options.create === false) throw new RuntimeError('NOT_FOUND', 'Session has no existing fake budget binding');
      this.sessions.add(sessionId);
    }
    return this.scopeKey;
  }
  snapshot(scopeKey: string): BudgetSnapshot {
    this.log('snapshot', scopeKey); this.checkScope(scopeKey); this.faults.hit('budget.snapshot.before');
    const usage = zeroUsage(); let reserved = 0; let finalizeUsed = 0; let finalizeReserved = 0; let unknownCalls = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === 'settled' && entry.usage) {
        for (const key of Object.keys(usage) as Array<keyof NormalizedUsage>) usage[key] += entry.usage[key];
        if (entry.purpose === 'finalize') finalizeUsed += usageTotal(entry.usage);
      }
      if (unresolved(entry)) { reserved += entry.estimatedTokens; if (entry.purpose === 'finalize') finalizeReserved += entry.estimatedTokens; }
      if (entry.status === 'unknown') unknownCalls += 1;
    }
    const used = usageTotal(usage); count(used, 'total usage'); count(reserved, 'total reserved');
    const total = allocation(this.limitTokens, used, reserved);
    return { ...total, scopeKey, ledgerSeq: this.receipts.length, unknownCalls, exhausted: unknownCalls > 0 || total.availableTokens === 0,
      meteringComplete: unknownCalls === 0, usage, work: allocation(this.limitTokens - this.finalizeTokens, used - finalizeUsed, reserved - finalizeReserved),
      finalize: allocation(this.finalizeTokens, finalizeUsed, finalizeReserved) };
  }
  reserve(request: ReservationRequest): ReservationDecision {
    this.log('reserve', request); this.faults.hit('budget.reserve.before'); this.checkScope(request.scopeKey);
    for (const key of ['modelCallId', 'sessionId', 'provider', 'model'] as const) nonempty(request[key], key);
    count(request.estimatedTokens, 'estimatedTokens');
    if (request.estimatedTokens === 0 || !['work', 'finalize'].includes(request.purpose)) throw new TypeError('Invalid fake reservation');
    this.scopeForSession(request.sessionId);
    const existing = [...this.entries.values()].find(value => value.modelCallId === request.modelCallId);
    if (existing) {
      const same = (Object.keys(request) as Array<keyof ReservationRequest>).every(key => existing[key] === request[key]);
      if (!same) throw new RuntimeError('CONFLICT', 'Conflicting duplicate modelCallId');
      return { allowed: true, reservation: clone(existing), replayed: true };
    }
    const before = this.snapshot(request.scopeKey);
    if (!before.meteringComplete) return { allowed: false, reason: 'USAGE_UNKNOWN', snapshot: before };
    if ([...this.entries.values()].filter(unresolved).length >= this.maxConcurrent) return { allowed: false, reason: 'CONCURRENT_LIMIT', snapshot: before };
    if (request.estimatedTokens > before.availableTokens || request.estimatedTokens > before[request.purpose].availableTokens) return { allowed: false, reason: 'BUDGET_UNAVAILABLE', snapshot: before };
    const reservation: BudgetReservation = { ...clone(request), reservationId: `fake-reservation-${this.entries.size + 1}`, status: 'reserved' };
    this.entries.set(reservation.reservationId, reservation);
    this.emit('reserve', { reservationId: reservation.reservationId, request: clone(request) }); this.faults.hit('budget.reserve.after');
    return { allowed: true, reservation: clone(reservation), replayed: false };
  }
  markDispatched(reservationId: string): void {
    this.log('markDispatched', reservationId); this.faults.hit('budget.dispatch.before'); const entry = this.get(reservationId);
    if (entry.status === 'dispatched') return;
    if (entry.status !== 'reserved') throw new RuntimeError('INVALID_TRANSITION', 'Only a reserved call can be dispatched');
    entry.status = 'dispatched'; this.emit('dispatch', { reservationId }); this.faults.hit('budget.dispatch.after');
  }
  settle(reservationId: string, usage: NormalizedUsage): void {
    this.log('settle', reservationId, usage); this.faults.hit('budget.settle.before'); const entry = this.get(reservationId); const normalized = normalizeUsage(usage);
    if (entry.status === 'settled') {
      if (!isDeepStrictEqual(entry.usage, normalized)) throw new RuntimeError('CONFLICT', 'Conflicting duplicate usage'); return;
    }
    if (entry.status !== 'dispatched' && entry.status !== 'unknown') throw new RuntimeError('INVALID_TRANSITION', 'Only a possibly dispatched call can settle');
    const priorTotal = this.snapshot(this.scopeKey).usedTokens; count(priorTotal + usageTotal(normalized), 'total usage');
    entry.status = 'settled'; entry.usage = normalized; delete entry.reason;
    this.emit('settle', { reservationId, usage: normalized }); this.faults.hit('budget.settle.after');
  }
  releaseUnsent(reservationId: string, reason: string): void {
    this.log('releaseUnsent', reservationId, reason); nonempty(reason, 'reason'); this.faults.hit('budget.release.before'); const entry = this.get(reservationId);
    if (entry.status === 'released_unsent') return;
    if (entry.status !== 'reserved') throw new RuntimeError('INVALID_TRANSITION', 'Dispatched or unknown calls cannot be refunded as unsent');
    entry.status = 'released_unsent'; entry.reason = reason; this.emit('release-unsent', { reservationId, reason }); this.faults.hit('budget.release.after');
  }
  markUnknown(reservationId: string, reason: string): void {
    this.log('markUnknown', reservationId, reason); nonempty(reason, 'reason'); this.faults.hit('budget.unknown.before'); const entry = this.get(reservationId);
    if (entry.status === 'unknown') return;
    if (entry.status !== 'dispatched') throw new RuntimeError('INVALID_TRANSITION', 'Only a dispatched call can have unknown usage');
    entry.status = 'unknown'; entry.reason = reason; this.emit('unknown', { reservationId, reason }); this.faults.hit('budget.unknown.after');
  }
  allocate(scopeKey: string, finalizeTokens: number, reason: string): void {
    this.log('allocate', scopeKey, finalizeTokens, reason); this.checkScope(scopeKey); count(finalizeTokens, 'finalizeTokens'); nonempty(reason, 'reason');
    this.faults.hit('budget.allocate.before');
    if (finalizeTokens > this.limitTokens || [...this.entries.values()].some(unresolved)) throw new RuntimeError('CONFLICT', 'Cannot change allocation beyond total or with unresolved calls');
    this.finalizeTokens = finalizeTokens; this.emit('allocate', { finalizeTokens, reason }); this.faults.hit('budget.allocate.after');
  }
  eventsAfter(cursor: number): BudgetEventReceipt[] {
    this.log('eventsAfter', cursor); count(cursor, 'cursor');
    if (cursor > this.receipts.length) throw new RuntimeError('CONFLICT', 'Cursor is ahead of fake ledger'); return clone(this.receipts.slice(cursor));
  }
  withPurpose<T>(sessionId: string, purpose: BudgetPurpose, callback: () => T): T {
    this.log('withPurpose', sessionId, purpose); nonempty(sessionId, 'sessionId');
    if (purpose !== 'work' && purpose !== 'finalize') throw new TypeError('Invalid fake budget purpose');
    const current = this.purposeContext.getStore();
    return this.purposeContext.run({ sessionId, purpose, ...(current?.sessionId === sessionId && current.modelCallId ? { modelCallId: current.modelCallId } : {}) }, callback);
  }
  withCallIdentity<T>(sessionId: string, modelCallId: string, callback: () => T): T {
    this.log('withCallIdentity', sessionId, modelCallId); nonempty(sessionId, 'sessionId'); nonempty(modelCallId, 'modelCallId');
    const current = this.purposeContext.getStore();
    return this.purposeContext.run({ sessionId, purpose: current?.sessionId === sessionId ? current.purpose : 'work', modelCallId }, callback);
  }
  /** Test provider helper: the default is work outside the trusted matching session context. */
  purposeForSession(sessionId: string): BudgetPurpose {
    const context = this.purposeContext.getStore(); return context?.sessionId === sessionId ? context.purpose : 'work';
  }
  callIdentityForSession(sessionId: string): string | undefined {
    const context = this.purposeContext.getStore(); return context?.sessionId === sessionId ? context.modelCallId : undefined;
  }
}
