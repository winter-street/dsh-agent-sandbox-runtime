import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { startApplication } from '../../src/app/index.js';
import type { ModelAdmissionEvidence } from '../../src/policy/engine.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeSandbox } from '../support/fakes.js';
import { validateArtifacts } from '../../eval/artifact-validation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class ControlledProvider extends LlmAdapter {
  calls = 0;
  systems: Array<string | undefined> = [];
  caps: Array<number | undefined> = [];
  toolResults: Array<Extract<GenerateOptions['messages'][number], { role: 'tool' }>> = [];
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls++;
    const systemMessage = options.messages.find(message => message.role === 'system');
    this.systems.push(options.system ?? systemMessage?.content.map(block => block.type === 'text' ? block.text : '').join('\n'));
    this.caps.push(options.maxTokens);
    const hasResult = options.messages.some(message => message.role === 'tool');
    this.toolResults = options.messages.filter((message): message is Extract<GenerateOptions['messages'][number], { role: 'tool' }> => message.role === 'tool');
    if (!hasResult && options.tools?.length) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: 'controlled-call' as never, name: 'runtime_python', argumentsDelta: '{"code":"print(1)"}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'controlled-call' as never, name: 'runtime_python', arguments: '{"code":"print(1)"}' } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'done' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function config(root: string, finalizeTokens = 0, maxTokens = 50000): string {
  const path = join(root, 'application.json');
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, runtimeConfigPath: resolve('config/example.json'), dataDir: root,
    model: { provider: 'controlled', name: 'controlled', apiKeyEnv: 'CONTROLLED_KEY' },
    budget: { maxTokens, finalizeTokens }, sandbox: { domain: 'http://127.0.0.1:8090', apiKeyEnv: 'SANDBOX_KEY' },
  }));
  return path;
}

