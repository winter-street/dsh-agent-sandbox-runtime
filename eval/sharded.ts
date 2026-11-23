import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/storage/index.js';
import { buildReport, createRunPlan, parseResults, renderReport, type LoadedSuite } from './report.js';
import { runEvaluation, slotWorker, type EvaluationDriver } from './runner.js';

type SharedOptions = { suite: LoadedSuite; directory: string; split: 'calibration' | 'evaluation'; repetitions: number };
const writeNew = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

/** Whole-run leases are conservative: a worker permits at most one provider and one sandbox at a time. */
export async function runShardedEvaluation(options: SharedOptions & {
  drivers: [EvaluationDriver, EvaluationDriver]; maxRunsPerWorker?: number;
  providerConcurrency?: number; sandboxConcurrency?: number; signal?: AbortSignal; reconcilePending?: boolean;
}) {
  const providerConcurrency = options.providerConcurrency ?? 2; const sandboxConcurrency = options.sandboxConcurrency ?? 2;
  for (const limit of [providerConcurrency, sandboxConcurrency]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2) throw new TypeError('Global concurrency must be 1 or 2');
  const maxRuns = options.maxRunsPerWorker ?? 1;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) throw new TypeError('maxRunsPerWorker must be 1..1000');
  const root = resolve(options.directory); mkdirSync(root, { recursive: true });
  const lock = new RuntimeStore(join(root, 'coordinator'));
  try {
    const manifest = options.drivers[0].manifest;
    if (JSON.stringify(manifest) !== JSON.stringify(options.drivers[1].manifest)) throw new Error('Shard driver identities differ');
    const experiment = { schemaVersion: 1, suiteSha256: options.suite.sha256, split: options.split, repetitions: options.repetitions,
      workers: 2, providerConcurrency, sandboxConcurrency, manifest };
    const identityPath = join(root, 'shards.json');
    if (existsSync(identityPath)) {
      if (JSON.stringify(JSON.parse(readFileSync(identityPath, 'utf8'))) !== JSON.stringify(experiment)) throw new Error('Sharded experiment identity changed');
    } else writeNew(identityPath, experiment);
    // Inspect both worker databases before any dispatch. Unknown intent is never redispatched.
    for (let index = 0; index < 2; index++) {
      const databasePath = join(root, `worker-${index}`, 'execution.sqlite');
      if (!existsSync(databasePath)) continue;
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const rows = db.prepare('SELECT result FROM slots').all() as { result: string | null }[];
        if (!options.reconcilePending && rows.some(row => row.result === null)) throw new Error('A worker has pending intent; explicitly reconcile both shards before new dispatch');
        if (!options.reconcilePending && rows.some(row => row.result !== null && (() => {
          const result = parseResults(row.result)[0]!; return result.outcome === 'paused' || result.calls.some(call => call.usage === null);
        })())) throw new Error('A worker has unresolved run/accounting evidence; investigate original run without resetting credit');
      } finally { db.close(); }
    }
    let active = 0; let peak = 0; let stopped = false;
    const queue: Array<() => void> = []; const capacity = Math.min(providerConcurrency, sandboxConcurrency);
    async function acquire(): Promise<() => void> {
      // Waiters reserve a released position before waking, so active cannot overshoot.
      if (active >= capacity) await new Promise<void>(done => queue.push(done)); else active++;
      peak = Math.max(peak, active);
      let released = false;
      const release = () => { if (released) return; released = true; const next = queue.shift(); if (next) next(); else active--; };
      try {
        options.signal?.throwIfAborted();
        if (stopped) throw new Error('A shard stopped; preserve both workers before resuming');
        return release;
      } catch (error) { release(); throw error; }
    }
    async function leased<T>(callback: () => Promise<T>): Promise<T> {
      const release = await acquire();
      try { return await callback(); } catch (error) { stopped = true; throw error; } finally { release(); }
    }
    const workers = await Promise.allSettled(options.drivers.map((driver, index) => {
      const bounded: EvaluationDriver = {
        manifest: driver.manifest,
        acquireSlot: () => acquire(),
        ...(driver.preflight ? { preflight: (signal?: AbortSignal) => leased(() => driver.preflight!(signal)) } : {}),
        execute: async (request, signal) => { try { return await driver.execute(request, signal); } catch (error) { stopped = true; throw error; } },
        ...(driver.reconcile ? { reconcile: async (request: Parameters<EvaluationDriver['execute']>[0], signal?: AbortSignal) => {
          try { return await driver.reconcile!(request, signal); } catch (error) { stopped = true; throw error; }
        } } : {}),
        validate: async (request, execution) => {
          try {
            const result = await driver.validate(request, execution);
            if (result.failureKind === 'sandbox' || result.outcome === 'paused' || result.calls.some(call => call.usage === null)) stopped = true;
            return result;
          } catch (error) { stopped = true; throw error; }
        },
      };
      return runEvaluation({ suite: options.suite, driver: bounded, directory: join(root, `worker-${index}`), split: options.split,
        repetitions: options.repetitions, workerIndex: index, workerCount: 2, maxRuns, stopOnUncertain: true,
        ...(options.signal ? { signal: options.signal } : {}), ...(options.reconcilePending ? { reconcilePending: true } : {}) })
        .catch(error => { stopped = true; throw error; });
    }));
    const status = { peakActiveRuns: peak, providerConcurrency, sandboxConcurrency, stopped,
      workers: workers.map((worker, index) => worker.status === 'fulfilled' ? { index, status: 'fulfilled', executed: worker.value.executed,
        reconciled: worker.value.reconciled, recorded: worker.value.records.length, assigned: worker.value.assignedRuns, stopped: worker.value.stopped ?? null }
        : { index, status: 'rejected', error: worker.reason instanceof Error ? worker.reason.message : 'Worker failed' }) };
    const temporary = join(root, 'progress.tmp'); writeFileSync(temporary, JSON.stringify(status, null, 2) + '\n'); renameSync(temporary, join(root, 'progress.json'));
    if (workers.some(worker => worker.status === 'rejected') || stopped) throw new Error('Sharded run stopped; inspect progress.json and reconcile original worker evidence');
    return status;
  } finally { lock.close(); }
}

