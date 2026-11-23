import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovedCodeExecutor } from '../../src/workflow/approved-executor.js';
import { DurableRetryExecutor } from '../../src/workflow/retry-executor.js';
import { SerialWorkflow, type MeteredRolePort } from '../../src/workflow/serial.js';
import { RUNTIME_PYTHON_TOOL } from '../../src/adapters/harness/index.js';
import { DurableToolRules } from '../../src/tools/durable.js';
import { ToolRuleEngine } from '../../src/policy/tool-rules.js';
import { RuntimeService } from '../../src/core/service.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { createRuntimeServer } from '../../src/api/server.js';
import { runtimeFixture } from '../support/runtime.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });
async function setup(maxCalls = 5) {
  const t = await runtimeFixture(); cleanups.push(t.dispose);
  const make = (service = t.service, rules = new ToolRuleEngine([{ toolName: RUNTIME_PYTHON_TOOL, warnAt: 1, maxCalls }])) => {
    const retry = new DurableRetryExecutor(service, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, now: t.clock.now, wait: t.clock.sleep });
    const gate = new ApprovedCodeExecutor(service, retry, new DurableToolRules(service.store, rules), {
      reason: 'Review this bounded Python execution', ttlMs: 10000, now: t.clock.now,
    });
    return { gate, retry };
  };
  const request = { runId: 'run', stepId: 'code', code: 'print(42)', inputs: [] };
  const approve = (service = t.service) => {
    const record = service.approvals.list('run').at(-1)!;
    return service.approvals.decide('run', record.approvalId, 'decide-' + record.approvalId, true);
  };
  const enqueue = (exitCode = 0) => t.sandbox.enqueue({ states: [exitCode === 0 ? { state: 'SUCCEEDED', exitCode: 0 } : { state: 'FAILED', exitCode }],
    collect: { stdout: '', stderr: exitCode ? 'same failure' : '', outputs: exitCode ? [] : [{ path: 'result.json', content: Buffer.from('{}') }] } });
  return { ...t, ...make(), make, request, approve, enqueue };
}

