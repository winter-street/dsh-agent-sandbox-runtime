import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAULT_SCENARIOS, runFaultMatrix } from '../../eval/fault-matrix.js';

describe('controlled provider and sandbox fault matrix', () => {
  it('records bounded evidence for every required fault class', async () => {
    const output = mkdtempSync(join(tmpdir(), 'fault-matrix-'));
    const report = await runFaultMatrix(output);
    expect(report.scenarios).toBe(FAULT_SCENARIOS.length);
    expect(report.failed).toBe(0);
    expect(report.observations.every(item => item.passed)).toBe(true);
    for (const item of report.observations) {
      const failure = JSON.parse(readFileSync(item.failurePath, 'utf8')) as Record<string, unknown>;
      expect(failure).toMatchObject({ scenario: item.scenario.id, failureKind: item.failureKind, code: item.errorCode, evidence: 'evidence.json' });
      expect(JSON.stringify(failure)).not.toContain('provider body must not be persisted');
    }
  });
});
