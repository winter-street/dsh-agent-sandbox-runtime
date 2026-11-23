import { describe, expect, it } from 'vitest';
import { ToolRuleEngine, type ToolRuleAction, type ToolRuleState } from '../../src/policy/tool-rules.js';

function action(callId: string, changes: Partial<ToolRuleAction> = {}): ToolRuleAction {
  return { callId, toolName: 'search', arguments: { q: 'same' }, inputVersion: 'v1', progressVersion: 'p1', ...changes };
}
function failing(engine: ToolRuleEngine, call: ToolRuleAction, state?: ToolRuleState, errorSignature = '404') {
  const admitted = engine.admit(call, state);
  expect(admitted.allowed).toBe(true);
  return engine.record(call, { ok: false, errorSignature, progressVersion: call.progressVersion }, admitted.state);
}
describe('local tool quotas and no-progress rules', () => {
  it('warns once at the local threshold and blocks only that tool after its quota', () => {
    const engine = new ToolRuleEngine([{ toolName: 'search', warnAt: 2, maxCalls: 3 }]);
    const first = engine.admit(action('1'));
    const second = engine.admit(action('2'), first.state);
    expect(second.notifications).toHaveLength(1);
    const third = engine.admit(action('3'), second.state);
    expect(third.notifications).toHaveLength(0);
    expect(engine.admit(action('4'), third.state)).toMatchObject({ allowed: false, reason: 'TOOL_CALL_LIMIT' });
    expect(engine.admit(action('other', { toolName: 'python' }), third.state).allowed).toBe(true);
  });
  it('blocks the third identical failure without progress and deduplicates its feedback', () => {
    const engine = new ToolRuleEngine([{ toolName: 'search', warnAt: 8, maxCalls: 10 }]);
    const first = failing(engine, action('1'));
    const second = failing(engine, action('2'), first.state);
    expect(second.notifications).toHaveLength(1);
    const restored = JSON.parse(JSON.stringify(second.state)) as ToolRuleState;
    expect(engine.admit(action('3'), restored)).toMatchObject({ allowed: false, reason: 'NO_PROGRESS' });
    expect(engine.record(action('2'), { ok: false, errorSignature: '404', progressVersion: 'p1' }, restored).notifications).toEqual([]);
  });
  it.each([
    { inputVersion: 'code-v2' }, { arguments: { q: 'different' } }, { progressVersion: 'artifact-v2' },
  ])('allows meaningful change %j instead of mistaking it for a loop', changes => {
    const engine = new ToolRuleEngine([{ toolName: 'search', warnAt: 8, maxCalls: 10 }]);
    const first = failing(engine, action('1'));
    const second = failing(engine, action('2'), first.state);
    expect(engine.admit(action('3', changes), second.state).allowed).toBe(true);
  });
  it('compares error signatures and resets consecutive count after actual progress', () => {
    const engine = new ToolRuleEngine([{ toolName: 'search', warnAt: 8, maxCalls: 10 }]);
    const first = failing(engine, action('1'));
    const second = failing(engine, action('2'), first.state, '429');
    expect(engine.admit(action('3'), second.state).allowed).toBe(true);
    const third = engine.admit(action('3'), second.state);
    const progressed = engine.record(action('3'), { ok: false, errorSignature: '429', progressVersion: 'p2' }, third.state);
    expect(engine.admit(action('4', { progressVersion: 'p2' }), progressed.state).allowed).toBe(true);
  });
  it.each(['polling', 'expected-transient-retry'] as const)('explicit %s exemption retains its hard local quota', exception => {
    const engine = new ToolRuleEngine([{ toolName: 'search', warnAt: 2, maxCalls: 3, exception }]);
    const first = failing(engine, action('1'));
    const second = failing(engine, action('2'), first.state);
    const third = failing(engine, action('3'), second.state);
    expect(engine.admit(action('4'), third.state).reason).toBe('TOOL_CALL_LIMIT');
  });
  it('does not count duplicate admission twice, rejects conflicts and refuses config drift', () => {
    const engine = new ToolRuleEngine([{ toolName: 'search', warnAt: 2, maxCalls: 3 }]);
    const first = engine.admit(action('1'));
    expect(engine.admit(action('1'), first.state).state.tools.search?.calls).toBe(1);
    expect(engine.admit(action('1', { arguments: { q: 'changed' } }), first.state).reason).toBe('CALL_CONFLICT');
    expect(() => new ToolRuleEngine([{ toolName: 'search', warnAt: 2, maxCalls: 4 }]).restore(first.state)).toThrow(/migration/);
  });
});
