import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RuntimeService, type RuntimeServiceOptions } from '../../src/core/service.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { runtimeFixture } from '../support/runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
async function fixture() { const t = await runtimeFixture(); cleanups.push(t.dispose); return t; }
function service(t: Awaited<ReturnType<typeof fixture>>, options: RuntimeServiceOptions = {}, store = t.store) {
  return new RuntimeService(store, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now, ...options });
}

describe('persistent context pause and host revalidation', () => {
  it('persists a blocked context across SQLite reopen and refuses ordinary resume', async () => {
    const t = await fixture();
    t.service.pauseForContext('run', 'CONTEXT_REQUIRED_TOO_LARGE');
    t.service.pauseForContext('run', 'CONTEXT_REQUIRED_TOO_LARGE');
    expect(t.store.eventsAfter('run').filter(e => e.type === 'context.blocked')).toHaveLength(1);
    const before = await t.service.getRun('run');
    expect(before.status).toBe('RECOVERY_REQUIRED');
    expect(before.contextBlock).toMatchObject({ code: 'CONTEXT_REQUIRED_TOO_LARGE', resolved: false });
    t.store.close();
    const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanups.push(() => reopened.close());
    const replacement = service(t, {}, reopened);
    await expect(replacement.resumeRun('run', 'resume', before.revision)).rejects.toMatchObject({ code: 'CONFLICT', details: { phase: 'context' } });
    expect((await replacement.getRun('run')).contextBlock).toEqual(before.contextBlock);
    expect(t.sandbox.calls).toHaveLength(0);
  });

  it('keeps unknown summary accounting paused even when the root ledger otherwise has credit', async () => {
    const t = await fixture(); t.service.pauseForContext('run', 'CONTEXT_USAGE_UNKNOWN');
    const paused = t.store.getRun('run');
    expect(paused.status).toBe('PAUSED_ACCOUNTING');
    await expect(service(t, { validateContextResume: async () => false }).resumeRun('run', 'resume', paused.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.budget.snapshot('scope').usedTokens).toBe(0);
    expect(t.store.getRun('run').status).toBe('PAUSED_ACCOUNTING');
  });

  it('atomically clears one block only after trusted validation and preserves command replay', async () => {
    const t = await fixture(); t.service.pauseForContext('run', 'CONTEXT_SUMMARY_PENDING');
    const paused = t.store.getRun('run'); const verified: string[] = [];
    const replacement = service(t, { validateContextResume: async (_run, block) => { verified.push(block.blockId); return true; } });
    const results = await Promise.allSettled([
      replacement.resumeRun('run', 'resume-a', paused.revision),
      replacement.resumeRun('run', 'resume-b', paused.revision),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0]!.status === 'fulfilled' ? 'resume-a' : 'resume-b';
    const resumed = await replacement.resumeRun('run', winner, paused.revision);
    expect(resumed).toMatchObject({ status: 'RUNNING', deadline: paused.deadline, budgetScopeKey: paused.budgetScopeKey });
    expect(t.store.eventsAfter('run').filter(e => e.type === 'context.unblocked')).toHaveLength(1);
    expect((await replacement.getRun('run')).contextBlock?.resolved).toBe(true);
    expect(verified).toHaveLength(2);
  });

  it('does not resume a replacement block that arrived while the validator awaited I/O', async () => {
    const t = await fixture(); t.service.pauseForContext('run', 'CONTEXT_REQUIRED_TOO_LARGE');
    const paused = t.store.getRun('run');
    const replacement = service(t, { validateContextResume: async () => {
      t.service.pauseForContext('run', 'CONTEXT_SUMMARY_PENDING'); return true;
    } });
    await expect(replacement.resumeRun('run', 'resume', paused.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await replacement.getRun('run')).contextBlock).toMatchObject({ code: 'CONTEXT_SUMMARY_PENDING', resolved: false });
    expect(t.store.eventsAfter('run').filter(e => e.type === 'context.unblocked')).toHaveLength(0);
  });

  it('does not overwrite cancellation or trust an incompatible persisted pause record', async () => {
    const t = await fixture(); await t.service.cancelRun('run', 'cancel', { reason: 'operator' });
    t.service.pauseForContext('run', 'CONTEXT_SUMMARY_PENDING');
    expect(t.store.getRun('run').status).toBe('CANCELLED');
    expect((await t.service.getRun('run')).contextBlock).toBeNull();
    t.store.setComponentState('run', 'runtime', 'context-block', { version: 99, resolved: true });
    await expect(t.service.getRun('run')).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
  });
});
