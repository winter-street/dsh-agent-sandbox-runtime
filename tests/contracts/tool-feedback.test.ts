import { describe, expect, it } from 'vitest';
import { ToolDiagnosticsSchema, validationProblems } from '../../src/contracts/tool-feedback.js';

describe('bounded trusted tool feedback', () => {
  it('projects only supported diagnostic strings and omits reference answers and unrelated evidence', () => {
    expect(validationProblems({ problems: ['missing report', { prompt: 'untrusted' }, 1], expectedStatistics: { secret: true }, rawProviderError: 'never expose' })).toEqual(['missing report']);
    expect(validationProblems({ missing: ['statistics.json'] })).toEqual(['statistics.json']);
    expect(validationProblems({ error: 'invalid JSON' })).toEqual(['invalid JSON']);
    expect(validationProblems(null)).toEqual([]);
    expect(validationProblems({ problems: Array.from({ length: 20 }, () => 'x'.repeat(1000)) })).toEqual(Array.from({ length: 8 }, () => 'x'.repeat(256)));
  });
  it('rejects oversized or authority-bearing feedback rather than silently projecting it', () => {
    const value = { schemaVersion: 1, stepId: 'step', execution: 'failed', validation: 'passed', problems: [], priorArtifacts: [],
      omittedArtifactCount: 0, repairableStepIds: ['step'], omittedRepairCount: 0, repairedStepIds: [], guidance: 'Repair the identified execution.' };
    expect(ToolDiagnosticsSchema.safeParse(value).success).toBe(true);
    expect(ToolDiagnosticsSchema.safeParse({ ...value, budgetScopeKey: 'new-budget' }).success).toBe(false);
    expect(ToolDiagnosticsSchema.safeParse({ ...value, repairableStepIds: ['../another-run'] }).success).toBe(false);
    expect(ToolDiagnosticsSchema.safeParse({ ...value, problems: ['x'.repeat(257)] }).success).toBe(false);
    expect(ToolDiagnosticsSchema.safeParse({ ...value, priorArtifacts: Array.from({ length: 9 }, () => ({ artifactId: 'artifact', inputPath: 'artifacts/artifact/statistics.json' })) }).success).toBe(false);
  });
});
