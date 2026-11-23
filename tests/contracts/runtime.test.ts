import { describe, expect, it } from 'vitest';
import { assertAttemptTransition, assertRunTransition, IdSchema, RunInputSchema } from '../../src/contracts/runtime.js';

describe('lifecycle boundaries', () => {
  it('requires remote cancellation confirmation and explicit recovery', () => {
    expect(() => assertRunTransition('RUNNING', 'CANCELLED')).toThrow();
    assertRunTransition('RUNNING', 'CANCELLING');
    assertRunTransition('CANCELLING', 'RECOVERY_REQUIRED');
    assertRunTransition('RECOVERY_REQUIRED', 'RUNNING');
    assertAttemptTransition('UNKNOWN', 'SUCCEEDED');
  });
  it('does not reopen terminal runs or silently reuse successful attempts', () => {
    for (const state of ['SUCCEEDED', 'COMPLETED_PARTIAL', 'FAILED', 'CANCELLED'] as const) {
      expect(() => assertRunTransition(state, 'RUNNING')).toThrow();
    }
    expect(() => assertAttemptTransition('SUCCEEDED', 'RUNNING')).toThrow();
    expect(() => assertAttemptTransition('DISPATCHING', 'SUCCEEDED')).toThrow();
  });
  it('rejects path-like identifiers and incomplete run requests', () => {
    for (const id of ['../x', 'C:\\x', '', '/root', 'a/b']) expect(IdSchema.safeParse(id).success).toBe(false);
    expect(RunInputSchema.safeParse({ runId: 'run-1' }).success).toBe(false);
  });
});
