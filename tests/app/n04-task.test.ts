import { describe, expect, it } from 'vitest';
import { expected, reportLines, verifyDelivery } from '../../spikes/n04/task.js';
function files(value: unknown = expected) { return new Map([
  ['ranking.json', Buffer.from(JSON.stringify(value))], ['report.md', Buffer.from(reportLines.join('\n'))],
]); }
describe('N04 independent ranking acceptance', () => {
  it('accepts the complete independently derived contract', () => { expect(verifyDelivery(files()).passed).toBe(true); });
  it('rejects a tied ranking reversed despite unchanged totals', () => {
    const value = structuredClone(expected); [value.ranking[0], value.ranking[1]] = [value.ranking[1]!, value.ranking[0]!];
    expect(verifyDelivery(files(value)).passed).toBe(false);
  });
  it('rejects a fabricated count, a missing report and an extra artifact', () => {
    expect(verifyDelivery(files({ ...expected, total_count: 99 })).passed).toBe(false);
    const missing = files(); missing.delete('report.md'); expect(verifyDelivery(missing).passed).toBe(false);
    const extra = files(); extra.set('secret.txt', Buffer.from('extra')); expect(verifyDelivery(extra).passed).toBe(false);
  });
  it('rejects mismatched visible report even with valid JSON', () => {
    const value = files(); value.set('report.md', Buffer.from('Rows: 6\nTotal: 14\n')); expect(verifyDelivery(value).passed).toBe(false);
  });
});
