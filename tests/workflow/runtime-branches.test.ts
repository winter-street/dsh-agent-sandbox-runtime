/** Actual RuntimeService, SQLite and ArtifactStore; sandbox/budget/time are explicit in-memory fakes. No Docker/model calls. */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { RuntimeBranchWorkflow, type RuntimeBranchBinding, type RuntimeBranchesOptions } from '../../src/workflow/runtime-branches.js';
import { normalizeResourceSample } from '../../src/resources/index.js';
import { ResourcePolicy } from '../../src/resources/policy.js';
import type { WorkflowGraph } from '../../src/workflow/graph.js';
import type { ExecutionRef, ExecutionRequest } from '../../src/contracts/sandbox.js';
import { runtimeFixture } from '../support/runtime.js';
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) f(); });
const graph = (...ids: string[]): WorkflowGraph => ({ version: 1, graphId: 'actual-services', nodes: ids.map(id => ({ id, required: true, dependencies: [] })) });
function binding(sessionId = 'executor'): RuntimeBranchBinding {
  return { sessionId, code: 'print("explicit fake remote plan supplies test output")', inputs: [{ path: 'input.txt', content: Buffer.from('original') }],
    expectedArtifacts: ['result.json'], validatorVersion: 'independent-test-v1',
    validate: async ({ artifacts, read }) => {
      const artifact = artifacts.find(a => a.path === 'result.json');
      const value = artifact ? JSON.parse(Buffer.from(await read(artifact)).toString('utf8')) as { answer?: number } : {};
      return { passed: value.answer === 42, data: { answer: value.answer ?? null } };
    } };
}
async function setup(g = graph('a', 'b'), overrides: Partial<RuntimeBranchesOptions> = {}, bindings?: Record<string, RuntimeBranchBinding>) {
  const t = await runtimeFixture(); cleanup.push(t.dispose);
  const b = bindings ?? Object.fromEntries(g.nodes.map(n => [n.id, binding()]));
  const options: RuntimeBranchesOptions = { maxConcurrency: 2, currentLimit: async () => 2, now: t.clock.now,
    cancellationTimeoutMs: 50, serviceOptions: { now: t.clock.now, wait: t.clock.sleep, cancelConfirmationTimeoutMs: 10 }, ...overrides };
  return { ...t, bindings: b, options, workflow: new RuntimeBranchWorkflow(t.service, g, b, options), graph: g };
}
function success(t: Awaited<ReturnType<typeof setup>>, answer = 42) {
  t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from(JSON.stringify({ answer })) }] } });
}

