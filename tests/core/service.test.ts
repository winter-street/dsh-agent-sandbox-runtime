import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService, type RuntimeServiceOptions } from '../../src/core/service.js';
import { loadConfig } from '../../src/config.js';
import { FakeBudget, FakeClock, FakeSandbox } from '../support/fakes.js';

const roots: string[] = [];
const stores: RuntimeStore[] = [];
async function setup(options: { fault?: RuntimeServiceOptions['fault']; validate?: boolean; mode?: 'observe' | 'enforce' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-service-')); roots.push(root);
  const clock = new FakeClock(1000);
  const store = new RuntimeStore(join(root, 'db'), clock.now); stores.push(store);
  const artifacts = new ArtifactStore(join(root, 'artifacts'));
  const sandbox = new FakeSandbox({ clock });
  const budget = new FakeBudget({ scopeKey: 'scope-1', sessionIds: ['session-1'], limitTokens: 10000, clock });
  const config = loadConfig('config/example.json'); config.sandbox.commandTimeoutMs = 1000;
  config.policy.mode = options.mode ?? config.policy.mode;
  const svcOptions = { now: clock.now, wait: clock.sleep, pollIntervalMs: 100,
    ...(options.fault ? { fault: options.fault } : {}),
    ...(options.validate ? { validate: async () => ({ passed: true, evidence: { fixture: 'test-only' } }) } : {}),
  };
  const service = new RuntimeService(store, artifacts, sandbox, budget, config, svcOptions);
  await service.createRun({ runId: 'run-1', rootSessionId: 'session-1', budgetScopeKey: 'scope-1',
    task: 'Analyze', deadline: 50000, policyVersion: 'budget-policy-v1', inputHash: 'a'.repeat(64) });
  const input = { runId: 'run-1', stepId: 'step-1', code: 'print(42)', inputs: [] };
  return { root, clock, store, artifacts, sandbox, budget, config, service, input };
}
async function pauseAtFinalizedBudget() {
  const t = await setup({ mode: 'enforce' });
  t.budget.allocate('scope-1', 500, 'Preserve finalization allowance');
  const decision = t.budget.reserve({ scopeKey: 'scope-1', modelCallId: 'fixture-usage', sessionId: 'session-1',
    provider: 'controlled', model: 'controlled', purpose: 'work', estimatedTokens: 9500 });
  if (!decision.allowed) throw new Error('Fixture usage reservation was rejected');
  t.budget.markDispatched(decision.reservation.reservationId);
  t.budget.settle(decision.reservation.reservationId, {
    inputTokens: 9500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  });
  await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
  expect(t.store.getRun('run-1').status).toBe('PAUSED_BUDGET');
  expect(t.store.getPolicyState('run-1')).toMatchObject({ finalized: true });
  return t;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime execution and recovery with controlled remote service', () => {
  it.each(['sandbox.destroy.before', 'sandbox.destroy.after'])('keeps user pause pending until cleanup is confirmed after %s', async point => {
    const t = await setup();
    await t.service.executeCode(t.input);
    t.store.saveSandbox(await t.sandbox.create('run-1', t.config.sandbox));
    await t.service.pauseRun('run-1', 'pause-1', { reason: 'test' });
    t.sandbox.faults.failNext(point);
    await expect(t.service.confirmUserPause('run-1')).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    expect(t.store.getRun('run-1').status).toBe('PAUSING');
    expect(t.store.getSandbox('run-1')).toBeDefined();
    await t.service.recover('run-1');
    expect(t.store.getSandbox('run-1')).toBeUndefined();
    expect((await t.service.confirmUserPause('run-1')).status).toBe('PAUSED_USER');
  });
  it('waits for the same sandbox cleanup when approval arrives during destruction', async () => {
    const t = await setup();
    await t.service.executeCode(t.input);
    t.store.saveSandbox(await t.sandbox.create('run-1', t.config.sandbox));
    const originalDestroy = t.sandbox.destroy.bind(t.sandbox);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    t.sandbox.destroy = async ref => { started(); await blocked; await originalDestroy(ref); };
    const approval = { runId: 'run-1', approvalId: 'approval-1', toolCallId: 'tool-1', args: { code: 'pass' }, reason: 'test', ttlMs: 10000 };
    const requested = t.service.requestApproval(approval);
    await entered;
    t.service.approvals.decide('run-1', 'approval-1', 'decision-1', true);
    const consumed = t.service.consumeApproval('run-1', 'approval-1', approval.args);
    expect(t.service.approvals.get('run-1', 'approval-1').status).toBe('approved');
    expect(t.store.getRun('run-1').status).toBe('PAUSED_APPROVAL');
    release();
    await Promise.all([requested, consumed]);
    expect(t.store.getRun('run-1').status).toBe('RUNNING');
    expect(t.store.getSandbox('run-1')).toBeUndefined();
    expect(t.sandbox.calls.filter(call => call.method === 'destroy')).toHaveLength(2);
  });
  it.each(['sandbox.destroy.before', 'sandbox.destroy.after'])('retains approval and blocks consumption until cleanup succeeds after %s', async point => {
    const t = await setup();
    await t.service.executeCode(t.input);
    t.store.saveSandbox(await t.sandbox.create('run-1', t.config.sandbox));
    const approval = { runId: 'run-1', approvalId: 'approval-1', toolCallId: 'tool-1', args: { code: 'pass' }, reason: 'test', ttlMs: 10000 };
    t.sandbox.faults.failNext(point);
    await expect(t.service.requestApproval(approval)).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    t.service.approvals.decide('run-1', 'approval-1', 'decision-1', true);
    t.sandbox.faults.failNext('sandbox.destroy.before');
    await expect(t.service.consumeApproval('run-1', 'approval-1', approval.args)).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    expect(t.service.approvals.get('run-1', 'approval-1').status).toBe('approved');
    expect(t.store.getRun('run-1').status).toBe('PAUSED_APPROVAL');
    await t.service.recover('run-1');
    await t.service.consumeApproval('run-1', 'approval-1', approval.args);
    expect(t.store.getRun('run-1').status).toBe('RUNNING');
    expect(t.service.approvals.get('run-1', 'approval-1').status).toBe('consumed');
  });
  it('retains an interrupted creation intent through recovery and cancellation', async () => {
    const t = await setup();
    t.store.addStep({ stepId: 'step-crash', runId: 'run-1', kind: 'python', required: true,
      inputHash: 'a'.repeat(64), status: 'PENDING', dependencies: [] });
    t.store.createAttempt('run-1', 'step-crash', 'b'.repeat(64));
    await t.service.recover('run-1');
    expect(t.store.listAttempts('run-1')[0]).toMatchObject({ status: 'UNKNOWN', errorCode: 'SANDBOX_CREATE_UNKNOWN' });
    expect(t.store.getRun('run-1').status).toBe('RECOVERY_REQUIRED');
    expect((await t.service.cancelRun('run-1', 'cancel-crash', { reason: 'test' })).status).toBe('RECOVERY_REQUIRED');
    await expect(t.service.finalize('run-1', false)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.sandbox.calls).toHaveLength(0);
  });
  it('commits artifact-backed output once and replays the same tool call', async () => {
    const t = await setup({ validate: true });
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      stdout: '42', outputs: [{ path: 'result.json', content: Buffer.from('{"answer":42}') }],
    } });
    const first = await t.service.executeCode(t.input);
    expect(first.stdout).toBe('42'); expect(first.artifacts).toHaveLength(1);
    const second = await t.service.executeCode(t.input);
    expect(second).toEqual(first);
    expect(t.store.listAttempts('run-1')).toHaveLength(1);
    const done = await t.service.finalize('run-1', true);
    expect(done.run.status).toBe('SUCCEEDED');
    expect(t.budget.snapshot('scope-1')).toMatchObject({ usedTokens: 0 });
  });

  it.each(['sandbox.destroy.before', 'sandbox.destroy.after'])('retries terminal sandbox cleanup after restart when %s fails', async point => {
    const t = await setup({ validate: true });
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
    await t.service.executeCode(t.input);
    t.store.saveSandbox(await t.sandbox.create('run-1', t.config.sandbox));
    t.sandbox.faults.failNext(point);
    expect((await t.service.finalize('run-1', true)).run.status).toBe('SUCCEEDED');
    expect(t.store.getSandbox('run-1')).toBeDefined();
    t.store.close();
    const reopened = new RuntimeStore(join(t.root, 'db'), t.clock.now); stores.push(reopened);
    const replacement = new RuntimeService(reopened, t.artifacts, t.sandbox, t.budget, t.config, { now: t.clock.now, wait: t.clock.sleep });
    t.sandbox.faults.failNext('sandbox.destroy.before');
    await expect(replacement.recover('run-1')).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    expect(reopened.getSandbox('run-1')).toBeDefined();
    await replacement.recover('run-1');
    expect(reopened.getSandbox('run-1')).toBeUndefined();
    expect(reopened.getRun('run-1').status).toBe('SUCCEEDED');
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
  });
  it('does not reclaim a terminal sandbox with an unresolved execution', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'UNKNOWN', reason: 'inspection unavailable' }] });
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    t.store.transitionRun('run-1', 'FAILED');
    await expect(t.service.recover('run-1')).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.store.getSandbox('run-1')).toBeDefined();
    expect(t.sandbox.calls.filter(call => call.method === 'destroy')).toHaveLength(0);
  });
  it('records sandbox infrastructure failures, pauses the run, and opens the dispatch circuit', async () => {
    const t = await setup();
    t.sandbox.faults.failNext('sandbox.create.before', new Error('DOCKER::SANDBOX_START_FAILED: egress sidecar failed'));
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'SANDBOX_CREATE_FAILED' });
    expect(t.store.getRun('run-1')).toMatchObject({ status: 'RECOVERY_REQUIRED' });
    expect(t.store.listSteps('run-1').find(step => step.stepId === 'step-1')).toMatchObject({ required: true });
    expect(t.store.listAttempts('run-1')[0]).toMatchObject({ status: 'UNKNOWN', errorCode: 'SANDBOX_CREATE_UNKNOWN', failure: { phase: 'sandbox.create' } });
    expect(t.store.eventsAfter('run-1').some(event => event.type === 'sandbox.creation_unknown')).toBe(true);
    expect(() => t.service.assertInfrastructureAvailable()).toThrow('egress sidecar failed');
  });
  it('does not treat a zero-exit script as independent task acceptance', async () => {
    const t = await setup(); t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
    await t.service.executeCode(t.input);
    await expect(t.service.finalize('run-1', true)).rejects.toThrow('validator');
    const partial = await t.service.finalize('run-1', false);
    expect(partial.run.status).toBe('COMPLETED_PARTIAL');
  });
  it.each(['cancel', 'context-pause'] as const)('preserves %s while the independent validator is awaiting evidence', async action => {
    const t = await setup();
    let enter!: () => void; let resolve!: (value: { passed: boolean; evidence: string }) => void;
    const started = new Promise<void>(done => { enter = done; });
    const validation = new Promise<{ passed: boolean; evidence: string }>(done => { resolve = done; });
    const service = new RuntimeService(t.store, t.artifacts, t.sandbox, t.budget, t.config, {
      now: t.clock.now, wait: t.clock.sleep,
      validate: async () => { enter(); return validation; },
    });
    await service.executeCode(t.input);
    const finalization = service.finalize('run-1', true);
    const rejected = expect(finalization).rejects.toMatchObject({ code: 'CONFLICT' });
    await started;
    await expect(service.executeCode({ ...t.input, stepId: 'concurrent-step' })).rejects.toMatchObject({ code: 'CONFLICT' });
    if (action === 'cancel') await service.cancelRun('run-1', 'cancel-during-finalize', { reason: 'user' });
    else service.pauseForContext('run-1', 'CONTEXT_REQUIRED_TOO_LARGE');
    resolve({ passed: true, evidence: 'late independent validation' });
    await rejected;
    expect(t.store.getRun('run-1').status).toBe(action === 'cancel' ? 'CANCELLED' : 'RECOVERY_REQUIRED');
    expect(t.store.listSteps('run-1').find(step => step.kind === 'review')?.status).toBe('PENDING');
    expect(t.store.eventsAfter('run-1').filter(event => event.type === 'validation.completed')).toHaveLength(0);
  });
  it.each(['dispatch', 'inspect'] as const)('counts time spent in %s before accepting a remote result', async boundary => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'FAILED', exitCode: -1 }], cancelConfirmed: true });
    if (boundary === 'dispatch') {
      const execute = t.sandbox.execute.bind(t.sandbox);
      t.sandbox.execute = async request => {
        const ref = await execute(request);
        t.clock.advance(1000);
        return ref;
      };
    } else {
      const inspect = t.sandbox.inspect.bind(t.sandbox);
      t.sandbox.inspect = async ref => {
        const status = await inspect(ref);
        t.clock.advance(1000);
        return status;
      };
    }
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('TIMED_OUT');
    expect(t.store.getRun('run-1').status).toBe('RUNNING');
    expect(t.store.getSandbox('run-1')).toBeUndefined();
    expect(t.sandbox.calls.filter(call => call.method === 'collect')).toHaveLength(0);
  });
  it('confirms timeout remotely before marking attempt timed out', async () => {
    const t = await setup(); t.sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: true });
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('TIMED_OUT');
  });
  it.each(['sandbox.destroy.before', 'sandbox.destroy.after'])('fences timeout cleanup across restart after %s', async point => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: true });
    t.sandbox.faults.failNext(point);
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    const oldSandbox = t.store.getSandbox('run-1');
    expect(oldSandbox).toBeDefined();
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('UNKNOWN');
    expect(t.store.getRun('run-1').status).toBe('RECOVERY_REQUIRED');
    await expect(t.service.resumeRun('run-1', 'before-cleanup', t.store.getRun('run-1').revision)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    t.store.close();
    const reopened = new RuntimeStore(join(t.root, 'db'), t.clock.now); stores.push(reopened);
    const replacement = new RuntimeService(reopened, t.artifacts, t.sandbox, t.budget, t.config, { now: t.clock.now, wait: t.clock.sleep });
    await replacement.recover('run-1');
    expect(reopened.getSandbox('run-1')).toBeUndefined();
    expect(reopened.listAttempts('run-1')[0]?.status).toBe('TIMED_OUT');
    await replacement.resumeRun('run-1', 'after-cleanup', reopened.getRun('run-1').revision);
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
    await replacement.executeCode({ ...t.input, stepId: 'step-2' });
    expect(reopened.getSandbox('run-1')?.sandboxId).not.toBe(oldSandbox?.sandboxId);
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(2);
  });
  it('keeps failed cleanup fenced when recovery cannot confirm destruction', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: false });
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    t.sandbox.faults.failNext('sandbox.destroy.before');
    await t.service.recover('run-1');
    expect(t.store.getRun('run-1').status).toBe('RECOVERY_REQUIRED');
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('UNKNOWN');
    await expect(t.service.resumeRun('run-1', 'cleanup-still-pending', t.store.getRun('run-1').revision)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
  });
  it('cleans up a remotely cancelled command first discovered during recovery', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'UNKNOWN', reason: 'inspection unavailable' }] });
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    const execution = t.sandbox.executionRefs[0]!;
    t.sandbox.setStatus(execution.executionId, { state: 'CANCELLED' });
    t.sandbox.faults.failNext('sandbox.destroy.before');
    await t.service.recover('run-1');
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('CANCELLED');
    expect(t.store.getRun('run-1').status).toBe('RECOVERY_REQUIRED');
    expect(t.store.getSandbox('run-1')).toBeDefined();
    await expect(t.service.resumeRun('run-1', 'before-remote-cancel-cleanup', t.store.getRun('run-1').revision))
      .rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    t.store.close();
    const reopened = new RuntimeStore(join(t.root, 'db'), t.clock.now); stores.push(reopened);
    const replacement = new RuntimeService(reopened, t.artifacts, t.sandbox, t.budget, t.config, { now: t.clock.now, wait: t.clock.sleep });
    await replacement.recover('run-1');
    expect(reopened.getSandbox('run-1')).toBeUndefined();
    expect(reopened.listAttempts('run-1')[0]?.status).toBe('CANCELLED');
  });
  it('does not mark cancellation terminal while a stopped command still has unresolved sandbox cleanup', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: false });
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    const execution = t.sandbox.executionRefs[0]!;
    t.sandbox.setStatus(execution.executionId, { state: 'CANCELLED' });
    t.sandbox.faults.failNext('sandbox.destroy.before');
    await t.service.recover('run-1');
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('CANCELLED');
    expect(t.store.getSandbox('run-1')).toBeDefined();

    t.sandbox.faults.failNext('sandbox.destroy.before');
    const failed = await t.service.cancelRun('run-1', 'cancel-with-pending-cleanup', { reason: 'user' });
    expect(failed.status).toBe('RECOVERY_REQUIRED');
    expect(t.store.getSandbox('run-1')).toBeDefined();
    await t.service.recover('run-1');
    expect(t.store.getSandbox('run-1')).toBeUndefined();
    const cancelled = await t.service.cancelRun('run-1', 'cancel-after-cleanup', { reason: 'user' });
    expect(cancelled.status).toBe('CANCELLED');
  });
  it('uses one remote cancel request when a user cancels an active execution', async () => {
    const t = await setup(); t.sandbox.enqueue({ states: [{ state: 'RUNNING' }] });
    const service = new RuntimeService(t.store, t.artifacts, t.sandbox, t.budget, t.config, {
      now: t.clock.now, wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))),
      pollIntervalMs: 10, cancelConfirmationTimeoutMs: 1000,
    });
    let executionError: unknown;
    const execution = service.executeCode(t.input).catch(error => { executionError = error; });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && t.store.listAttempts('run-1')[0]?.status !== 'RUNNING') {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('RUNNING');
    const cancelled = await service.cancelRun('run-1', 'active-cancel', { reason: 'user' });
    await execution;
    expect(cancelled.status).toBe('CANCELLED');
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('CANCELLED');
    expect(t.sandbox.calls.filter(call => call.method === 'cancel')).toHaveLength(1);
    expect(executionError).toMatchObject({ code: 'CONFLICT' });
  });
  it('waits for completed execution cleanup before confirming concurrent cancellation', async () => {
    const t = await setup();
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.txt', content: Buffer.from('saved') }],
    } });
    let unblock!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const destroying = new Promise<void>(resolve => { started = resolve; });
    const originalDestroy = t.sandbox.destroy.bind(t.sandbox);
    t.sandbox.destroy = async ref => { started(); await blocked; await originalDestroy(ref); };
    // Use the fixture clock for the run deadline and a real advancing clock for cancellation.
    const originalNow = Date.now;
    const serviceWithClock = new RuntimeService(t.store, t.artifacts, t.sandbox, t.budget, t.config, {
      now: () => 1000 + originalNow() - startTime,
      wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))),
      pollIntervalMs: 10, cancelConfirmationTimeoutMs: 1000,
    });
    const startTime = originalNow();
    const execution = serviceWithClock.executeCode(t.input);
    await destroying;
    const cancellation = serviceWithClock.cancelRun('run-1', 'cancel-during-cleanup', { reason: 'user' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(t.store.getRun('run-1').status).toBe('CANCELLING');
    expect(t.store.getSandbox('run-1')).toBeDefined();
    unblock();
    await execution;
    expect((await cancellation).status).toBe('CANCELLED');
    expect(t.store.getSandbox('run-1')).toBeUndefined();
    expect(t.store.listArtifacts('run-1')).toHaveLength(1);
    expect(t.sandbox.calls.filter(call => call.method === 'cancel')).toHaveLength(0);
  });
  it('keeps uncertain cancellation unresolved and rejects blind resume', async () => {
    const t = await setup(); t.sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: false });
    await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
    expect(t.store.getRun('run-1').status).toBe('RECOVERY_REQUIRED');
    const run = t.store.getRun('run-1');
    await expect(t.service.resumeRun('run-1', 'resume-1', run.revision)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
  });
  it.each(['after-cleanup-intent', 'after-publish', 'after-commit', 'after-destroy'] as const)(
    'reopens and reconciles a completed execution interrupted at %s', async point => {
      let once = true;
      const t = await setup({ fault: current => {
        if (current === point && once) { once = false; throw new Error('injected cleanup crash'); }
      } });
      t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
        outputs: [{ path: 'result.txt', content: Buffer.from('saved') }],
      } });
      await expect(t.service.executeCode(t.input)).rejects.toThrow();
      const oldSandbox = t.store.getSandbox('run-1');
      expect(oldSandbox).toBeDefined();
      await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
      t.store.close();
      const reopened = new RuntimeStore(join(t.root, 'db'), t.clock.now); stores.push(reopened);
      const replacement = new RuntimeService(reopened, t.artifacts, t.sandbox, t.budget, t.config, { now: t.clock.now, wait: t.clock.sleep });
      await replacement.recover('run-1');
      await replacement.recover('run-1');
      expect(reopened.getSandbox('run-1')).toBeUndefined();
      expect(reopened.listAttempts('run-1')).toHaveLength(1);
      expect(reopened.listAttempts('run-1')[0]?.status).toBe('SUCCEEDED');
      expect(reopened.eventsAfter('run-1').filter(event => event.type === 'tool.finished')).toHaveLength(1);
      const saved = reopened.listArtifacts('run-1');
      expect(saved).toHaveLength(1);
      expect(Buffer.from(await t.artifacts.read(saved[0]!)).toString()).toBe('saved');
      if (reopened.getRun('run-1').status === 'RECOVERY_REQUIRED') {
        await replacement.resumeRun('run-1', 'resume-cleanup', reopened.getRun('run-1').revision);
      }
      const replay = await replacement.executeCode(t.input);
      expect(replay.attemptId).toBe(reopened.listAttempts('run-1')[0]?.attemptId);
      t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
      await replacement.executeCode({ ...t.input, stepId: 'step-2' });
      const calls = t.sandbox.calls.filter(call => call.method === 'execute');
      expect(calls).toHaveLength(2);
      const request = calls[1]!.args[0] as { sandbox: { sandboxId: string }; inputs: Array<{ path: string; content: Uint8Array }> };
      expect(request.sandbox.sandboxId).not.toBe(oldSandbox?.sandboxId);
      expect(request.inputs.some(input => input.path === `artifacts/${saved[0]!.artifactId}/result.txt`
        && Buffer.from(input.content).toString() === 'saved')).toBe(true);
    },
  );
  it.each(['sandbox.destroy.before', 'sandbox.destroy.after'] as const)(
    'preserves a completed result across restart when %s fails', async point => {
      const t = await setup();
      t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
        outputs: [{ path: 'result.txt', content: Buffer.from('saved') }],
      } });
      t.sandbox.faults.failNext(point);
      await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
      const oldSandbox = t.store.getSandbox('run-1');
      expect(oldSandbox).toBeDefined();
      expect(t.store.getRun('run-1').status).toBe('RECOVERY_REQUIRED');
      const saved = t.store.listArtifacts('run-1');
      expect(saved).toHaveLength(1);
      expect(Buffer.from(await t.artifacts.read(saved[0]!)).toString()).toBe('saved');
      await expect(t.service.executeCode(t.input)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
      await expect(t.service.resumeRun('run-1', 'before-cleanup', t.store.getRun('run-1').revision)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
      t.store.close();
      const reopened = new RuntimeStore(join(t.root, 'db'), t.clock.now); stores.push(reopened);
      const replacement = new RuntimeService(reopened, t.artifacts, t.sandbox, t.budget, t.config, { now: t.clock.now, wait: t.clock.sleep });
      await replacement.recover('run-1');
      expect(reopened.getSandbox('run-1')).toBeUndefined();
      expect(reopened.listArtifacts('run-1')).toHaveLength(1);
      expect(reopened.listAttempts('run-1')).toHaveLength(1);
      expect(reopened.eventsAfter('run-1').filter(event => event.type === 'tool.finished')).toHaveLength(1);
      await replacement.resumeRun('run-1', 'after-cleanup', reopened.getRun('run-1').revision);
      const replay = await replacement.executeCode(t.input);
      expect(replay.attemptId).toBe(reopened.listAttempts('run-1')[0]?.attemptId);
      expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
      t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
      await replacement.executeCode({ ...t.input, stepId: 'step-2' });
      const calls = t.sandbox.calls.filter(call => call.method === 'execute');
      const request = calls[1]!.args[0] as { sandbox: { sandboxId: string }; inputs: Array<{ path: string; content: Uint8Array }> };
      expect(request.sandbox.sandboxId).not.toBe(oldSandbox?.sandboxId);
      expect(request.inputs.some(input => input.path === `artifacts/${saved[0]!.artifactId}/result.txt`
        && Buffer.from(input.content).toString() === 'saved')).toBe(true);
    },
  );
  it.each([0, 7])('destroys the sandbox after committing a command with exit code %s', async exitCode => {
    const t = await setup();
    t.sandbox.enqueue({ states: [exitCode === 0 ? { state: 'SUCCEEDED', exitCode } : { state: 'FAILED', exitCode }],
      collect: { outputs: [{ path: 'result.txt', content: Buffer.from('saved') }] } });
    const result = await t.service.executeCode(t.input);
    expect(result.exitCode).toBe(exitCode);
    expect(t.store.listAttempts('run-1')[0]?.status).toBe(exitCode === 0 ? 'SUCCEEDED' : 'FAILED');
    expect(t.store.getSandbox('run-1')).toBeUndefined();
    expect(result.artifacts).toHaveLength(1);
    expect(Buffer.from(await t.artifacts.read(t.store.listArtifacts('run-1')[0]!)).toString()).toBe('saved');
    expect(t.sandbox.calls.filter(call => call.method === 'destroy')).toHaveLength(1);
  });
  it('collects remote completion after publication-before-database failure without rerun', async () => {
    let once = true;
    const t = await setup({ fault: point => { if (point === 'after-publish' && once) { once = false; throw new Error('injected crash'); } } });
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.txt', content: Buffer.from('saved') }],
    } });
    await expect(t.service.executeCode(t.input)).rejects.toThrow('injected crash');
    expect(t.store.listArtifacts('run-1')).toHaveLength(0);
    const replacement = new RuntimeService(t.store, t.artifacts, t.sandbox, t.budget, t.config, { now: t.clock.now, wait: t.clock.sleep });
    await replacement.recover('run-1');
    expect(t.store.listAttempts('run-1')).toHaveLength(1);
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('SUCCEEDED');
    expect(t.store.listArtifacts('run-1')).toHaveLength(1);
    const paused = t.store.getRun('run-1');
    const resumed = await replacement.resumeRun('run-1', 'resume-1', paused.revision);
    expect(resumed.budgetScopeKey).toBe('scope-1');
    expect(await replacement.resumeRun('run-1', 'resume-1', paused.revision)).toEqual(resumed);
    const replayed = await replacement.executeCode(t.input);
    expect(replayed.artifacts).toHaveLength(1);
    expect(t.store.listAttempts('run-1')).toHaveLength(1);
  });
  it('retains dispatch-without-ID as unknown instead of launching another attempt', async () => {
    const t = await setup({ fault: point => { if (point === 'after-execute') throw new Error('crash before identity write'); } });
    t.sandbox.enqueue({ states: [{ state: 'RUNNING' }] });
    await expect(t.service.executeCode(t.input)).rejects.toThrow('identity');
    await t.service.recover('run-1');
    expect(t.store.listAttempts('run-1')[0]).toMatchObject({ status: 'UNKNOWN', executionId: null });
    await expect(t.service.executeCode(t.input)).rejects.toThrow('RECOVERY_REQUIRED');
  });
  it.each(['after-dispatch-intent', 'after-commit'] as const)('recovers the %s crash window without a second dispatch', async point => {
    let once = true;
    const t = await setup({ fault: current => { if (current === point && once) { once = false; throw new Error('crash-window'); } } });
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
    await expect(t.service.executeCode(t.input)).rejects.toThrow('crash-window');
    await t.service.recover('run-1');
    if (point === 'after-dispatch-intent') {
      expect(t.store.listAttempts('run-1')[0]).toMatchObject({ status: 'UNKNOWN', executionId: null });
      expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(0);
      await expect(t.service.resumeRun('run-1', 'resume', t.store.getRun('run-1').revision)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    } else {
      await t.service.executeCode(t.input);
      expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
      expect(t.store.eventsAfter('run-1').filter(e => e.type === 'tool.finished')).toHaveLength(1);
    }
    expect(t.store.listAttempts('run-1')).toHaveLength(1);
  });
  it('waits for a known remote execution and then commits it without redispatch', async () => {
    const t = await setup(); t.sandbox.enqueue({ states: [{ state: 'RUNNING' }] });
    t.sandbox.faults.failNext('sandbox.inspect.before');
    await expect(t.service.executeCode(t.input)).rejects.toThrow('Injected failure');
    const ref = t.sandbox.executionRefs[0]!;
    await t.service.recover('run-1');
    expect(t.store.listAttempts('run-1')[0]).toMatchObject({ status: 'UNKNOWN', errorCode: 'EXECUTION_UNKNOWN' });
    await expect(t.service.resumeRun('run-1', 'premature', t.store.getRun('run-1').revision)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    t.sandbox.setStatus(ref.executionId, { state: 'SUCCEEDED', exitCode: 0 });
    await t.service.recover('run-1');
    expect(t.store.listAttempts('run-1')[0]?.status).toBe('SUCCEEDED');
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });
  it('cleans unpublished staging after the original remote result is committed', async () => {
    const t = await setup(); let once = true;
    const artifacts = new ArtifactStore(t.artifacts.rootDir, { beforePublish: () => { if (once) { once = false; throw new Error('staging crash'); } } });
    const service = new RuntimeService(t.store, artifacts, t.sandbox, t.budget, t.config, { now: t.clock.now, wait: t.clock.sleep });
    t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.txt', content: Buffer.from('saved') }] } });
    await expect(service.executeCode(t.input)).rejects.toThrow('staging crash');
    expect((await artifacts.list()).staging).toHaveLength(1);
    await service.recover('run-1');
    expect((await artifacts.list()).staging).toHaveLength(0);
    expect(t.store.listArtifacts('run-1')).toHaveLength(1);
    expect(t.sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(1);
  });
  it('admits one of two clients resuming the same revision and replays identical commands', async () => {
    const t = await setup(); t.store.transitionRun('run-1', 'PAUSED_BUDGET'); t.store.saveCheckpoint('run-1');
    const revision = t.store.getRun('run-1').revision;
    const competing = await Promise.allSettled([
      t.service.resumeRun('run-1', 'client-a', revision), t.service.resumeRun('run-1', 'client-b', revision),
    ]);
    expect(competing.filter(c => c.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter(c => c.status === 'rejected')).toHaveLength(1);
    const winner = competing[0]?.status === 'fulfilled' ? 'client-a' : 'client-b';
    expect(await t.service.resumeRun('run-1', winner, revision)).toEqual(t.store.getRun('run-1'));
    await expect(t.service.resumeRun('run-1', winner, revision + 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(t.store.getRun('run-1').revision).toBe(revision + 1);
  });
  it('keeps budget pause and finalized policy intact when work allowance is still exhausted', async () => {
    const t = await pauseAtFinalizedBudget();
    const paused = t.store.getRun('run-1');
    const policy = t.store.getPolicyState('run-1');
    const checkpoint = t.store.latestCheckpoint('run-1');
    const events = t.store.eventsAfter('run-1');
    expect(t.budget.snapshot('scope-1')).toMatchObject({ availableTokens: 500, work: { availableTokens: 0 } });
    await expect(t.service.resumeRun('run-1', 'resume-finalized', paused.revision))
      .rejects.toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
    expect(t.store.getRun('run-1')).toEqual(paused);
    expect(t.store.getPolicyState('run-1')).toEqual(policy);
    expect(t.store.latestCheckpoint('run-1')).toEqual(checkpoint);
    expect(t.store.eventsAfter('run-1')).toEqual(events);
  });
  it('rolls back finalize release and command completion when checkpoint persistence fails and permits the same retry', async () => {
    const t = await pauseAtFinalizedBudget();
    t.budget.allocate('scope-1', 0, 'Trusted operator restored work allowance');
    const paused = t.store.getRun('run-1');
    const policy = t.store.getPolicyState('run-1');
    const checkpoint = t.store.latestCheckpoint('run-1');
    const events = t.store.eventsAfter('run-1');
    const saveCheckpoint = vi.spyOn(t.store, 'saveCheckpoint').mockImplementationOnce(() => {
      throw new Error('checkpoint persistence failure');
    });
    await expect(t.service.resumeRun('run-1', 'resume-finalized', paused.revision))
      .rejects.toThrow('checkpoint persistence failure');
    saveCheckpoint.mockRestore();
    expect(t.store.getRun('run-1')).toEqual(paused);
    expect(t.store.getPolicyState('run-1')).toEqual(policy);
    expect(t.store.latestCheckpoint('run-1')).toEqual(checkpoint);
    expect(t.store.eventsAfter('run-1')).toEqual(events);
    const resumed = await t.service.resumeRun('run-1', 'resume-finalized', paused.revision);
    expect(resumed.status).toBe('RUNNING');
    expect(t.store.getPolicyState('run-1')).toMatchObject({ finalized: false, stage: 'normal' });
    expect(t.store.latestCheckpoint('run-1')).toMatchObject({ revision: resumed.revision,
      policyState: { finalized: false, stage: 'normal' } });
    const committedEvents = t.store.eventsAfter('run-1');
    expect(committedEvents.slice(events.length).filter(event => event.type === 'policy.changed')).toHaveLength(1);
    expect(await t.service.resumeRun('run-1', 'resume-finalized', paused.revision)).toEqual(resumed);
    expect(t.store.eventsAfter('run-1')).toEqual(committedEvents);
  });
  it.each(['PAUSED_ACCOUNTING', 'RECOVERY_REQUIRED'] as const)(
    'preserves finalized policy during reconstruction and resume from %s', async status => {
      const t = await pauseAtFinalizedBudget();
      t.budget.allocate('scope-1', 0, 'Trusted operator restored work allowance');
      t.store.transitionRun('run-1', 'RECOVERY_REQUIRED');
      if (status === 'PAUSED_ACCOUNTING') t.store.transitionRun('run-1', status);
      t.store.saveCheckpoint('run-1');
      const policy = t.store.getPolicyState('run-1');
      const replacement = new RuntimeService(t.store, t.artifacts, t.sandbox, t.budget, t.config,
        { now: t.clock.now, wait: t.clock.sleep });
      await replacement.recover('run-1');
      expect(t.store.getPolicyState('run-1')).toEqual(policy);
      const paused = t.store.getRun('run-1');
      expect(paused.status).toBe(status);
      await replacement.resumeRun('run-1', 'resume-other-reason', paused.revision);
      expect(t.store.getPolicyState('run-1')).toEqual(policy);
      expect(t.store.eventsAfter('run-1').filter(event => event.type === 'policy.changed' &&
        (event.payload as { lastOperatorReason?: string }).lastOperatorReason)).toHaveLength(0);
    },
  );
  it('refuses changed input on a replayed step', async () => {
    const t = await setup(); t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }] });
    await t.service.executeCode(t.input);
    await expect(t.service.executeCode({ ...t.input, code: 'print(99)' })).rejects.toThrow('changed');
  });
  it('cancels idempotently and rejects changed command payload', async () => {
    const t = await setup();
    const first = await t.service.cancelRun('run-1', 'cancel-1', { reason: 'user' });
    expect(first.status).toBe('CANCELLED');
    expect(await t.service.cancelRun('run-1', 'cancel-1', { reason: 'user' })).toEqual(first);
    await expect(t.service.cancelRun('run-1', 'cancel-1', { reason: 'other' })).rejects.toThrow('reused');
    await expect(t.service.resumeRun('run-1', 'resume-1', first.revision)).rejects.toThrow('terminal');
  });
  it('does not renew the original deadline on resume', async () => {
    const t = await setup(); t.store.transitionRun('run-1', 'PAUSED_BUDGET');
    t.clock.advance(50000);
    await expect(t.service.resumeRun('run-1', 'resume-1', t.store.getRun('run-1').revision)).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
  });
});
