import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { loadSuite } from '../../eval/report.js';
import { PendingEvaluationError, runEvaluation, type EvaluationDriver, type EvaluationRequest } from '../../eval/runner.js';

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'eval-runner-')); disposals.push(() => rmSync(directory, { recursive: true, force: true }));
  const suite = loadSuite(); const calls: EvaluationRequest[] = []; const validated: EvaluationRequest[] = [];
  const variant = { configSha256: 'a'.repeat(64), budgetLimitTokens: 1000 };
  const driver: EvaluationDriver = {
    manifest: { schemaVersion: 1, mode: 'simulation', execution: { provider: 'controlled-test', model: 'controlled-test', modelVersion: '1',
      harnessVersion: 'none-test', sandboxVersion: 'none-test', codeRevision: 'test' }, variants: { 'hard-only': variant, tiered: variant, 'tiered-finalize': variant } },
    async execute(request) { calls.push(request); return { runId: request.runId }; },
    async validate(request) {
      validated.push(request); const task = suite.suite.tasks.find(task => task.id === request.taskId)!;
      return { schemaVersion: 1, suiteSha256: suite.sha256, taskId: request.taskId, variant: request.variant, repetition: request.repetition,
        runId: request.runId, mode: 'simulation', execution: { ...driver.manifest.execution, configSha256: variant.configSha256 },
        outcome: 'complete', candidateStatistics: task.expectedStatistics, checks: { report: true, chart: true },
        calls: [{ callId: `${request.runId}-synthetic`, category: 'work', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
        budgetLimitTokens: 1000, durationMs: 1, interruptions: 0, denials: 0, reviewedDenials: 0, falseDenials: 0, failureKind: null,
        evidence: { trace: 'simulation/trace', ledger: 'simulation/ledger', validation: 'simulation/validator', artifacts: ['simulation/statistics'] } };
    },
  };
  return { directory, suite, driver, calls, validated, options: { directory, suite, driver, split: 'calibration' as const, repetitions: 1 } };
}
describe('durable evaluation runner (controlled hooks; no provider or sandbox)', () => {
  it('executes one slot by default and on reopen advances without repeating a committed slot', async () => {
    const { options, calls, directory } = setup();
    const first = await runEvaluation(options); expect(first.executed).toBe(1); expect(first.report.finalEvaluationEligible).toBe(false);
    const second = await runEvaluation(options); expect(second.executed).toBe(1); expect(second.records).toHaveLength(2);
    expect(calls.map(call => call.taskId)).toEqual(['c01', 'c02']);
    const db = new DatabaseSync(join(directory, 'execution.sqlite')); try {
      expect(db.prepare('SELECT count(*) AS n FROM slots WHERE result IS NOT NULL').get()).toMatchObject({ n: 2 });
      expect(db.prepare("SELECT value FROM metadata WHERE key='owner'").get()).toBeUndefined();
    } finally { db.close(); }
  });
  it('passes only the task prompt and input to execution, and gives validation fresh input bytes', async () => {
    const { options, driver, validated } = setup();
    const execute = driver.execute;
    driver.execute = async (request, signal) => {
      expect(Object.keys(request).sort()).toEqual(['input', 'prompt', 'repetition', 'runId', 'suiteSha256', 'taskId', 'variant']);
      expect(request.input.path).toBe('input.csv'); expect(JSON.stringify(request)).not.toContain('expectedStatistics');
      const output = await execute(request, signal); request.input.content.fill(0); return output;
    };
    await runEvaluation(options); expect(Buffer.from(validated[0]!.input.content).toString('utf8')).toContain('alert_id');
  });
  it('keeps failed dispatch intent durable and refuses automatic rerun on restart', async () => {
    const { options, driver, calls } = setup(); const execute = driver.execute;
    driver.execute = async (request, signal) => { await execute(request, signal); throw new Error('response lost'); };
    await expect(runEvaluation(options)).rejects.toThrow('remains pending reconciliation');
    await expect(runEvaluation(options)).rejects.toBeInstanceOf(PendingEvaluationError);
    expect(calls).toHaveLength(1);
  });
  it('keeps validation failures pending rather than repeating a potentially charged call', async () => {
    const { options, driver, calls } = setup(); const validate = driver.validate;
    driver.validate = async (request, execution) => ({ ...await validate(request, execution), runId: 'different' });
    await expect(runEvaluation(options)).rejects.toThrow('evidence validation failed');
    await expect(runEvaluation(options)).rejects.toBeInstanceOf(PendingEvaluationError); expect(calls).toHaveLength(1);
  });
  it('reconciles an existing run by explicit lookup and validation without dispatching any new task', async () => {
    const { options, driver, calls } = setup(); const execute = driver.execute;
    driver.execute = async (request, signal) => { await execute(request, signal); throw new Error('response lost'); };
    await expect(runEvaluation(options)).rejects.toThrow('remains pending');
    const reconciledIds: string[] = [];
    driver.reconcile = async request => { reconciledIds.push(request.runId); return { runId: request.runId }; };
    const recovered = await runEvaluation({ ...options, reconcilePending: true, maxRuns: 3 });
    expect(recovered.executed).toBe(0); expect(recovered.reconciled).toBe(1); expect(recovered.records).toHaveLength(1);
    expect(reconciledIds).toEqual([calls[0]!.runId]); expect(calls).toHaveLength(1);
    driver.execute = execute; await runEvaluation(options); expect(calls.map(call => call.taskId)).toEqual(['c01', 'c02']);
  });
  it('blocks commit when the pinned reference changes during execution, before calling validation', async () => {
    const { options, driver, calls, validated, directory } = setup();
    const copy = join(directory, 'suite-copy'); mkdirSync(join(copy, 'examples/charging-analysis'), { recursive: true });
    cpSync('eval', join(copy, 'eval'), { recursive: true });
    const reference = join(copy, 'examples/charging-analysis/reference.py'); const original = readFileSync('examples/charging-analysis/reference.py');
    writeFileSync(reference, original); const suite = loadSuite(join(copy, 'eval/suite.json'));
    const execute = driver.execute; driver.execute = async (request, signal) => { const output = await execute(request, signal); writeFileSync(reference, 'changed'); return output; };
    await expect(runEvaluation({ ...options, suite, maxRuns: 2 })).rejects.toThrow('evidence validation failed');
    expect(calls).toHaveLength(1); expect(validated).toHaveLength(0);
    writeFileSync(reference, original);
    await expect(runEvaluation({ ...options, suite })).rejects.toBeInstanceOf(PendingEvaluationError); expect(calls).toHaveLength(1);
  });
  it('refuses a second active runner even across separate database connections', async () => {
    const { options, driver, calls } = setup(); const execute = driver.execute;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    driver.execute = async (request, signal) => { started(); await gate; return execute(request, signal); };
    const first = runEvaluation(options); await ready;
    try { await expect(runEvaluation(options)).rejects.toThrow('active runner'); }
    finally { release(); }
    await first; expect(calls).toHaveLength(1);
  });
  it('rejects changed driver/configuration or plan before invoking another task', async () => {
    const { options, driver, calls } = setup(); await runEvaluation(options);
    await expect(runEvaluation({ ...options, repetitions: 2 })).rejects.toThrow('different suite, plan or driver');
    driver.manifest.variants.tiered = { ...driver.manifest.variants.tiered, configSha256: 'b'.repeat(64) };
    await expect(runEvaluation(options)).rejects.toThrow('different suite, plan or driver'); expect(calls).toHaveLength(1);
  });
  it('honors cancellation before the next slot and preserves the just completed result', async () => {
    const { options, driver, calls } = setup(); const controller = new AbortController(); const validate = driver.validate;
    driver.validate = async (request, execution) => { const result = await validate(request, execution); controller.abort(); return result; };
    await expect(runEvaluation({ ...options, signal: controller.signal, maxRuns: 3 })).rejects.toThrow(); expect(calls).toHaveLength(1);
    driver.validate = validate; const resumed = await runEvaluation(options); expect(resumed.records).toHaveLength(2); expect(calls).toHaveLength(2);
  });
  it('validates bounded call count before any execution', async () => {
    const { options, calls } = setup();
    await expect(runEvaluation({ ...options, maxRuns: 0 })).rejects.toThrow('maxRuns'); expect(calls).toHaveLength(0);
  });
  it('stops the current batch after committing a sandbox infrastructure failure', async () => {
    const { options, driver, calls } = setup(); const validate = driver.validate;
    driver.validate = async (request, execution) => ({ ...await validate(request, execution), outcome: 'failed', failureKind: 'sandbox' });
    const result = await runEvaluation({ ...options, maxRuns: 3 });
    expect(result.executed).toBe(1); expect(result.records).toHaveLength(1);
    expect(result.stopped).toMatchObject({ reason: 'sandbox-failure', slot: JSON.stringify(['c01', 'hard-only', 1]) });
    expect(calls).toHaveLength(1);
  });
  it('recovers a dead process owner without releasing its unknown slot', async () => {
    const { options, directory, calls, suite } = setup(); await runEvaluation(options);
    const db = new DatabaseSync(join(directory, 'execution.sqlite')); try {
      db.prepare('INSERT INTO metadata VALUES (?,?)').run('owner', JSON.stringify({ pid: 2147483647, token: 'ab93d53f-d725-4e09-b718-c722b02920ee' }));
      db.prepare('INSERT INTO slots VALUES (?,?,NULL)').run('["c02","hard-only",1]', JSON.stringify({ runId: 'unresolved', suiteSha256: suite.sha256,
        taskId: 'c02', variant: 'hard-only', repetition: 1, inputSha256: suite.suite.tasks.find(task => task.id === 'c02')!.inputSha256, promptSha256: suite.suite.taskPromptSha256 }));
    } finally { db.close(); }
    await expect(runEvaluation(options)).rejects.toBeInstanceOf(PendingEvaluationError); expect(calls).toHaveLength(1);
  });
});
