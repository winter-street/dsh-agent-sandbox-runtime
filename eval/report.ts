import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const VARIANTS = ['hard-only', 'tiered', 'tiered-finalize'] as const;
const taskSchema = z.strictObject({
  id: z.string().regex(/^[ce][0-9]{2}$/), split: z.enum(['calibration', 'evaluation']), title: label,
  input: z.string().regex(/^fixtures\/[ce][0-9]{2}\.csv$/), inputSha256: hashSchema,
  expectedStatistics: z.record(z.string(), z.unknown()), requiredChecks: z.array(z.enum(['statistics', 'report', 'chart'])).min(1),
});
export const SuiteSchema = z.strictObject({
  schemaVersion: z.literal(1), suiteId: label, phase: label, frozenForFinalEvaluation: z.boolean(),
  expectedOrigin: label, referenceSha256: hashSchema, taskPrompt: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/), taskPromptSha256: hashSchema,
  tasks: z.array(taskSchema).min(1),
});
export type EvaluationSuite = z.infer<typeof SuiteSchema>;
const usageSchema = z.strictObject({ inputTokens: count, cacheReadTokens: count, cacheWriteTokens: count, outputTokens: count });
export const RunResultSchema = z.strictObject({
  schemaVersion: z.literal(1), suiteSha256: hashSchema, taskId: taskSchema.shape.id,
  variant: z.enum(VARIANTS), repetition: count.min(1), mode: z.enum(['real', 'simulation']), runId: label,
  execution: z.strictObject({ provider: label, model: label, modelVersion: label, harnessVersion: label, sandboxVersion: label, codeRevision: label, configSha256: hashSchema }),
  outcome: z.enum(['complete', 'partial', 'failed', 'paused', 'cancelled']),
  candidateStatistics: z.record(z.string(), z.unknown()).nullable(),
  checks: z.strictObject({ report: z.boolean().nullable(), chart: z.boolean().nullable() }),
  calls: z.array(z.strictObject({ callId: label, category: z.enum(['work', 'summary', 'review', 'retry', 'finalize']), usage: usageSchema.nullable() })),
  budgetLimitTokens: count,
  durationMs: count.nullable(), interruptions: count,
  denials: count, reviewedDenials: count, falseDenials: count,
  failureKind: z.enum(['provider', 'sandbox', 'accounting', 'validation', 'budget', 'permission', 'cancelled', 'other']).nullable(),
  failureEvidence: z.strictObject({ code: label, phase: label, retryable: z.boolean(), message: label, observedAt: count, causeRef: label.optional() }).optional(),
  evidence: z.strictObject({ trace: label, ledger: label, validation: label, artifacts: z.array(label) }),
}).superRefine((value, ctx) => {
  if (value.falseDenials > value.reviewedDenials || value.reviewedDenials > value.denials) ctx.addIssue({ code: 'custom', message: 'falseDenials <= reviewedDenials <= denials is required' });
  if (value.calls.some(call => call.usage && !Number.isSafeInteger(Object.values(call.usage).reduce((sum, n) => sum + n, 0)))) ctx.addIssue({ code: 'custom', message: 'Usage exceeds safe integer range' });
});
export type RunResult = z.infer<typeof RunResultSchema>;
export interface LoadedSuite { suite: EvaluationSuite; sha256: string; path: string }
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export function loadSuite(path = resolve('eval/suite.json'), referencePath = resolve(dirname(path), '../examples/charging-analysis/reference.py')): LoadedSuite {
  const bytes = readFileSync(path); const suite = SuiteSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (digest(readFileSync(referencePath)) !== suite.referenceSha256) throw new Error('Reference implementation hash mismatch');
  const ids = new Set<string>(); const inputs = new Map<string, string>();
  for (const task of suite.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate evaluation task ${task.id}`); ids.add(task.id);
    if (task.input !== `fixtures/${task.id}.csv` || !task.id.startsWith(task.split === 'calibration' ? 'c' : 'e')) throw new Error(`Task identity/split mismatch: ${task.id}`);
    if (digest(readFileSync(resolve(dirname(path), task.input))) !== task.inputSha256) throw new Error(`Fixture hash mismatch: ${task.id}`);
    const existingSplit = inputs.get(task.inputSha256);
    if (existingSplit && existingSplit !== task.split) throw new Error(`Calibration/evaluation input overlap: ${task.id}`);
    inputs.set(task.inputSha256, task.split);
    if (new Set(task.requiredChecks).size !== task.requiredChecks.length || !task.requiredChecks.includes('statistics')) throw new Error('Every task needs unique checks including statistics');
  }
  if (digest(readFileSync(resolve(dirname(path), suite.taskPrompt))) !== suite.taskPromptSha256) throw new Error('Task prompt hash mismatch');
  return { suite, sha256: digest(bytes), path };
}

export function parseResults(text: string): RunResult[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return RunResultSchema.parse(JSON.parse(line)); }
    catch (error) { throw new Error(`Invalid result row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

export function createRunPlan(loaded: LoadedSuite, split: 'calibration' | 'evaluation', repetitions = 3) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new TypeError('Repetitions must be 1..100');
  const tasks = loaded.suite.tasks.filter(task => task.split === split);
  if (!tasks.length) throw new Error('Selected evaluation split has no tasks');
  return { schemaVersion: 1, suiteSha256: loaded.sha256, split, repetitions, phase: loaded.suite.phase,
    frozenForFinalEvaluation: loaded.suite.frozenForFinalEvaluation,
    runs: VARIANTS.flatMap(variant => tasks.flatMap(task => Array.from({ length: repetitions }, (_, index) => ({
      taskId: task.id, variant, repetition: index + 1, input: task.input, inputSha256: task.inputSha256,
      prompt: loaded.suite.taskPrompt, requiredChecks: task.requiredChecks,
    })))),
  };
}

export interface MetricFraction { numerator: number; denominator: number; value: number | null }
const fraction = (numerator: number, denominator: number): MetricFraction => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
export interface VariantReport {
  variant: typeof VARIANTS[number]; planned: number; recorded: number; missing: number;
  completion: MetricFraction; correctness: MetricFraction; unknownCorrectness: number;
  falseBlocking: MetricFraction; unreviewedDenials: number; interruptions: number;
  tokenUsage: { knownTotalLowerBound: number; completeRuns: number; unknownCalls: number; meanAmongCompleteRuns: number | null; auxiliaryTokensLowerBound: number; overageKnownRuns: number; knownOverage: number };
  elapsed: { knownRuns: number; missingRuns: number; meanMs: number | null };
  failures: Record<string, number>; falseCompletionClaims: number;
}

/** Aggregate only submitted evidence. Missing rows or usage never become synthetic zeros. */
export function buildReport(loaded: LoadedSuite, rawResults: readonly unknown[], options: { split: 'calibration' | 'evaluation'; repetitions: number; mode: 'real' | 'simulation' }) {
  const plan = createRunPlan(loaded, options.split, options.repetitions);
  const results = rawResults.map(value => RunResultSchema.parse(value));
  const tasks = new Map(loaded.suite.tasks.filter(task => task.split === options.split).map(task => [task.id, task]));
  const slots = new Set<string>(); const runs = new Set<string>(); const configs = new Map<string, string>();
  const budgetLimits = new Map<string, number>();
  const callOwners = new Map<string, string>();
  let experimentIdentity: string | undefined;
  for (const record of results) {
    if (record.suiteSha256 !== loaded.sha256) throw new Error('Result suite fingerprint mismatch');
    if (record.mode !== options.mode) throw new Error('Real and simulation records must be reported separately');
    if (!tasks.has(record.taskId) || record.repetition > options.repetitions) throw new Error('Result lies outside the selected split/repetitions');
    const slot = JSON.stringify([record.taskId, record.variant, record.repetition]);
    if (slots.has(slot) || runs.has(record.runId)) throw new Error('Duplicate run or experiment slot');
    slots.add(slot); runs.add(record.runId);
    for (const call of record.calls) {
      const owner = callOwners.get(call.callId);
      if (owner && owner !== record.runId) throw new Error('One model call cannot be counted in multiple evaluation runs');
      callOwners.set(call.callId, record.runId);
    }
    const { configSha256, ...identity } = record.execution; const serialized = JSON.stringify(identity);
    if (experimentIdentity !== undefined && experimentIdentity !== serialized) throw new Error('Model/provider/runtime versions differ within one comparison');
    experimentIdentity = serialized;
    const config = configs.get(record.variant);
    if (config !== undefined && config !== configSha256) throw new Error(`Configuration changed within variant ${record.variant}`);
    configs.set(record.variant, configSha256);
    const limit = budgetLimits.get(record.variant);
    if (limit !== undefined && limit !== record.budgetLimitTokens) throw new Error(`Budget limit changed within variant ${record.variant}`);
    budgetLimits.set(record.variant, record.budgetLimitTokens);
  }
  const reports: VariantReport[] = VARIANTS.map(variant => {
    const records = results.filter(result => result.variant === variant);
    const planned = plan.runs.filter(run => run.variant === variant).length;
    let complete = 0; let correct = 0; let checked = 0; let falseClaims = 0;
    let knownTokens = 0; let auxiliaryTokens = 0; let accountedRuns = 0; let completeTokens = 0; let unknownCalls = 0; let overage = 0;
    let duration = 0; let timedRuns = 0; let denials = 0; let reviewed = 0; let falseDenials = 0; let interruptions = 0;
    const failures: Record<string, number> = {};
    for (const result of records) {
      const task = tasks.get(result.taskId)!;
      const statistics = result.candidateStatistics === null ? null : isDeepStrictEqual(result.candidateStatistics, task.expectedStatistics);
      if (statistics !== null) { checked += 1; if (statistics) correct += 1; }
      const checks = { statistics, ...result.checks };
      const accepted = task.requiredChecks.every(check => checks[check] === true);
      if (result.outcome === 'complete' && accepted) complete += 1;
      else {
        const failure = result.outcome === 'complete' ? 'validation' : result.failureKind ?? result.outcome;
        failures[failure] = (failures[failure] ?? 0) + 1;
        if (result.outcome === 'complete') falseClaims += 1;
      }
      const calls = new Map<string, RunResult['calls'][number]>();
      for (const call of result.calls) {
        const existing = calls.get(call.callId);
        if (existing && !isDeepStrictEqual(existing, call)) throw new Error(`Conflicting usage for call ${call.callId}`);
        calls.set(call.callId, call);
      }
      let tokens = 0; let missing = 0;
      for (const call of calls.values()) {
        if (call.usage === null) { missing += 1; continue; }
        const used = Object.values(call.usage).reduce((sum, value) => sum + value, 0); tokens += used;
        if (call.category !== 'work') auxiliaryTokens += used;
      }
      // An empty call list cannot prove that a purported Agent run consumed zero tokens.
      if (calls.size === 0) missing += 1;
      knownTokens += tokens; unknownCalls += missing;
      // Unknown additional consumption cannot erase an already established overage lower bound.
      overage += Math.max(0, tokens - result.budgetLimitTokens);
      if (missing === 0) { accountedRuns += 1; completeTokens += tokens; }
      if (result.durationMs !== null) { timedRuns += 1; duration += result.durationMs; }
      denials += result.denials; reviewed += result.reviewedDenials; falseDenials += result.falseDenials; interruptions += result.interruptions;
    }
    for (const value of [knownTokens, auxiliaryTokens, completeTokens, overage, duration, denials, reviewed, falseDenials, interruptions]) if (!Number.isSafeInteger(value)) throw new Error('Aggregated metric exceeds safe integer range');
    return { variant, planned, recorded: records.length, missing: planned - records.length,
      completion: fraction(complete, records.length), correctness: fraction(correct, checked), unknownCorrectness: records.length - checked,
      falseBlocking: fraction(falseDenials, reviewed), unreviewedDenials: denials - reviewed, interruptions,
      tokenUsage: { knownTotalLowerBound: knownTokens, completeRuns: accountedRuns, unknownCalls, meanAmongCompleteRuns: accountedRuns ? completeTokens / accountedRuns : null,
        auxiliaryTokensLowerBound: auxiliaryTokens, overageKnownRuns: accountedRuns, knownOverage: overage },
      elapsed: { knownRuns: timedRuns, missingRuns: records.length - timedRuns, meanMs: timedRuns ? duration / timedRuns : null }, failures, falseCompletionClaims: falseClaims };
  });
  const unaccepted = results.filter(result => {
    const task = tasks.get(result.taskId)!;
    return result.outcome !== 'complete' || !task.requiredChecks.every(check => check === 'statistics'
      ? result.candidateStatistics !== null && isDeepStrictEqual(result.candidateStatistics, task.expectedStatistics)
      : result.checks[check] === true);
  });
  const unknownChecks = results.filter(result => tasks.get(result.taskId)!.requiredChecks.some(check => check === 'statistics'
    ? result.candidateStatistics === null : result.checks[check] === null));
  const unknownUsage = results.filter(result => !result.calls.length || result.calls.some(call => call.usage === null));
  const missingDuration = results.filter(result => result.durationMs === null);
  const eligibilityBlockers: Array<{ code: string; count: number; runIds: string[] }> = [];
  const block = (code: string, affected: RunResult[]) => { if (affected.length) eligibilityBlockers.push({ code, count: affected.length, runIds: affected.map(result => result.runId) }); };
  if (options.split !== 'evaluation') eligibilityBlockers.push({ code: 'NOT_EVALUATION_SPLIT', count: 1, runIds: [] });
  if (options.mode !== 'real') eligibilityBlockers.push({ code: 'NOT_REAL_MODE', count: 1, runIds: [] });
  if (!loaded.suite.frozenForFinalEvaluation) eligibilityBlockers.push({ code: 'SUITE_NOT_FROZEN', count: 1, runIds: [] });
  if (results.length !== plan.runs.length) eligibilityBlockers.push({ code: 'MISSING_RUNS', count: plan.runs.length - results.length, runIds: [] });
  block('UNKNOWN_USAGE', unknownUsage); block('MISSING_DURATION', missingDuration); block('UNKNOWN_REQUIRED_CHECKS', unknownChecks);
  const evaluationDataComplete = eligibilityBlockers.length === 0;
  block('RUN_NOT_ACCEPTED', unaccepted);
  return { schemaVersion: 1, suiteId: loaded.suite.suiteId, suiteSha256: loaded.sha256, suitePhase: loaded.suite.phase,
    mode: options.mode, split: options.split, repetitions: options.repetitions, expectedRuns: plan.runs.length, recordedRuns: results.length,
    evaluationDataComplete,
    acceptance: { passedRuns: results.length - unaccepted.length, notAcceptedRuns: unaccepted.length,
      allRunsAccepted: results.length === plan.runs.length && unaccepted.length === 0 },
    // Preserve the historical strict gate. A failed task remains part of a complete experiment.
    finalEvaluationEligible: evaluationDataComplete && unaccepted.length === 0,
    eligibilityBlockers,
    unacceptedRuns: unaccepted.map(({ taskId, variant, repetition, runId, outcome, failureKind }) => ({ taskId, variant, repetition, runId, outcome, failureKind })),
    experiment: experimentIdentity ? JSON.parse(experimentIdentity) as Record<string, string> : null,
    configurations: Object.fromEntries(configs), budgetLimits: Object.fromEntries(budgetLimits), reports,
  };
}
export type EvaluationReport = ReturnType<typeof buildReport>;
const ratioText = (metric: MetricFraction) => metric.value === null ? '待测 / 无分母' : `${(metric.value * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`;
export function renderReport(report: EvaluationReport): string {
  const rows = report.reports.map(row => `| ${row.variant} | ${row.recorded}/${row.planned} | ${ratioText(row.completion)} | ${ratioText(row.correctness)} | ${row.tokenUsage.meanAmongCompleteRuns === null ? '待测' : row.tokenUsage.meanAmongCompleteRuns.toFixed(1)} (${row.tokenUsage.completeRuns} runs) | ${ratioText(row.falseBlocking)} | ${row.elapsed.meanMs === null ? '待测' : row.elapsed.meanMs.toFixed(1)} |`);
  const failures = report.unacceptedRuns.length ? `\n\n未完整通过的记录（保留原结果，不删除或重标成功）：\n\n| 任务 | 策略 | 重复 | 状态 | 失败分类 | runId |\n| --- | --- | --- | --- | --- | --- |\n${report.unacceptedRuns.map(run => `| ${run.taskId} | ${run.variant} | ${run.repetition} | ${run.outcome} | ${run.failureKind ?? 'validation'} | ${run.runId} |`).join('\n')}` : '';
  return `# 固定任务评测报告\n\n模式：${report.mode}。任务集指纹：\`${report.suiteSha256}\`。\n\n任务集阶段：${report.suitePhase}。有效记录 ${report.recordedRuns}/${report.expectedRuns}。\n\n评测数据完整：\`${report.evaluationDataComplete}\`。完整通过 ${report.acceptance.passedRuns}/${report.recordedRuns}，未完整通过 ${report.acceptance.notAcceptedRuns}。历史严格门槛 finalEvaluationEligible：\`${report.finalEvaluationEligible}\`（另要求每条记录完整成功及必需检查通过）。失败样本是评测结果的一部分；该门槛为 false 不等于批次未跑完。数据完整仅核对记录字段，证据文件仍需独立复查。\n\n阻止严格门槛通过的原因：${report.eligibilityBlockers.map(blocker => `${blocker.code} (${blocker.count})`).join('、') || '无'}。\n\n| 策略 | 已记录/计划 | 完整完成率 | 统计正确率 | 平均 token（用量完整记录） | 误拦截率（已复核拒绝） | 平均耗时 ms |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}${failures}\n\n完成率分母为已记录任务；统计正确率分母为提交了候选统计的任务。未执行记录、未知 usage 和缺失耗时不填零。JSON 报告另含缺失数量、失败分类、辅助调用消耗、已核对超额及人工打断次数。\n\nsimulation 仅检查评测管线，不能证明真实 Agent 效果。校准集不能混入最终评估；报告和图表检查由独立验证或人工复核提供，脚本退出码不算通过。\n`;
}
