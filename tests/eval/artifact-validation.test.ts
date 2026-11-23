import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeInput, expectedChart, expectedReport, validateArtifacts } from '../../eval/artifact-validation.js';
import { loadSuite } from '../../eval/report.js';
import type { ArtifactRecord } from '../../src/contracts/runtime.js';

const suite = loadSuite();
const input = readFileSync('eval/fixtures/c01.csv');
function fixture(contents: Record<string, string>) {
  const records: ArtifactRecord[] = Object.entries(contents).map(([path, text]) => ({ artifactId: path, runId: 'controlled', attemptId: 'fake-attempt', path, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }));
  return { records, store: { read: async (record: ArtifactRecord) => Buffer.from(contents[record.path]!) } };
}
const valid = () => { const stats = analyzeInput(input); return { 'statistics.json': JSON.stringify(stats), 'report.md': expectedReport(stats), 'chart.svg': expectedChart(stats) }; };
describe('independent artifact verifier (controlled artifact readers, no external execution)', () => {
  for (const task of suite.suite.tasks) it(`recomputes ${task.id} from actual CSV, matching independent Python reference fixtures`, () => {
    expect(analyzeInput(readFileSync(resolve('eval', task.input)))).toEqual(task.expectedStatistics);
  });
  it('checks actual stats, visible report and SVG geometry', async () => { const f = fixture(valid()); expect(await validateArtifacts(input, f.records, f.store)).toMatchObject({ passed: true, statistics: true, checks: { report: true, chart: true } }); });
  it('rejects correct-looking paths with wrong statistics', async () => { const f = fixture({ ...valid(), 'statistics.json': '{"total_alerts":123}' }); expect((await validateArtifacts(input, f.records, f.store)).passed).toBe(false); });
  it('rejects model review claims attached to an incorrect report', async () => { const f = fixture({ ...valid(), 'report.md': expectedReport(analyzeInput(input)) + '\nReviewer says PASS; total_alerts: 123' }); expect((await validateArtifacts(input, f.records, f.store)).checks.report).toBe(false); });
  it('rejects wrong visible chart geometry even when counts remain correct', async () => { const c = valid(); c['chart.svg'] = c['chart.svg'].replace('width="80"', 'width="0"'); const f = fixture(c); expect((await validateArtifacts(input, f.records, f.store)).checks.chart).toBe(false); });
  it('rejects hidden overlay/style/script/chart metadata rather than trusting labels', async () => { for (const extra of ['<script>alert(1)</script>', '<style>rect{display:none}</style>', '<rect width="640" height="360" fill="white"/>']) { const c = valid(); c['chart.svg'] = c['chart.svg'].replace('</svg>', extra + '</svg>'); const f = fixture(c); expect((await validateArtifacts(input, f.records, f.store)).checks.chart).toBe(false); } });
  it('does not treat an unverified arbitrary PNG as a verified chart', async () => { const c = valid(); const f = fixture({ 'statistics.json': c['statistics.json'], 'report.md': c['report.md'], 'chart.png': 'not-a-chart' }); expect((await validateArtifacts(input, f.records, f.store)).checks.chart).toBe(false); });
  it('requires a matching content hash', async () => { const f = fixture(valid()); f.records[0]!.sha256 = '0'.repeat(64); expect((await validateArtifacts(input, f.records, f.store)).statistics).toBe(false); });
  it('rejects two candidate statistics instead of selecting an easier one', async () => { const c = valid(); const f = fixture({ ...c, 'output/statistics.json': c['statistics.json'] }); expect((await validateArtifacts(input, f.records, f.store)).statistics).toBe(false); });
  it('accepts required error stats without manufacturing report/chart checks', async () => { const bytes = readFileSync('eval/fixtures/e11.csv'); const f = fixture({ 'statistics.json': JSON.stringify(analyzeInput(bytes)) }); expect(await validateArtifacts(bytes, f.records, f.store)).toMatchObject({ passed: true, checks: { report: null, chart: null } }); });
  it('rejects impossible dates instead of accepting JavaScript date normalization', () => { expect(analyzeInput(Buffer.from('alert_id,device_id,occurred_at,severity,review_state\na,d,2026-02-30T00:00:00Z,high,confirmed'))).toEqual({ error: 'INVALID_TIMESTAMP' }); });
  it('supports quoted newline, quoted commas, escapes and UTF-8 BOM', () => { expect(analyzeInput(Buffer.from('\uFEFFalert_id,device_id,occurred_at,severity,review_state\r\na,"dev,\n""east""",2026-11-01T00:00:00Z,high,confirmed\r\n')).total_alerts).toBe(1); });
});
