import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { IdSchema } from '../src/contracts/runtime.js';
import { validateArtifacts } from './artifact-validation.js';
import { buildReport, loadSuite, parseResults, type LoadedSuite } from './report.js';
import { collectLedgerCalls } from './runtime-driver.js';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const artifactSchema = z.strictObject({ artifactId: IdSchema, runId: IdSchema, attemptId: IdSchema,
  path: z.string().min(1), size: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });

/** Offline revalidation of original bytes and original ledger receipts; never opens a host. */
export async function auditEvaluation(options: {
  records: string; suite?: LoadedSuite; split: 'calibration' | 'evaluation'; repetitions: number; mode: 'real' | 'simulation';
}) {
  const loaded = options.suite ?? loadSuite(); const raw = readFileSync(options.records);
  const records = parseResults(raw.toString('utf8'));
  const report = buildReport(loaded, records, options);
  let artifactCount = 0; let tokenTotal = 0; let validationPassed = 0; let reservedTokens = 0; let ledgerUnknownCalls = 0;
  for (const record of records) {
    const root = dirname(resolve(record.evidence.validation));
    const metadata = artifactSchema.array().parse(JSON.parse(readFileSync(join(root, 'artifacts.json'), 'utf8')));
    if (metadata.some(a => a.runId !== record.runId) || new Set(metadata.map(a => a.artifactId)).size !== metadata.length) throw new Error(`Invalid artifact identity: ${record.runId}`);
    const bytes = new Map<string, Uint8Array>();
    if (metadata.length !== record.evidence.artifacts.length) throw new Error(`Artifact count differs: ${record.runId}`);
    for (const artifact of metadata) {
      const path = join(root, `${artifact.artifactId}.artifact`);
      if (!record.evidence.artifacts.some(entry => resolve(entry) === path)) throw new Error(`Artifact evidence is missing: ${artifact.artifactId}`);
      const content = readFileSync(path);
      if (content.length !== artifact.size || hash(content) !== artifact.sha256) throw new Error(`Artifact fingerprint mismatch: ${artifact.artifactId}`);
      bytes.set(artifact.artifactId, content); artifactCount++;
    }
    const stored = JSON.parse(readFileSync(record.evidence.validation, 'utf8'));
    const selected = metadata.filter(a => a.attemptId === stored.attemptId);
    if (metadata.length && !selected.length) throw new Error(`Delivery attempt is missing: ${record.runId}`);
    const task = loaded.suite.tasks.find(task => task.id === record.taskId)!;
    const validation = await validateArtifacts(readFileSync(resolve(dirname(loaded.path), task.input)), selected,
      { read: async artifact => bytes.get(artifact.artifactId)! });
    if (!isDeepStrictEqual(validation.candidateStatistics, record.candidateStatistics) || !isDeepStrictEqual(validation.checks, record.checks)
      || validation.passed !== stored.passed) throw new Error(`Independent validation differs: ${record.runId}`);
    if (validation.passed) validationPassed++;
    const ledger = JSON.parse(readFileSync(record.evidence.ledger, 'utf8'));
    const categories = new Map(record.calls.map(call => [call.callId, call.category]));
    const calls = collectLedgerCalls(ledger.receipts, ledger.scopeKey, categories);
    if (!isDeepStrictEqual(calls, record.calls)) throw new Error(`Original call receipts differ: ${record.runId}`);
    const used = calls.reduce((sum, call) => sum + (call.usage ? Object.values(call.usage).reduce((a, b) => a + b, 0) : 0), 0);
    if (used !== ledger.snapshot.usedTokens || ledger.snapshot.limitTokens !== record.budgetLimitTokens) throw new Error(`Original balance differs: ${record.runId}`);
    if (!Number.isSafeInteger(ledger.snapshot.reservedTokens) || ledger.snapshot.reservedTokens < 0
      || !Number.isSafeInteger(ledger.snapshot.unknownCalls) || ledger.snapshot.unknownCalls < 0 || typeof ledger.snapshot.meteringComplete !== 'boolean') throw new Error(`Accounting state is absent: ${record.runId}`);
    if (ledger.snapshot.unknownCalls === 0 && ledger.snapshot.meteringComplete && calls.some(call => call.usage === null)) throw new Error(`Unknown call hidden by snapshot: ${record.runId}`);
    reservedTokens += ledger.snapshot.reservedTokens; ledgerUnknownCalls += ledger.snapshot.unknownCalls;
    tokenTotal += used;
  }
  return { schemaVersion: 1, mode: options.mode, split: options.split, suiteSha256: loaded.sha256,
    recordsSha256: hash(raw), recorded: records.length, expected: report.expectedRuns, complete: report.acceptance.passedRuns,
    artifactCount, validationPassed, tokenTotal, reservedTokens, ledgerUnknownCalls, unknownCalls: report.reports.reduce((n, v) => n + v.tokenUsage.unknownCalls, 0),
    report, limitations: ['Offline audit of persisted evidence; no new model or sandbox execution.', 'Call categories are host labels, not independently inferred billing purposes.'] };
}
