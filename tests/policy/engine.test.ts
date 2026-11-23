import { describe, expect, it } from 'vitest';
import { RuntimeConfigSchema } from '../../src/config.js';
import {
  PolicyEngine, type PolicyAction, type PolicySnapshot, type PolicyState,
} from '../../src/policy/engine.js';
import type { BudgetAllocation } from '../../src/contracts/budget.js';

const config = RuntimeConfigSchema.parse({ schemaVersion: 1, sandbox: { image: 'python' }, policy: { mode: 'enforce' } }).policy;
const tool: PolicyAction = { kind: 'tool', required: true };
function allocation(limitTokens: number, usedTokens = 0, reservedTokens = 0): BudgetAllocation {
  return { limitTokens, usedTokens, reservedTokens, availableTokens: Math.max(0, limitTokens - usedTokens - reservedTokens) };
}
function snapshot(used = 0, reserved = 0, overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    budget: {
      ...allocation(10000, used, reserved), scopeKey: 'root', ledgerSeq: 0, unknownCalls: 0,
      exhausted: used + reserved >= 10000, meteringComplete: true,
      usage: { inputTokens: used, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      work: allocation(9500, used, reserved), finalize: allocation(500),
    },
    cancelled: false, deadlineExceeded: false, inflightModelCalls: reserved > 0 ? 1 : 0,
    stepBoundary: 0, settlementBoundary: 0, ...overrides,
  };
}
function model(estimatedTokens = 100): PolicyAction {
  return { kind: 'model', purpose: 'work', required: true, estimatedTokens };
}
function jsonRoundtrip(state: PolicyState): PolicyState { return JSON.parse(JSON.stringify(state)) as PolicyState; }