/** Merge requires exact coverage; it never creates missing results or deduplicates mistakes away. */
export function mergeShardedEvaluation(options: SharedOptions & { output: string; mode: 'real' | 'simulation' }) {
  const root = resolve(options.directory); const experiment = JSON.parse(readFileSync(join(root, 'shards.json'), 'utf8'));
  if (experiment.workers !== 2 || experiment.suiteSha256 !== options.suite.sha256 || experiment.split !== options.split
    || experiment.repetitions !== options.repetitions || experiment.manifest.mode !== options.mode) throw new Error('Shard manifest does not match merge request');
  const records = [0, 1].flatMap(index => {
    const path = join(root, `worker-${index}`, 'records.jsonl');
    const rows = parseResults(readFileSync(path, 'utf8'));
    if (rows.some(row => slotWorker(row, 2) !== index)) throw new Error('Record belongs to another worker');
    const db = new DatabaseSync(join(root, `worker-${index}`, 'execution.sqlite'), { readOnly: true });
    try {
      const stored = db.prepare('SELECT request,result FROM slots').all() as { request: string; result: string | null }[];
      if (stored.some(row => row.result === null)) throw new Error('Pending shard intent prevents merge');
      const committed = stored.map(row => parseResults(row.result!)[0]!);
      if (committed.length !== rows.length || committed.some(record => !rows.some(row => JSON.stringify(row) === JSON.stringify(record)))) throw new Error('Shard export differs from committed results');
    } finally { db.close(); }
    for (const record of rows) {
      const { configSha256, ...identity } = record.execution;
      if (JSON.stringify(identity) !== JSON.stringify(experiment.manifest.execution)
        || configSha256 !== experiment.manifest.variants[record.variant].configSha256
        || record.budgetLimitTokens !== experiment.manifest.variants[record.variant].budgetLimitTokens) throw new Error('Shard result differs from pinned driver manifest');
    }
    return rows;
  });
  const report = buildReport(options.suite, records, options);
  if (report.recordedRuns !== report.expectedRuns) throw new Error(`Incomplete shard coverage ${report.recordedRuns}/${report.expectedRuns}`);
  const order = createRunPlan(options.suite, options.split, options.repetitions).runs;
  const key = (r: { taskId: string; variant: string; repetition: number }) => JSON.stringify([r.taskId, r.variant, r.repetition]);
  records.sort((a, b) => order.findIndex(r => key(r) === key(a)) - order.findIndex(r => key(r) === key(b)));
  const output = resolve(options.output); if (existsSync(output)) throw new Error('Merge output already exists; preserve original evidence');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'records.jsonl'), records.map(row => JSON.stringify(row) + '\n').join(''), { flag: 'wx' });
  writeNew(join(output, 'report.json'), report); writeFileSync(join(output, 'report.md'), renderReport(report), { flag: 'wx' });
  return report;
}
