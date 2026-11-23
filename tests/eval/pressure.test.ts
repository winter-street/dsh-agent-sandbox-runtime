import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPressureEvaluation } from '../../eval/pressure.js';
import { RuntimeStore } from '../../src/storage/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('fixed pressure benchmark with original budget plugin and controlled provider', () => {
  it('covers gradients, bounded unsent retry, unknown admission, independent sums, finalization and durable pause state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pressure-eval-')); roots.push(root);
    const directory = join(root, 'experiment'); const report = await runPressureEvaluation(directory);
    expect(report.mode).toBe('controlled'); expect(report.conditions).toBe(27);
    expect(readFileSync(join(directory, 'plan.json'))).toEqual(readFileSync('eval/pressure-plan.json'));
    for (const result of report.results) {
      expect(result.snapshot.usedTokens).toBeLessThanOrEqual(result.budgetLimit);
      expect(result.calls).toHaveLength(result.providerCalls);
      expect(result.denialReview.reviewed).toBe(result.denials.length);
      expect(result.denialReview.rate).toBe(result.denials.length ? result.denialReview.candidateFalseDenials / result.denials.length : null);
      if (result.scenario === 'unknown-usage') {
        expect(result.status).toBe('PAUSED_ACCOUNTING'); expect(result.complete).toBe(false);
        expect(result.snapshot.unknownCalls).toBe(1); expect(result.snapshot.reservedTokens).toBeGreaterThan(0);
        expect(result.denials.at(-1)?.reasons).toContain('USAGE_UNKNOWN'); expect(result.providerCalls).toBe(3);
      } else {
        expect(result.snapshot.unknownCalls).toBe(0); expect(result.snapshot.reservedTokens).toBe(0);
        expect(result.injectedRetries).toBe(result.scenario === 'retry-unsent' ? 1 : 0);
        if (result.complete) expect(result.values).toEqual([9, 13, 12, 11, 15, 18, 18, 13]);
      }
      const store = new RuntimeStore(join(directory, `${result.budgetLimit}-${result.scenario}-${result.variant}`, 'runtime'));
      try {
        expect(store.getRun('pressure-run')).toMatchObject({ status: result.status, budgetScopeKey: result.scopeKey });
        expect(store.getPolicyState('pressure-run')).toBeDefined();
      } finally { store.close(); }
    }
    expect(report.results.find(r => r.budgetLimit === 12000 && r.variant === 'tiered-finalize' && r.scenario === 'steady'))
      .toMatchObject({ complete: true, finalization: 'model', snapshot: { finalize: { usedTokens: 450 } } });
    expect(report.results.find(r => r.budgetLimit === 3000 && r.variant === 'tiered-finalize' && r.scenario === 'steady'))
      .toMatchObject({ complete: false, finalization: 'template-budget' });
    await expect(runPressureEvaluation(directory)).rejects.toThrow('already exists');
  }, 30000);
});
