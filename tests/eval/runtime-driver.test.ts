import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectLedgerCalls, createRuntimeEvaluationDriver, inferInfrastructureFailure, type EvaluationRuntimeHost } from '../../eval/runtime-driver.js';
import { analyzeInput, expectedChart, expectedReport } from '../../eval/artifact-validation.js';
import type { BudgetEventReceipt } from '../../src/contracts/budget.js';
import { loadConfig } from '../../src/config.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService, type RuntimeServiceOptions } from '../../src/core/service.js';
import { FakeBudget, FakeSandbox } from '../support/fakes.js';

const usage = { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3 };
function receipts(events: Array<{ type: string; payload: Record<string, unknown>; scopeKey?: string }>): BudgetEventReceipt[] {
  return events.map((event, i) => ({ cursor: i + 1, eventId: `receipt-${i + 1}`, scopeKey: event.scopeKey ?? 'root', type: event.type, payload: event.payload }));
}
const reserve = (id: string, purpose = 'work', scopeKey = 'root') => ({ type: 'reserve', scopeKey, payload: { reservationId: id, request: { scopeKey, modelCallId: `call-${id}`, sessionId: `session-${id}`, purpose } } });
function configs() {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-driver-config-')); const configs = {} as Record<'hard-only' | 'tiered' | 'tiered-finalize', string>;
  const runtime = JSON.parse(readFileSync('config/example.json', 'utf8')) as { policy: Record<string, unknown> };
  for (const variant of ['hard-only', 'tiered', 'tiered-finalize'] as const) {
    const r = structuredClone(runtime); r.policy = { ...r.policy, mode: variant === 'hard-only' ? 'observe' : 'enforce', finalizeShare: variant === 'tiered-finalize' ? 0.1 : 0 };
    writeFileSync(join(directory, `${variant}.runtime.json`), JSON.stringify(r));
    const path = join(directory, `${variant}.json`);
    writeFileSync(path, JSON.stringify({ runtimeConfigPath: `${variant}.runtime.json`, dataDir: `${variant}.data`,
      model: { provider: 'deepseek', name: 'deepseek-chat', apiKeyEnv: 'CONTROLLED_MODEL_KEY' }, budget: { maxTokens: 10000, finalizeTokens: variant === 'tiered-finalize' ? 1000 : 0 },
      sandbox: { domain: '127.0.0.1:8090', apiKeyEnv: 'CONTROLLED_SANDBOX_KEY' } })); configs[variant] = path;
  }
  return { directory, configs };
}
describe('original ledger receipt enumeration (controlled receipt fixtures)', () => {
  it('includes work, summary, review, retry and finalize consumption', () => {
    const purposes = ['work', 'work', 'work', 'work', 'finalize'];
    const events = receipts(purposes.flatMap((p, i) => [reserve(String(i), p), { type: 'dispatch', payload: { reservationId: String(i) } }, { type: 'settle', payload: { reservationId: String(i), usage } }]));
    const hints = new Map([['call-1', 'summary'], ['call-2', 'review'], ['call-3', 'retry']] as const);
    const calls = collectLedgerCalls(events, 'root', hints);
    expect(calls.map(c => c.category)).toEqual(['work', 'summary', 'review', 'retry', 'finalize']); expect(calls.every(c => c.usage?.inputTokens === 10)).toBe(true);
  });
  it('preserves dispatched UNKNOWN and pending reservations as null usage', () => {
    const events = receipts([reserve('a'), { type: 'dispatch', payload: { reservationId: 'a' } }, { type: 'unknown', payload: { reservationId: 'a' } }, reserve('b')]);
    expect(collectLedgerCalls(events, 'root').map(c => c.usage)).toEqual([null, null]);
  });
  it('accepts explicit later settlement of UNKNOWN without replaying a call', () => {
    const events = receipts([reserve('a'), { type: 'dispatch', payload: { reservationId: 'a' } }, { type: 'unknown', payload: { reservationId: 'a' } }, { type: 'settle', payload: { reservationId: 'a', usage } }]);
    expect(collectLedgerCalls(events, 'root')).toEqual([{ callId: 'call-a', category: 'work', usage }]);
  });
  it('rejects invalid repeated dispatch and UNKNOWN transitions', () => {
    expect(() => collectLedgerCalls(receipts([reserve('a'), { type: 'dispatch', payload: { reservationId: 'a' } }, { type: 'dispatch', payload: { reservationId: 'a' } }]), 'root')).toThrow();
    expect(() => collectLedgerCalls(receipts([reserve('a'), { type: 'unknown', payload: { reservationId: 'a' } }]), 'root')).toThrow();
    expect(() => collectLedgerCalls(receipts([reserve('a'), { type: 'dispatch', payload: { reservationId: 'a' } }, { type: 'unknown', payload: { reservationId: 'a' } }, { type: 'unknown', payload: { reservationId: 'a' } }]), 'root')).toThrow();
  });
  it('omits only proven released-unsent reservations', () => {
    expect(collectLedgerCalls(receipts([reserve('a'), { type: 'release-unsent', payload: { reservationId: 'a' } }]), 'root')).toEqual([]);
  });
  it('never fills missing usage buckets with zeros', () => {
    expect(() => collectLedgerCalls(receipts([reserve('a'), { type: 'dispatch', payload: { reservationId: 'a' } }, { type: 'settle', payload: { reservationId: 'a', usage: { inputTokens: 10 } } }]), 'root')).toThrow();
  });
  it('does not borrow calls from unrelated root scopes', () => {
    expect(collectLedgerCalls(receipts([reserve('a', 'work', 'other')]), 'root')).toEqual([]);
  });
  it('rejects orphan settlements, dispatchless settlements and duplicate call IDs', () => {
    for (const events of [[{ type: 'settle', payload: { reservationId: 'a', usage } }], [reserve('a'), { type: 'settle', payload: { reservationId: 'a', usage } }], [reserve('a'), reserve('a')]]) expect(() => collectLedgerCalls(receipts(events), 'root')).toThrow();
  });
  it('includes unknown legacy calls, compaction and ordinary samples without losing cache buckets', () => {
    expect(collectLedgerCalls(receipts([{ type: 'start', payload: { callId: 'a' } }, { type: 'sample', payload: { callId: 'a', purpose: 'compaction', usage } }, { type: 'unmetered', payload: { callId: 'b' } }]), 'root')).toEqual([{ callId: 'a', category: 'summary', usage }, { callId: 'b', category: 'work', usage: null }]);
  });
});
describe('runtime driver preflight (controlled configuration; no network/provider/sandbox)', () => {
  it('requires sandbox attribution rather than classifying a generic provider fetch failure as sandbox', () => {
    expect(inferInfrastructureFailure([], { code: 'HOST_FAILED', message: 'fetch failed' })).toBeUndefined();
    expect(inferInfrastructureFailure([], { code: 'HOST_FAILED', message: 'fetch failed', phase: 'sandbox.create' })).toMatchObject({ phase: 'sandbox.create' });
  });
  it('classifies a persisted sandbox-create attempt failure for batch gating', () => {
    const evidence = inferInfrastructureFailure([{
      schemaVersion: 1, eventId: 'event-1', runId: 'run-1', eventSeq: 1, timestamp: 123,
      type: 'attempt.failed', payload: { errorCode: 'SANDBOX_CREATE_FAILED' },
    }]);
    expect(evidence).toMatchObject({ code: 'SANDBOX_CREATE_FAILED', phase: 'sandbox.create', retryable: false });
  });

  it('fails on absent credentials before the host can be started', () => {
    const f = configs(); expect(() => createRuntimeEvaluationDriver({ configs: f.configs, env: {} })).toThrow('missing required credential');
  });
  it('does not allow an injected host or execution identity to be labeled real', () => {
    const f = configs(); const start = vi.fn(); expect(() => createRuntimeEvaluationDriver({ configs: f.configs, start })).toThrow('injected host');
  });
  it('has distinct semantic settings and hashes for three variants', () => {
    const f = configs(); const driver = createRuntimeEvaluationDriver({ configs: f.configs, mode: 'simulation', directory: f.directory });
    expect(driver.manifest.mode).toBe('simulation'); expect(new Set(Object.values(driver.manifest.variants).map(v => v.configSha256)).size).toBe(3);
    expect(Object.values(driver.manifest.variants).map(v => v.budgetLimitTokens)).toEqual([10000, 10000, 10000]);
  });
  it('rejects mislabeled observe settings or unequal budgets instead of changing only labels', () => {
    const f = configs(); const path = f.configs.tiered; const app = JSON.parse(readFileSync(path, 'utf8')) as { budget: { maxTokens: number } }; app.budget.maxTokens = 20000; writeFileSync(path, JSON.stringify(app));
    expect(() => createRuntimeEvaluationDriver({ configs: f.configs, mode: 'simulation' })).toThrow('identical model configuration and total token budget');
  });
  it('reconcile refuses absent local intent before starting an app or sending calls', async () => {
    const f = configs(); const start = vi.fn(); const driver = createRuntimeEvaluationDriver({ configs: f.configs, mode: 'simulation', start, directory: f.directory });
    await expect(driver.reconcile!({ runId: 'old-run', suiteSha256: 'a'.repeat(64), taskId: 'c01', variant: 'hard-only', repetition: 1, prompt: 'task', input: { path: 'input.csv', content: new Uint8Array(), sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } })).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });
});
describe('driver lifecycle against real core service/storage with explicitly fake budget/sandbox (simulation only)', () => {
  it.each([
    { code: 'MODEL_OUTPUT_TRUNCATED', finish: 'max-tokens', expected: 'provider' },
    { code: 'HOST_FAILED', finish: 'error', expected: 'provider' },
    { code: 'CONFLICT', finish: 'stop', expected: 'other' },
    { code: 'HOST_FAILED', finish: 'stop', expected: 'other' },
    { code: 'RUNTIME_MODEL_POLICY_BLOCKED', finish: undefined, expected: 'other' },
    { code: 'BUDGET_UNAVAILABLE', finish: 'tool-calls', expected: 'budget' },
    { code: undefined, finish: 'max-tokens', expected: 'provider' },
    { code: 'VALIDATION_FAILED', finish: 'stop', expected: 'validation' },
    { code: undefined, finish: 'stop', expected: 'validation' },
  ])('preserves $expected classification for $code / $finish despite missing artifacts', async ({ code, finish, expected }) => {
    const f = configs(); const store = new RuntimeStore(join(f.directory, 'db')); const artifacts = new ArtifactStore(join(f.directory, 'artifacts'));
    const budget = new FakeBudget({ sessionIds: ['root-session'], scopeKey: 'controlled-scope' }); const sandbox = new FakeSandbox();
    const service = new RuntimeService(store, artifacts, sandbox, budget, loadConfig('config/example.json'));
    const snapshot = async (runId: string) => ({ ...await service.getRun(runId), host: { active: false, recoveryRequired: false,
      ...(code ? { error: { code, message: 'controlled response failure' } } : {}) } });
    const start = async (): Promise<EvaluationRuntimeHost> => ({
      mode: { provider: 'controlled', sandbox: 'fake', injectedProvider: true, injectedSandbox: true, finalization: 'disabled' }, store, artifacts,
      budget: { port: budget, control: budget, operator: budget, reader: budget },
      async submit(request) {
        await service.createRun({ runId: request.runId, task: request.task, rootSessionId: 'root-session', budgetScopeKey: 'controlled-scope',
          deadline: Date.now() + 60_000, policyVersion: 'controlled', inputHash: 'a'.repeat(64) });
        store.appendEvent(request.runId, 'model.response', { finishReason: finish });
        await service.finalize(request.runId, false);
      }, wait: snapshot, get: snapshot, reconcile: snapshot, close: async () => undefined,
    });
    try {
      const driver = createRuntimeEvaluationDriver({ configs: f.configs, mode: 'simulation', directory: join(f.directory, 'evidence'), start });
      const input = readFileSync('eval/fixtures/c01.csv');
      const request = { runId: 'controlled-failure-run', suiteSha256: 'a'.repeat(64), taskId: 'c01', variant: 'hard-only' as const, repetition: 1,
        prompt: 'controlled task', input: { path: 'input.csv' as const, content: input, sha256: createHash('sha256').update(input).digest('hex') } };
      const result = await driver.validate(request, await driver.execute(request));
      expect(result.failureKind).toBe(expected);
      const failure = JSON.parse(readFileSync(join(dirname(result.evidence.trace), 'failure.json'), 'utf8'));
      expect(failure).toMatchObject({ failureKind: expected, hostErrorCode: code ?? null, lastModelFinishReason: finish ?? null, validationPassed: false });
      expect(JSON.stringify(failure)).not.toContain('controlled response failure');
      expect(result.evidence.artifacts).toEqual([]);
      expect(sandbox.calls.some(call => call.method === 'execute')).toBe(false);
    } finally { store.close(); }
  });

  it('records verified bytes and unknown usage, then reconciles only existing run without another execution', async () => {
    const f = configs(); const store = new RuntimeStore(join(f.directory, 'db')); const artifacts = new ArtifactStore(join(f.directory, 'artifacts'));
    const budget = new FakeBudget({ sessionIds: ['root-session'], scopeKey: 'controlled-scope' }); const sandbox = new FakeSandbox();
    const input = readFileSync('eval/fixtures/c01.csv'); const stats = analyzeInput(input);
    sandbox.enqueue({ collect: { outputs: Object.entries({ 'statistics.json': JSON.stringify(stats), 'report.md': expectedReport(stats), 'chart.svg': expectedChart(stats) }).map(([path, content]) => ({ path, content: Buffer.from(content) })) } });
    let service!: RuntimeService;
    const submit = vi.fn(async (request: { runId: string; task: string }) => {
      await service.createRun({ runId: request.runId, task: request.task, rootSessionId: 'root-session', budgetScopeKey: 'controlled-scope', deadline: Date.now() + 60000, policyVersion: 'controlled', inputHash: 'a'.repeat(64) });
      await service.executeCode({ runId: request.runId, stepId: 'controlled-step', code: '# not executed by fake sandbox', inputs: [] });
      const decision = budget.reserve({ scopeKey: 'controlled-scope', modelCallId: 'controlled-call', sessionId: 'root-session', provider: 'controlled', model: 'controlled', purpose: 'work', estimatedTokens: 20 });
      if (!decision.allowed) throw new Error('Unexpected fake denial'); budget.markDispatched(decision.reservation.reservationId); budget.markUnknown(decision.reservation.reservationId, 'controlled lost usage');
      await service.finalize(request.runId, false);
    });
    const snapshot = async (runId: string) => ({ ...await service.getRun(runId), host: { active: false, recoveryRequired: false } });
    const reconcile = vi.fn(async (runId: string) => { await service.recover(runId); return snapshot(runId); });
    const wait = vi.fn(snapshot); const close = vi.fn(async () => undefined);
    const start = vi.fn(async (args: { validate: RuntimeServiceOptions['validate'] }) => {
      service = new RuntimeService(store, artifacts, sandbox, budget, loadConfig('config/example.json'), { ...(args.validate ? { validate: args.validate } : {}) });
      return { mode: { provider: 'controlled', sandbox: 'fake', injectedProvider: true, injectedSandbox: true, finalization: 'disabled' }, store, artifacts,
        budget: { port: budget, control: budget, operator: budget, reader: budget }, submit, wait, get: snapshot, reconcile, close } satisfies EvaluationRuntimeHost;
    });
    try {
      const driver = createRuntimeEvaluationDriver({ configs: f.configs, mode: 'simulation', directory: join(f.directory, 'evidence'), start });
      const request = { runId: 'controlled-run', suiteSha256: 'a'.repeat(64), taskId: 'c01', variant: 'hard-only' as const, repetition: 1, prompt: 'controlled task', input: { path: 'input.csv' as const, content: input, sha256: createHash('sha256').update(input).digest('hex') } };
      const handle = await driver.execute(request); const result = await driver.validate(request, handle);
      expect(result).toMatchObject({ mode: 'simulation', outcome: 'partial', checks: { report: true, chart: true }, calls: [{ callId: 'controlled-call', usage: null }] });
      expect(JSON.parse(readFileSync(result.evidence.validation, 'utf8'))).toMatchObject({ passed: true, statistics: true });
      const callsBefore = sandbox.calls.filter(c => c.method === 'execute').length;
      await driver.reconcile!(request);
      expect(reconcile).toHaveBeenCalledOnce(); expect(submit).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledTimes(2);
      expect(sandbox.calls.filter(c => c.method === 'execute')).toHaveLength(callsBefore);
      await expect(driver.reconcile!({ ...request, prompt: 'different task' })).rejects.toThrow('intent does not match');
      await expect(driver.execute(request)).rejects.toThrow();
      await expect(driver.validate({ ...request, repetition: 2 }, handle)).rejects.toThrow('exact request');
    } finally { store.close(); }
  });
});
