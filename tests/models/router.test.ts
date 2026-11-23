import { describe, expect, it } from 'vitest';
import { ModelRouter, schemaFingerprint, type ModelProfile, type ModelRouteRequest } from '../../src/models/router.js';

const toolHash = schemaFingerprint({ name: 'lookup', parameters: { type: 'object', properties: {} } });
const outputHash = schemaFingerprint({ type: 'object', required: ['answer'] });
export function profile(id: string, overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { id, provider: 'controlled', model: id, modelWindowTokens: 16000, maxOutputTokens: 2000,
    taskTypes: ['analysis'], toolCalling: true, structuredOutput: true, validatedToolSchemaHashes: [toolHash],
    validatedOutputSchemaHashes: [outputHash], reasoningEfforts: [], verification: 'controlled',
    verifiedAt: 'fixture-only', evidenceRefs: ['controlled fixture, not a verified production profile'], ...overrides };
}
const allocation = (limitTokens: number) => ({ limitTokens, usedTokens: 0, reservedTokens: 0, availableTokens: limitTokens });
export function request(): ModelRouteRequest {
  return { runId: 'run', stepBoundary: 0, atRequestBoundary: true, inflightModelCalls: 0, unresolvedToolCalls: 0,
    requestEconomy: true, purpose: 'work', budget: { ...allocation(30000), scopeKey: 'root', ledgerSeq: 0, unknownCalls: 0,
      exhausted: false, meteringComplete: true, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      work: allocation(28000), finalize: allocation(2000) },
    requirements: { taskType: 'analysis', toolSchemaHashes: [toolHash], outputSchemaHash: outputHash, desiredOutputTokens: 1000, minimumOutputTokens: 500 },
    countInputTokens: () => 1000 };
}
function router(profiles = [profile('main'), profile('small')], options: Record<string, unknown> = {}) {
  return new ModelRouter({ schemaVersion: 1, enabled: true, baselineId: 'main', candidates: profiles.slice(1).map(p => p.id), allowControlledProfiles: true, ...options }, profiles);
}
describe('validated sticky model routing', () => {
  it('is disabled by default and never invents remotely verified profiles', () => {
    const p = [profile('main'), profile('small')];
    const disabled = new ModelRouter({ schemaVersion: 1, baselineId: 'main', candidates: ['small'], allowControlledProfiles: true }, p).decide(request());
    expect(disabled).toMatchObject({ allowed: true, changed: false, profile: { id: 'main' } });
    const unverified = new ModelRouter({ schemaVersion: 1, enabled: true, baselineId: 'main', candidates: ['small'] }, p).decide(request());
    expect(unverified.allowed).toBe(false);
    expect(unverified.assessments.every(a => a.reasons.includes('REMOTE_PROFILE_UNVERIFIED'))).toBe(true);
  });
  it('selects a validated candidate and re-estimates its own tokenizer/window/output', () => {
    const r = request(); r.countInputTokens = p => p.id === 'small' ? 1400 : 1000;
    const decision = router([profile('main'), profile('small', { maxOutputTokens: 800 })]).decide(r);
    expect(decision).toMatchObject({ allowed: true, changed: true, inputTokens: 1400, outputTokens: 800, estimatedTokens: 2200, profile: { id: 'small' } });
  });
  it.each([
    ['tool flag', { toolCalling: false }, 'TOOL_CALLING_UNSUPPORTED'],
    ['schema', { validatedToolSchemaHashes: [] }, 'TOOL_SCHEMA_UNVERIFIED'],
    ['output schema', { validatedOutputSchemaHashes: [] }, 'OUTPUT_SCHEMA_UNVERIFIED'],
    ['task type', { taskTypes: ['translation'] }, 'TASK_TYPE_UNVERIFIED'],
    ['window', { modelWindowTokens: 2000 }, 'CONTEXT_WINDOW_TOO_SMALL'],
    ['output', { maxOutputTokens: 100 }, 'OUTPUT_SPACE_TOO_SMALL'],
  ] as const)('rejects candidate with incompatible %s while retaining valid baseline', (_name, changes, reason) => {
    const result = router([profile('main'), profile('small', changes as Partial<ModelProfile>)]).decide(request());
    expect(result).toMatchObject({ allowed: true, changed: false, profile: { id: 'main' } });
    expect(result.assessments.find(a => a.profileId === 'small')?.reasons).toContain(reason);
  });
  it('is sticky after pressure relief and restores exactly the same selected model', () => {
    const routing = router(); const first = routing.decide(request());
    expect(first.allowed).toBe(true);
    const next = routing.decide({ ...request(), requestEconomy: false, stepBoundary: 2 }, JSON.parse(JSON.stringify(first.state)));
    expect(next).toMatchObject({ allowed: true, changed: false, profile: { id: 'small' } });
    expect(first.state.lastObservedStep).toBe(0);
  });
  it.each(['inflight', 'tools', 'reserved', 'boundary'] as const)('defers switching across unsafe %s boundaries', kind => {
    const r = request();
    if (kind === 'inflight') r.inflightModelCalls = 1;
    if (kind === 'tools') r.unresolvedToolCalls = 1;
    if (kind === 'reserved') { r.budget.reservedTokens = 100; r.budget.work.reservedTokens = 100; }
    if (kind === 'boundary') r.atRequestBoundary = false;
    expect(router().decide(r)).toMatchObject({ allowed: true, changed: false, profile: { id: 'main' } });
  });
  it('respects switch limits and cooldown before a further fallback', () => {
    const routing = router([profile('main'), profile('small'), profile('tiny')], { maxSwitches: 2, minimumStableSteps: 2 });
    const first = routing.decide(request());
    const second = routing.decide({ ...request(), stepBoundary: 1 }, first.state);
    expect(second).toMatchObject({ allowed: true, changed: false, profile: { id: 'small' } });
    const third = routing.decide({ ...request(), stepBoundary: 2 }, second.state);
    expect(third).toMatchObject({ allowed: true, changed: true, profile: { id: 'tiny' } });
  });
  it('rejects unknown accounting, unavailable estimates and insufficient complete-request budget', () => {
    const routing = router(); const r = request();
    r.budget.unknownCalls = 1;
    expect(routing.decide(r)).toMatchObject({ allowed: false, reason: 'USAGE_UNKNOWN' });
    r.budget.unknownCalls = 0; r.countInputTokens = () => NaN;
    expect(routing.decide(r).allowed).toBe(false);
    r.countInputTokens = () => 1000; r.budget.usedTokens = 29500;
    expect(routing.decide(r).allowed).toBe(false);
  });
  it('validates state version/run and monotonic boundaries', () => {
    const routing = router(); const d = routing.decide({ ...request(), stepBoundary: 3 });
    expect(() => routing.decide(request(), d.state)).toThrow('backwards');
    expect(() => routing.decide({ ...request(), runId: 'other' }, d.state)).toThrow('migration');
    expect(() => router(undefined, { minimumStableSteps: 3 }).decide({ ...request(), stepBoundary: 3 }, d.state)).toThrow('migration');
  });
  it('reports monetary estimates with explicit currency without assuming lower token usage', () => {
    const d = router([profile('main'), profile('small', { pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 } })]).decide(request());
    expect(d.assessments.find(a => a.profileId === 'small')?.estimatedCost).toEqual({ currency: 'USD', amount: 0.003 });
  });
  it('canonicalizes schema object key ordering while retaining actual requirements', () => {
    expect(schemaFingerprint({ type: 'object', required: ['a'] })).toBe(schemaFingerprint({ required: ['a'], type: 'object' }));
    expect(schemaFingerprint({ required: ['b'] })).not.toBe(schemaFingerprint({ required: ['a'] }));
  });
});
