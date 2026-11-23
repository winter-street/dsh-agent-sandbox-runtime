import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvaluation } from '../../eval/audit.js';
import { loadSuite, type RunResult } from '../../eval/report.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'offline-audit-')); roots.push(root);
  const suite = loadSuite(); const task = suite.suite.tasks.find(t => t.id === 'c04')!;
  const artifact = Buffer.from(JSON.stringify(task.expectedStatistics)); const path = join(root, 'artifact-a.artifact'); writeFileSync(path, artifact);
  writeFileSync(join(root, 'artifacts.json'), JSON.stringify([{ artifactId: 'artifact-a', runId: 'audit-run', attemptId: 'attempt-a', path: 'statistics.json',
    size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') }]));
  const usage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const receipts = [
    { type: 'reserve', payload: { reservationId: 'reservation-a', request: { scopeKey: 'scope-a', modelCallId: 'call-a', purpose: 'work' } } },
    { type: 'dispatch', payload: { reservationId: 'reservation-a' } }, { type: 'settle', payload: { reservationId: 'reservation-a', usage } },
  ].map((event, index) => ({ ...event, eventId: `receipt-${index}`, cursor: index + 1, scopeKey: 'scope-a' }));
  writeFileSync(join(root, 'ledger.json'), JSON.stringify({ scopeKey: 'scope-a', snapshot: { usedTokens: 5, limitTokens: 1000, reservedTokens: 0, unknownCalls: 0, meteringComplete: true }, receipts }));
  writeFileSync(join(root, 'validation.json'), JSON.stringify({ passed: true, attemptId: 'attempt-a' }));
  const result: RunResult = { schemaVersion: 1, suiteSha256: suite.sha256, taskId: task.id, variant: 'hard-only', repetition: 1, mode: 'simulation', runId: 'audit-run',
    execution: { provider: 'controlled', model: 'controlled', modelVersion: '1', harnessVersion: 'test', sandboxVersion: 'test', codeRevision: 'test', configSha256: 'a'.repeat(64) },
    outcome: 'complete', candidateStatistics: task.expectedStatistics, checks: { report: null, chart: null }, calls: [{ callId: 'call-a', category: 'work', usage }],
    budgetLimitTokens: 1000, durationMs: 1, interruptions: 0, denials: 0, reviewedDenials: 0, falseDenials: 0, failureKind: null,
    evidence: { trace: join(root, 'trace.json'), ledger: join(root, 'ledger.json'), validation: join(root, 'validation.json'), artifacts: [path] } };
  // Invalid-input delivery does not require report/chart checks; keep them null.
  const records = join(root, 'records.jsonl'); const save = () => writeFileSync(records, JSON.stringify(result) + '\n'); save();
  return { root, records, result, save, options: { records, suite, split: 'calibration' as const, repetitions: 1, mode: 'simulation' as const } };
}
describe('offline evidence revalidation without host startup', () => {
  it('checks artifact bytes and original receipts and retains incomplete suite coverage', async () => {
    const s = setup(); const audit = await auditEvaluation(s.options);
    expect(audit).toMatchObject({ recorded: 1, expected: 15, complete: 1, artifactCount: 1, tokenTotal: 5 });
    expect(audit.report.evaluationDataComplete).toBe(false);
  });
  it('rejects corrupted artifact bytes', async () => {
    const s = setup(); writeFileSync(join(s.root, 'artifact-a.artifact'), 'corrupted');
    await expect(auditEvaluation(s.options)).rejects.toThrow('fingerprint');
  });
  it('rejects mismatched original usage instead of trusting the recorded total', async () => {
    const s = setup(); const ledgerPath = join(s.root, 'ledger.json'); const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    ledger.snapshot.usedTokens = 0; writeFileSync(ledgerPath, JSON.stringify(ledger));
    await expect(auditEvaluation(s.options)).rejects.toThrow('balance');
  });
  it('does not turn independently valid artifacts into successful execution for a partial run', async () => {
    const s = setup(); s.result.outcome = 'partial'; s.result.failureKind = 'other'; s.save();
    expect(await auditEvaluation(s.options)).toMatchObject({ validationPassed: 1, complete: 0 });
  });
});
