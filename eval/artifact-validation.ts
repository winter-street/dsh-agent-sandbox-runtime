import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactStore } from '../src/artifacts/index.js';
import type { ArtifactRecord, RunRecord } from '../src/contracts/runtime.js';

const BANDS = ['00-05', '06-11', '12-17', '18-23'] as const;
const LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** RFC4180-style quoted fields; no dependency on the model's Python implementation. */
function csv(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let closed = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false;
      if (c !== ',') { if (c === '\r' && input[i + 1] === '\n') i++; if (row.some(v => v !== '') || row.length > 1) rows.push(row); row = []; }
    } else { if (closed || c === '"') throw new Error('Malformed CSV'); field += c; }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}
const unicodeCompare = (a: string, b: string) => {
  const x = Array.from(a, c => c.codePointAt(0)!); const y = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};
/** Independent input-derived oracle. Throws on an unsupported/malformed CSV instead of guessing. */
export function analyzeInput(bytes: Uint8Array): Record<string, unknown> {
  const rows = csv(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  const headers = rows.shift() ?? [];
  if (!['alert_id', 'device_id', 'occurred_at', 'severity', 'review_state'].every(k => headers.includes(k))) return { error: 'MISSING_COLUMN' };
  const ids = new Set<string>(); const devices = new Map<string, { device_id: string; total: number; confirmed: number }>();
  const time_bands = Object.fromEntries(BANDS.map(k => [k, 0])) as Record<string, number>;
  const severity = Object.fromEntries(LEVELS.map(k => [k, 0])) as Record<string, number>;
  let confirmed = 0; let rejected = 0; let pending = 0;
  for (const values of rows) {
    const record = Object.fromEntries(headers.map((k, i) => [k, values[i] ?? '']));
    const id = record.alert_id!; const device = record.device_id!;
    if (!id || !device || ids.has(id)) return { error: 'INVALID_ID' }; ids.add(id);
    const stamp = record.occurred_at!;
    // Explicit date validity prevents Date.parse normalising February 30 into March.
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(stamp);
    const ms = Date.parse(stamp);
    if (!match || !Number.isFinite(ms) || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1
      || Number(match[3]) > new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate()
      || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) return { error: 'INVALID_TIMESTAMP' };
    const review = record.review_state || 'pending'; const level = record.severity || 'unknown';
    if (!['confirmed', 'rejected', 'pending'].includes(review) || !LEVELS.includes(level as typeof LEVELS[number])) return { error: 'INVALID_ENUM' };
    if (review === 'confirmed') confirmed++; else if (review === 'rejected') rejected++; else pending++;
    const entry = devices.get(device) ?? { device_id: device, total: 0, confirmed: 0 };
    entry.total++; entry.confirmed += Number(review === 'confirmed'); devices.set(device, entry);
    time_bands[BANDS[Math.floor(new Date(ms + 8 * 3600_000).getUTCHours() / 6)]!]!++;
    severity[level]!++;
  }
  return { total_alerts: rows.length, confirmed, rejected, pending, false_positive_rate: confirmed + rejected ? Number((rejected / (confirmed + rejected)).toFixed(6)) : null,
    devices: [...devices.values()].sort((a, b) => b.total - a.total || unicodeCompare(a.device_id, b.device_id)), time_bands, severity };
}

const method = 'Method: timezone UTC+08; false_positive_rate = rejected / (confirmed + rejected); pending excluded; devices sorted by total descending then device_id ascending.';
const limitation = 'Limitations: this input alone does not establish a trend or causality; unreviewed alerts remain uncertain.';
/** A deliberately finite report contract makes every visible claim independently checkable. */
export function expectedReport(stats: Record<string, unknown>): string {
  if ('error' in stats) throw new Error('Error tasks do not require a report');
  return ['# Alert analysis', ...['total_alerts', 'confirmed', 'rejected', 'pending', 'false_positive_rate'].map(k => `${k}: ${JSON.stringify(stats[k])}`),
    `devices: ${JSON.stringify(stats.devices)}`, `time_bands: ${JSON.stringify(stats.time_bands)}`, `severity: ${JSON.stringify(stats.severity)}`,
    method, limitation, stats.total_alerts === 0 ? 'Conclusion: no data.' : 'Conclusion: counts describe this input only.'].join('\n');
}
function verifyReport(text: string, stats: Record<string, unknown>): boolean {
  const lines = text.trim().replace(/\r\n/g, '\n').split('\n');
  const keys = ['total_alerts', 'confirmed', 'rejected', 'pending', 'false_positive_rate', 'devices', 'time_bands', 'severity'];
  if (lines.length !== 12 || lines[0] !== '# Alert analysis' || lines[9] !== method || lines[10] !== limitation
    || lines[11] !== (stats.total_alerts === 0 ? 'Conclusion: no data.' : 'Conclusion: counts describe this input only.')) return false;
  return keys.every((key, i) => {
    const line = lines[i + 1]!; if (!line.startsWith(`${key}: `)) return false;
    try { return isDeepStrictEqual(JSON.parse(line.slice(key.length + 2)), stats[key]); } catch { return false; }
  });
}
/** Fixed visible SVG grammar: no scripts, styles, hidden metadata or external references. */
export function expectedChart(stats: Record<string, unknown>): string {
  if ('error' in stats) throw new Error('Error tasks do not require a chart');
  const bands = stats.time_bands as Record<string, number>; const scale = 200 / Math.max(1, ...Object.values(bands));
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">'];
  BANDS.forEach((key, i) => { const x = 40 + i * 150; const height = Number((bands[key]! * scale).toFixed(6)); const y = Number((280 - height).toFixed(6));
    parts.push(`<rect x="${x}" y="${y}" width="80" height="${height}" fill="#2563eb"/>`,
      `<text x="${x}" y="310" fill="#111111">${key}: ${bands[key]}</text>`); });
  return [...parts, '</svg>'].join('\n');
}
export const ARTIFACT_FORMAT_INSTRUCTIONS = `
Additional output contract (format only, no reference answers): write statistics.json, report.md, chart.svg directly under the AGENT_OUTPUT_DIR environment variable's directory.
Execution requirements: make one complete runtime_python call instead of exploratory calls. Read only AGENT_INPUT_DIR/input.csv, validate it, compute the requested values with the standard library, write all required files under AGENT_OUTPUT_DIR, and check the files before returning. Do not search the container or print the input as a substitute for producing artifacts.
For invalid input write only statistics.json with the required error. Select the self-check file list inside this error branch: check only statistics.json, then return normally with exit code 0. A handled invalid input is a successful error delivery, not a Python execution failure. Never follow it with unconditional report.md/chart.svg existence assertions; genuine unexpected script errors must still fail. For valid input:
report.md must contain these lines in order, with no other claims: '# Alert analysis'; total_alerts: JSON_VALUE; confirmed: JSON_VALUE; rejected: JSON_VALUE; pending: JSON_VALUE; false_positive_rate: JSON_VALUE; devices: COMPACT_JSON_ARRAY; time_bands: COMPACT_JSON_OBJECT; severity: COMPACT_JSON_OBJECT; '${method}'; '${limitation}'; and 'Conclusion: no data.' for empty input or 'Conclusion: counts describe this input only.' otherwise. Use the key order from TASK.md; device objects order device_id,total,confirmed.
chart.svg root exactly <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">. For each ordered band 00-05,06-11,12-17,18-23 append a <rect x="X" y="Y" width="80" height="H" fill="#2563eb"/> and <text x="X" y="310" fill="#111111">BAND: COUNT</text>, then </svg>. X=40+150*index; scale=200/max(1,max band count); H=round(count*scale,6); Y=round(280-H,6). Serialize numbers without trailing zeroes. No other SVG elements/attributes. Whitespace between tags is allowed. Counts must come from input.csv.
`;
export interface ArtifactValidation {
  version: 1; inputSha256: string; candidateStatistics: Record<string, unknown> | null;
  statistics: boolean; checks: { report: boolean | null; chart: boolean | null }; passed: boolean;
  hashes: Record<string, string>; problems: string[];
}
export async function validateArtifacts(input: Uint8Array, records: readonly ArtifactRecord[], store: Pick<ArtifactStore, 'read'>): Promise<ArtifactValidation> {
  const expected = analyzeInput(input); const problems: string[] = []; const hashes: Record<string, string> = {};
  const read = async (path: string) => {
    const matches = records.filter(record => record.path === path || record.path === `output/${path}`);
    if (matches.length !== 1) { problems.push(`${path}: missing or ambiguous`); return null; }
    const record = matches[0]!;
    try { const bytes = await store.read(record); if (bytes.length > 1_000_000 || digest(bytes) !== record.sha256) throw new Error('Content hash/size mismatch');
      hashes[path] = digest(bytes); return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { problems.push(`${path}: unreadable or unverified content`); return null; }
  };
  let candidateStatistics: Record<string, unknown> | null = null;
  const stats = await read('statistics.json');
  if (stats !== null) { try { const value: unknown = JSON.parse(stats); if (value && typeof value === 'object' && !Array.isArray(value)) candidateStatistics = value as Record<string, unknown>; } catch { problems.push('statistics.json: invalid JSON'); } }
  const statistics = isDeepStrictEqual(candidateStatistics, expected);
  if (!statistics) problems.push('statistics.json: independent input-derived comparison failed');
  let report: boolean | null = null; let chart: boolean | null = null;
  if (!('error' in expected)) {
    const reportText = await read('report.md'); const chartText = await read('chart.svg');
    report = reportText !== null && verifyReport(reportText, expected);
    chart = chartText !== null && chartText.replace(/>\s+</g, '><').trim() === expectedChart(expected).replace(/>\s+</g, '><');
    if (!report) problems.push('report.md: visible content does not satisfy verified report contract');
    if (!chart) problems.push('chart.svg: visible labels/geometry do not satisfy verified SVG contract');
  }
  return { version: 1, inputSha256: digest(input), candidateStatistics, statistics, checks: { report, chart }, passed: statistics && report !== false && chart !== false, hashes, problems };
}
export function createArtifactValidator(input: Uint8Array, store: Pick<ArtifactStore, 'read'>) {
  const immutableInput = Uint8Array.from(input);
  return async (_run: RunRecord, records: ArtifactRecord[]) => { const evidence = await validateArtifacts(immutableInput, records, store); return { passed: evidence.passed, evidence }; };
}
