import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { RuntimeStore } from '../../src/storage/index.js';
import { SerialWorkflow, RoleNotDispatchedError, type MeteredRolePort, type RoleRequest, type SerialWorkflowOptions } from '../../src/workflow/serial.js';
import { runtimeFixture } from '../support/runtime.js';
import { RuntimeService } from '../../src/core/service.js';
import { DurableRetryExecutor } from '../../src/workflow/retry-executor.js';
import { FinalizationCoordinator } from '../../src/core/finalize.js';
const cleanup: Array<() => void> = []; afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
async function setup(passes = true) {
  const t = await runtimeFixture(); cleanup.push(t.dispose); const calls: RoleRequest[] = [];
  const roles: MeteredRolePort = { async call(request) {
    calls.push(request);
    const reserve = t.budget.reserve({ scopeKey: request.scopeKey, modelCallId: request.callId, sessionId: request.sessionId,
      provider: 'fake', model: 'fake', purpose: 'work', estimatedTokens: 100 });
    if (!reserve.allowed) throw new Error('budget unavailable');
    t.budget.markDispatched(reserve.reservation.reservationId);
    t.budget.settle(reserve.reservation.reservationId, { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const receipt = t.budget.eventsAfter(0).findLast(r => r.type === 'settle')!;
    return { receiptId: receipt.eventId, value: request.role === 'planner' ? { steps: ['produce result'], checks: ['result.json exists'] }
      : request.role === 'executor' ? { code: 'print(42)' } : { passed: passes, findings: passes ? [] : ['missing requirement'] } };
  } };
  const options: SerialWorkflowOptions = { sessionForRole: (_run, role) => role, maxRepairs: 1, inputs: async () => [], now: t.clock.now };
  const workflow = new SerialWorkflow(t.service, t.budget, roles, options);
  return { ...t, workflow, calls, roles, options };
}
describe('serial role workflow', () => {
  it('requires same-ledger settlements and independent acceptance before success', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    expect((await t.workflow.run('run')).run.status).toBe('SUCCEEDED');
    expect(t.calls.map(c => c.role)).toEqual(['planner', 'executor', 'reviewer']);
    expect(t.budget.snapshot('scope').usedTokens).toBe(30);
    await t.workflow.run('run'); expect(t.calls).toHaveLength(3);
  });
  it('limits reviewer repair loops and preserves partial delivery', async () => {
    const t = await setup(false);
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] }).enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
    expect((await t.workflow.run('run')).run.status).toBe('COMPLETED_PARTIAL');
    expect(t.calls.filter(c => c.role === 'reviewer')).toHaveLength(2);
    expect(t.sandbox.calls.filter(c => c.method === 'create')).toHaveLength(2);
    expect(t.sandbox.calls.filter(c => c.method === 'destroy')).toHaveLength(2);
    const links = t.store.eventsAfter('run').filter(event => event.type === 'workflow.executor_step_linked')
      .map(event => event.payload as { modelCallId: string; stepId: string });
    expect(links).toHaveLength(2);
    expect(new Set(links.map(link => link.modelCallId)).size).toBe(2);
    expect(new Set(links.map(link => link.stepId)).size).toBe(2);
    expect(links.map(link => t.store.listAttempts('run').filter(attempt => attempt.stepId === link.stepId).length)).toEqual([1, 1]);
  });
  it('composes safe creation retries with the serial workflow using fresh service attempts', async () => {
    const t = await setup();
    t.sandbox.faults.failNext('sandbox.create.before');
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    const executor = new DurableRetryExecutor(t.service, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100,
      now: t.clock.now, wait: t.clock.sleep });
    const workflow = new SerialWorkflow(t.service, t.budget, t.roles, { ...t.options, executor });
    expect((await workflow.run('run')).run.status).toBe('SUCCEEDED');
    const attempts = t.store.listAttempts('run');
    expect(attempts.map(a => [a.attemptNo, a.status])).toEqual([[1, 'FAILED'], [2, 'SUCCEEDED']]);
    const links = t.store.eventsAfter('run').filter(event => event.type === 'workflow.executor_step_linked');
    expect(links).toHaveLength(1);
    expect(attempts.map(attempt => attempt.stepId)).toEqual([(links[0]!.payload as { stepId: string }).stepId, (links[0]!.payload as { stepId: string }).stepId]);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    expect(t.calls.map(c => c.role)).toEqual(['planner', 'executor', 'reviewer']);
    await workflow.run('run');
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });
  it('records partial workflow completion when the finalizer detects unresolved model usage', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    const coordinator = new FinalizationCoordinator(t.service);
    const workflow = new SerialWorkflow(t.service, t.budget, t.roles, { ...t.options, finalizer: {
      finalize: async (runId, complete) => {
        const reserve = t.budget.reserve({ scopeKey: 'scope', sessionId: 'root', modelCallId: 'late-unknown',
          provider: 'fake', model: 'fake', purpose: 'work', estimatedTokens: 100 });
        if (!reserve.allowed) throw new Error('test fixture budget unavailable');
        t.budget.markDispatched(reserve.reservation.reservationId);
        t.budget.markUnknown(reserve.reservation.reservationId, 'injected unknown before final delivery');
        return coordinator.finalize(runId, complete);
      },
    } });
    const result = await workflow.run('run');
    expect(result.run.status).toBe('COMPLETED_PARTIAL');
    expect(result.state.status).toBe('partial');
    expect(t.budget.snapshot('scope').unknownCalls).toBe(1);
  });
  it('does not replay a model request after a dispatch/response loss', async () => {
    const t = await setup(); let count = 0;
    const workflow = new SerialWorkflow(t.service, t.budget, { call: async () => { count++; throw new Error('response lost'); } },
      t.options);
    await expect(workflow.run('run')).rejects.toThrow('lost');
    await expect(workflow.run('run')).rejects.toMatchObject({ code: 'USAGE_UNKNOWN' });
    expect(count).toBe(1);
  });

  it('allows continuation after a trusted context preflight proves the primary role was unsent', async () => {
    const t = await setup(); let blocked = false;
    const roles: MeteredRolePort = { async call(request) {
      if (!blocked) {
        blocked = true; t.service.pauseForContext('run', 'CONTEXT_REQUIRED_TOO_LARGE');
        throw new RoleNotDispatchedError('Context does not fit; primary role was not sent');
      }
      return t.roles.call(request);
    } };
    const workflow = new SerialWorkflow(t.service, t.budget, roles, t.options);
    await expect(workflow.run('run')).rejects.toBeInstanceOf(RoleNotDispatchedError);
    expect(t.calls).toHaveLength(0);
    expect(t.budget.snapshot('scope').usedTokens).toBe(0);
    expect(t.store.getComponentState('run', 'role-calls', 'planner-0')).toMatchObject({ status: 'not-dispatched' });
    const replacementService = new RuntimeService(t.store, t.service.artifacts, t.sandbox, t.budget, t.service.config, {
      now: t.clock.now, validateContextResume: async () => true,
      validate: async (_run, artifacts) => ({ passed: artifacts.some(a => a.path === 'result.json'), evidence: 'independent fixture check' }),
    });
    await replacementService.resumeRun('run', 'context-fixed', t.store.getRun('run').revision);
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    const replacement = new SerialWorkflow(replacementService, t.budget, roles, t.options);
    expect((await replacement.run('run')).run.status).toBe('SUCCEEDED');
    expect(t.calls.map(c => c.role)).toEqual(['planner', 'executor', 'reviewer']);
    expect(t.budget.snapshot('scope').usedTokens).toBe(30);
  });

  it('does not accept another call settlement from the same role session', async () => {
    const t = await setup();
    const workflow = new SerialWorkflow(t.service, t.budget, { call: async request => {
      return t.roles.call({ ...request, callId: 'unrelated-model-call' });
    } }, t.options);
    await expect(workflow.run('run')).rejects.toMatchObject({ code: 'USAGE_UNKNOWN' });
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(0);
  });

  it('correlates a trusted adapter ledger call ID without requiring a provider to reuse the workflow ID', async () => {
    const t = await setup();
    const workflow = new SerialWorkflow(t.service, t.budget, { call: async request => {
      const modelCallId = `ledger-${request.callId}`;
      const result = await t.roles.call({ ...request, callId: modelCallId });
      return { ...result, correlation: { callId: request.callId, modelCallId } };
    } }, t.options);
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    expect((await workflow.run('run')).run.status).toBe('SUCCEEDED');
    const events = t.store.eventsAfter('run').filter(e => e.type === 'workflow.role_completed');
    expect(events).toHaveLength(3);
    expect(events[0]?.payload).toMatchObject({ modelCallId: expect.stringMatching(/^ledger-role-/) });
    expect(t.budget.snapshot('scope').usedTokens).toBe(30);
  });

  it.each(['wrong-intent', 'wrong-ledger-id'])('rejects %s in a trusted adapter correlation', async mode => {
    const t = await setup();
    const workflow = new SerialWorkflow(t.service, t.budget, { call: async request => {
      const result = await t.roles.call(request);
      return { ...result, correlation: {
        callId: mode === 'wrong-intent' ? 'another-workflow-call' : request.callId,
        modelCallId: mode === 'wrong-ledger-id' ? 'another-ledger-call' : request.callId,
      } };
    } }, t.options);
    await expect(workflow.run('run')).rejects.toMatchObject({ code: 'USAGE_UNKNOWN' });
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(0);
  });

  it('uses different model-call identities for two runs in the same root budget', async () => {
    const t = await setup();
    await t.service.createRun({ runId: 'second-run', rootSessionId: 'root', budgetScopeKey: 'scope', task: 'produce result.json', inputHash: 'b'.repeat(64), policyVersion: 'budget-policy-v1', deadline: 100000 });
    for (let i = 0; i < 2; i++) t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    expect((await t.workflow.run('run')).run.status).toBe('SUCCEEDED');
    expect((await t.workflow.run('second-run')).run.status).toBe('SUCCEEDED');
    expect(new Set(t.calls.map(c => c.callId)).size).toBe(6);
    expect(t.budget.snapshot('scope').usedTokens).toBe(60);
  });

  it('allows only one of two runner objects to claim a role before model dispatch', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    const second = new SerialWorkflow(t.service, t.budget, t.roles, t.options);
    const results = await Promise.allSettled([t.workflow.run('run'), second.run('run')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.calls.map(c => c.role)).toEqual(['planner', 'executor', 'reviewer']);
  });

  it('rechecks task state after asynchronous budget lookup and stops before dispatch', async () => {
    const t = await setup(); const snapshot = t.budget.snapshot.bind(t.budget);
    vi.spyOn(t.budget, 'snapshot').mockImplementationOnce(scope => {
      t.store.transitionRun('run', 'PAUSED_BUDGET');
      return snapshot(scope);
    });
    await expect(t.workflow.run('run')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.calls).toHaveLength(0);
    expect(t.store.listComponentState('run', 'role-calls')).toHaveLength(0);
  });

  it('honors the original deadline before spending on a role', async () => {
    const t = await setup(); t.clock.set(100000);
    await expect(t.workflow.run('run')).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
    expect(t.calls).toHaveLength(0);
  });

  it('rechecks cancellation after asynchronous budget lookup before claiming a role', async () => {
    const t = await setup(); const controller = new AbortController(); const snapshot = t.budget.snapshot.bind(t.budget);
    vi.spyOn(t.budget, 'snapshot').mockImplementationOnce(scope => {
      controller.abort(new Error('operator cancelled'));
      return snapshot(scope);
    });
    await expect(t.workflow.run('run', controller.signal)).rejects.toThrow('operator cancelled');
    expect(t.calls).toHaveLength(0);
    expect(t.store.listComponentState('run', 'role-calls')).toHaveLength(0);
  });

  it('reconciles finalization committed before serial state without replaying roles or code', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    const write = t.store.setComponentState.bind(t.store);
    const spy = vi.spyOn(t.store, 'setComponentState').mockImplementation((runId, namespace, key, data) => {
      if (namespace === 'workflow' && (data as { status?: string }).status === 'done') throw new Error('crash after finalize');
      return write(runId, namespace, key, data);
    });
    await expect(t.workflow.run('run')).rejects.toThrow('crash after finalize');
    expect(t.store.getRun('run').status).toBe('SUCCEEDED');
    spy.mockRestore();
    const replacement = new SerialWorkflow(t.service, t.budget, t.roles, t.options);
    expect((await replacement.run('run')).state.status).toBe('done');
    expect(t.calls).toHaveLength(3);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('refuses to attach a new workflow to an unrelated terminal task', async () => {
    const t = await setup(); await t.service.finalize('run', false);
    await expect(t.workflow.run('run')).rejects.toThrow('no serial workflow');
    expect(t.calls).toHaveLength(0);
    expect(t.store.getComponentState('run', 'workflow', 'serial')).toBeUndefined();
  });

  it('refuses recovery if role session bindings changed', async () => {
    const t = await setup();
    const original = new SerialWorkflow(t.service, t.budget, { call: async () => { throw new Error('lost'); } }, t.options);
    await expect(original.run('run')).rejects.toThrow('lost');
    const replacement = new SerialWorkflow(t.service, t.budget, t.roles, { ...t.options, sessionForRole: () => 'root' });
    await expect(replacement.run('run')).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.calls).toHaveLength(0);
  });

  it('persists the executor-to-step link across database reopen without duplicating calls or links', async () => {
    const t = await setup(); let interrupted = false;
    const options: SerialWorkflowOptions = { ...t.options, inputs: async () => {
      if (!interrupted) { interrupted = true; throw new Error('interrupted before dispatch'); }
      return [];
    } };
    const workflow = new SerialWorkflow(t.service, t.budget, t.roles, options);
    await expect(workflow.run('run')).rejects.toThrow('interrupted before dispatch');
    const before = t.store.eventsAfter('run').filter(event => event.type === 'workflow.executor_step_linked');
    expect(before).toHaveLength(1);
    expect(t.store.listAttempts('run')).toHaveLength(0);
    t.store.close();
    const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now);
    cleanup.unshift(() => reopened.close());
    const service = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, {
      now: t.clock.now, wait: t.clock.sleep,
      validate: async (_run, artifacts) => ({ passed: artifacts.some(a => a.path === 'result.json'), evidence: 'independent fixture check' }),
    });
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    const resumed = new SerialWorkflow(service, t.budget, t.roles, options);
    expect((await resumed.run('run')).run.status).toBe('SUCCEEDED');
    const links = reopened.eventsAfter('run').filter(event => event.type === 'workflow.executor_step_linked');
    expect(links).toEqual(before);
    const link = links[0]!.payload as { callId: string; modelCallId: string; receiptId: string; stepId: string };
    const completion = reopened.eventsAfter('run').find(event => event.type === 'workflow.role_completed'
      && (event.payload as { role?: string }).role === 'executor');
    expect(completion?.payload).toMatchObject({ callId: link.callId, modelCallId: link.modelCallId, receiptId: link.receiptId });
    const ledger = t.budget.eventsAfter(0);
    const settlement = ledger.find(event => event.type === 'settle' && event.eventId === link.receiptId)!;
    const reservation = ledger.find(event => event.type === 'reserve' && event.payload.reservationId === settlement.payload.reservationId)!;
    expect(reservation.payload.request).toMatchObject({ modelCallId: link.modelCallId, scopeKey: 'scope' });
    const attempts = reopened.listAttempts('run').filter(attempt => attempt.stepId === link.stepId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.executionId).toBeTruthy();
    expect(t.calls.map(call => call.role)).toEqual(['planner', 'executor', 'reviewer']);
  });

  it('resumes a legacy executor record without inventing a model-call link', async () => {
    const t = await setup();
    const originalAppend = t.store.appendEvent.bind(t.store);
    const interruption = vi.spyOn(t.store, 'appendEvent').mockImplementation((...args) => {
      if (args[1] === 'workflow.executor_step_linked') throw new Error('interrupted before link');
      return originalAppend(...args);
    });
    await expect(t.workflow.run('run')).rejects.toThrow('interrupted before link');
    interruption.mockRestore();
    const old = t.store.getComponentState<Record<string, unknown>>('run', 'role-calls', 'executor-0')!;
    delete old.modelCallId;
    t.store.setComponentState('run', 'role-calls', 'executor-0', old);
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    expect((await t.workflow.run('run')).run.status).toBe('SUCCEEDED');
    expect(t.calls.map(call => call.role)).toEqual(['planner', 'executor', 'reviewer']);
    expect(t.store.eventsAfter('run').filter(event => event.type === 'workflow.executor_step_linked')).toHaveLength(0);
  });

  it('resumes approved code with a recreated runner without replaying roles or consuming approval twice', async () => {
    const t = await setup(); let requested = false;
    const args = { code: 'print(42)' };
    const options: SerialWorkflowOptions = { ...t.options, inputs: async () => {
      if (!requested) {
        requested = true;
        await t.service.requestApproval({ runId: 'run', approvalId: 'code-approval', toolCallId: 'code-tool', args, reason: 'Operator review', ttlMs: 10000 });
      }
      return [];
    } };
    const original = new SerialWorkflow(t.service, t.budget, t.roles, options);
    await expect(original.run('run')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.store.getRun('run').status).toBe('PAUSED_APPROVAL');
    expect(t.calls.map(c => c.role)).toEqual(['planner', 'executor']);
    t.service.approvals.decide('run', 'code-approval', 'approve-click', true);
    await t.service.consumeApproval('run', 'code-approval', args);
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{}') }] } });
    const replacement = new SerialWorkflow(t.service, t.budget, t.roles, options);
    expect((await replacement.run('run')).run.status).toBe('SUCCEEDED');
    expect(t.calls.map(c => c.role)).toEqual(['planner', 'executor', 'reviewer']);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    await expect(t.service.consumeApproval('run', 'code-approval', args)).rejects.toThrow('unavailable');
  });
});
