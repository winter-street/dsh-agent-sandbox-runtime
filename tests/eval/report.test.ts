import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReport, createRunPlan, loadSuite, parseResults, renderReport, VARIANTS, type LoadedSuite, type RunResult } from '../../eval/report.js';

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
const hash = 'a'.repeat(64);
export function record(loaded: LoadedSuite, overrides: Partial<RunResult> = {}): RunResult {
  return { schemaVersion: 1, suiteSha256: loaded.sha256, taskId: 'c01', variant: 'hard-only', repetition: 1, mode: 'real', runId: 'run-1',
    execution: { provider: 'test', model: 'test', modelVersion: 'fixed', harnessVersion: 'fixed', sandboxVersion: 'fixed', codeRevision: 'fixed', configSha256: hash },
    outcome: 'complete', candidateStatistics: loaded.suite.tasks.find(task => task.id === 'c01')!.expectedStatistics,
    checks: { report: true, chart: true }, calls: [{ callId: 'call-1', category: 'work', usage: { inputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 5 } }],
    budgetLimitTokens: 10, durationMs: 100, interruptions: 0, denials: 0, reviewedDenials: 0, falseDenials: 0, failureKind: null,
    evidence: { trace: 'local/trace', ledger: 'local/ledger', validation: 'local/validation', artifacts: ['local/statistics.json'] }, ...overrides };
}
const opts = { split: 'calibration' as const, repetitions: 1, mode: 'real' as const };
describe('evaluation evidence and denominators', () => {
  it('verifies 25 candidate inputs, prompt and the pinned reference and retains calibration/evaluation separation', () => {
    const loaded = loadSuite(); expect(loaded.suite.tasks).toHaveLength(25);
    expect(createRunPlan(loaded, 'calibration', 3).runs).toHaveLength(45);
    expect(createRunPlan(loaded, 'evaluation', 3).runs).toHaveLength(180);
    expect(loaded.suite.phase).toBe('frozen-for-final-evaluation');
    expect(loaded.suite.frozenForFinalEvaluation).toBe(true);
  });
  it('rejects a modified reference even when fixture/prompt hashes are unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eval-reference-')); disposals.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'reference.py'); writeFileSync(path, 'modified');
    expect(() => loadSuite(resolve('eval/suite.json'), path)).toThrow('Reference implementation hash mismatch');
  });
  it('rejects a task identity/split mismatch before interpreting answers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eval-identity-')); disposals.push(() => rmSync(directory, { recursive: true, force: true }));
    const suite = JSON.parse(readFileSync('eval/suite.json', 'utf8')) as LoadedSuite['suite']; suite.tasks[0]!.split = 'evaluation';
    mkdirSync(join(directory, 'eval')); const path = join(directory, 'eval/suite.json'); writeFileSync(path, JSON.stringify(suite));
    expect(() => loadSuite(path, resolve('examples/charging-analysis/reference.py'))).toThrow('identity/split mismatch');
  });
  it('does not count missing runs or unknown usage as zero', () => {
    const loaded = loadSuite(); const report = buildReport(loaded, [record(loaded, { calls: [
      { callId: 'known', category: 'work', usage: { inputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 1 } },
      { callId: 'unknown', category: 'summary', usage: null },
    ], candidateStatistics: null, checks: { report: null, chart: null }, durationMs: null })], opts);
    expect(report.reports[0]).toMatchObject({ recorded: 1, missing: 4, unknownCorrectness: 1, completion: { numerator: 0, denominator: 1 },
      tokenUsage: { knownTotalLowerBound: 4, completeRuns: 0, unknownCalls: 1, meanAmongCompleteRuns: null }, elapsed: { knownRuns: 0, missingRuns: 1, meanMs: null } });
    expect(report.finalEvaluationEligible).toBe(false);
  });
  it('deduplicates identical call rows, includes auxiliary usage and identifies false completion claims', () => {
    const loaded = loadSuite(); const base = record(loaded); const call = base.calls[0]!;
    const report = buildReport(loaded, [record(loaded, { candidateStatistics: { wrong: true }, calls: [call, call,
      { callId: 'summary', category: 'summary', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }] })], opts);
    expect(report.reports[0]).toMatchObject({ falseCompletionClaims: 1, failures: { validation: 1 }, tokenUsage: {
      knownTotalLowerBound: 18, auxiliaryTokensLowerBound: 3, unknownCalls: 0, knownOverage: 8 } });
  });
  it('rejects cross-run usage reuse, conflicting calls and repeated experiment slots', () => {
    const loaded = loadSuite(); const base = record(loaded);
    expect(() => buildReport(loaded, [base, { ...base, runId: 'run-2', taskId: 'c02' }], opts)).toThrow('multiple evaluation runs');
    expect(() => buildReport(loaded, [{ ...base, calls: [...base.calls, { ...base.calls[0]!, usage: null }] }], opts)).toThrow('Conflicting usage');
    expect(() => buildReport(loaded, [base, { ...base, runId: 'run-2' }], opts)).toThrow('Duplicate run');
  });
  it('rejects comparison changes and mixed real/simulation records', () => {
    const loaded = loadSuite(); const base = record(loaded); const next = { ...base, runId: 'run-2', taskId: 'c02', calls: [{ ...base.calls[0]!, callId: 'call-2' }] };
    expect(() => buildReport(loaded, [base, { ...next, mode: 'simulation' }], opts)).toThrow('separately');
    expect(() => buildReport(loaded, [base, { ...next, execution: { ...next.execution, model: 'other' } }], opts)).toThrow('versions differ');
    expect(() => buildReport(loaded, [base, { ...next, execution: { ...next.execution, configSha256: 'b'.repeat(64) } }], opts)).toThrow('Configuration changed');
    expect(() => buildReport(loaded, [base, { ...next, budgetLimitTokens: 20 }], opts)).toThrow('Budget limit changed');
  });
  it('retains a proven overage lower bound even when additional usage is unknown', () => {
    const loaded = loadSuite(); const base = record(loaded);
    const report = buildReport(loaded, [{ ...base, calls: [...base.calls, { callId: 'unknown', category: 'retry', usage: null }] }], opts);
    expect(report.reports[0]!.tokenUsage).toMatchObject({ knownTotalLowerBound: 15, completeRuns: 0, unknownCalls: 1, knownOverage: 5 });
  });
  it('requires evaluated/frozen complete real records, with every required check actually known', () => {
    const loaded = loadSuite(); loaded.suite.frozenForFinalEvaluation = true;
    for (const split of ['calibration', 'evaluation'] as const) {
      const records = VARIANTS.flatMap(variant => loaded.suite.tasks.filter(task => task.split === split).map(task => record(loaded, {
        variant, taskId: task.id, runId: `${variant}-${task.id}`, candidateStatistics: task.expectedStatistics,
        calls: [{ callId: `${variant}-${task.id}`, category: 'work', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
      })));
      expect(buildReport(loaded, records, { ...opts, split }).finalEvaluationEligible).toBe(split === 'evaluation');
      if (split === 'evaluation') {
        records[0]!.checks.chart = null;
        expect(buildReport(loaded, records, { ...opts, split }).finalEvaluationEligible).toBe(false);
        records[0]!.checks.chart = true;
        records[0]!.outcome = 'paused';
        records[0]!.failureKind = 'budget';
        expect(buildReport(loaded, records, { ...opts, split }).finalEvaluationEligible).toBe(false);
      }
    }
  });
  it('rejects invalid reviewer counts, unsafe aggregates and absent task splits', () => {
    const loaded = loadSuite(); const base = record(loaded);
    expect(() => parseResults(JSON.stringify({ ...base, falseDenials: 1 }))).toThrow('falseDenials');
    const huge = { ...base, denials: Number.MAX_SAFE_INTEGER, reviewedDenials: 0 };
    expect(() => buildReport(loaded, [huge, { ...huge, taskId: 'c02', runId: 'run-2', calls: [] }], opts)).toThrow('safe integer');
    const onlyCalibration = { ...loaded, suite: { ...loaded.suite, tasks: loaded.suite.tasks.filter(task => task.split === 'calibration') } };
    expect(() => createRunPlan(onlyCalibration, 'evaluation')).toThrow('no tasks');
  });
  it('separates complete evaluation data from task success without changing the strict gate or discarding failures', () => {
    const loaded = loadSuite();
    const records = createRunPlan(loaded, 'evaluation', 1).runs.map(slot => record(loaded, {
      taskId: slot.taskId, variant: slot.variant, repetition: slot.repetition, runId: `${slot.variant}-${slot.taskId}`, candidateStatistics: loaded.suite.tasks.find(task => task.id === slot.taskId)!.expectedStatistics,
      calls: [{ callId: `${slot.variant}-${slot.taskId}`, category: 'work', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    }));
    records[0]!.outcome = 'partial'; records[0]!.failureKind = 'other';
    records[1]!.candidateStatistics = { incorrect: true };
    records[2]!.checks.report = false;
    const report = buildReport(loaded, records, { ...opts, split: 'evaluation' });
    expect(report).toMatchObject({ recordedRuns: 60, evaluationDataComplete: true, finalEvaluationEligible: false,
      acceptance: { passedRuns: 57, notAcceptedRuns: 3, allRunsAccepted: false },
      eligibilityBlockers: [{ code: 'RUN_NOT_ACCEPTED', count: 3, runIds: records.slice(0, 3).map(row => row.runId) }] });
    expect(report.reports[0]).toMatchObject({ completion: { numerator: 17, denominator: 20 }, falseCompletionClaims: 2 });
    expect(report.unacceptedRuns).toHaveLength(3);
    expect(renderReport(report)).toContain('false 不等于批次未跑完');
    expect(renderReport(report)).toContain(records[0]!.runId);
  });
  it('identifies unknown fields separately from failure and missing coverage', () => {
    const loaded = loadSuite(); const base = record(loaded, { taskId: 'e01', runId: 'incomplete-evidence', calls: [],
      durationMs: null, candidateStatistics: null, checks: { report: null, chart: null }, outcome: 'partial' });
    const report = buildReport(loaded, [base], { ...opts, split: 'evaluation' });
    expect(report.evaluationDataComplete).toBe(false);
    expect(report.eligibilityBlockers.map(item => item.code)).toEqual(['MISSING_RUNS', 'UNKNOWN_USAGE', 'MISSING_DURATION', 'UNKNOWN_REQUIRED_CHECKS', 'RUN_NOT_ACCEPTED']);
    expect(report.eligibilityBlockers[0]!.count).toBe(59);
  });
  it('never labels calibration, simulation or an unfrozen suite as complete final evaluation data', () => {
    const loaded = loadSuite();
    const records = createRunPlan(loaded, 'evaluation', 1).runs.map(slot => record(loaded, {
      taskId: slot.taskId, variant: slot.variant, repetition: slot.repetition, runId: `${slot.variant}-${slot.taskId}`, candidateStatistics: loaded.suite.tasks.find(task => task.id === slot.taskId)!.expectedStatistics,
      calls: [{ callId: `${slot.variant}-${slot.taskId}`, category: 'work', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    }));
    expect(buildReport(loaded, records, { ...opts, split: 'evaluation' }).evaluationDataComplete).toBe(true);
    expect(buildReport(loaded, [], opts).eligibilityBlockers).toContainEqual({ code: 'NOT_EVALUATION_SPLIT', count: 1, runIds: [] });
    expect(buildReport(loaded, records.map(row => ({ ...row, mode: 'simulation' })), { ...opts, split: 'evaluation', mode: 'simulation' }).evaluationDataComplete).toBe(false);
    loaded.suite.frozenForFinalEvaluation = false;
    expect(buildReport(loaded, records, { ...opts, split: 'evaluation' }).eligibilityBlockers).toEqual([{ code: 'SUITE_NOT_FROZEN', count: 1, runIds: [] }]);
  });
});
