import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startApplication, type ApplicationConfig, type ApplicationHostOptions, type EvaluationRuntimeHost } from '../../src/app/index.js';
import { createRuntimeServer } from '../../src/api/server.js';
import { RUNTIME_PYTHON_TOOL } from '../../src/adapters/harness/index.js';
import { DurableToolRules } from '../../src/tools/durable.js';
import { ToolRuleEngine, type ToolRuleState } from '../../src/policy/tool-rules.js';
import { FakeSandbox } from '../support/fakes.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
const token = 'serial-test-token-32-characters-only';
const runId = 'serial-app-run';
const code = "import json, os\nfrom pathlib import Path\nPath(os.environ['AGENT_OUTPUT_DIR'], 'result.json').write_text(json.dumps({'verified': True}))";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class SerialProvider extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  response(request: GenerateOptions): unknown {
    return String(request.sessionId).endsWith('-planner') ? { steps: ['write result.json'], checks: ['verified is true'] }
      : String(request.sessionId).endsWith('-executor') ? { code } : { passed: true, findings: [] };
  }
  override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(request);
    const text = JSON.stringify(this.response(request));
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'application-serial-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'application.json');
  const app: ApplicationConfig = { schemaVersion: 1, runtimeConfigPath: resolve('config/example.json'), dataDir: root,
    model: { provider: 'controlled', name: 'controlled', apiKeyEnv: 'CONTROLLED_KEY', maxOutputTokens: 2048 },
    budget: { maxTokens: 50000, finalizeTokens: 0 }, sandbox: { domain: 'http://127.0.0.1:8090', apiKeyEnv: 'SANDBOX_KEY' },
    workflow: { mode: 'serial', maxRepairs: 1, approval: { reason: 'Review generated Python', ttlMs: 60000 },
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      context: { modelWindowTokens: 32768, safetyReserveTokens: 256 }, reference: { key: 'ranking' } },
  };
  const save = () => writeFileSync(configPath, JSON.stringify(app)); save();
  const provider = new SerialProvider(); const sandbox = new FakeSandbox();
  sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }],
    collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"verified":true}') }] } });
  const boot = async (overrides: Partial<ApplicationHostOptions> = {}) => {
    const host = await startApplication({ configPath, env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async (_run, artifacts, read) => {
        const result = artifacts.find(artifact => artifact.path === 'result.json');
        return { passed: !!result && JSON.parse(Buffer.from(await read(result)).toString()).verified === true, evidence: { controlled: true } };
      }, ...overrides });
    cleanups.push(() => host.close()); return host;
  };
  const submit = (host: EvaluationRuntimeHost) => host.submit({ runId, task: 'Read input.csv and write verified result.json.',
    inputs: [{ path: 'input.csv', content: Buffer.from('id\n42\n') }] });
  const pending = async (host: EvaluationRuntimeHost) => {
    expect((await host.wait(runId, { timeoutMs: 10000 })).status).toBe('PAUSED_APPROVAL');
    return host.service.approvals.list(runId)[0]!;
  };
  return { root, app, configPath, save, provider, sandbox, boot, submit, pending };
}
async function http(host: EvaluationRuntimeHost) {
  const server = createRuntimeServer(host.service, { token, control: { decideApproval: host.decideApproval, cancel: host.cancel } });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, value: unknown) => fetch(`${url}/runs/${runId}/${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}
async function succeeded(host: EvaluationRuntimeHost) {
  await expect.poll(async () => {
    const snapshot = await host.get(runId);
    if (snapshot.host.error) throw new Error(JSON.stringify(snapshot.host));
    return snapshot.status;
  }, { timeout: 10000 }).toBe('SUCCEEDED');
  await host.wait(runId, { timeoutMs: 1000 });
}

async function assertAccounting(host: EvaluationRuntimeHost, calls: number) {
  const scope = host.store.getRun(runId).budgetScopeKey;
  const ledger = await host.budget.reader.eventsAfter(0);
  for (const type of ['reserve', 'settle']) {
    const entries = ledger.filter(event => event.type === type);
    expect(entries).toHaveLength(calls);
    expect(entries.every(event => event.scopeKey === scope)).toBe(true);
  }
  expect(await host.budget.reader.snapshot(scope)).toMatchObject({ usedTokens: calls * 30, reservedTokens: 0, unknownCalls: 0 });
}

describe('application serial workflow with actual Harness, budget and MCP; controlled provider/sandbox', () => {
  it('automatically continues after HTTP approval, consumes once and shares the original ledger', async () => {
    const t = setup(); const host = await t.boot(); const post = await http(host);
    await t.submit(host); const approval = await t.pending(host);
    expect(t.provider.calls.map(call => String(call.sessionId))).toEqual([`${runId}-root-planner`, `${runId}-root-executor`]);
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(0);
    const body = { decisionId: 'approve-once', approved: true };
    expect((await post(`approvals/${approval.approvalId}`, body)).status).toBe(200);
    await succeeded(host);
    expect((await post(`approvals/${approval.approvalId}`, body)).status).toBe(200);
    expect((await post(`approvals/${approval.approvalId}`, { ...body, approved: false })).status).toBe(409);
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    expect(t.provider.calls).toHaveLength(3);
    expect(host.service.approvals.list(runId)[0]!.status).toBe('consumed');
    const events = host.store.eventsAfter(runId);
    expect(events.filter(event => event.type === 'approval.consumed')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool.completed').map(event => event.payload)).toMatchObject([
      { toolName: 'mcp.lookup_rule', location: 'mcp-host', ok: true },
      { toolName: RUNTIME_PYTHON_TOOL, location: 'sandbox', ok: true },
    ]);
    const scope = host.store.getRun(runId).budgetScopeKey;
    const ledger = await host.budget.reader.eventsAfter(0);
    const reserves = ledger.filter(event => event.type === 'reserve');
    expect(reserves).toHaveLength(3); expect(new Set(reserves.map(event => event.scopeKey))).toEqual(new Set([scope]));
    expect(ledger.filter(event => event.type === 'settle')).toHaveLength(3);
    expect(await host.budget.reader.snapshot(scope)).toMatchObject({ usedTokens: 90, reservedTokens: 0, unknownCalls: 0 });
    for (const call of t.provider.calls) {
      expect(JSON.stringify(call.messages)).toContain('Sort descending');
      expect(call.system).not.toContain('Sort descending');
    }
    expect(host.store.listArtifacts(runId)).toHaveLength(1);
  });

  it('coalesces approval arriving before the previous approval wait has returned', async () => {
    const t = setup(); const host = await t.boot(); const post = await http(host);
    const entered = gate(); const finish = gate();
    const request = host.service.requestApproval.bind(host.service);
    vi.spyOn(host.service, 'requestApproval').mockImplementationOnce(async input => {
      const record = await request(input); entered.resolve(); await finish.promise; return record;
    });
    try {
      await t.submit(host); await entered.promise;
      const approval = host.service.approvals.list(runId)[0]!;
      expect((await post(`approvals/${approval.approvalId}`, { decisionId: 'approve-race', approved: true })).status).toBe(200);
      finish.resolve(); await succeeded(host);
      expect(t.provider.calls).toHaveLength(3);
      expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    } finally { finish.resolve(); }
  });

  it('keeps pending approvals across reopening and resumes without repeating roles or MCP', async () => {
    const t = setup(); const first = await t.boot(); await t.submit(first); const approval = await t.pending(first);
    const original = first.store.getRun(runId); await first.close();
    const resumed = await t.boot();
    expect(resumed.store.getRun(runId)).toMatchObject({ status: 'PAUSED_APPROVAL', deadline: original.deadline, budgetScopeKey: original.budgetScopeKey });
    await resumed.decideApproval(runId, approval.approvalId, 'approve-reopened', true); await succeeded(resumed);
    expect(t.provider.calls).toHaveLength(3);
    expect(resumed.store.eventsAfter(runId).filter(event => event.type === 'tool.completed').map(event => event.payload)).toMatchObject([
      { toolName: 'mcp.lookup_rule', ok: true },
      { toolName: RUNTIME_PYTHON_TOOL, location: 'sandbox', ok: true },
    ]);
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
  });

  it('reconciles an approved wait after sandbox cleanup fails on restart', async () => {
    const t = setup(); const entered = gate(); const finish = gate();
    class PausingPlanner extends SerialProvider {
      override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
        if (String(request.sessionId).endsWith('-planner')) { entered.resolve(); await finish.promise; }
        yield* super.stream(request);
      }
    }
    const first = await t.boot({ provider: new PausingPlanner() });
    try {
      await t.submit(first); await entered.promise;
      await first.service.executeCode({ runId, stepId: 'earlier-step', code: 'print(1)', inputs: [] });
      first.store.saveSandbox(await t.sandbox.create(runId, first.service.config.sandbox));
      t.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }],
        collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"verified":true}') }] } });
      t.sandbox.faults.failNext('sandbox.destroy.before');
      finish.resolve();
      await expect.poll(() => first.isExecuting(runId), { timeout: 10_000 }).toBe(false);
      expect((await first.get(runId)).status).toBe('PAUSED_APPROVAL');
      expect(first.store.getSandbox(runId)).toBeDefined();
      const approval = first.service.approvals.list(runId)[0]!;
      first.service.approvals.decide(runId, approval.approvalId, 'approve-before-restart', true);
    } finally { finish.resolve(); await first.close(); }
    t.sandbox.faults.failNext('sandbox.destroy.before');
    const resumed = await t.boot();
    expect(await resumed.get(runId)).toMatchObject({ status: 'PAUSED_APPROVAL', host: { recoveryRequired: true, error: { code: 'CANCEL_UNCONFIRMED' } } });
    expect(resumed.service.approvals.list(runId)[0]!.status).toBe('approved');
    await resumed.reconcile(runId);
    await succeeded(resumed);
    expect(resumed.service.approvals.list(runId)[0]!.status).toBe('consumed');
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(2);
  }, 40_000);

  it('schedules a decision persisted immediately before shutdown when the host reopens', async () => {
    const t = setup(); const first = await t.boot(); await t.submit(first); const approval = await t.pending(first);
    first.service.approvals.decide(runId, approval.approvalId, 'approved-before-restart', true);
    await first.close(); const resumed = await t.boot(); await succeeded(resumed);
    expect(t.provider.calls).toHaveLength(3);
    expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
  });

  it('keeps rejection paused after restart, rejects a changed decision and allows cancellation', async () => {
    const t = setup(); const first = await t.boot(); await t.submit(first); const approval = await t.pending(first);
    await first.decideApproval(runId, approval.approvalId, 'reject-once', false); await first.close();
    const resumed = await t.boot(); const post = await http(resumed);
    expect((await resumed.get(runId)).status).toBe('PAUSED_APPROVAL');
    expect((await post(`approvals/${approval.approvalId}`, { decisionId: 'reject-once', approved: false })).status).toBe(200);
    expect((await post(`approvals/${approval.approvalId}`, { decisionId: 'changed', approved: true })).status).toBe(409);
    expect((await post('cancel', { commandId: 'cancel-rejected', reason: 'User cancelled' })).status).toBe(200);
    expect((await resumed.get(runId)).status).toBe('CANCELLED');
    expect(t.provider.calls).toHaveLength(2); expect(t.sandbox.executionRefs).toHaveLength(0);
  });

  it('pauses after the active role settles and resumes from that role after reopening', async () => {
    const t = setup(); const entered = gate(); const finish = gate();
    class PausingProvider extends SerialProvider {
      override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
        if (String(request.sessionId).endsWith('-planner')) { entered.resolve(); await finish.promise; }
        yield* super.stream(request);
      }
    }
    const provider = new PausingProvider(); const first = await t.boot({ provider });
    try {
      await t.submit(first); await entered.promise;
      expect((await first.pause(runId, 'pause-role', 'User pause')).status).toBe('PAUSING');
      finish.resolve();
      await expect.poll(() => first.store.getRun(runId).status).toBe('PAUSED_USER');
      const original = first.store.getRun(runId);
      expect(provider.calls).toHaveLength(1);
      expect(await first.budget.reader.snapshot(original.budgetScopeKey)).toMatchObject({ usedTokens: 30, reservedTokens: 0, unknownCalls: 0 });
      await first.close(); const resumed = await t.boot();
      const paused = resumed.store.getRun(runId);
      expect(paused).toMatchObject({ status: 'PAUSED_USER', deadline: original.deadline, budgetScopeKey: original.budgetScopeKey });
      await resumed.resume(runId, 'resume-role', paused.revision); const approval = await t.pending(resumed);
      await resumed.decideApproval(runId, approval.approvalId, 'approve-after-user-pause', true); await succeeded(resumed);
      expect(t.provider.calls.map(call => String(call.sessionId))).toEqual([`${runId}-root-executor`, `${runId}-root-reviewer`]);
      expect(t.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
      expect(await resumed.budget.reader.snapshot(original.budgetScopeKey)).toMatchObject({ usedTokens: 90, reservedTokens: 0, unknownCalls: 0 });
    } finally { finish.resolve(); }
  });

  it('cancels a running approved execution without dispatching Reviewer or replaying after restart', async () => {
    const t = setup(); const sandbox = new FakeSandbox({ plans: [{ states: [{ state: 'RUNNING' }] }] });
    const first = await t.boot({ sandbox }); const post = await http(first); await t.submit(first); const approval = await t.pending(first);
    await first.decideApproval(runId, approval.approvalId, 'approve-then-cancel', true);
    await expect.poll(() => first.store.listAttempts(runId)[0]?.status).toBe('RUNNING');
    expect((await post('cancel', { commandId: 'cancel-running', reason: 'User cancelled execution' })).status).toBe(200);
    expect((await first.wait(runId, { timeoutMs: 10000 })).status).toBe('CANCELLED');
    await first.close(); const resumed = await t.boot({ sandbox });
    expect((await resumed.get(runId)).status).toBe('CANCELLED');
    expect(resumed.store.listAttempts(runId)).toEqual([expect.objectContaining({ status: 'CANCELLED' })]);
    expect(t.provider.calls).toHaveLength(2);
    expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    expect(sandbox.calls.some(call => call.method === 'cancel')).toBe(true);
    expect(sandbox.calls.some(call => call.method === 'destroy')).toBe(true);
  });

  it('settles optional reporting in the original finalize allocation after independent acceptance', async () => {
    const t = setup(); t.app.budget.finalizeTokens = 2500; t.save(); const host = await t.boot();
    await t.submit(host); const approval = await t.pending(host);
    await host.decideApproval(runId, approval.approvalId, 'approve-with-report', true); await succeeded(host);
    const scope = host.store.getRun(runId).budgetScopeKey;
    const reserves = (await host.budget.reader.eventsAfter(0)).filter(event => event.type === 'reserve');
    expect(reserves.map(event => (event.payload.request as { purpose: string }).purpose)).toEqual(['work', 'work', 'work', 'finalize']);
    expect(new Set(reserves.map(event => event.scopeKey))).toEqual(new Set([scope]));
    expect(await host.budget.reader.snapshot(scope)).toMatchObject({ usedTokens: 120, reservedTokens: 0, unknownCalls: 0,
      work: { usedTokens: 90 }, finalize: { usedTokens: 30 } });
    const events = host.store.eventsAfter(runId);
    expect(events.find(event => event.type === 'validation.completed')!.eventSeq).toBeLessThan(
      events.find(event => event.type === 'finalization.report_intent')!.eventSeq);
  });

  it.each(['model', 'retry', 'mode'] as const)('blocks %s configuration drift after reopening', async change => {
    const t = setup(); const first = await t.boot(); await t.submit(first); const approval = await t.pending(first); await first.close();
    if (change === 'model') t.app.model.name = 'different';
    else if (change === 'retry') t.app.workflow!.retry.maxAttempts++;
    else delete t.app.workflow;
    t.save(); const resumed = await t.boot();
    expect((await resumed.get(runId)).host).toMatchObject({ recoveryRequired: true, error: { code: 'VERSION_MISMATCH' } });
    await expect(resumed.decideApproval(runId, approval.approvalId, 'approve-drift', true)).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(t.provider.calls).toHaveLength(2); expect(t.sandbox.executionRefs).toHaveLength(0);
    expect(resumed.service.approvals.get(runId, approval.approvalId).status).toBe('pending');
  });

  it('blocks changed original inputs before recording approval', async () => {
    const t = setup(); const host = await t.boot(); await t.submit(host); const approval = await t.pending(host);
    host.store.setComponentState(runId, 'application', 'inputs', { version: 1, files: [{ path: 'input.csv', base64: Buffer.from('changed').toString('base64') }] });
    await expect(host.decideApproval(runId, approval.approvalId, 'approve-changed-input', true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(host.service.approvals.get(runId, approval.approvalId).status).toBe('pending');
    expect(t.sandbox.executionRefs).toHaveLength(0);
  });

  it('rejects an expired decision without dispatching or creating a new prompt', async () => {
    const t = setup(); const host = await t.boot(); await t.submit(host); const approval = await t.pending(host);
    host.store.setComponentState(runId, 'approvals', approval.approvalId, { ...approval, expiresAt: Date.now() - 1 });
    await expect(host.decideApproval(runId, approval.approvalId, 'approve-expired', true)).rejects.toThrow('expired');
    expect(host.service.approvals.list(runId)).toHaveLength(1); expect(t.sandbox.executionRefs).toHaveLength(0);
  });

  it('rechecks hard budget limits after approval and keeps the decision unconsumed', async () => {
    const t = setup(); const host = await t.boot(); await t.submit(host); const approval = await t.pending(host);
    const run = host.store.getRun(runId); const before = await host.budget.reader.snapshot(run.budgetScopeKey);
    const reservation = await host.budget.control.reserve({ scopeKey: run.budgetScopeKey, sessionId: run.rootSessionId, modelCallId: 'controlled-budget-exhaustion',
      provider: 'controlled', model: 'controlled', purpose: 'work', estimatedTokens: before.availableTokens });
    expect(reservation.allowed).toBe(true); if (!reservation.allowed) throw new Error('Expected a test reservation');
    await host.budget.control.markDispatched(reservation.reservation.reservationId);
    await host.budget.control.settle(reservation.reservation.reservationId, { inputTokens: before.availableTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await host.decideApproval(runId, approval.approvalId, 'approve-with-empty-budget', true);
    await expect.poll(async () => (await host.get(runId)).host.error?.code).toBe('BUDGET_UNAVAILABLE');
    expect(host.service.approvals.get(runId, approval.approvalId).status).toBe('approved');
    expect(t.sandbox.executionRefs).toHaveLength(0);
  });

  it('preserves an incomplete role as recovery-required across restart without provider replay', async () => {
    const t = setup();
    class IncompleteProvider extends SerialProvider {
      override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
        this.calls.push(request);
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
      }
    }
    const incomplete = new IncompleteProvider();
    const first = await t.boot({ provider: incomplete }); await t.submit(first);
    expect((await first.wait(runId, { timeoutMs: 10000 })).status).toBe('RECOVERY_REQUIRED'); await first.close();
    const resumed = await t.boot(); expect((await resumed.get(runId)).status).toBe('RECOVERY_REQUIRED');
    expect(resumed.store.listComponentState(runId, 'role-calls')).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(incomplete.calls).toHaveLength(1); expect(t.provider.calls).toHaveLength(0); expect(t.sandbox.executionRefs).toHaveLength(0);
  });

  it('does not replay an unknown code dispatch on restart or repeated approval', async () => {
    const t = setup(); const sandbox = new FakeSandbox({ plans: [{ throwAfterDispatch: true }] });
    const first = await t.boot({ sandbox }); await t.submit(first); const approval = await t.pending(first);
    await first.decideApproval(runId, approval.approvalId, 'approve-unknown', true);
    await expect.poll(() => first.store.getRun(runId).status).toBe('RECOVERY_REQUIRED'); await first.close();
    const resumed = await t.boot({ sandbox });
    await resumed.decideApproval(runId, approval.approvalId, 'approve-unknown', true);
    expect((await resumed.get(runId)).status).toBe('RECOVERY_REQUIRED');
    expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1); expect(t.provider.calls).toHaveLength(2);
  });

  it('requires independent validation even when Reviewer passes', async () => {
    const t = setup(); const host = await t.boot({ validate: async () => ({ passed: false, evidence: { mismatch: true } }) });
    await t.submit(host); const approval = await t.pending(host);
    await host.decideApproval(runId, approval.approvalId, 'approve-invalid-artifact', true);
    await expect.poll(() => host.store.getRun(runId).status).toBe('COMPLETED_PARTIAL');
    expect(t.provider.calls).toHaveLength(3);
    expect(host.store.listSteps(runId).find(step => step.kind === 'review')!.status).toBe('FAILED');
  });

  it('retries a proven unsent creation failure under one approval without repeating roles or charging tools as model calls', async () => {
    const t = setup(); t.sandbox.faults.failNext('sandbox.create.before');
    const host = await t.boot(); await t.submit(host); const approval = await t.pending(host);
    await host.decideApproval(runId, approval.approvalId, 'approve-unsent-retry', true); await succeeded(host);
    expect(host.store.listAttempts(runId).map(attempt => [attempt.attemptNo, attempt.status, attempt.errorCode])).toEqual([
      [1, 'FAILED', 'SANDBOX_CREATE_FAILED'], [2, 'SUCCEEDED', null],
    ]);
    expect(t.sandbox.calls.filter(call => call.method === 'create')).toHaveLength(2);
    expect(t.sandbox.executionRefs).toHaveLength(1); expect(t.provider.calls).toHaveLength(3);
    expect(host.service.approvals.list(runId)).toHaveLength(1);
    expect(host.store.eventsAfter(runId).filter(event => event.type === 'approval.consumed')).toHaveLength(1);
    await assertAccounting(host, 3);
    await host.close(); const reopened = await t.boot();
    expect((await reopened.get(runId)).status).toBe('SUCCEEDED'); await assertAccounting(reopened, 3);
    expect(t.sandbox.executionRefs).toHaveLength(1); expect(t.provider.calls).toHaveLength(3);
  });

  it('stops at the configured creation retry bound and retains the exhausted attempts after restart', async () => {
    const t = setup(); t.sandbox.faults.failNext('sandbox.create.before').failNext('sandbox.create.before');
    const host = await t.boot(); await t.submit(host); const approval = await t.pending(host);
    await host.decideApproval(runId, approval.approvalId, 'approve-exhausted-retry', true);
    await expect.poll(() => host.store.getRun(runId).status).toBe('COMPLETED_PARTIAL');
    expect(host.store.listAttempts(runId)).toHaveLength(2);
    expect(host.store.listAttempts(runId).every(attempt => attempt.status === 'FAILED' && attempt.errorCode === 'SANDBOX_CREATE_FAILED'
      && attempt.sandboxId === null && attempt.executionId === null && attempt.workDir === null)).toBe(true);
    expect(host.store.listComponentState(runId, 'retry-executor')).toEqual([expect.objectContaining({ phase: 'blocked', dispatchNo: 2, failure: 'transient-unsent' })]);
    expect(t.sandbox.calls.filter(call => call.method === 'create')).toHaveLength(2);
    expect(t.sandbox.executionRefs).toHaveLength(0); expect(t.provider.calls).toHaveLength(2);
    await assertAccounting(host, 2);
    await host.close(); const reopened = await t.boot();
    await reopened.decideApproval(runId, approval.approvalId, 'approve-exhausted-retry', true);
    expect((await reopened.get(runId)).status).toBe('COMPLETED_PARTIAL');
    expect(t.sandbox.calls.filter(call => call.method === 'create')).toHaveLength(2); await assertAccounting(reopened, 2);
  });

  it.each(['planner', 'executor', 'reviewer'] as const)('blocks a settled but schema-invalid %s response without replay on restart', async role => {
    const t = setup(); const response = t.provider.response.bind(t.provider);
    vi.spyOn(t.provider, 'response').mockImplementation(request => String(request.sessionId).endsWith(`-${role}`) ? { unexpected: true } : response(request));
    const host = await t.boot(); await t.submit(host);
    if (role === 'reviewer') {
      const approval = await t.pending(host); await host.decideApproval(runId, approval.approvalId, 'approve-before-invalid-review', true);
    }
    await expect.poll(() => host.store.getRun(runId).status).toBe('RECOVERY_REQUIRED');
    const calls = role === 'planner' ? 1 : role === 'executor' ? 2 : 3;
    expect(t.provider.calls).toHaveLength(calls);
    expect(host.store.listComponentState(runId, 'role-calls').filter(record => (record as { status: string }).status === 'pending')).toHaveLength(1);
    expect(t.sandbox.executionRefs).toHaveLength(role === 'reviewer' ? 1 : 0); await assertAccounting(host, calls);
    await host.close(); const reopened = await t.boot();
    expect((await reopened.get(runId)).status).toBe('RECOVERY_REQUIRED');
    expect(t.provider.calls).toHaveLength(calls); await assertAccounting(reopened, calls);
  });

  it('enforces the persisted production tool quota before creating an approval', async () => {
    const t = setup(); const host = await t.boot(); const response = t.provider.response.bind(t.provider);
    vi.spyOn(t.provider, 'response').mockImplementation(request => {
      if (String(request.sessionId).endsWith('-executor')) {
        // Seed prior admissions through the actual engine; this serial fixture does not execute 32 scripts.
        const rules = new DurableToolRules(host.store, new ToolRuleEngine([
          { toolName: RUNTIME_PYTHON_TOOL, warnAt: 8, maxCalls: 32, warnNoProgressAt: 2, stopNoProgressAt: 3 },
          { toolName: 'mcp.lookup_rule', warnAt: 1, maxCalls: 1 },
        ]));
        const inputHash = host.store.getRun(runId).inputHash;
        for (let index = 0; index < 32; index++) expect(rules.admit(runId, { callId: `seed-prior-${index}`, toolName: RUNTIME_PYTHON_TOOL,
          arguments: { seededPriorHistory: index }, inputVersion: inputHash, progressVersion: inputHash }).allowed).toBe(true);
      }
      return response(request);
    });
    await t.submit(host); await expect.poll(() => host.store.getRun(runId).status).toBe('COMPLETED_PARTIAL');
    expect((await host.get(runId)).host.error).toMatchObject({ code: 'POLICY_TOOL_BLOCKED', message: 'TOOL_CALL_LIMIT' });
    expect(host.service.approvals.list(runId)).toHaveLength(0); expect(t.sandbox.executionRefs).toHaveLength(0);
    const state = host.store.getComponentState<ToolRuleState>(runId, 'tool-policy', 'state')!;
    expect(state.tools[RUNTIME_PYTHON_TOOL]!.calls).toBe(32);
    expect(Object.values(state.admissions).filter(value => value.reason === 'TOOL_CALL_LIMIT')).toHaveLength(1);
    await assertAccounting(host, 2); await host.close(); const reopened = await t.boot();
    expect(reopened.store.getComponentState(runId, 'tool-policy', 'state')).toEqual(state);
    expect(t.provider.calls).toHaveLength(2); expect(t.sandbox.calls).toHaveLength(0);
  });

  it('stops a fourth identical script after three failed approved executions without new input or progress', async () => {
    const t = setup(); t.app.workflow!.maxRepairs = 3; t.save();
    const sandbox = new FakeSandbox({ plans: Array.from({ length: 3 }, () => ({ states: [{ state: 'FAILED' as const, exitCode: 7 }],
      collect: { stdout: 'same-failure', stderr: 'same-error' } })) });
    const host = await t.boot({ sandbox }); await t.submit(host);
    for (let index = 0; index < 3; index++) {
      await expect.poll(() => host.service.approvals.list(runId).filter(value => value.status === 'pending').length).toBe(1);
      const approval = host.service.approvals.list(runId).find(value => value.status === 'pending')!;
      await host.decideApproval(runId, approval.approvalId, `approve-failure-${index}`, true);
    }
    await expect.poll(() => host.store.getRun(runId).status).toBe('COMPLETED_PARTIAL');
    expect((await host.get(runId)).host.error).toMatchObject({ code: 'POLICY_TOOL_BLOCKED', message: 'NO_PROGRESS' });
    expect(host.service.approvals.list(runId)).toHaveLength(3);
    expect(host.service.approvals.list(runId).every(value => value.status === 'consumed')).toBe(true);
    expect(sandbox.executionRefs).toHaveLength(3); expect(t.provider.calls).toHaveLength(8);
    const state = host.store.getComponentState<ToolRuleState>(runId, 'tool-policy', 'state')!;
    expect(state.tools[RUNTIME_PYTHON_TOOL]).toMatchObject({ calls: 3, repeatedFailures: 3 });
    expect(Object.values(state.admissions).filter(value => value.reason === 'NO_PROGRESS')).toHaveLength(1);
    await assertAccounting(host, 8); await host.close(); const reopened = await t.boot({ sandbox });
    expect(reopened.store.getComponentState(runId, 'tool-policy', 'state')).toEqual(state);
    expect(sandbox.executionRefs).toHaveLength(3); expect(t.provider.calls).toHaveLength(8);
  });

  it.each(['timeout', 'disconnect'] as const)('blocks the required MCP %s before any role call and preserves the failed receipt across restart', async kind => {
    const t = setup(); const callTool = Client.prototype.callTool;
    const request = vi.spyOn(Client.prototype, 'callTool').mockImplementationOnce(async function (this: Client, params, schema, options) {
      // Exercise the real stdio server/SDK; disconnect kills only this test-owned MCP subprocess.
      const pending = callTool.call(this, { ...params, arguments: { ...params.arguments, delayMs: 1000 } }, schema,
        { ...options, timeout: kind === 'timeout' ? 30 : 2000 });
      if (kind === 'disconnect') {
        expect(this.transport).toBeInstanceOf(StdioClientTransport);
        const pid = (this.transport as StdioClientTransport).pid;
        if (!pid) throw new Error('Test MCP process has no PID');
        process.kill(pid, 'SIGKILL');
      }
      return pending;
    });
    const host = await t.boot(); await t.submit(host);
    const expected = kind === 'timeout' ? 'COMPLETED_PARTIAL' : 'RECOVERY_REQUIRED';
    await expect.poll(() => host.store.getRun(runId).status, { timeout: 10000 }).toBe(expected);
    expect(request).toHaveBeenCalledTimes(1); expect(t.provider.calls).toHaveLength(0);
    expect(host.service.approvals.list(runId)).toHaveLength(0); expect(t.sandbox.calls).toHaveLength(0);
    const receipts = host.store.listComponentState(runId, 'tool-calls');
    expect(receipts).toEqual([expect.objectContaining({ result: expect.objectContaining({ ok: false,
      error: expect.objectContaining({ code: kind === 'timeout' ? 'TOOL_TIMEOUT' : 'EXECUTION_UNKNOWN' }) }) })]);
    expect(host.store.listComponentState(runId, 'role-calls')).toEqual([expect.objectContaining({ status: 'not-dispatched' })]);
    await assertAccounting(host, 0); await host.close(); const reopened = await t.boot();
    expect((await reopened.get(runId)).status).toBe(expected);
    expect(reopened.store.listComponentState(runId, 'tool-calls')).toEqual(receipts);
    expect(request).toHaveBeenCalledTimes(1); expect(t.provider.calls).toHaveLength(0); await assertAccounting(reopened, 0);
  });

  it('rejects unsupported workflow configuration before any provider call', async () => {
    const t = setup();
    const invalid = JSON.parse(readFileSync(t.configPath, 'utf8')); invalid.workflow.untrustedCommand = 'arbitrary-server';
    writeFileSync(t.configPath, JSON.stringify(invalid));
    await expect(t.boot()).rejects.toThrow(); expect(t.provider.calls).toHaveLength(0);
  });
});
