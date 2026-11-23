import { afterEach, describe, expect, it } from 'vitest';
import { GraphStateStore, validateGraph, validateBranchResult, conditionMatches, type WorkflowGraph } from '../../src/workflow/graph.js';
import { runtimeFixture } from '../support/runtime.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const graph = (): WorkflowGraph => ({ version: 1, graphId: 'g', nodes: [{ id: 'a', required: true, dependencies: [] }] });
async function setup() { const t = await runtimeFixture(); cleanup.push(t.dispose); return { ...t, persistence: new GraphStateStore(t.store, t.clock.now) }; }

describe('versioned graph state and transactional claims (actual SQLite)', () => {
  it.each([
    { version: 1, graphId: 'g', nodes: [{ id: 'a', required: true, dependencies: ['a'] }] },
    { version: 1, graphId: 'g', nodes: [{ id: 'a', required: true, dependencies: ['missing'] }] },
    { version: 1, graphId: 'g', nodes: [{ id: 'a', required: false, dependencies: [] }, { id: 'b', required: true, dependencies: ['a'] }] },
    { version: 1, graphId: 'g', nodes: [{ id: 'a', required: true, dependencies: [] }, { id: 'b', required: false, dependencies: ['a', 'a'] }] },
    { version: 1, graphId: 'g', nodes: [{ id: 'a', required: false, dependencies: [], condition: { node: 'other', field: 'x', equals: true } }] },
    { version: 1, graphId: 'g', nodes: [{ id: 'a', required: true, dependencies: [] }, { id: 'a', required: true, dependencies: [] }] },
  ])('rejects invalid dependency topology %#', value => { expect(() => validateGraph(value)).toThrow(); });

  it('claims synchronously across distinct store facades and fences stale owners', async () => {
    const t = await setup(); const g = graph(); const first = t.persistence.claim('run', g, 'scope', 'host');
    const second = new GraphStateStore(t.store, t.clock.now);
    expect(() => second.claim('run', g, 'scope', 'host')).toThrow('owner');
    expect(() => second.update('run', g, 'scope', 'host', 'other', () => {}, 'test', {})).toThrow('claim');
    expect(() => second.reconcile('run', g, 'scope', 'host', first.revision, {}, 'inspected')).toThrow('active owner');
    t.persistence.release('run', g, 'scope', 'host', first.owner!);
    const next = second.claim('run', g, 'scope', 'host'); expect(next.revision).toBeGreaterThan(first.revision);
    second.release('run', g, 'scope', 'host', next.owner!);
  });

  it.each([{ version: 1 }, { version: 2, nodes: {} }, { version: 200 }])('rejects corrupt or unsupported persisted state %#', async raw => {
    const t = await setup(); t.store.setComponentState('run', 'graphs', 'g', raw);
    expect(() => t.persistence.load('run', graph())).toThrow('state');
  });

  it('binds root input, scope, deadline and trusted host identity', async () => {
    const t = await setup(); const g = graph(); const s = t.persistence.claim('run', g, 'scope', 'host');
    t.persistence.release('run', g, 'scope', 'host', s.owner!);
    expect(() => t.persistence.load('run', g, 'other', 'host')).toThrow('scope');
    expect(() => t.persistence.load('run', g, 'scope', 'changed')).toThrow('identity');
    expect(() => t.persistence.load('run', { ...g, nodes: [...g.nodes, { id: 'b', required: false, dependencies: [] }] }, 'scope', 'host')).toThrow('identity');
    t.clock.set(100000); expect(() => t.persistence.claim('run', g, 'scope', 'host')).toThrow('deadline');
  });

  it('requires explicit revision and every unresolved outcome; cannot reset pending for retry', async () => {
    const t = await setup(); const g = graph(); const s = t.persistence.claim('run', g, 'scope', 'host');
    t.persistence.update('run', g, 'scope', 'host', s.owner!, state => { state.nodes.a = { status: 'unknown', claimId: 'dispatch', reason: 'lost response' }; }, 'test', {});
    t.persistence.release('run', g, 'scope', 'host', s.owner!);
    const current = t.persistence.load('run', g, 'scope', 'host');
    expect(() => t.persistence.claim('run', g, 'scope', 'host')).toThrow('unresolved');
    expect(() => t.persistence.reconcile('run', g, 'scope', 'host', current.revision - 1, {}, 'remote inspection')).toThrow('revision');
    expect(() => t.persistence.reconcile('run', g, 'scope', 'host', current.revision, {}, 'remote inspection')).toThrow('Every unresolved');
    expect(() => t.persistence.reconcile('run', g, 'scope', 'host', current.revision, { a: { status: 'pending' } }, 'remote inspection')).toThrow('redispatch');
    const resolved = t.persistence.reconcile('run', g, 'scope', 'host', current.revision, { a: { status: 'cancelled', reason: 'remote stop confirmed' } }, 'remote inspection');
    expect(resolved.nodes.a!.status).toBe('cancelled');
  });

  it.each(['branches/a/../out', 'branches/a//out', 'branches/a/out\\file', 'branches/a/out:stream', 'branches/b/out', 'branches/a/out.', 'branches/a/out\u0000', 'branches/a/NUL.json', 'branches/a/file?.json'])('rejects unsafe branch artifact %s', path => {
    expect(() => validateBranchResult('a', { data: {}, artifacts: [{ path, sha256: 'a'.repeat(64), size: 1 }] })).toThrow('namespace');
  });
  it('rejects non-finite data and case-colliding manifests', () => {
    expect(() => validateBranchResult('a', { data: { x: Infinity }, artifacts: [] })).toThrow('schema');
    expect(() => validateBranchResult('a', { data: {}, artifacts: ['Out', 'out'].map(p => ({ path: `branches/a/${p}`, sha256: 'a'.repeat(64), size: 1 })) })).toThrow('namespace');
    expect(() => validateBranchResult('a', { data: {}, artifacts: ['out', 'out/file'].map(p => ({ path: `branches/a/${p}`, sha256: 'a'.repeat(64), size: 1 })) })).toThrow('file/directory');
  });
  it('conditions require done dependency and exact own-property values', async () => {
    const t = await setup(); const s = t.persistence.load('run', graph()); const n = { id: 'b', required: false, dependencies: ['a'], condition: { node: 'a', field: 'x.y', equals: true } };
    expect(conditionMatches(n, s)).toBe(false);
    s.nodes.a = { status: 'done', claimId: 'd', result: { data: { x: { y: true } }, artifacts: [] } };
    expect(conditionMatches(n, s)).toBe(true);
    expect(conditionMatches({ ...n, condition: { ...n.condition, field: 'toString' } }, s)).toBe(false);
  });
});
