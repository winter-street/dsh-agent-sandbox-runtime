import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeShardedEvaluation, runShardedEvaluation } from '../../eval/sharded.js';
import { loadSuite, type RunResult } from '../../eval/report.js';
import { slotWorker, type EvaluationDriver, type EvaluationRequest } from '../../eval/runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'eval-shards-')); roots.push(directory);
  const suite = loadSuite(); const calls: EvaluationRequest[] = []; let active = 0; let peak = 0;
  const variant = { configSha256: 'a'.repeat(64), budgetLimitTokens: 1000 };
  function driver(): EvaluationDriver {
    const driver: EvaluationDriver = {
      manifest: { schemaVersion: 1, mode: 'simulation', execution: { provider: 'controlled', model: 'controlled', modelVersion: '1',
        harnessVersion: 'test', sandboxVersion: 'test', codeRevision: 'pinned' }, variants: { 'hard-only': variant, tiered: variant, 'tiered-finalize': variant } },
      async execute(request) { calls.push(request); active++; peak = Math.max(peak, active); await delay(8); active--; return { runId: request.runId }; },
      async reconcile(request) { return { runId: request.runId }; },
      async validate(request) {
        return { schemaVersion: 1, suiteSha256: suite.sha256, taskId: request.taskId, variant: request.variant, repetition: request.repetition,
          runId: request.runId, mode: 'simulation', execution: { ...driver.manifest.execution, configSha256: variant.configSha256 }, outcome: 'complete',
          candidateStatistics: suite.suite.tasks.find(task => task.id === request.taskId)!.expectedStatistics, checks: { report: true, chart: true },
          calls: [{ callId: request.runId + '-synthetic', category: 'work', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
          budgetLimitTokens: 1000, durationMs: 1, interruptions: 0, denials: 0, reviewedDenials: 0, falseDenials: 0, failureKind: null,
          evidence: { trace: 'controlled', ledger: 'controlled', validation: 'controlled', artifacts: [] } };
      },
    }; return driver;
  }
  const drivers: [EvaluationDriver, EvaluationDriver] = [driver(), driver()];
  const options = { suite, directory, split: 'calibration' as const, repetitions: 1, drivers };
  return { options, calls, drivers, peak: () => peak, directory };
}

describe('two isolated durable evaluation workers, controlled hooks only', () => {
  it.each([1, 2])('respects global cap %s, resumes committed work once and merges exact coverage', async cap => {
    const s = setup();
    await runShardedEvaluation({ ...s.options, providerConcurrency: cap, sandboxConcurrency: 2, maxRunsPerWorker: 2 });
    expect(s.calls).toHaveLength(4);
    await runShardedEvaluation({ ...s.options, providerConcurrency: cap, sandboxConcurrency: 2, maxRunsPerWorker: 15 });
    expect(s.calls).toHaveLength(15); expect(s.peak()).toBe(cap);
    const before = s.calls.map(call => call.runId);
    await runShardedEvaluation({ ...s.options, providerConcurrency: cap, sandboxConcurrency: 2, maxRunsPerWorker: 15 });
    expect(s.calls.map(call => call.runId)).toEqual(before);
    const report = mergeShardedEvaluation({ ...s.options, output: join(s.directory, 'merged'), mode: 'simulation' });
    expect(report).toMatchObject({ recordedRuns: 15, expectedRuns: 15, acceptance: { passedRuns: 15 }, finalEvaluationEligible: false });
    expect(new Set(s.calls.map(call => [call.taskId, call.variant, call.repetition].join('/'))).size).toBe(15);
    await expect(runShardedEvaluation({ ...s.options, providerConcurrency: cap === 1 ? 2 : 1 })).rejects.toThrow('identity changed');
  });
  it('refuses merge with missing slots and refuses swapped exports', async () => {
    const s = setup(); await runShardedEvaluation(s.options);
    expect(() => mergeShardedEvaluation({ ...s.options, output: join(s.directory, 'missing'), mode: 'simulation' })).toThrow('Incomplete');
    const path = join(s.directory, 'worker-0', 'records.jsonl'); const other = readFileSync(join(s.directory, 'worker-1', 'records.jsonl'), 'utf8');
    writeFileSync(path, other);
    expect(() => mergeShardedEvaluation({ ...s.options, output: join(s.directory, 'swapped'), mode: 'simulation' })).toThrow('another worker');
  });
  it('retains lost-response intent; global restart blocks all new dispatch and explicit reconciliation preserves run identity', async () => {
    const s = setup(); const execute = s.drivers[0].execute;
    s.drivers[0].execute = async request => { await execute(request); throw new Error('lost response'); };
    await expect(runShardedEvaluation({ ...s.options, providerConcurrency: 1, maxRunsPerWorker: 15 })).rejects.toThrow('stopped');
    const before = s.calls.map(call => call.runId);
    await expect(runShardedEvaluation({ ...s.options, providerConcurrency: 1 })).rejects.toThrow('pending intent');
    expect(s.calls.map(call => call.runId)).toEqual(before);
    s.drivers[0].execute = execute;
    await runShardedEvaluation({ ...s.options, providerConcurrency: 1, reconcilePending: true, maxRunsPerWorker: 15 });
    expect(s.calls.map(call => call.runId)).toEqual(before);
    await runShardedEvaluation({ ...s.options, providerConcurrency: 1, maxRunsPerWorker: 15 });
    expect(s.calls).toHaveLength(15); expect(new Set(s.calls.map(call => call.runId)).size).toBe(15);
  });
  it('keeps UNKNOWN usage visible, stops future jobs and blocks later automatic continuation', async () => {
    const s = setup(); const validate = s.drivers[0].validate;
    s.drivers[0].validate = async (request, output) => ({ ...await validate(request, output), outcome: 'paused', failureKind: 'accounting',
      calls: [{ callId: request.runId + '-unknown', category: 'work', usage: null }] });
    await expect(runShardedEvaluation({ ...s.options, providerConcurrency: 1, maxRunsPerWorker: 15 })).rejects.toThrow('stopped');
    const before = s.calls.length;
    await expect(runShardedEvaluation({ ...s.options, providerConcurrency: 1 })).rejects.toThrow(/unresolved|pending/);
    expect(s.calls).toHaveLength(before);
  });
  it('pins per-worker assignment and rejects duplicate record exports instead of silently deduplicating', async () => {
    const s = setup(); await runShardedEvaluation({ ...s.options, maxRunsPerWorker: 15 });
    const path = join(s.directory, 'worker-0', 'records.jsonl'); const text = readFileSync(path, 'utf8'); writeFileSync(path, text + text.split('\n')[0] + '\n');
    expect(() => mergeShardedEvaluation({ ...s.options, output: join(s.directory, 'duplicate'), mode: 'simulation' })).toThrow('differs');
    expect(slotWorker({ taskId: 'c01', variant: 'tiered', repetition: 1 }, 2)).toBe(slotWorker({ taskId: 'c01', variant: 'tiered', repetition: 1 }, 2));
    expect(() => slotWorker({} as RunResult, 0)).toThrow();
  });
});
