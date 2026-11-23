import { afterEach, expect, it } from 'vitest';
import { RetryController, type FailureClass } from '../../src/workflow/retry.js';
import { runtimeFixture } from '../support/runtime.js';
const cleanup: Array<() => void> = []; afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
it('persists attempt count/backoff and never resets either on reconstruction', async () => {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  const options = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 };
  const retry = new RetryController(t.store, options, t.clock.now);
  retry.begin('run', 'step'); expect(retry.failed('run', 'step', 1, 'transient-unsent').retryable).toBe(true);
  const next = new RetryController(t.store, options, t.clock.now);
  expect(() => next.begin('run', 'step')).toThrow('backoff'); t.clock.advance(100);
  expect(next.begin('run', 'step').attempts).toBe(2);
  expect(next.failed('run', 'step', 2, 'transient-idempotent').retryable).toBe(false);
  expect(() => next.begin('run', 'step')).toThrow('bound');
});
it.each<FailureClass>(['invalid-input', 'budget', 'cancelled', 'unknown', 'permanent'])('does not auto retry %s', async kind => {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  const retry = new RetryController(t.store, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 }, t.clock.now);
  retry.begin('run', 'step'); expect(retry.failed('run', 'step', 1, kind).retryable).toBe(false);
  expect(() => retry.begin('run', 'step')).toThrow('reconciliation');
});

it('keeps duplicate outcomes idempotent and rejects stale or conflicting classifications', async () => {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  const retry = new RetryController(t.store, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }, t.clock.now);
  expect(() => retry.failed('run', 'step', 1, 'unknown')).toThrow('recorded attempt');
  retry.begin('run', 'step');
  expect(() => retry.begin('run', 'step')).toThrow('reconciliation');
  const first = retry.failed('run', 'step', 1, 'transient-unsent');
  t.clock.advance(50);
  expect(retry.failed('run', 'step', 1, 'transient-unsent')).toEqual(first);
  expect(t.store.eventsAfter('run').filter(e => e.type === 'retry.classified')).toHaveLength(1);
  expect(() => retry.failed('run', 'step', 1, 'permanent')).toThrow('differently');
  t.clock.advance(50); retry.begin('run', 'step');
  const pending = retry.state('run', 'step');
  expect(() => retry.failed('run', 'step', 1, 'transient-unsent')).toThrow('current recorded attempt');
  expect(retry.state('run', 'step')).toEqual(pending);
  retry.failed('run', 'step', 2, 'unknown');
  expect(() => retry.failed('run', 'step', 2, 'transient-idempotent')).toThrow('differently');
  expect(() => retry.begin('run', 'step')).toThrow();
});

it.each([
  { maxAttempts: NaN, baseDelayMs: 0, maxDelayMs: 1 },
  { maxAttempts: 2, baseDelayMs: NaN, maxDelayMs: 1 },
  { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: Infinity },
  { maxAttempts: 2, baseDelayMs: 0.5, maxDelayMs: 1 },
  { maxAttempts: 2, baseDelayMs: -1, maxDelayMs: 1 },
  { maxAttempts: 2, baseDelayMs: 2, maxDelayMs: 1 },
])('rejects invalid numeric retry bounds: %j', async options => {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  expect(() => new RetryController(t.store, options, t.clock.now)).toThrow('bounds');
});

it.each([
  { version: 1, attempts: 1, nextAt: 1000, lastFailure: 'transient-unsent' },
  { version: 2, attempts: -1, nextAt: 1000, phase: 'failed', lastFailure: 'transient-unsent' },
  { version: 2, attempts: 1, nextAt: 1000, phase: 'idle', lastFailure: null },
  { version: 2, attempts: 1, nextAt: 1000, phase: 'failed', lastFailure: null },
])('refuses incompatible or corrupt persisted retry state: %j', async state => {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  t.store.setComponentState('run', 'retry', 'step', state);
  const retry = new RetryController(t.store, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 }, t.clock.now);
  expect(() => retry.begin('run', 'step')).toThrow('invalid retry state');
  expect(() => retry.failed('run', 'step', 1, 'transient-unsent')).toThrow('invalid retry state');
});

it('caps exponential backoff and refuses retries crossing the original deadline', async () => {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  const retry = new RetryController(t.store, { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 150 }, t.clock.now);
  retry.begin('run', 'step'); expect(retry.failed('run', 'step', 1, 'transient-unsent').state.nextAt).toBe(1100);
  t.clock.advance(100); retry.begin('run', 'step');
  expect(retry.failed('run', 'step', 2, 'transient-idempotent').state.nextAt).toBe(1250);
  t.clock.set(99900); retry.begin('run', 'step');
  expect(retry.failed('run', 'step', 3, 'transient-unsent').retryable).toBe(false);
  t.clock.set(100050); expect(() => retry.begin('run', 'step')).toThrow('cannot retry');
  expect(retry.failed('run', 'step', 3, 'transient-unsent').retryable).toBe(false);
});

it('rechecks pause before reporting that a duplicate failure remains retryable', async () => {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  const retry = new RetryController(t.store, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 }, t.clock.now);
  retry.begin('run', 'step'); expect(retry.failed('run', 'step', 1, 'transient-unsent').retryable).toBe(true);
  t.store.transitionRun('run', 'PAUSED_BUDGET');
  expect(retry.failed('run', 'step', 1, 'transient-unsent').retryable).toBe(false);
  expect(() => retry.begin('run', 'step')).toThrow('cannot retry');
});
