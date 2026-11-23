/** Real SQLite; branch callbacks are explicit fake remote executors. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeError } from '../../src/contracts/runtime.js';
import { GraphStateStore, type GraphNodeResult, type WorkflowGraph } from '../../src/workflow/graph.js';
import { ParallelWorkflow, type ParallelOptions } from '../../src/workflow/parallel.js';
import { runtimeFixture } from '../support/runtime.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const g = (...ids: string[]): WorkflowGraph => ({ version: 1, graphId: 'g', nodes: ids.map(id => ({ id, required: true, dependencies: [] })) });
const result = (id: string): GraphNodeResult => ({ data: { id }, artifacts: [] });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function setup(options: Partial<ParallelOptions> = {}) {
  const t = await runtimeFixture(); cleanup.push(t.dispose); const persistence = new GraphStateStore(t.store, t.clock.now);
  const opts: ParallelOptions = { maxConcurrency: 2, cancellationTimeoutMs: 25, currentLimit: async () => 2,
    assertAdmission: async () => {}, execute: async n => result(n.id), verifyArtifact: async () => {}, cancel: async () => true, ...options };
  const workflow = new ParallelWorkflow(persistence, opts);
  return { ...t, persistence, opts, workflow };
}
describe('bounded parallel workflow with explicit fake branch callbacks', () => {
  it('bounds concurrent branches and samples the dynamic limit before each launch', async () => {
    const gates = new Map(['a', 'b', 'c'].map(id => [id, deferred<GraphNodeResult>()])); const started: string[] = []; let running = 0; let peak = 0;
    const t = await setup({ execute: async n => { started.push(n.id); running++; peak = Math.max(peak, running); const r = await gates.get(n.id)!.promise; running--; return r; } });
    const pending = t.workflow.run('run', 'scope', g('a', 'b', 'c'));
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    gates.get('a')!.resolve(result('a')); await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    gates.get('b')!.resolve(result('b')); gates.get('c')!.resolve(result('c'));
    expect((await pending).complete).toBe(true); expect(peak).toBe(2);
    expect(t.persistence.load('run', g('a', 'b', 'c'), 'scope', t.workflow.identity).owner).toBe(null);
  });
  it('zero dynamic concurrency pauses pending work without dispatching', async () => {
    const execute = vi.fn(async () => result('a')); const t = await setup({ currentLimit: async () => 0, execute });
    const first = await t.workflow.run('run', 'scope', g('a')); expect(first.complete).toBe(false); expect(execute).not.toHaveBeenCalled();
    const second = new ParallelWorkflow(t.persistence, { ...t.opts, currentLimit: async () => 1 });
    expect((await second.run('run', 'scope', g('a'))).complete).toBe(true);
  });
  it('rechecks a reduced limit without cancelling already dispatched branches', async () => {
    const gate = deferred<GraphNodeResult>(); let limit = 2; const execute = vi.fn(async () => { limit = 0; return gate.promise; });
    const t = await setup({ currentLimit: async () => limit, execute }); const p = t.workflow.run('run', 'scope', g('a', 'b'));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1)); gate.resolve(result('a'));
    const outcome = await p; expect(outcome.complete).toBe(false); expect(outcome.state.nodes.a!.status).toBe('done'); expect(outcome.state.nodes.b!.status).toBe('pending');
  });
  it('distinct runner objects cannot dispatch the same persisted graph', async () => {
    const gate = deferred<GraphNodeResult>(); const execute = vi.fn(async () => gate.promise); const t = await setup({ execute });
    const p = t.workflow.run('run', 'scope', g('a')); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const other = new ParallelWorkflow(new GraphStateStore(t.store, t.clock.now), t.opts);
    await expect(other.run('run', 'scope', g('a'))).rejects.toThrow('unresolved'); gate.resolve(result('a')); await p;
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('optional failures and false conditions permit required completion', async () => {
    const t = await setup({ execute: async n => { if (n.id === 'optional') throw new Error('fake script failure'); return { data: { route: false }, artifacts: [] }; } });
    const graph: WorkflowGraph = { ...g('required'), nodes: [...g('required').nodes,
      { id: 'optional', required: false, dependencies: [] },
      { id: 'conditional', required: false, dependencies: ['required'], condition: { node: 'required', field: 'route', equals: true } },
      { id: 'dependent', required: false, dependencies: ['optional'] }] };
    const out = await t.workflow.run('run', 'scope', graph);
    expect(out.complete).toBe(true); expect(Object.fromEntries(Object.entries(out.state.nodes).map(([id, n]) => [id, n.status]))).toEqual({ required: 'done', optional: 'failed', conditional: 'skipped', dependent: 'skipped' });
  });
  it('passes only committed direct dependencies to a true conditional branch', async () => {
    const calls: string[] = []; const t = await setup({ execute: async (n, _c, deps) => { calls.push(n.id); if (n.id === 'b') expect(deps).toEqual({ a: { data: { ready: true }, artifacts: [] } }); return { data: { ready: true }, artifacts: [] }; } });
    const graph: WorkflowGraph = { ...g('a'), nodes: [...g('a').nodes, { id: 'b', required: false, dependencies: ['a'], condition: { node: 'a', field: 'ready', equals: true } }] };
    expect((await t.workflow.run('run', 'scope', graph)).complete).toBe(true); expect(calls).toEqual(['a', 'b']);
  });
  it('an optional UNKNOWN blocks completion and prevents automatic retry', async () => {
    const execute = vi.fn(async () => { throw new RuntimeError('EXECUTION_UNKNOWN', 'fake lost remote response'); }); const t = await setup({ execute });
    const graph: WorkflowGraph = { ...g('a'), nodes: [{ id: 'a', required: false, dependencies: [] }] };
    const out = await t.workflow.run('run', 'scope', graph); expect(out.complete).toBe(false); expect(out.state.nodes.a!.status).toBe('unknown');
    await expect(new ParallelWorkflow(t.persistence, t.opts).run('run', 'scope', graph)).rejects.toThrow('unresolved'); expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each([false, 'hang', 'throw'] as const)('unconfirmed remote cancellation (%s) is bounded and remains UNKNOWN', async mode => {
    const started = deferred<void>(); const never = deferred<GraphNodeResult>(); const abort = new AbortController();
    const t = await setup({ execute: async () => { started.resolve(); return never.promise; }, cancel: async () => {
      if (mode === 'throw') throw new Error('fake cancellation transport error'); if (mode === 'hang') return new Promise<boolean>(() => {}); return false;
    } });
    const p = t.workflow.run('run', 'scope', g('a'), abort.signal); await started.promise; abort.abort();
    const out = await p; expect(out.complete).toBe(false); expect(out.state.nodes.a!.status).toBe('unknown');
    never.resolve(result('a')); await Promise.resolve(); await Promise.resolve();
    expect(t.persistence.load('run', g('a'), 'scope', t.workflow.identity).nodes.a!.status).toBe('unknown');
  });
  it('confirmed cancellation fences late successful callbacks without awaiting them forever', async () => {
    const started = deferred<void>(); const late = deferred<GraphNodeResult>(); const abort = new AbortController(); const cancel = vi.fn(async () => true);
    const t = await setup({ execute: async () => { started.resolve(); return late.promise; }, cancel });
    const p = t.workflow.run('run', 'scope', g('a'), abort.signal); await started.promise; abort.abort(); const out = await p;
    expect(out.state.nodes.a!.status).toBe('cancelled'); expect(cancel).toHaveBeenCalledTimes(1);
    late.resolve(result('a')); await Promise.resolve(); await Promise.resolve();
    expect(t.persistence.load('run', g('a'), 'scope', t.workflow.identity).nodes.a!.status).toBe('cancelled');
  });
  it('unexpected scheduler errors clean up every active remote branch', async () => {
    const started = deferred<void>(); let calls = 0; const cancel = vi.fn(async () => false);
    const t = await setup({ execute: async () => { started.resolve(); return new Promise<GraphNodeResult>(() => {}); }, currentLimit: async () => { if (++calls > 1) throw new Error('fake policy failure'); return 2; }, cancel });
    await expect(t.workflow.run('run', 'scope', g('a', 'b'))).rejects.toThrow('fake policy failure');
    expect(cancel).toHaveBeenCalledTimes(1); const state = t.persistence.load('run', g('a', 'b'), 'scope', t.workflow.identity);
    expect(state.owner).toBeTruthy(); expect(state.nodes.a!.status).toBe('unknown');
    expect(() => t.persistence.claimReconciliation('run', g('a', 'b'), 'scope', t.workflow.identity, state.revision, 'host inspect')).toThrow('active owner');
  });
  it('root pause after an asynchronous limit check prevents new remote dispatch', async () => {
    const execute = vi.fn(async () => result('a')); const t = await setup({ execute });
    t.opts.currentLimit = async () => { t.store.transitionRun('run', 'PAUSED_BUDGET'); return 2; };
    await expect(t.workflow.run('run', 'scope', g('a'))).rejects.toThrow('paused'); expect(execute).not.toHaveBeenCalled();
  });
  it('observes a host pause while a remote callback hangs and returns the released state revision', async () => {
    const started = deferred<void>(); const cancel = vi.fn(async () => true);
    const t = await setup({ execute: async () => { started.resolve(); return new Promise<GraphNodeResult>(() => {}); }, cancel });
    const pending = t.workflow.run('run', 'scope', g('a')); const rejected = expect(pending).rejects.toThrow('paused');
    await started.promise; t.store.transitionRun('run', 'PAUSED_BUDGET'); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1); const state = t.persistence.load('run', g('a'), 'scope', t.workflow.identity);
    expect(state.nodes.a!.status).toBe('cancelled'); expect(state.owner).toBe(null);
    const other = await setup(); const out = await other.workflow.run('run', 'scope', g('a'));
    expect(out.state.revision).toBe(other.persistence.load('run', g('a'), 'scope', other.workflow.identity).revision);
  });
  it('a generic post-dispatch error requires stop confirmation, while admission errors are unsent', async () => {
    const cancel = vi.fn(async () => false); const t = await setup({ execute: async () => { throw new Error('fake remote exception'); }, cancel });
    expect((await t.workflow.run('run', 'scope', g('a'))).state.nodes.a!.status).toBe('unknown'); expect(cancel).toHaveBeenCalledTimes(1);
    const other = await setup({ assertAdmission: async () => { throw new Error('admission denied'); }, cancel });
    expect((await other.workflow.run('run', 'scope', g('a'))).state.nodes.a!.status).toBe('failed'); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('reverifies prior results and poisons dependent completed evidence after tampering', async () => {
    let intact = true; const execute = vi.fn(async n => ({ data: {}, artifacts: [{ path: `branches/${n.id}/result.json`, sha256: 'a'.repeat(64), size: 1 }] }));
    const t = await setup({ execute, verifyArtifact: async () => { if (!intact) throw new RuntimeError('ARTIFACT_INVALID', 'fake modified artifact'); } });
    const graph: WorkflowGraph = { ...g('a'), nodes: [...g('a').nodes, { id: 'b', required: true, dependencies: ['a'] }] };
    expect((await t.workflow.run('run', 'scope', graph)).complete).toBe(true); intact = false;
    await expect(t.workflow.run('run', 'scope', graph)).rejects.toThrow('modified');
    const state = t.persistence.load('run', graph, 'scope', t.workflow.identity);
    expect(state.nodes.a!.status).toBe('unknown'); expect(state.nodes.b!.status).toBe('unknown'); expect(execute).toHaveBeenCalledTimes(2);
  });
});