describe('approved serial execution with durable tool limits', () => {
  it('automatically requests approval before any sandbox operation and deduplicates pending prompts', async () => {
    const t = await setup();
    for (let i = 0; i < 2; i++) await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(t.store.getRun('run').status).toBe('PAUSED_APPROVAL');
    expect(t.service.approvals.list('run')).toHaveLength(1);
    expect(t.sandbox.calls).toHaveLength(0);
    expect(t.store.listAttempts('run')).toHaveLength(0);
    expect(t.store.eventsAfter('run').filter(e => e.type === 'tool.policy-admission')).toHaveLength(1);
    expect(t.budget.snapshot('scope').usedTokens).toBe(0);
  });

  it('continues a serial run after HTTP approval and SQLite reopen without repeating paid roles or code', async () => {
    const t = await setup(); const calls: string[] = [];
    const roles: MeteredRolePort = { async call(request) {
      calls.push(request.role);
      const reserve = t.budget.reserve({ scopeKey: request.scopeKey, sessionId: request.sessionId, modelCallId: request.callId,
        provider: 'fake', model: 'fake', purpose: 'work', estimatedTokens: 100 });
      if (!reserve.allowed) throw new Error('Fixture budget unavailable');
      t.budget.markDispatched(reserve.reservation.reservationId);
      t.budget.settle(reserve.reservation.reservationId, { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return { receiptId: t.budget.eventsAfter(0).findLast(e => e.type === 'settle')!.eventId,
        value: request.role === 'planner' ? { steps: ['produce result'], checks: ['result.json exists'] }
          : request.role === 'executor' ? { code: t.request.code } : { passed: true, findings: [] } };
    } };
    const options = { sessionForRole: (_run: string, role: string) => role, maxRepairs: 0, inputs: async () => [], now: t.clock.now };
    await expect(new SerialWorkflow(t.service, t.budget, roles, { ...options, executor: t.gate }).run('run')).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(calls).toEqual(['planner', 'executor']);
    const approval = t.service.approvals.list('run')[0]!;
    const token = 'test-approval-token-with-24-characters';
    const server = createRuntimeServer(t.service, { token });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
      const decide = () => fetch('http://127.0.0.1:' + address.port + '/runs/run/approvals/' + approval.approvalId, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ decisionId: 'same-click', approved: true }),
      });
      expect((await decide()).status).toBe(200); expect((await decide()).status).toBe(200);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    const before = t.store.getRun('run'); t.store.close();
    const reopened = new RuntimeStore(join(t.directory, 'db'), t.clock.now); cleanups.push(() => reopened.close());
    const service = new RuntimeService(reopened, t.service.artifacts, t.sandbox, t.budget, t.service.config, {
      now: t.clock.now, wait: t.clock.sleep, validate: async (_run, artifacts, read) => ({
        passed: artifacts.length === 1 && Buffer.from(await read(artifacts[0]!)).toString() === '{}', evidence: 'Independent content check',
      }),
    });
    t.enqueue();
    const workflow = new SerialWorkflow(service, t.budget, roles, { ...options, executor: t.make(service).gate });
    expect((await workflow.run('run')).run.status).toBe('SUCCEEDED');
    expect(calls).toEqual(['planner', 'executor', 'reviewer']);
    expect(service.approvals.get('run', approval.approvalId).status).toBe('consumed');
    expect(reopened.eventsAfter('run').filter(e => e.type === 'approval.consumed')).toHaveLength(1);
    expect(t.budget.snapshot('scope')).toMatchObject({ usedTokens: 30, reservedTokens: 0, unknownCalls: 0 });
    expect(reopened.getRun('run')).toMatchObject({ deadline: before.deadline, budgetScopeKey: before.budgetScopeKey });
    await workflow.run('run'); expect(calls).toHaveLength(3);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('preserves a rejection and never reprompts or dispatches', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const record = t.service.approvals.list('run')[0]!;
    t.service.approvals.decide('run', record.approvalId, 'reject', false);
    await expect(t.make().gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(t.service.approvals.list('run')).toHaveLength(1); expect(t.sandbox.calls).toHaveLength(0);
  });

  it('refuses changed code, input bytes and host approval configuration', async () => {
    const t = await setup(); const request = { ...t.request, inputs: [{ path: 'data.txt', content: Buffer.from('original') }] };
    await expect(t.gate.executeCode(request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    await expect(t.gate.executeCode({ ...request, code: 'print(43)' })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    await expect(t.gate.executeCode({ ...request, inputs: [{ path: 'data.txt', content: Buffer.from('changed') }] })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    const changed = new ApprovedCodeExecutor(t.service, t.retry, new DurableToolRules(t.store, new ToolRuleEngine([])), { reason: 'Changed', ttlMs: 10000, now: t.clock.now });
    await expect(changed.executeCode(request)).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.service.approvals.list('run')[0]!.status).toBe('approved'); expect(t.sandbox.calls).toHaveLength(0);
  });

  it('revalidates persisted tool-rule configuration before consuming approval', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    const changed = t.make(t.service, new ToolRuleEngine([{ toolName: RUNTIME_PYTHON_TOOL, warnAt: 1, maxCalls: 99 }]));
    await expect(changed.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.service.approvals.list('run')[0]!.status).toBe('approved'); expect(t.sandbox.calls).toHaveLength(0);
  });

  it.each([
    { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 100 },
    { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 200 },
  ])('refuses changed retry bounds before consuming approval: %j', async bounds => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    const retry = new DurableRetryExecutor(t.service, { ...bounds, now: t.clock.now, wait: t.clock.sleep });
    const changed = new ApprovedCodeExecutor(t.service, retry, new DurableToolRules(t.store, new ToolRuleEngine([{ toolName: RUNTIME_PYTHON_TOOL, warnAt: 1, maxCalls: 5 }])), {
      reason: 'Review this bounded Python execution', ttlMs: 10000, now: t.clock.now,
    });
    await expect(changed.executeCode(t.request)).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.service.approvals.list('run')[0]!.status).toBe('approved');
    expect(t.sandbox.calls).toHaveLength(0); expect(t.store.listAttempts('run')).toHaveLength(0);
  });

  it('cannot consume an expired approval or one whose run was cancelled', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    t.clock.advance(10000);
    await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'CONFLICT' });
    await t.service.cancelRun('run', 'cancel', { reason: 'User cancelled' });
    await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.sandbox.calls).toHaveLength(0);
  });

  it('rechecks hard budget constraints and leaves approval unconsumed when accounting is unknown', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    const reserve = t.budget.reserve({ scopeKey: 'scope', sessionId: 'root', modelCallId: 'unknown', provider: 'fake', model: 'fake', purpose: 'work', estimatedTokens: 100 });
    if (!reserve.allowed) throw new Error('Fixture budget unavailable');
    t.budget.markDispatched(reserve.reservation.reservationId); t.budget.markUnknown(reserve.reservation.reservationId, 'Missing usage');
    await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'USAGE_UNKNOWN' });
    expect(t.service.approvals.list('run')[0]!.status).toBe('approved'); expect(t.sandbox.calls).toHaveLength(0);
  });

  it('retains tool quotas across recreated executors; approval cannot override a denial', async () => {
    const t = await setup(1); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve(); t.enqueue(7);
    expect((await t.gate.executeCode(t.request)).exitCode).toBe(7);
    await expect(t.make().gate.executeCode({ ...t.request, stepId: 'second' })).rejects.toMatchObject({ code: 'POLICY_TOOL_BLOCKED', message: 'TOOL_CALL_LIMIT' });
    expect(t.service.approvals.list('run')).toHaveLength(1); expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('stops repeated identical failures before requesting another approval', async () => {
    const t = await setup();
    for (const stepId of ['first', 'second']) {
      const request = { ...t.request, stepId };
      await expect(t.gate.executeCode(request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve(); t.enqueue(7);
      expect((await t.gate.executeCode(request)).exitCode).toBe(7);
    }
    await expect(t.make().gate.executeCode({ ...t.request, stepId: 'third' })).rejects.toMatchObject({ code: 'POLICY_TOOL_BLOCKED', message: 'NO_PROGRESS' });
    expect(t.service.approvals.list('run')).toHaveLength(2); expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(2);
  });

  it('allows a bounded proven-unsent creation retry under the same approval', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    t.sandbox.faults.failNext('sandbox.create.before'); t.enqueue();
    expect((await t.gate.executeCode(t.request)).exitCode).toBe(0);
    expect(t.store.listAttempts('run').map(a => [a.attemptNo, a.status])).toEqual([[1, 'FAILED'], [2, 'SUCCEEDED']]);
    expect(t.service.approvals.list('run')).toHaveLength(1);
    expect(t.store.eventsAfter('run').filter(e => e.type === 'approval.consumed')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('blocks the consumed-approval window before the dispatch marker', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    const consume = t.service.consumeApproval.bind(t.service);
    const fault = vi.spyOn(t.service, 'consumeApproval').mockImplementationOnce(async (...args) => { await consume(...args); throw new Error('Crash after consume'); });
    await expect(t.gate.executeCode(t.request)).rejects.toThrow('Crash after consume'); fault.mockRestore();
    await expect(t.make().gate.executeCode(t.request)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.sandbox.calls).toHaveLength(0); expect(t.service.approvals.list('run')[0]!.status).toBe('consumed');
  });

  it('blocks a dispatch marker without a retry receipt instead of executing again', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve();
    vi.spyOn(t.retry, 'executeCode').mockRejectedValueOnce(new Error('Crash before retry receipt'));
    await expect(t.gate.executeCode(t.request)).rejects.toThrow('Crash before retry receipt');
    await expect(t.make().gate.executeCode(t.request)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.sandbox.calls).toHaveLength(0);
  });

  it('replays a committed result after the gate commit fails and verifies stored artifacts', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve(); t.enqueue();
    const write = t.store.setComponentState.bind(t.store);
    const fault = vi.spyOn(t.store, 'setComponentState').mockImplementation((runId, namespace, key, state) => {
      if (namespace === 'approved-executor' && (state as { phase?: string }).phase === 'done') throw new Error('Gate commit failed');
      write(runId, namespace, key, state);
    });
    await expect(t.gate.executeCode(t.request)).rejects.toThrow('Gate commit failed'); fault.mockRestore();
    const result = await t.make().gate.executeCode(t.request);
    expect(result.artifacts).toHaveLength(1);
    expect((await t.make().gate.executeCode(t.request)).attemptId).toBe(result.attemptId);
    expect(t.store.eventsAfter('run').filter(e => e.type === 'tool.policy-outcome')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });

  it('allows only one of two competing gate objects to consume and dispatch', async () => {
    const t = await setup(); await expect(t.gate.executeCode(t.request)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' }); t.approve(); t.enqueue();
    const results = await Promise.allSettled([t.gate.executeCode(t.request), t.make().gate.executeCode(t.request)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
    expect(t.store.eventsAfter('run').filter(e => e.type === 'approval.consumed')).toHaveLength(1);
  });
});