describe('application host', () => {
  it('pauses at an accounting boundary and continues with the original input after reopening the host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-user-pause-')); roots.push(root);
    const configPath = config(root);
    const runId = 'user-pause-run';
    const task = 'Read input.csv and produce result.json.';
    const inputs = [{ path: 'input.csv', content: Buffer.from('id\n42\n') }];
    const entered = gate();
    const finish = gate();
    class FirstTurn extends LlmAdapter {
      calls = 0;
      override async *stream(): AsyncGenerator<StreamChunk> {
        this.calls++;
        entered.resolve();
        await finish.promise;
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    class Continuation extends ControlledProvider {
      messages: GenerateOptions['messages'] | undefined;
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        this.messages = options.messages;
        yield* super.stream(options);
      }
    }
    const firstProvider = new FirstTurn();
    const options = { configPath, env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false } as const;
    const first = await startApplication({ ...options, provider: firstProvider, sandbox: new FakeSandbox(),
      validate: async () => { throw new Error('A paused task cannot be finalized'); } });
    const paused = await (async () => {
      try {
        await first.submit({ runId, task, inputs });
        await entered.promise;
        expect((await first.pause(runId, 'pause', 'User pause')).status).toBe('PAUSING');
        finish.resolve();
        const snapshot = await first.wait(runId, { timeoutMs: 1500 });
        expect(snapshot).toMatchObject({ status: 'PAUSED_USER', host: { active: false, recoveryRequired: false } });
        expect(firstProvider.calls).toBe(1);
        expect(first.store.listComponentState(runId, 'sessions')).toEqual([
          { runId, sessionId: snapshot.rootSessionId, purpose: 'work', intent: 'work' },
        ]);
        expect(await first.budget.reader.snapshot(snapshot.budgetScopeKey)).toMatchObject({ usedTokens: 15, reservedTokens: 0, unknownCalls: 0 });
        return snapshot;
      } finally { finish.resolve(); await first.close(); }
    })();
    const provider = new Continuation();
    const sandbox = new FakeSandbox().enqueue({ collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const second = await startApplication({ ...options, provider, sandbox,
      validate: async (_run, artifacts) => ({ passed: artifacts.some(artifact => artifact.path === 'result.json'), evidence: {} }) });
    try {
      const resume = () => second.resume(runId, 'resume', paused.revision);
      await Promise.all([resume(), resume()]);
      const done = await second.wait(runId, { timeoutMs: 4000 });
      expect(done).toMatchObject({ status: 'SUCCEEDED', rootSessionId: paused.rootSessionId, budgetScopeKey: paused.budgetScopeKey, deadline: paused.deadline });
      const messages = JSON.stringify(provider.messages);
      expect(messages).toContain(task);
      expect(messages).toContain('Continue from the persisted checkpoint.');
      const executions = sandbox.calls.filter(call => call.method === 'execute');
      expect(executions).toHaveLength(1);
      expect(executions[0]!.args[0]).toMatchObject({ inputs: [{ path: 'input.csv', content: Uint8Array.from(inputs[0]!.content) }] });
      expect(await second.budget.reader.snapshot(done.budgetScopeKey)).toMatchObject({ usedTokens: 30, reservedTokens: 0, unknownCalls: 0 });
      expect(second.store.eventsAfter(runId).filter(event => event.type === 'run.running')).toHaveLength(2);
      await resume();
      expect(await second.get(runId)).toMatchObject({ status: 'SUCCEEDED' });
      expect(provider.calls).toBe(1);
    } finally { await second.close(); }
  }, 12_000);

  it.each(['hard-only', 'tiered', 'tiered-finalize'] as const)('concludes %s after independently verified invalid-input delivery before a new-directory inspection', async variant => {
    const root = mkdtempSync(join(tmpdir(), 'application-invalid-input-')); roots.push(root);
    const path = config(root, variant === 'tiered-finalize' ? 5000 : 0);
    const application = JSON.parse(readFileSync(path, 'utf8'));
    const runtime = JSON.parse(readFileSync('config/example.json', 'utf8'));
    runtime.policy = { mode: variant === 'hard-only' ? 'observe' : 'enforce', finalizeShare: variant === 'tiered-finalize' ? 0.1 : 0 };
    application.runtimeConfigPath = join(root, 'runtime.json');
    writeFileSync(application.runtimeConfigPath, JSON.stringify(runtime));
    writeFileSync(path, JSON.stringify(application));
    class InspectionProvider extends LlmAdapter {
      calls = 0;
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        const call = ++this.calls;
        // A final report has no tools. A second work request would inspect a
        // fresh output directory, recreating the real c05 failure chain.
        if (!options.tools?.length) {
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
          yield { type: 'finish', reason: { kind: 'stop' } }; return;
        }
        const code = call === 1 ? 'write_invalid_timestamp_result()' : 'open(os.path.join(os.environ["AGENT_OUTPUT_DIR"], "statistics.json"))';
        const id = `inspection-${call}` as never;
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'runtime_python', arguments: JSON.stringify({ code }) } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    const provider = new InspectionProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ collect: { outputs: [{ path: 'statistics.json', content: Buffer.from('{"error":"INVALID_TIMESTAMP"}') }] } });
    sandbox.enqueue({ states: [{ state: 'FAILED', exitCode: 1 }], collect: { stderr: 'FileNotFoundError: statistics.json' } });
    const input = readFileSync('eval/fixtures/c05.csv');
    const host = await startApplication({ configPath: path, env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async (_run, records, read) => { const evidence = await validateArtifacts(input, records, { read }); return { passed: evidence.passed, evidence }; } });
    try {
      await host.submit({ runId: `invalid-input-${variant}`, task: 'Analyze input.csv; invalid timestamps require only statistics.json with INVALID_TIMESTAMP.', inputs: [{ path: 'input.csv', content: input }] });
      const snapshot = await host.wait(`invalid-input-${variant}`, { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('SUCCEEDED');
      expect(snapshot.artifacts.map(record => record.path)).toEqual(['statistics.json']);
      expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
      expect(provider.calls).toBe(variant === 'tiered-finalize' ? 2 : 1);
      expect(host.store.listSteps(snapshot.runId).every(step => !step.required || step.status === 'SUCCEEDED')).toBe(true);
      expect(await host.budget.reader.snapshot(snapshot.budgetScopeKey)).toMatchObject({ usedTokens: provider.calls * 15, unknownCalls: 0, reservedTokens: 0, meteringComplete: true });
    } finally { await host.close(); }
  }, 40_000);

  it.each([false, true])('recovers a user pause after reopening with cleanup failure on startup=%s', async failStartup => {
    const root = mkdtempSync(join(tmpdir(), 'application-pause-cleanup-')); roots.push(root);
    const sandbox = new FakeSandbox();
    const entered = gate(); const finish = gate();
    class PausingProvider extends LlmAdapter {
      override async *stream(): AsyncGenerator<StreamChunk> {
        entered.resolve(); await finish.promise;
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const options = { configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      sandbox, validate: async () => ({ passed: true, evidence: {} }) } as const;
    const runId = 'pause-cleanup';
    const first = await startApplication({ ...options, provider: new PausingProvider() });
    try {
      await first.submit({ runId, task: 'Pause after execution', inputs: [] });
      await entered.promise;
      await first.service.executeCode({ runId, stepId: 'pause-step', code: 'print(1)', inputs: [] });
      first.store.saveSandbox(await sandbox.create(runId, first.service.config.sandbox));
      await first.pause(runId, 'pause-command', 'User pause');
      sandbox.faults.failNext('sandbox.destroy.before').failNext('sandbox.destroy.before');
      finish.resolve();
      await expect.poll(() => first.isExecuting(runId), { timeout: 10_000 }).toBe(false);
      expect(await first.get(runId)).toMatchObject({ status: 'PAUSING', host: { recoveryRequired: true, error: { code: 'CANCEL_UNCONFIRMED' } } });
      expect(first.store.getSandbox(runId)).toBeDefined();
    } finally { finish.resolve(); await first.close(); }
    if (failStartup) sandbox.faults.failNext('sandbox.destroy.before');
    const second = await startApplication({ ...options, provider: new ControlledProvider() });
    try {
      if (failStartup) {
        expect(await second.get(runId)).toMatchObject({ status: 'PAUSING', host: { recoveryRequired: true, error: { code: 'CANCEL_UNCONFIRMED' } } });
        expect(await second.reconcile(runId)).toMatchObject({ status: 'PAUSED_USER', host: { recoveryRequired: false } });
      } else {
        expect(await second.get(runId)).toMatchObject({ status: 'PAUSED_USER', host: { recoveryRequired: false } });
      }
      expect(second.store.getSandbox(runId)).toBeUndefined();
      expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    } finally { await second.close(); }
  }, 40_000);

  it('retries a terminal run sandbox cleanup on startup and exposes unresolved cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-terminal-cleanup-')); roots.push(root);
    const sandbox = new FakeSandbox();
    sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    let first!: Awaited<ReturnType<typeof startApplication>>;
    const options = { configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      sandbox, validate: async () => {
        first.store.saveSandbox(await sandbox.create('terminal-cleanup', first.service.config.sandbox));
        sandbox.faults.failNext('sandbox.destroy.before');
        return { passed: true, evidence: {} };
      } } as const;
    first = await startApplication({ ...options, provider: new ControlledProvider() });
    try {
      await first.submit({ runId: 'terminal-cleanup', task: 'Produce result.json', inputs: [] });
      const done = await first.wait('terminal-cleanup', { timeoutMs: 30_000 });
      expect(done.status).toBe('SUCCEEDED');
      expect(done.host.recoveryRequired).toBe(true);
      expect(first.store.getSandbox('terminal-cleanup')).toBeDefined();
    } finally { await first.close(); }
    sandbox.faults.failNext('sandbox.destroy.before');
    const second = await startApplication({ ...options, provider: new ControlledProvider() });
    try {
      expect(await second.get('terminal-cleanup')).toMatchObject({ status: 'SUCCEEDED', host: { recoveryRequired: true, error: { code: 'CANCEL_UNCONFIRMED' } } });
      expect(second.store.getSandbox('terminal-cleanup')).toBeDefined();
      expect(await second.reconcile('terminal-cleanup')).toMatchObject({ status: 'SUCCEEDED', host: { recoveryRequired: false } });
      expect(second.store.getSandbox('terminal-cleanup')).toBeUndefined();
      expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    } finally { await second.close(); }
  }, 40_000);

  it('composes the real runtime store/ledger path with controlled provider and sandbox seams', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-host-')); roots.push(root);
    const provider = new ControlledProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const host = await startApplication({ configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async (_run, records) => ({ passed: records.length === 1 && records[0]!.path === 'result.json', evidence: { controlled: true } }) });
    try {
      await host.submit({ runId: 'controlled-host-run', task: 'Use runtime_python once and finish.', inputs: [] });
      const snapshot = await host.wait('controlled-host-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('SUCCEEDED');
      expect(snapshot.host.active).toBe(false);
      expect(snapshot.artifacts).toHaveLength(1);
      expect(provider.calls).toBe(1);
      expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
      expect(host.store.eventsAfter('controlled-host-run').filter(event => event.type === 'tool.policy-outcome').map(event => event.payload)).toMatchObject([{ ok: true }]);
      expect(host.store.eventsAfter('controlled-host-run').filter(event => event.type === 'delivery.accepted')).toHaveLength(1);
      expect(provider.caps).toEqual([8192]);
      expect(provider.systems[0]).toContain('AGENT_INPUT_DIR');
      expect(provider.systems[0]).toContain('AGENT_OUTPUT_DIR');
      expect(provider.systems[0]).toContain('runtime_python');
      expect(provider.systems[0]).toContain('next action must be one runtime_python call');
      expect(provider.systems[0]).toContain('Each runtime_python call gets fresh input/output directories.');
      expect(provider.systems[0]).toContain('that file alone completes the delivery');
      const responses = host.store.eventsAfter('controlled-host-run').filter(event => event.type === 'model.response');
      expect(responses.map(event => event.payload)).toMatchObject([
        { finishReason: 'tool-calls', requestedMaxTokens: 8192, toolCalls: 1, usageReported: true },
      ]);
      expect((await host.get('controlled-host-run')).status).toBe('SUCCEEDED');
    } finally { await host.close(); }
  }, 40_000);

  it('waits for sandbox cleanup before finalizing the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-cleanup-')); roots.push(root);
    const entered = gate(); const finish = gate();
    class DelayedDestroySandbox extends FakeSandbox {
      override async destroy(ref: Parameters<FakeSandbox['destroy']>[0]): Promise<void> {
        entered.resolve(); await finish.promise; await super.destroy(ref);
      }
    }
    const sandbox = new DelayedDestroySandbox();
    sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const host = await startApplication({ configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider: new ControlledProvider(), sandbox, validate: async () => ({ passed: true, evidence: {} }) });
    try {
      await host.submit({ runId: 'cleanup-run', task: 'Use runtime_python once and finish.', inputs: [] });
      await entered.promise;
      expect(await host.get('cleanup-run')).toMatchObject({ status: 'RUNNING', host: { active: true } });
      expect(await host.wait('cleanup-run', { timeoutMs: 50 })).toMatchObject({ status: 'RUNNING', host: { active: true } });
      finish.resolve();
      expect(await host.wait('cleanup-run', { timeoutMs: 5000 })).toMatchObject({ status: 'SUCCEEDED', host: { active: false } });
      expect(host.store.getSandbox('cleanup-run')).toBeUndefined();
    } finally { finish.resolve(); await host.close(); }
  }, 40_000);

  it('does not dispatch a queued sibling inspection after accepted delivery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-batch-')); roots.push(root);
    class BatchProvider extends LlmAdapter {
      calls = 0;
      override async *stream(): AsyncGenerator<StreamChunk> {
        this.calls++;
        for (let index = 0; index < 2; index++) {
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'block-end', index, block: { type: 'tool-call', id: `batch-${index}` as never, name: 'runtime_python', arguments: JSON.stringify({ code: index === 0 ? 'write_result()' : 'inspect_previous_output_directory()' }) } };
        }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    const provider = new BatchProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const host = await startApplication({ configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async (_run, records) => ({ passed: records.length === 1, evidence: { controlled: true } }) });
    try {
      await host.submit({ runId: 'queued-sibling-run', task: 'Produce result.json.', inputs: [] });
      const snapshot = await host.wait('queued-sibling-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('SUCCEEDED'); expect(provider.calls).toBe(1);
      expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
      expect(host.store.listAttempts(snapshot.runId)).toHaveLength(1);
      expect(host.store.eventsAfter(snapshot.runId).filter(event => event.type === 'delivery.accepted')).toHaveLength(1);
    } finally { await host.close(); }
  }, 40_000);

  it('retains a failed required step after later artifact acceptance and skips optional model spending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-required-failure-')); roots.push(root);
    class RepairProvider extends LlmAdapter {
      calls = 0;
      override async *stream(): AsyncGenerator<StreamChunk> {
        const call = ++this.calls;
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `repair-${call}` as never, name: 'runtime_python', arguments: JSON.stringify({ code: `attempt_${call}()` }) } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
    const provider = new RepairProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ states: [{ state: 'FAILED', exitCode: 1 }], collect: { stderr: 'FileNotFoundError' } });
    sandbox.enqueue({ collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const host = await startApplication({ configPath: config(root, 5000), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async (_run, records) => ({ passed: records.length === 1, evidence: { controlled: true } }) });
    try {
      await host.submit({ runId: 'required-failure-run', task: 'Produce result.json.', inputs: [] });
      const snapshot = await host.wait('required-failure-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('COMPLETED_PARTIAL');
      expect(snapshot.host.error).toMatchObject({ code: 'CONFLICT', message: 'Required work is incomplete' });
      expect(provider.calls).toBe(2);
      expect(host.store.listSteps(snapshot.runId).filter(step => step.required && step.status === 'FAILED')).toHaveLength(1);
      const events = host.store.eventsAfter(snapshot.runId);
      expect(events.some(event => event.type === 'delivery.accepted')).toBe(true);
      expect(events.some(event => ['step.optional', 'step.superseded', 'finalization.report_intent'].includes(event.type))).toBe(false);
      expect(await host.budget.reader.snapshot(snapshot.budgetScopeKey)).toMatchObject({ usedTokens: 30, unknownCalls: 0, finalize: { usedTokens: 0 } });
    } finally { await host.close(); }
  }, 40_000);

  it('persists the exact admission snapshot for a rejected model request without dispatching it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-admission-')); roots.push(root);
    class AdmissionProvider extends ControlledProvider {
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        for await (const chunk of super.stream(options)) {
          yield chunk.type === 'usage' ? { type: 'usage', usage: { inputTokens: 6500, outputTokens: 5 } } : chunk;
        }
      }
    }
    const provider = new AdmissionProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const host = await startApplication({ configPath: config(root, 0, 15000), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async () => ({ passed: false, evidence: { controlled: true, reason: 'incorrect output' } }) });
    try {
      await host.submit({ runId: 'controlled-admission-run', task: 'Use runtime_python once and finish.', inputs: [] });
      const snapshot = await host.wait('controlled-admission-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('COMPLETED_PARTIAL');
      expect(provider.calls).toBe(1);
      const events = host.store.eventsAfter('controlled-admission-run');
      expect(events.filter(event => event.type === 'model.response').map(event => event.payload)).toMatchObject([
        { finishReason: 'tool-calls', usageReported: true },
      ]);
      const rejections = events.filter(event => event.type === 'model.admission-rejected');
      expect(rejections.length).toBeGreaterThan(0);
      for (const rejection of rejections) expect(rejection.payload).toMatchObject({ code: 'RUNTIME_MODEL_POLICY_BLOCKED', reasons: expect.arrayContaining(['GLOBAL_BUDGET_UNAVAILABLE', 'WORK_BUDGET_UNAVAILABLE']) });
      expect(events.some(event => event.type === 'delivery.accepted')).toBe(false);
      expect(await host.budget.reader.snapshot(snapshot.budgetScopeKey)).toMatchObject({ usedTokens: 6505, unknownCalls: 0, reservedTokens: 0, meteringComplete: true });
    } finally { await host.close(); }
    const reopened = new RuntimeStore(join(root, 'database'));
    try {
      const events = reopened.eventsAfter('controlled-admission-run');
      const decisions = events.filter(event => event.type === 'policy.decision')
        .map(event => event.payload as { phase: string; allowed: boolean; admission?: ModelAdmissionEvidence })
        .filter(decision => decision.phase === 'dispatch' && !decision.allowed);
      const observedRejections = events.filter(event => event.type === 'model.admission-rejected')
        .map(event => event.payload as { sessionId: string; requestedMaxTokens: number });
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions).toHaveLength(observedRejections.length);
      for (const [index, decision] of decisions.entries()) {
        const evidence = decision.admission!;
        expect(evidence).toMatchObject({ schemaVersion: 1, sessionId: observedRejections[index]!.sessionId, purpose: 'work', required: true,
          requestedMaxTokens: observedRejections[index]!.requestedMaxTokens, rulesFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          snapshot: { cancelled: false, deadlineExceeded: false, inflightModelCalls: 0,
            budget: { limitTokens: 15000, usedTokens: 6505, reservedTokens: 0, availableTokens: 8495,
              unknownCalls: 0, meteringComplete: true, work: { availableTokens: 8495 } } } });
        expect(evidence.estimatedTokens).toBeGreaterThan(evidence.snapshot.budget.availableTokens);
      }
    } finally { reopened.close(); }
  }, 40_000);

  it('reconcile only recovers an existing run and never submits another agent turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-reconcile-')); roots.push(root);
    const provider = new ControlledProvider(); const sandbox = new FakeSandbox();
    const host = await startApplication({ configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async () => ({ passed: true, evidence: { controlled: true } }) });
    try {
      await expect(host.reconcile('missing-run')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(provider.calls).toBe(0);
    } finally { await host.close(); }
  }, 40_000);

  it('runs optional finalization only after independent acceptance is committed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-finalize-')); roots.push(root);
    const provider = new ControlledProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const host = await startApplication({ configPath: config(root, 5000), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async (_run, records) => ({ passed: records.length === 1 && records[0]!.path === 'result.json', evidence: { controlled: true } }) });
    try {
      await host.submit({ runId: 'controlled-finalize-run', task: 'Use runtime_python once and finish.', inputs: [] });
      const snapshot = await host.wait('controlled-finalize-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('SUCCEEDED');
      expect(provider.calls).toBe(2);
      const events = host.store.eventsAfter('controlled-finalize-run');
      expect(events.find(event => event.type === 'validation.completed')!.eventSeq).toBeLessThan(events.find(event => event.type === 'finalization.report_intent')!.eventSeq);
    } finally { await host.close(); }
  }, 40_000);

  it('commits independent acceptance when optional finalization is disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-no-finalize-')); roots.push(root);
    const provider = new ControlledProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"ok":true}') }] } });
    const host = await startApplication({ configPath: config(root, 0), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async (_run, records) => ({ passed: records.length === 1 && records[0]!.path === 'result.json', evidence: { controlled: true } }) });
    try {
      await host.submit({ runId: 'controlled-no-finalize-run', task: 'Use runtime_python once and finish.', inputs: [] });
      const snapshot = await host.wait('controlled-no-finalize-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('SUCCEEDED');
      expect(provider.calls).toBe(1);
      expect(host.store.eventsAfter('controlled-no-finalize-run').some(event => event.type === 'finalization.report_intent')).toBe(false);
    } finally { await host.close(); }
  }, 40_000);

  it('gives one bounded completion nudge before recording validation failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-validation-nudge-')); roots.push(root);
    const provider = new ControlledProvider(); const sandbox = new FakeSandbox();
    sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [] } });
    const host = await startApplication({ configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider, sandbox, validate: async () => ({ passed: false, evidence: { reason: 'missing artifact' } }) });
    try {
      await host.submit({ runId: 'controlled-validation-nudge-run', task: 'Use runtime_python once and finish.', inputs: [] });
      const snapshot = await host.wait('controlled-validation-nudge-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('COMPLETED_PARTIAL');
      expect(snapshot.host.error).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(provider.calls).toBe(3);
    } finally { await host.close(); }
  }, 40_000);

  it('records bounded response diagnostics and a truncation error without persisting reasoning text or executing tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'application-truncated-')); roots.push(root);
    let calls = 0;
    class TruncatedProvider extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        calls++;
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: 'private-reasoning-marker' };
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private-reasoning-marker' } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: options.maxTokens! } };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
      }
    }
    const sandbox = new FakeSandbox();
    const host = await startApplication({ configPath: config(root), env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false,
      provider: new TruncatedProvider(), sandbox, validate: async () => ({ passed: false, evidence: { reason: 'missing artifact' } }) });
    try {
      await host.submit({ runId: 'controlled-truncated-run', task: 'Produce the requested artifact.', inputs: [] });
      const snapshot = await host.wait('controlled-truncated-run', { timeoutMs: 30_000 });
      expect(snapshot.status).toBe('COMPLETED_PARTIAL');
      expect(snapshot.host.error).toMatchObject({ code: 'MODEL_OUTPUT_TRUNCATED' });
      expect(calls).toBe(2);
      expect(sandbox.calls.some(call => call.method === 'execute')).toBe(false);
      const trace = host.store.eventsAfter('controlled-truncated-run');
      expect(trace.filter(event => event.type === 'model.response').map(event => event.payload)).toEqual([
        expect.objectContaining({ finishReason: 'max-tokens', reasoningChars: 24, textChars: 0, toolCalls: 0, requestedMaxTokens: 8192 }),
        expect.objectContaining({ finishReason: 'max-tokens', reasoningChars: 24, textChars: 0, toolCalls: 0, requestedMaxTokens: 8192 }),
      ]);
      expect(JSON.stringify(trace)).not.toContain('private-reasoning-marker');
      expect((await host.budget.reader.snapshot(snapshot.budgetScopeKey)).usedTokens).toBe(16404);
    } finally { await host.close(); }
  }, 40_000);
});
