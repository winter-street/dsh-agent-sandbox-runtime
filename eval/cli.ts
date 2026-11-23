import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildReport, createRunPlan, loadSuite, parseResults, renderReport } from './report.js';
import { runEvaluation, type EvaluationDriver } from './runner.js';
import { auditEvaluation } from './audit.js';
import { runPressureEvaluation } from './pressure.js';
import { mergeShardedEvaluation, runShardedEvaluation } from './sharded.js';
import { createRuntimeEvaluationDriver, runtimeDriverConfigs } from './runtime-driver.js';
import { runDemo } from './demo.js';
import { runFaultMatrix } from './fault-matrix.js';
import { runTransportFaults } from './transport-faults.js';
import { runExternalTransportFaults } from './external-transport-faults.js';
import { runQa02 } from './qa-02.js';

const [command, ...args] = process.argv.slice(2);
function option(name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`); const value = index < 0 ? fallback : args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required`); return value;
}
function output(path: string, content: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
}
try {
  const loaded = loadSuite(option('suite', 'eval/suite.json'));
  if (command === 'verify-fixtures') {
    console.log(`Verified ${loaded.suite.tasks.length} fixture hashes and prompt; suite=${loaded.sha256}; phase=${loaded.suite.phase}`);
  } else if (command === 'demo') {
    const result = await runDemo({ directory: option('out'), configPath: option('config', 'config/eval-finalize.json') });
    console.log(JSON.stringify({ passed: result.passed, runId: result.runId, status: result.status, tokens: result.budget.usedTokens, delivery: result.deliveryDirectory }, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else if (command === 'pressure') {
    const report = await runPressureEvaluation(option('out'), option('plan', 'eval/pressure-plan.json'));
    console.log(`Controlled pressure conditions=${report.conditions}; external model/sandbox calls=0. Report: ${resolve(option('out'), 'report.json')}`);
  } else if (command === 'fault-matrix') {
    const report = await runFaultMatrix(option('out'));
    console.log(`Controlled fault matrix ${report.passed}/${report.scenarios} passed. Report: ${resolve(option('out'), 'report.json')}`);
    if (report.failed) process.exitCode = 1;
  } else if (command === 'transport-faults') {
    const report = await runTransportFaults(option('out'));
    console.log(`Loopback transport faults ${report.passed}/${report.results.length} passed. Report: ${resolve(option('out'), 'report.json')}`);
    if (report.passed !== report.results.length) process.exitCode = 1;
  } else if (command === 'external-transport-faults') {
    const report = await runExternalTransportFaults(option('out'));
    console.log(`DeepSeek transport observations ${report.passed}/${report.results.length} passed. Report: ${resolve(option('out'), 'report.json')}`);
    if (report.passed !== report.results.length) process.exitCode = 1;
  } else if (command === 'qa-02') {
    const report = await runQa02(option('out'));
    console.log(JSON.stringify({ mode: report.mode, scenarios: report.scenarios, passed: report.passed, failed: report.failed,
      report: resolve(option('out'), 'report.json') }, null, 2));
    if (report.failed > 0) process.exitCode = 1;
  } else if (command === 'plan') {
    const split = option('split', 'evaluation'); if (split !== 'calibration' && split !== 'evaluation') throw new Error('Invalid split');
    const plan = createRunPlan(loaded, split, Number(option('repetitions', '3')));
    output(option('out'), `${JSON.stringify(plan, null, 2)}\n`); console.log(`Wrote ${plan.runs.length} planned runs; no model or sandbox was invoked.`);
  } else if (command === 'verify-result') {
    const task = loaded.suite.tasks.find(item => item.id === option('task')); if (!task) throw new Error('Unknown task');
    const candidate = JSON.parse(readFileSync(option('candidate'), 'utf8')) as unknown;
    if (!isDeepStrictEqual(candidate, task.expectedStatistics)) throw new Error(`Incorrect statistics for ${task.id}`);
    console.log(`PASS statistics for ${task.id}; required report/chart checks remain independent.`);
  } else if (command === 'doctor') {
    const mode = option('mode', 'real'); const module = await import(pathToFileURL(resolve(option('driver'))).href) as { default?: EvaluationDriver };
    const driver = module.default;
    if (!driver || driver.manifest?.mode !== mode || typeof driver.preflight !== 'function') throw new Error('Driver must export a preflight-capable default driver matching --mode');
    console.log(JSON.stringify(await driver.preflight(), null, 2));
  } else if (command === 'run' || command === 'reconcile') {
    const split = option('split', 'calibration'); const mode = option('mode');
    if (split !== 'calibration' && split !== 'evaluation') throw new Error('Invalid split');
    if (mode !== 'real' && mode !== 'simulation') throw new Error('Invalid mode');
    const module = await import(pathToFileURL(resolve(option('driver'))).href) as { default?: EvaluationDriver };
    const driver = module.default;
    if (!driver || typeof driver.execute !== 'function' || typeof driver.validate !== 'function' || driver.manifest?.mode !== mode) throw new Error('Driver must export a default trusted host driver matching --mode');
    const controller = new AbortController(); const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await runEvaluation({ suite: loaded, driver, directory: option('out'), split,
        repetitions: Number(option('repetitions', '3')), maxRuns: Number(option('max-runs', '1')), signal: controller.signal, reconcilePending: command === 'reconcile' });
      console.log(`Executed ${result.executed} slot(s); reconciled=${result.reconciled}; mode=${mode}; recorded=${result.records.length}/${result.report.expectedRuns}; finalEvaluationEligible=${result.report.finalEvaluationEligible}${result.stopped ? `; stopped=${result.stopped.reason} slot=${result.stopped.slot}` : ''}`);
      if (result.stopped) process.exitCode = 2;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } else if (command === 'parallel-run' || command === 'parallel-reconcile') {
    const split = option('split', 'calibration');
    if (split !== 'calibration' && split !== 'evaluation') throw new Error('Invalid split');
    const root = resolve(option('out')); const configs = runtimeDriverConfigs();
    const drivers = [0, 1].map(index => createRuntimeEvaluationDriver({ configs, directory: resolve(root, `worker-${index}`, 'evidence'),
      applicationDirectory: resolve(root, `worker-${index}`, 'application') })) as [EvaluationDriver, EvaluationDriver];
    const controller = new AbortController(); const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const status = await runShardedEvaluation({ suite: loaded, drivers, directory: root, split,
        repetitions: Number(option('repetitions', '1')), maxRunsPerWorker: Number(option('max-runs-per-worker', '1')),
        providerConcurrency: Number(option('provider-concurrency', '2')), sandboxConcurrency: Number(option('sandbox-concurrency', '2')),
        reconcilePending: command === 'parallel-reconcile', signal: controller.signal });
      console.log(JSON.stringify(status, null, 2));
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } else if (command === 'merge-shards') {
    const split = option('split', 'calibration'); const mode = option('mode', 'real');
    if (split !== 'calibration' && split !== 'evaluation' || mode !== 'real' && mode !== 'simulation') throw new Error('Invalid merge mode/split');
    const report = mergeShardedEvaluation({ suite: loaded, directory: option('root'), split, mode,
      repetitions: Number(option('repetitions', '1')), output: option('out') });
    console.log(`Merged exact coverage ${report.recordedRuns}/${report.expectedRuns}; accepted=${report.acceptance.passedRuns}; finalEvaluationEligible=${report.finalEvaluationEligible}`);
  } else if (command === 'audit') {
    const split = option('split', 'calibration'); const mode = option('mode', 'real');
    if (split !== 'calibration' && split !== 'evaluation' || mode !== 'real' && mode !== 'simulation') throw new Error('Invalid audit mode/split');
    const audit = await auditEvaluation({ records: option('records'), suite: loaded, split, mode, repetitions: Number(option('repetitions', '1')) });
    output(option('out'), `${JSON.stringify(audit, null, 2)}\n`);
    console.log(`Audited ${audit.recorded}/${audit.expected}; complete=${audit.complete}; validated=${audit.validationPassed}; artifacts=${audit.artifactCount}; unknownCalls=${audit.unknownCalls}`);
  } else if (command === 'report') {
    const split = option('split', 'evaluation'); const mode = option('mode', 'real');
    if (split !== 'calibration' && split !== 'evaluation') throw new Error('Invalid split');
    if (mode !== 'real' && mode !== 'simulation') throw new Error('Invalid mode');
    const results = parseResults(readFileSync(option('records'), 'utf8'));
    const report = buildReport(loaded, results, { split, mode, repetitions: Number(option('repetitions', '3')) });
    const root = resolve(option('out')); output(resolve(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); output(resolve(root, 'report.md'), renderReport(report));
    console.log(`Recorded ${report.recordedRuns}/${report.expectedRuns}; evaluationDataComplete=${report.evaluationDataComplete}; accepted=${report.acceptance.passedRuns}/${report.recordedRuns}; finalEvaluationEligible=${report.finalEvaluationEligible}`);
  } else throw new Error('Commands: verify-fixtures, plan, doctor, run, reconcile, report, verify-result, audit, pressure, fault-matrix, transport-faults, external-transport-faults, qa-02, parallel-run, parallel-reconcile, merge-shards. See eval/README.md for options.');
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