describe('actual RuntimeService branch composition with explicitly fake remote ports', () => {
  it('persists sampled pressure and reduces only future branch dispatches', async () => {
    const t = await setup(graph('a', 'b', 'c'), {
      resourcePolicy: {
        policy: new ResourcePolicy({ mode: 'enforce', maxConcurrency: 2, reducedConcurrency: 1, highRatio: 0.8,
          recoverRatio: 0.6, consecutiveHigh: 1, consecutiveLow: 2, maxSampleAgeMs: 5000, signals: ['cpu'], limits: {} }),
        sample: async (_runId) => normalizeResourceSample({
          execution: { runId: 'run', sandboxId: 'sample', attemptId: 'sample', executionId: 'replaceable', workDir: '/sample' },
          observedAt: t.clock.now(), deployment: { evidenceRef: 'controlled scheduler sample', cpuCores: 1, memoryMiB: 512 },
          metrics: { timestamp: t.clock.now(), cpuCount: 1, cpuUsedPercentage: 95, memoryUsedMiB: 256, memoryTotalMiB: 512 },
        }),
      },
    });
    success(t); success(t); success(t);
    const workflow = new RuntimeBranchWorkflow(t.service, graph('a', 'b', 'c'), t.bindings, t.options);
    const out = await workflow.run('run', undefined);
    expect(out.complete).toBe(true);
    expect(t.store.getComponentState('run', 'resource-policy', 'branches')).toMatchObject({ throttled: true, highSamples: 1 });
    expect(t.store.eventsAfter('run').some(event => event.type === 'resource.policy_decision'
      && (event.payload as { reasons?: string[] }).reasons?.includes('RESOURCE_CONCURRENCY_REDUCED'))).toBe(true);
  });
  it('runs two branches concurrently with separate run/sandbox/attempt/validation identity and one root budget', async () => {
    const t = await setup(); success(t); success(t);
    const realInspect = t.sandbox.inspect.bind(t.sandbox); let inspected = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(t.sandbox, 'inspect').mockImplementation(async ref => { inspected++; if (inspected === 2) release(); await barrier; return realInspect(ref); });
    const out = await t.workflow.run('run'); expect(out.complete).toBe(true); expect(inspected).toBe(2);
    const children = t.store.listRuns().filter(r => r.runId !== 'run'); expect(children).toHaveLength(2);
    expect(children.every(r => r.status === 'SUCCEEDED' && r.budgetScopeKey === 'scope' && r.deadline === 100000)).toBe(true);
    const attempts = children.flatMap(r => t.store.listAttempts(r.runId));
    expect(attempts).toHaveLength(2); expect(new Set(attempts.map(a => a.sandboxId)).size).toBe(2); expect(new Set(attempts.map(a => a.workDir)).size).toBe(2);
    expect(out.artifacts.map(a => a.path).sort()).toEqual(['branches/a/result.json', 'branches/b/result.json']);
    for (const a of out.artifacts) {
      expect(a.source).toBeDefined(); const actual = t.store.listArtifacts(a.source!.runId)[0]!;
      expect(JSON.parse(Buffer.from(await t.service.artifacts.read(actual)).toString())).toEqual({ answer: 42 });
      expect(t.store.eventsAfter(actual.runId).filter(e => e.type === 'validation.completed')).toHaveLength(1);
    }
    expect(t.sandbox.calls.filter(c => c.method === 'destroy')).toHaveLength(2);
    expect(t.budget.reservations).toHaveLength(0); expect(t.budget.snapshot('scope').usedTokens).toBe(0);
    expect(t.store.getRun('run').status).toBe('RUNNING'); // parent acceptance remains its own explicit step
  });
  it('passes verified dependency bytes into the dependent child and runs its independent validator', async () => {
    const g = graph('a', 'b'); g.nodes[1]!.dependencies = ['a']; const t = await setup(g); success(t); success(t);
    t.bindings.b!.validate = async ({ dependencies }) => ({ passed: dependencies.a?.data.answer === 42, data: { acceptedDependency: true } });
    // Recreate to snapshot the trusted validator binding before execution.
    const workflow = new RuntimeBranchWorkflow(t.service, g, t.bindings, t.options);
    const out = await workflow.run('run'); expect(out.complete).toBe(true);
    const requests = t.sandbox.calls.filter(c => c.method === 'execute').map(c => c.args[0] as ExecutionRequest);
    expect(requests[1]!.inputs.map(i => i.path)).toEqual(['input.txt', 'dependencies/a/result.json']);
    expect(Buffer.from(requests[1]!.inputs[1]!.content).toString()).toBe('{"answer":42}');
    expect(out.state.nodes.b!.result!.data).toEqual({ acceptedDependency: true });
  });
  it('replays committed graph outcomes after genuinely closing and reopening SQLite without new execution', async () => {
    const t = await setup(); success(t); success(t); expect((await t.workflow.run('run')).complete).toBe(true);
    t.store.close(); const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanup.push(() => reopened.close());
    const service = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now });
    const replacement = new RuntimeBranchWorkflow(service, t.graph, t.bindings, t.options);
    expect((await replacement.run('run')).complete).toBe(true); expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(2);
  });
  it('does not dispatch after root work budget is fully reserved even in observe mode', async () => {
    const t = await setup(graph('a')); t.budget.reserve({ scopeKey: 'scope', sessionId: 'root', modelCallId: 'pressure', provider: 'fake', model: 'fake', purpose: 'work', estimatedTokens: 100000 });
    const out = await t.workflow.run('run'); expect(out.complete).toBe(false); expect(out.state.nodes.a!.status).toBe('failed');
    expect(t.sandbox.calls).toHaveLength(0); expect(t.store.listRuns()).toHaveLength(1); expect(t.budget.reservations).toHaveLength(1);
  });
  it('rejects an unbound child session without creating or resetting a budget', async () => {
    const t = await setup(graph('a'), {}, { a: binding('unregistered') }); const out = await t.workflow.run('run');
    expect(out.complete).toBe(false); expect(t.sandbox.calls).toHaveLength(0);
    expect(t.budget.calls.filter(c => c.method === 'scopeForSession' && c.args[0] === 'unregistered').every(c => (c.args[1] as { create: boolean }).create === false)).toBe(true);
    expect(t.budget.reservations).toHaveLength(0);
  });
  it('independent acceptance rejects a plausible artifact with the wrong answer and reclaims the child sandbox', async () => {
    const t = await setup(graph('a')); success(t, 41); const out = await t.workflow.run('run');
    expect(out.complete).toBe(false); expect(out.state.nodes.a!.status).toBe('failed');
    const childId = t.workflow.childRunId('run', 'a'); expect(t.store.getRun(childId).status).toBe('CANCELLED');
    expect(t.store.eventsAfter(childId).find(e => e.type === 'validation.completed')?.payload).toMatchObject({ passed: false });
    expect(t.sandbox.calls.filter(c => c.method === 'destroy')).toHaveLength(1);
  });
  it('missing expected artifact and nonzero script exits cannot be reported complete', async () => {
    for (const failedScript of [false, true]) {
      const t = await setup(graph('a'));
      t.sandbox.enqueue(failedScript ? { states: [{ state: 'FAILED', exitCode: 7 }], collect: { stderr: 'explicit fake failure' } } : { collect: { outputs: [] } });
      const out = await t.workflow.run('run'); expect(out.complete).toBe(false);
      expect(t.store.getRun(t.workflow.childRunId('run', 'a')).status).not.toBe('SUCCEEDED');
      expect(t.sandbox.calls.filter(c => c.method === 'destroy')).toHaveLength(1);
    }
  });
  it('recovers UNKNOWN child by actual remote inspection and independent acceptance, with no redispatch', async () => {
    const t = await setup(graph('a')); t.sandbox.enqueue({ states: [{ state: 'UNKNOWN', reason: 'explicit fake transient inspect failure' }],
      cancelConfirmed: false, collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"answer":42}') }] } });
    const first = await t.workflow.run('run'); expect(first.state.nodes.a!.status).toBe('unknown');
    const childId = t.workflow.childRunId('run', 'a'); const attempt = t.store.listAttempts(childId)[0]!;
    expect(attempt.status).toBe('UNKNOWN'); expect(attempt.executionId).toBeTruthy();
    await expect(t.workflow.run('run')).rejects.toThrow('unresolved');
    t.sandbox.setStatus(attempt.executionId!, { state: 'SUCCEEDED', exitCode: 0 });
    t.store.close(); const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanup.push(() => reopened.close());
    const service = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, { now: t.clock.now, wait: t.clock.sleep });
    const replacement = new RuntimeBranchWorkflow(service, t.graph, t.bindings, t.options);
    const old = replacement.persistence.load('run', t.graph, 'scope', replacement.parallel.identity);
    const reconciled = await replacement.reconcile('run', old.revision, 'host inspected same persisted remote execution');
    expect(reconciled.nodes.a!.status).toBe('done'); expect(reopened.getRun(childId).status).toBe('SUCCEEDED');
    expect((await replacement.run('run')).complete).toBe(true); expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    expect(reopened.listAttempts(childId)).toHaveLength(1); expect(reopened.getRun(childId).deadline).toBe(100000);
  });
  it('lost dispatch response without execution identity remains UNKNOWN after reconciliation', async () => {
    const t = await setup(graph('a')); t.sandbox.enqueue({ throwAfterDispatch: true, cancelConfirmed: false });
    const first = await t.workflow.run('run'); expect(first.state.nodes.a!.status).toBe('unknown');
    const childId = t.workflow.childRunId('run', 'a'); expect(t.store.listAttempts(childId)[0]!.executionId).toBe(null);
    const current = t.workflow.persistence.load('run', t.graph, 'scope', t.workflow.parallel.identity);
    const after = await t.workflow.reconcile('run', current.revision, 'host recovery has no durable remote identity');
    expect(after.nodes.a!.status).toBe('unknown'); await expect(t.workflow.run('run')).rejects.toThrow('unresolved');
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });
  it('claims recovery before remote effects across two distinct workflow and child-service instances', async () => {
    const t = await setup(graph('a')); t.sandbox.enqueue({ states: [{ state: 'UNKNOWN', reason: 'fake unavailable inspection' }], cancelConfirmed: false,
      collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"answer":42}') }] } });
    await t.workflow.run('run'); const execution = t.sandbox.executionRefs[0]!; t.sandbox.setStatus(execution.executionId, { state: 'SUCCEEDED', exitCode: 0 });
    const replacement = new RuntimeBranchWorkflow(t.service, t.graph, t.bindings, t.options);
    const state = t.workflow.persistence.load('run', t.graph, 'scope', t.workflow.parallel.identity);
    let entered!: () => void; let release!: () => void; let inspections = 0;
    const started = new Promise<void>(r => { entered = r; }); const barrier = new Promise<void>(r => { release = r; });
    const inspect = t.sandbox.inspect.bind(t.sandbox);
    vi.spyOn(t.sandbox, 'inspect').mockImplementation(async ref => { inspections++; entered(); await barrier; return inspect(ref); });
    const first = t.workflow.reconcile('run', state.revision, 'first host recovery'); await started;
    await expect(replacement.reconcile('run', state.revision, 'second host recovery')).rejects.toThrow('revision');
    expect(inspections).toBe(1); release(); const done = await first; expect(done.nodes.a!.status).toBe('done');
    expect(t.sandbox.calls.filter(c => c.method === 'collect')).toHaveLength(1); expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });
  it('rejects empty recovery evidence before claiming or inspecting any child', async () => {
    const t = await setup(graph('a')); t.sandbox.enqueue({ states: [{ state: 'UNKNOWN', reason: 'fake unavailable inspection' }], cancelConfirmed: false });
    await t.workflow.run('run'); const state = t.workflow.persistence.load('run', t.graph, 'scope', t.workflow.parallel.identity);
    const inspectCount = t.sandbox.calls.filter(c => c.method === 'inspect').length; const eventCount = t.store.eventsAfter('run').length;
    await expect(t.workflow.reconcile('run', state.revision, '   ')).rejects.toThrow('evidence');
    expect(t.sandbox.calls.filter(c => c.method === 'inspect')).toHaveLength(inspectCount); expect(t.store.eventsAfter('run')).toHaveLength(eventCount);
  });
  it('rejects changed trusted code/input/validator version and detects artifact tampering before replay', async () => {
    const t = await setup(graph('a')); success(t); expect((await t.workflow.run('run')).complete).toBe(true);
    const b = t.bindings.a!;
    for (const changed of [{ ...b, code: 'different' }, { ...b, validatorVersion: 'v2' }, { ...b, inputs: [{ path: 'input.txt', content: Buffer.from('changed') }] }]) {
      const replacement = new RuntimeBranchWorkflow(t.service, t.graph, { a: changed }, t.options);
      await expect(replacement.run('run')).rejects.toThrow('identity');
    }
    const artifact = t.store.listArtifacts(t.workflow.childRunId('run', 'a'))[0]!;
    writeFileSync(join(t.service.artifacts.rootDir, 'runs', artifact.runId, 'attempts', artifact.attemptId, 'files', artifact.path), 'tampered');
    await expect(t.workflow.run('run')).rejects.toThrow();
    const state = t.workflow.persistence.load('run', t.graph, 'scope', t.workflow.parallel.identity); expect(state.nodes.a!.status).toBe('unknown');
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });
  it('snapshots caller-owned trusted input bytes before asynchronous execution', async () => {
    const b = binding(); const t = await setup(graph('a'), {}, { a: b }); success(t);
    b.inputs[0]!.content.fill(0); b.code = 'changed'; const out = await t.workflow.run('run'); expect(out.complete).toBe(true);
    const request = t.sandbox.calls.find(c => c.method === 'execute')!.args[0] as ExecutionRequest;
    expect(Buffer.from(request.inputs[0]!.content).toString()).toBe('original'); expect(request.code).not.toBe('changed');
  });
  it('rejects changed runtime configuration before replay or remote recovery', async () => {
    const t = await setup(graph('a')); success(t); await t.workflow.run('run');
    const config = structuredClone(t.service.config); config.sandbox.memoryMiB += 1;
    const parent = new RuntimeService(t.store, t.service.artifacts, t.sandbox, t.budget, config, { now: t.clock.now });
    const workflow = new RuntimeBranchWorkflow(parent, t.graph, t.bindings, t.options);
    await expect(workflow.run('run')).rejects.toThrow('configuration differs');
    await expect(workflow.reconcile('run', 1, 'host check')).rejects.toThrow('configuration differs');
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });
  it('does not run recovery while the original graph runner is active', async () => {
    const t = await setup(graph('a')); success(t); let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const block = new Promise<void>(r => { release = r; });
    const realInspect = t.sandbox.inspect.bind(t.sandbox);
    vi.spyOn(t.sandbox, 'inspect').mockImplementation(async (ref: ExecutionRef) => { entered(); await block; return realInspect(ref); });
    const pending = t.workflow.run('run'); await started;
    const state = t.workflow.persistence.load('run', t.graph, 'scope', t.workflow.parallel.identity);
    await expect(t.workflow.reconcile('run', state.revision, 'must not interrupt live runner')).rejects.toThrow('active owner');
    release(); expect((await pending).complete).toBe(true);
  });
  it('cancels during independent validation, reclaims the stopped sandbox and fences its late acceptance', async () => {
    let entered!: () => void; let finish!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const validation = new Promise<void>(r => { finish = r; });
    const b = binding(); b.validate = async () => { entered(); await validation; return { passed: true, data: { answer: 42 } }; };
    const t = await setup(graph('a'), {}, { a: b }); success(t); const abort = new AbortController();
    const pending = t.workflow.run('run', abort.signal); await started; abort.abort(); const out = await pending;
    const child = t.workflow.childRunId('run', 'a'); expect(out.complete).toBe(false); expect(out.state.nodes.a!.status).toBe('cancelled');
    expect(t.store.getRun(child).status).toBe('CANCELLED'); expect(t.store.getSandbox(child)).toBeUndefined();
    expect(t.sandbox.calls.filter(c => c.method === 'destroy')).toHaveLength(1);
    finish(); await new Promise<void>(r => setImmediate(r));
    expect(t.store.getRun(child).status).toBe('CANCELLED'); expect(t.store.eventsAfter(child).filter(e => e.type === 'validation.completed')).toHaveLength(0);
  });
});
