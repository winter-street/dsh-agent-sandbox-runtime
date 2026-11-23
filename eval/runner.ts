import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { buildReport, createRunPlan, loadSuite, RunResultSchema, type LoadedSuite, type RunResult } from './report.js';

const variantSchema = z.strictObject({ configSha256: z.string().regex(/^[a-f0-9]{64}$/), budgetLimitTokens: z.int().nonnegative() });
export const DriverManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: z.enum(['real', 'simulation']),
  execution: RunResultSchema.shape.execution.omit({ configSha256: true }),
  variants: z.strictObject({ 'hard-only': variantSchema, tiered: variantSchema, 'tiered-finalize': variantSchema }),
});
export type DriverManifest = z.infer<typeof DriverManifestSchema>;
export interface EvaluationRequest {
  readonly runId: string; readonly suiteSha256: string; readonly taskId: string;
  readonly variant: RunResult['variant']; readonly repetition: number;
  readonly prompt: string; readonly input: { readonly path: 'input.csv'; readonly content: Uint8Array; readonly sha256: string };
}
/** Trusted host hooks. execute must not receive answers; validate reads independently committed evidence. */
export interface EvaluationDriver {
  readonly manifest: DriverManifest;
  /** Optional coordinator lease spans execution and validation, including uncertain results. */
  acquireSlot?(request: EvaluationRequest): Promise<() => void>;
  execute(request: EvaluationRequest, signal?: AbortSignal): Promise<unknown>;
  /** Host-only infrastructure probe. It must run before the first evaluation slot. */
  preflight?(signal?: AbortSignal): Promise<unknown>;
  /** Host-only lookup of a previous run. It must never dispatch a model request or retry a tool. */
  reconcile?(request: EvaluationRequest, signal?: AbortSignal): Promise<unknown>;
  validate(request: EvaluationRequest, execution: unknown): Promise<RunResult>;
}
export class PendingEvaluationError extends Error {
  constructor(readonly slots: readonly string[]) {
    super(`Evaluation has ${slots.length} dispatched slot(s) without a committed result; reconcile before resuming`);
    this.name = 'PendingEvaluationError';
  }
}
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const slotKey = (value: { taskId: string; variant: string; repetition: number }) => JSON.stringify([value.taskId, value.variant, value.repetition]);
export function slotWorker(slot: { taskId: string; variant: string; repetition: number }, count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new TypeError('Worker count must be 1..64');
  let value = 0; for (const byte of Buffer.from(slotKey(slot))) value = (value * 31 + byte) % count; return value;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}
function sameIdentity(request: Pick<EvaluationRequest, 'runId' | 'suiteSha256' | 'taskId' | 'variant' | 'repetition'>, result: RunResult, manifest: DriverManifest): void {
  if (result.runId !== request.runId || result.suiteSha256 !== request.suiteSha256 || slotKey(result) !== slotKey(request)
    || result.mode !== manifest.mode || result.budgetLimitTokens !== manifest.variants[request.variant].budgetLimitTokens
    || JSON.stringify(result.execution) !== JSON.stringify({ ...manifest.execution, configSha256: manifest.variants[request.variant].configSha256 })) {
    throw new Error('Driver returned a result for a different execution identity, slot, budget or configuration');
  }
}

