import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeService } from '../../src/core/service.js';
import { runtimeFixture } from '../support/runtime.js';
import { RuntimeStore } from '../../src/storage/index.js';

const cleanups: (() => void)[] = [];
async function fixture() {
  const t = await runtimeFixture(); cleanups.push(t.dispose); return t;
}
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function changeCheckpoint(directory: string, change: (value: Record<string, unknown>) => unknown) {
  const database = new DatabaseSync(join(directory, 'db/runtime.sqlite'));
  try {
    const row = database.prepare('SELECT id,data FROM checkpoints ORDER BY rowid DESC LIMIT 1').get()!;
    database.prepare('UPDATE checkpoints SET data=? WHERE id=?').run(JSON.stringify(change(JSON.parse(String(row.data)))), row.id!);
  } finally { database.close(); }
}

describe('versioned checkpoints and compatibility before recovery', () => {
  it('reopens execution/code/artifact references and never snapshots budget balances', async () => {
    const t = await fixture();
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.json', content: Buffer.from('{"answer":42}') }],
    } });
    await t.service.executeCode({ runId: 'run', stepId: 'step', code: 'print(42)', inputs: [] });
    t.store.transitionRun('run', 'PAUSED_BUDGET');
    const checkpoint = t.store.saveCheckpoint('run');
    expect(checkpoint).toMatchObject({ schemaVersion: 2, runtimeIdentity: { schemaVersion: 1 }, budgetScopeKey: 'scope' });
    expect(checkpoint.attempts[0]?.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.steps.map(s => s.stepId)).toContain('step');
    expect(checkpoint.artifacts).toHaveLength(1);
    expect(checkpoint).not.toHaveProperty('usedTokens');
    expect(checkpoint).not.toHaveProperty('reservedTokens');
    t.store.close();
    const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanups.push(() => reopened.close());
    expect(reopened.latestCheckpoint('run')).toEqual(checkpoint);
    const replacement = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now });
    const resumed = await replacement.resumeRun('run', 'resume', reopened.getRun('run').revision);
    expect(resumed).toMatchObject({ status: 'RUNNING', deadline: 100000, budgetScopeKey: 'scope' });
    expect(reopened.listAttempts('run')).toHaveLength(1);
  });

  it('rejects configuration changes before remote inspection and new dispatch', async () => {
    const t = await fixture(); t.store.saveCheckpoint('run');
    const changed = structuredClone(t.service.config); changed.sandbox.memoryMiB *= 2;
    const replacement = new RuntimeService(t.store, t.service.artifacts, t.sandbox, t.budget, changed);
    await expect(replacement.recover('run')).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    await expect(replacement.executeCode({ runId: 'run', stepId: 'step', code: 'pass', inputs: [] })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.sandbox.calls).toHaveLength(0);
    expect(t.store.listAttempts('run')).toHaveLength(0);
  });

  it('rejects code fingerprints that differ from the persisted run identity', async () => {
    const t = await fixture(); t.store.saveCheckpoint('run');
    const identity = t.store.getComponentState<Record<string, unknown>>('run', 'runtime', 'identity')!;
    t.store.setComponentState('run', 'runtime', 'identity', { ...identity, codeHash: 'f'.repeat(64) });
    await expect(t.service.recover('run')).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.sandbox.calls).toHaveLength(0);
  });

  it.each([
    ['legacy schema', (c: Record<string, unknown>) => ({ ...c, schemaVersion: 1 })],
    ['future schema', (c: Record<string, unknown>) => ({ ...c, schemaVersion: 999 })],
    ['invalid cursor', (c: Record<string, unknown>) => ({ ...c, lastEventSeq: -1 })],
    ['future cursor', (c: Record<string, unknown>) => ({ ...c, lastEventSeq: 1_000_000 })],
    ['foreign run', (c: Record<string, unknown>) => ({ ...c, runId: 'another-run' })],
    ['missing steps', (c: Record<string, unknown>) => ({ ...c, steps: undefined })],
    ['unexpected budget balance', (c: Record<string, unknown>) => ({ ...c, usedTokens: 0 })],
    ['changed step input', (c: Record<string, unknown>) => ({ ...c, steps: [{ stepId: (c.steps as { stepId: string }[])[0]!.stepId, inputHash: 'f'.repeat(64) }] })],
  ])('refuses %s instead of trusting a JSON cast', async (_name, change) => {
    const t = await fixture(); t.store.saveCheckpoint('run');
    changeCheckpoint(t.directory, change);
    await expect(t.service.recover('run')).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.sandbox.calls).toHaveLength(0);
  });

  it('rejects a checkpoint that drops the original artifact checksum or loses its file', async () => {
    const t = await fixture();
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.json', content: Buffer.from('{}') }],
    } });
    await t.service.executeCode({ runId: 'run', stepId: 'step', code: 'pass', inputs: [] });
    const original = t.store.latestCheckpoint('run')!;
    changeCheckpoint(t.directory, c => ({ ...c, artifacts: original.artifacts.map(a => ({ ...a, sha256: 'f'.repeat(64) })) }));
    await expect(t.service.recover('run')).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    changeCheckpoint(t.directory, () => original);
    const artifact = original.artifacts[0]!;
    rmSync(join(t.service.artifacts.rootDir, 'runs', artifact.runId, 'attempts', artifact.attemptId, 'files', artifact.path));
    await expect(t.service.recover('run')).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(t.store.listAttempts('run')).toHaveLength(1);
  });
});