describe('pure budget policy engine', () => {
  it.each([
    [4999, 'normal'], [5000, 'notice'], [6499, 'notice'], [6500, 'conserve'],
    [7999, 'conserve'], [8000, 'focus'], [9499, 'focus'], [9500, 'finalize'],
  ] as const)('settled usage %i enters %s at exact thresholds', (used, stage) => {
    expect(new PolicyEngine(config).evaluate(snapshot(used), tool).stage).toBe(stage);
  });

  it('is deterministic without mutating the snapshot, action, config or prior state', () => {
    const engine = new PolicyEngine(config);
    const current = snapshot(8000);
    const prior = engine.evaluate(snapshot(5000), tool).state;
    const before = JSON.stringify({ current, prior, tool, config });
    const first = engine.evaluate(current, tool, prior);
    expect(engine.evaluate(current, tool, prior)).toEqual(first);
    expect(JSON.stringify({ current, prior, tool, config })).toBe(before);
    expect(first.state).not.toBe(prior);
    expect(first.state.notifiedStages).not.toBe(prior.notifiedStages);
  });

  it('keeps used and reserved pressure separate', () => {
    const decision = new PolicyEngine(config).evaluate(snapshot(4000, 2500), tool);
    expect(decision.pressure).toEqual({ used: 0.4, reserved: 0.25, total: 0.65 });
    expect(decision.stage).toBe('conserve');
    expect(decision.limits.maxModelConcurrency).toBe(1);
  });

  it('waits at 95% caused by reservations without latching finalize', () => {
    const engine = new PolicyEngine(config);
    const waiting = engine.evaluate(snapshot(6000, 3500), tool);
    expect(waiting.disposition).toBe('wait');
    expect(waiting.state.finalized).toBe(false);
    expect(waiting.reasons).toContainEqual(expect.objectContaining({ code: 'WAIT_INFLIGHT' }));
    const settled = engine.evaluate(snapshot(6200, 0, { stepBoundary: 1, settlementBoundary: 1 }), tool, waiting.state);
    expect(settled.disposition).toBe('allow');
    expect(settled.stage).toBe('notice');
  });

  it('waits when ordinary capacity could return after an inflight reservation settles', () => {
    const decision = new PolicyEngine(config).evaluate(snapshot(2000, 7000), model(1000));
    expect(decision.disposition).toBe('wait');
    expect(decision.state.finalized).toBe(false);
    expect(decision.reasons.map(reason => reason.code)).toContain('WORK_BUDGET_UNAVAILABLE');
  });

  it('does not latch finalization for an oversized optional model request', () => {
    const decision = new PolicyEngine(config).evaluate(snapshot(1000), { kind: 'model', purpose: 'work', required: false, estimatedTokens: 9000 });
    expect(decision.disposition).toBe('deny');
    expect(decision.state.finalized).toBe(false);
  });

  it('ordinary required-call shortage enters finalization and never spends a second total', () => {
    const engine = new PolicyEngine(config);
    const first = engine.evaluate(snapshot(9400), model(200));
    expect(first.disposition).toBe('deny');
    expect(first.state.finalized).toBe(true);
    const allowed = engine.evaluate(snapshot(9400), { kind: 'model', purpose: 'finalize', required: true, intent: 'final-report', estimatedTokens: 400 }, first.state);
    expect(allowed.disposition).toBe('allow');
    const tooLarge = engine.evaluate(snapshot(9400), { kind: 'model', purpose: 'finalize', required: true, intent: 'final-report', estimatedTokens: 700 }, first.state);
    expect(tooLarge.disposition).toBe('deny');
    expect(tooLarge.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['GLOBAL_BUDGET_UNAVAILABLE', 'FINALIZE_BUDGET_UNAVAILABLE']));
  });

  it('requires both trusted final report intent and latched stage for finalize credit', () => {
    const engine = new PolicyEngine(config);
    const request: PolicyAction = { kind: 'model', purpose: 'finalize', required: true, estimatedTokens: 100 };
    expect(engine.evaluate(snapshot(9500), request).reasons).toContainEqual(expect.objectContaining({ code: 'FINALIZE_INTENT_REQUIRED', hard: true }));
    expect(engine.evaluate(snapshot(1000), { ...request, intent: 'final-report' as const }).disposition).toBe('deny');
  });

  it.each(['observe', 'enforce'] as const)('retains all hard prohibitions in %s mode', mode => {
    const engine = new PolicyEngine({ ...config, mode });
    const current = snapshot(9600, 0, { cancelled: true, deadlineExceeded: true, permissionDenied: true });
    current.budget.unknownCalls = 1;
    current.budget.meteringComplete = false;
    const decision = engine.evaluate(current, model());
    expect(decision.disposition).toBe('deny');
    expect(decision.reasons.filter(reason => reason.hard).map(reason => reason.code)).toEqual(expect.arrayContaining([
      'CANCELLED', 'DEADLINE_EXCEEDED', 'PERMISSION_DENIED', 'USAGE_UNKNOWN', 'WORK_BUDGET_UNAVAILABLE',
    ]));
  });

  it('observe records proposed limits while applying baseline behavior', () => {
    const engine = new PolicyEngine({ ...config, mode: 'observe' });
    const decision = engine.evaluate(snapshot(8500), { kind: 'spawn-agent', required: false });
    expect(decision.allowed).toBe(true);
    expect(decision.limits).toEqual({ maxModelConcurrency: 2, allowOptionalWork: true, allowNewAgents: true });
    expect(decision.proposedLimits).toEqual({ maxModelConcurrency: 1, allowOptionalWork: false, allowNewAgents: false });
    expect(decision.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['OPTIONAL_WORK_BLOCKED', 'NEW_AGENT_BLOCKED']));
  });

  it('observe still waits on the original hard concurrency ceiling', () => {
    const engine = new PolicyEngine({ ...config, mode: 'observe' });
    expect(engine.evaluate(snapshot(6500, 0, { inflightModelCalls: 1 }), model()).allowed).toBe(true);
    expect(engine.evaluate(snapshot(6500, 0, { inflightModelCalls: 2 }), model()).disposition).toBe('wait');
  });

  it('enforce narrows future concurrency without cancelling calls already underway', () => {
    const decision = new PolicyEngine(config).evaluate(snapshot(6500, 0, { inflightModelCalls: 1 }), model());
    expect(decision.disposition).toBe('wait');
    expect(decision.limits.maxModelConcurrency).toBe(1);
    expect(decision.reasons).toContainEqual(expect.objectContaining({ code: 'MODEL_CONCURRENCY_LIMIT', hard: false }));
  });

  it.each(['code', 'structured'] as const)('preserves the complete %s output budget', kind => {
    const decision = new PolicyEngine(config).evaluate(snapshot(8000), {
      kind: 'model', purpose: 'work', required: true, estimatedTokens: 200,
      output: { kind, maxTokens: 800, minTokens: 300 },
    });
    expect(decision.limits.outputTokenCap).toBe(800);
    expect(decision.requiresReestimate).toBe(false);
  });

  it('reduces prose with a minimum floor and requires the final request to be re-estimated', () => {
    const decision = new PolicyEngine(config).evaluate(snapshot(8000), {
      kind: 'model', purpose: 'work', required: true, estimatedTokens: 200,
      output: { kind: 'prose', maxTokens: 800, minTokens: 500 },
    });
    expect(decision.limits.outputTokenCap).toBe(500);
    expect(decision.requiresReestimate).toBe(true);
  });

  it('zero total and zero finalize allocation deny model work but preserve cleanup', () => {
    const current = snapshot();
    current.budget = { ...current.budget, ...allocation(0), work: allocation(0), finalize: allocation(0) };
    const engine = new PolicyEngine(config);
    const denied = engine.evaluate(current, { kind: 'model', purpose: 'finalize', required: true, intent: 'final-report', estimatedTokens: 1 });
    expect(denied.disposition).toBe('deny');
    expect(Number.isFinite(denied.pressure.total)).toBe(true);
    expect(engine.evaluate(current, { kind: 'cleanup' }).allowed).toBe(true);
  });

  it('allows only maintenance after cancellation/unknown usage, respecting its permissions', () => {
    const current = snapshot(9500, 0, { cancelled: true, deadlineExceeded: true });
    current.budget.unknownCalls = 1;
    current.budget.meteringComplete = false;
    const engine = new PolicyEngine(config);
    for (const kind of ['cleanup', 'collect', 'checkpoint'] as const) expect(engine.evaluate(current, { kind }).allowed).toBe(true);
    expect(engine.evaluate({ ...current, permissionDenied: true }, { kind: 'collect' }).allowed).toBe(false);
    expect(engine.evaluate(current, { kind: 'tool', required: true, finalizeAllowed: true }).allowed).toBe(false);
  });

  it('verified acceptance completion finalizes and keeps required verification available', () => {
    const engine = new PolicyEngine(config);
    const current = snapshot(2000, 0, { requiredWorkComplete: true });
    expect(engine.evaluate(current, tool).disposition).toBe('finalize');
    expect(engine.evaluate(current, { kind: 'tool', required: true, finalizeAllowed: true }).allowed).toBe(true);
    expect(engine.evaluate(current, { kind: 'spawn-agent', required: true }).allowed).toBe(false);
  });

  it('does not trust a stale cached available balance over used and reserved figures', () => {
    const current = snapshot(9900);
    current.budget.availableTokens = 10000;
    current.budget.work.availableTokens = 10000;
    expect(new PolicyEngine(config).evaluate(current, model(200)).allowed).toBe(false);
  });
});