/** Durable sequential execution. A persisted intent is never retried merely because the process restarted. */
export async function runEvaluation(options: {
  suite: LoadedSuite; driver: EvaluationDriver; directory: string;
  split: 'calibration' | 'evaluation'; repetitions: number; maxRuns?: number; signal?: AbortSignal; reconcilePending?: boolean;
  workerIndex?: number; workerCount?: number;
  stopOnUncertain?: boolean;
}) {
  const maxRuns = options.maxRuns ?? 1;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) throw new TypeError('maxRuns must be 1..1000');
  // Validate files again immediately before dispatch, rather than trusting an earlier loaded object.
  const loaded = loadSuite(options.suite.path);
  if (loaded.sha256 !== options.suite.sha256) throw new Error('Suite changed since planning');
  const manifest = DriverManifestSchema.parse(options.driver.manifest);
  const plan = createRunPlan(loaded, options.split, options.repetitions);
  const workerCount = options.workerCount ?? 1; const workerIndex = options.workerIndex ?? 0;
  slotWorker(plan.runs[0]!, workerCount);
  if (!Number.isSafeInteger(workerIndex) || workerIndex < 0 || workerIndex >= workerCount) throw new TypeError('workerIndex must identify an assigned worker');
  const workerPlan = plan.runs.filter(slot => slotWorker(slot, workerCount) === workerIndex);
  if (!workerPlan.length) throw new Error(`Worker ${workerIndex}/${workerCount} has no assigned slots`);
  // Do not persist a slot until the real host has passed its sandbox probe.
  if (!options.reconcilePending) await options.driver.preflight?.(options.signal);
  const assertUnchanged = () => {
    if (loadSuite(loaded.path).sha256 !== loaded.sha256) throw new Error('Suite changed during evaluation');
  };
  const identity = JSON.stringify({ version: 1, suiteSha256: loaded.sha256, split: options.split, repetitions: options.repetitions, manifest,
    ...(workerCount > 1 ? { workerIndex, workerCount } : {}) });
  const directory = resolve(options.directory); mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'execution.sqlite'));
  const owner = randomUUID(); let claimed = false;
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const intentSchema = z.strictObject({ runId: z.string().min(1), suiteSha256: z.string(), taskId: z.string(), variant: z.enum(['hard-only', 'tiered', 'tiered-finalize']),
    repetition: z.int().positive(), inputSha256: z.string(), promptSha256: z.string() });
  const storedSlots = () => (db.prepare('SELECT slot,request,result FROM slots ORDER BY slot').all() as { slot: string; request: string; result: string | null }[])
    .map(row => {
      const intent = intentSchema.parse(JSON.parse(row.request)); const slot = workerPlan.find(slot => slotKey(slot) === row.slot);
      if (!slot || slotKey(intent) !== row.slot || intent.suiteSha256 !== loaded.sha256 || intent.inputSha256 !== slot.inputSha256
        || intent.promptSha256 !== loaded.suite.taskPromptSha256) throw new Error('Persisted evaluation intent does not match the plan');
      const result = row.result === null ? null : RunResultSchema.parse(JSON.parse(row.result));
      if (result) sameIdentity(intent, result, manifest);
      return { ...row, intent, result };
    });
  const exportRecords = (records: RunResult[]) => {
    const temporary = join(directory, `records.${owner}.tmp`);
    writeFileSync(temporary, records.map(record => JSON.stringify(record) + '\n').join(''), { flag: 'wx' });
    renameSync(temporary, join(directory, 'records.jsonl'));
  };
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS slots (slot TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT);');
    transaction(() => {
      const previous = db.prepare('SELECT value FROM metadata WHERE key=?').get('identity') as { value: string } | undefined;
      if (previous && previous.value !== identity) throw new Error('Evaluation directory belongs to a different suite, plan or driver manifest');
      const lock = db.prepare('SELECT value FROM metadata WHERE key=?').get('owner') as { value: string } | undefined;
      if (lock) {
        const prior = z.strictObject({ pid: z.int().positive(), token: z.string().uuid() }).parse(JSON.parse(lock.value));
        if (alive(prior.pid)) throw new Error('Evaluation already has an active runner');
      }
      db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('identity', identity);
      db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('owner', JSON.stringify({ pid: process.pid, token: owner }));
    }); claimed = true;
    const stored = storedSlots(); let records = stored.flatMap(row => row.result ? [row.result] : []);
    buildReport(loaded, records, { split: options.split, repetitions: options.repetitions, mode: manifest.mode });
    const pending = stored.filter(row => row.result === null);
    if (pending.length && (!options.reconcilePending || !options.driver.reconcile)) throw new PendingEvaluationError(pending.map(row => row.slot));
    exportRecords(records);
    let executed = 0; let reconciled = 0;
    let stopped: { reason: 'sandbox-failure' | 'unresolved-run'; runId: string; slot: string } | undefined;
    for (const slot of workerPlan) {
      options.signal?.throwIfAborted();
      if (records.some(record => slotKey(record) === slotKey(slot))) continue;
      if (executed + reconciled >= maxRuns) break;
      const prior = pending.find(row => row.slot === slotKey(slot));
      // A reconciliation invocation only inspects existing work and never starts new tasks.
      if (options.reconcilePending && !prior) continue;
      assertUnchanged();
      const content = readFileSync(resolve(dirname(loaded.path), slot.input));
      const prompt = readFileSync(resolve(dirname(loaded.path), loaded.suite.taskPrompt), 'utf8');
      if (digest(content) !== slot.inputSha256 || digest(prompt) !== loaded.suite.taskPromptSha256) throw new Error('Fixture or task prompt changed before dispatch');
      const request: EvaluationRequest = Object.freeze({ runId: prior?.intent.runId ?? `eval-${randomUUID()}`, suiteSha256: loaded.sha256, taskId: slot.taskId,
        variant: slot.variant, repetition: slot.repetition, prompt, input: Object.freeze({ path: 'input.csv' as const, content, sha256: slot.inputSha256 }) });
      // Only identity and hashes are persisted here; secrets and model request contents are not needed.
      const intent = JSON.stringify({ runId: request.runId, suiteSha256: loaded.sha256, taskId: request.taskId, variant: request.variant,
        repetition: request.repetition, inputSha256: slot.inputSha256, promptSha256: loaded.suite.taskPromptSha256 });
      let result: RunResult;
      let release: (() => void) | undefined;
      try {
        release = await options.driver.acquireSlot?.(request);
        if (!prior) transaction(() => db.prepare('INSERT INTO slots(slot,request,result) VALUES (?,?,NULL)').run(slotKey(slot), intent));
        const output = prior ? await options.driver.reconcile!(request, options.signal) : await options.driver.execute(request, options.signal);
        assertUnchanged();
        // The validator gets a fresh input copy; mutation by an executor cannot alter its baseline.
        const validationRequest = { ...request, input: { ...request.input, content: readFileSync(resolve(dirname(loaded.path), slot.input)) } };
        if (digest(validationRequest.input.content) !== slot.inputSha256) throw new Error('Input changed during execution');
        result = RunResultSchema.parse(await options.driver.validate(validationRequest, output));
        assertUnchanged();
        sameIdentity(request, result, manifest);
        buildReport(loaded, [...records, result], { split: options.split, repetitions: options.repetitions, mode: manifest.mode });
      } catch (error) { throw new Error('Driver execution or evidence validation failed; dispatched slot remains pending reconciliation', { cause: error }); }
      finally { release?.(); }
      transaction(() => {
        const committed = db.prepare('UPDATE slots SET result=? WHERE slot=? AND request=? AND result IS NULL').run(JSON.stringify(result), slotKey(slot), prior?.request ?? intent);
        if (committed.changes !== 1) throw new Error('Evaluation result commit conflicted');
      });
      records = [...records, result]; if (prior) reconciled += 1; else executed += 1; exportRecords(records);
      if (result.failureKind === 'sandbox') {
        stopped = { reason: 'sandbox-failure', runId: request.runId, slot: slotKey(slot) };
        break;
      }
      if (options.stopOnUncertain && (result.outcome === 'paused' || result.calls.some(call => call.usage === null))) {
        stopped = { reason: 'unresolved-run', runId: request.runId, slot: slotKey(slot) }; break;
      }
    }
    return { executed, reconciled, records, workerIndex, workerCount, assignedRuns: workerPlan.length, ...(stopped ? { stopped } : {}), report: buildReport(loaded, records, { split: options.split, repetitions: options.repetitions, mode: manifest.mode }) };
  } finally {
    try { if (claimed) transaction(() => {
      const lock = db.prepare('SELECT value FROM metadata WHERE key=?').get('owner') as { value: string } | undefined;
      if (lock && (JSON.parse(lock.value) as { token: string }).token === owner) db.prepare('DELETE FROM metadata WHERE key=?').run('owner');
    }); } finally { db.close(); }
  }
}
