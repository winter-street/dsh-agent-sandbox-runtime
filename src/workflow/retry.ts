import { z } from 'zod';
import { RuntimeError } from '../contracts/runtime.js';
import type { RuntimeStore } from '../storage/index.js';

const failureSchema = z.enum(['invalid-input', 'transient-unsent', 'transient-idempotent', 'budget', 'cancelled', 'unknown', 'permanent']);
export type FailureClass = z.infer<typeof failureSchema>;
const stateSchema = z.strictObject({
  version: z.literal(2), attempts: z.number().int().nonnegative().safe(), nextAt: z.number().int().nonnegative().safe(),
  phase: z.enum(['idle', 'pending', 'failed']), lastFailure: failureSchema.nullable(),
}).refine(s => s.phase === 'idle' ? s.attempts === 0 && s.nextAt === 0 && s.lastFailure === null
  : s.attempts > 0 && (s.phase === 'pending' ? s.lastFailure === 'unknown' : s.lastFailure !== null));
export type RetryState = z.infer<typeof stateSchema>;
const transient = (kind: FailureClass | null) => kind === 'transient-unsent' || kind === 'transient-idempotent';

/** Callers classify a recorded attempt; this controller never dispatches external work itself. */
export class RetryController {
  constructor(private readonly store: RuntimeStore, private readonly options: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1
      || !Number.isSafeInteger(options.baseDelayMs) || options.baseDelayMs < 0
      || !Number.isSafeInteger(options.maxDelayMs) || options.maxDelayMs < options.baseDelayMs) throw new TypeError('Invalid retry bounds');
  }
  state(runId: string, key: string): RetryState {
    const stored = this.store.getComponentState<unknown>(runId, 'retry', key);
    if (stored === undefined) return { version: 2, attempts: 0, nextAt: 0, phase: 'idle', lastFailure: null };
    const parsed = stateSchema.safeParse(stored);
    if (!parsed.success) throw new RuntimeError('VERSION_MISMATCH', 'Unsupported or invalid retry state; reconcile before dispatch');
    return parsed.data;
  }
  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid retry clock');
    return now;
  }
  begin(runId: string, key: string): RetryState {
    return this.store.transaction(() => {
      const state = this.state(runId, key); const run = this.store.getRun(runId); const now = this.timestamp();
      if (run.status !== 'RUNNING' || now >= run.deadline) throw new RuntimeError('CONFLICT', 'Task cannot retry now');
      if (state.attempts >= this.options.maxAttempts || now < state.nextAt) throw new RuntimeError('CONFLICT', 'Retry bound or backoff prevents dispatch');
      if (state.phase === 'pending' || state.phase === 'failed' && !transient(state.lastFailure)) throw new RuntimeError('CONFLICT', 'Failure requires correction or reconciliation before retry');
      const next: RetryState = { ...state, attempts: state.attempts + 1, phase: 'pending', lastFailure: 'unknown' };
      this.store.setComponentState(runId, 'retry', key, next);
      this.store.appendEvent(runId, 'retry.dispatch_intent', { key, ...next });
      return next;
    });
  }
  failed(runId: string, key: string, attempt: number, kind: FailureClass): { retryable: boolean; state: RetryState } {
    failureSchema.parse(kind);
    return this.store.transaction(() => {
      const state = this.state(runId, key); const run = this.store.getRun(runId); const now = this.timestamp();
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt !== state.attempts) throw new RuntimeError('CONFLICT', 'Failure does not match the current recorded attempt');
      const retryable = (next: RetryState) => transient(next.lastFailure) && next.attempts < this.options.maxAttempts
        && Math.max(now, next.nextAt) < run.deadline && run.status === 'RUNNING';
      if (state.phase === 'failed') {
        if (state.lastFailure !== kind) throw new RuntimeError('CONFLICT', 'Attempt already classified differently; reconcile explicitly');
        return { retryable: retryable(state), state };
      }
      if (state.phase !== 'pending') throw new RuntimeError('CONFLICT', 'No pending recorded attempt');
      const nextAt = now + Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** Math.min(state.attempts - 1, 30));
      if (!Number.isSafeInteger(nextAt)) throw new TypeError('Retry timestamp exceeds safe range');
      const next: RetryState = { ...state, phase: 'failed', lastFailure: kind, nextAt };
      const allowed = retryable(next);
      this.store.setComponentState(runId, 'retry', key, next);
      this.store.appendEvent(runId, 'retry.classified', { key, retryable: allowed, ...next });
      return { retryable: allowed, state: next };
    });
  }
}