describe('serializable policy recovery, hysteresis and notifications', () => {
  it('requires hysteresis, a settlement and two step boundaries to recover capacity', () => {
    const engine = new PolicyEngine(config);
    const state = engine.evaluate(snapshot(4000, 2500), tool).state;
    expect(engine.evaluate(snapshot(6000, 0, { stepBoundary: 2, settlementBoundary: 1 }), tool, state).stage).toBe('conserve');
    expect(engine.evaluate(snapshot(5900, 0, { stepBoundary: 1, settlementBoundary: 1 }), tool, state).stage).toBe('conserve');
    expect(engine.evaluate(snapshot(5900, 0, { stepBoundary: 2, settlementBoundary: 0 }), tool, state).stage).toBe('conserve');
    expect(engine.evaluate(snapshot(5900, 0, { stepBoundary: 2, settlementBoundary: 1 }), tool, state).stage).toBe('notice');
  });

  it('does not repeat a stage notification after a JSON roundtrip or later re-entry', () => {
    const engine = new PolicyEngine(config);
    const first = engine.evaluate(snapshot(6500), tool);
    expect(first.notifications).toHaveLength(1);
    const again = engine.evaluate(snapshot(6500), tool, jsonRoundtrip(first.state));
    expect(again.notifications).toEqual([]);
    const lower = engine.evaluate(snapshot(4000, 0, { stepBoundary: 2, settlementBoundary: 1 }), tool, again.state);
    const higher = engine.evaluate(snapshot(6500, 0, { stepBoundary: 3, settlementBoundary: 2 }), tool, jsonRoundtrip(lower.state));
    expect(higher.stage).toBe('conserve');
    expect(higher.notifications).toEqual([]);
  });

  it('retains finalization over restart and lower pressure until explicit operator release', () => {
    const engine = new PolicyEngine(config);
    const first = engine.evaluate(snapshot(9500), tool);
    const current = snapshot(1000, 0, { stepBoundary: 10, settlementBoundary: 10 });
    const latched = engine.evaluate(current, tool, jsonRoundtrip(first.state));
    expect(latched.stage).toBe('finalize');
    expect(latched.disposition).toBe('finalize');
    const released = engine.releaseFinalize(latched.state, 'operator increased the task budget');
    expect(engine.evaluate(current, tool, released).stage).toBe('normal');
    expect(released.lastOperatorReason).toBe('operator increased the task budget');
    expect(() => engine.releaseFinalize(latched.state, ' ')).toThrow();
  });

  it('rejects policy/schema/config incompatibility and backwards boundary counters', () => {
    const engine = new PolicyEngine(config);
    const state = engine.evaluate(snapshot(6500, 0, { stepBoundary: 2, settlementBoundary: 1 }), tool).state;
    expect(() => new PolicyEngine(config, { version: 'budget-policy-v2' }).restoreState(state)).toThrow(/migration/);
    // Observe mode deliberately migrates stale latched state to a clean baseline
    // instead of bricking the conversation; enforce mode still refuses.
    const observed = new PolicyEngine({ ...config, mode: 'observe' }).restoreState(state);
    expect(observed.lastStepBoundary).toBe(0);
    expect(observed.lastSettlementBoundary).toBe(0);
    expect(observed.evaluationCount).toBe(0);
    expect(() => engine.restoreState({ ...state, schemaVersion: 2 })).toThrow();
    expect(() => engine.restoreState({ ...state, finalized: true })).toThrow();
    expect(() => engine.evaluate(snapshot(6500), tool, state)).toThrow(/backwards/);
  });

  it('rejects invalid numbers and a zero-length model estimate', () => {
    const engine = new PolicyEngine(config);
    expect(() => engine.evaluate(snapshot(Number.NaN), tool)).toThrow();
    expect(() => engine.evaluate(snapshot(-1), tool)).toThrow();
    expect(() => engine.evaluate(snapshot(), model(0))).toThrow();
    expect(() => new PolicyEngine({ ...config, noticeRatio: 0.9 })).toThrow();
  });
});
