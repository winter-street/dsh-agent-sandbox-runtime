import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ApplicationHostOptions } from '../../src/app/index.js';

// Trusted fixture records generate both the input bytes and an independent oracle.
const rows = [
  { device_id: 'beta', count: 3 }, { device_id: 'alpha', count: 2 },
  { device_id: 'gamma', count: 2 }, { device_id: 'alpha', count: 3 },
  { device_id: 'delta', count: 2 }, { device_id: 'beta', count: 2 },
];
export const input = Buffer.from('device_id,count\n' + rows.map(row => `${row.device_id},${row.count}\n`).join(''));
export const inputSha256 = createHash('sha256').update(input).digest('hex');
const totals = new Map<string, number>();
for (const row of rows) totals.set(row.device_id, (totals.get(row.device_id) ?? 0) + row.count);
export const expected = { total_rows: rows.length, total_count: rows.reduce((sum, row) => sum + row.count, 0),
  ranking: [...totals].map(([device_id, count]) => ({ device_id, count }))
    .sort((a, b) => b.count - a.count || (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0)) };
export const reportLines = [`Rows: ${expected.total_rows}`, `Total: ${expected.total_count}`,
  ...expected.ranking.map((row, index) => `${index + 1}. ${row.device_id}: ${row.count}`)];
export const task = [
  'Analyze input.csv (columns device_id,count). Sum integer count per device. Sort descending by summed count, then ascending by device_id for ties; use the supplied ranking reference.',
  'Use only Python standard library and the provided AGENT_INPUT_DIR / AGENT_OUTPUT_DIR. Write exactly two files, no other output files.',
  'ranking.json must be a JSON object with exactly total_rows (input data row count), total_count (sum of counts), ranking (all devices in order, each exactly {"device_id":"...","count":integer}).',
  'report.md must have one visible line "Rows: N", one line "Total: N", then one line per device "1. DEVICE: COUNT", "2. DEVICE: COUNT", etc, matching ranking.json. Do not wrap these lines in code fences.',
  'Read and validate both output files before exit. Print the full computed JSON and report to stdout, with a clear verification statement for the Reviewer. Do not invent results or depend on network/packages.',
].join('\n');
const rankingSchema = z.strictObject({ total_rows: z.int().nonnegative(), total_count: z.int().nonnegative(),
  ranking: z.array(z.strictObject({ device_id: z.string(), count: z.int().nonnegative() })) });
export function verifyDelivery(files: ReadonlyMap<string, Uint8Array>) {
  const problems: string[] = [];
  if ([...files.keys()].sort().join(',') !== 'ranking.json,report.md') problems.push('Expected exactly ranking.json and report.md');
  try {
    const value = rankingSchema.parse(JSON.parse(Buffer.from(files.get('ranking.json') ?? []).toString('utf8')));
    if (!isDeepStrictEqual(value, expected)) problems.push('Ranking does not match the independent fixture-derived oracle');
  } catch { problems.push('Ranking JSON is missing or invalid'); }
  const report = Buffer.from(files.get('report.md') ?? []).toString('utf8').replaceAll('\r', '').trim();
  if (report.split('\n').map(line => line.trim()).filter(Boolean).join('\n') !== reportLines.join('\n')) {
    problems.push('Visible report does not match the independently derived lines');
  }
  return { passed: problems.length === 0, evidence: { schemaVersion: 1, inputSha256, expected, problems } };
}
export const validate: ApplicationHostOptions['validate'] = async (_run, records, read) => {
  const files = new Map<string, Uint8Array>();
  for (const record of records) {
    if (files.has(record.path)) return { passed: false, evidence: { problems: ['Ambiguous duplicate output path'] } };
    if (record.size > 65536) return { passed: false, evidence: { problems: ['Acceptance artifact exceeds 64 KiB'] } };
    files.set(record.path, await read(record));
  }
  return verifyDelivery(files);
};
