import { describe, expect, it } from 'vitest';
import validate from '../../examples/charging-analysis/validator.js';
import type { ArtifactRecord } from '../../src/contracts/runtime.js';

function artifact(path: string, content: string): ArtifactRecord {
  return { artifactId: `artifact-${path.replaceAll(/[^A-Za-z0-9]/g, '-')}`, runId: 'run', attemptId: 'attempt', path,
    size: Buffer.byteLength(content), sha256: 'a'.repeat(64) };
}

const run = { runId: 'run', rootSessionId: 'session', budgetScopeKey: 'scope', task: 'task', deadline: 100,
  policyVersion: 'v1', inputHash: 'a'.repeat(64), status: 'RUNNING' as const, revision: 0, createdAt: 0, updatedAt: 0, outcome: null };

describe('charging-analysis task validator', () => {
  it('accepts the required committed artifact shape through the read-only reader', async () => {
    const values = new Map<string, Uint8Array>([
      ['statistics.json', Buffer.from(JSON.stringify({ total_alerts: 0, confirmed: 0, rejected: 0, pending: 0,
        false_positive_rate: null, devices: [], time_bands: {}, severity: {} }))],
      ['report.md', Buffer.from('# report')], ['chart.png', Buffer.from('png')],
    ]);
    const records = [...values.entries()].map(([path, bytes]) => artifact(path, Buffer.from(bytes).toString()));
    const result = await validate(run, records, async record => values.get(record.path)!);
    expect(result.passed).toBe(true);
  });

  it('rejects missing or malformed committed artifacts without reading arbitrary paths', async () => {
    const result = await validate(run, [artifact('statistics.json', '{bad')], async () => Buffer.from('{bad'));
    expect(result.passed).toBe(false);
    expect(result.evidence).toMatchObject({ missing: ['report.md', 'chart'] });
  });
});
