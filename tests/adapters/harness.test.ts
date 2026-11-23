import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native';
import type { ArtifactRecord } from '../../src/contracts/runtime.js';
import {
  createHarnessRuntimePlugin, RUNTIME_PYTHON_TOOL, runtimeStepId,
  type HarnessRunBinding, type HarnessRuntimeOptions, type RuntimeCodeResult,
} from '../../src/adapters/harness/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function result(): RuntimeCodeResult {
  return {
    attemptId: 'attempt-1', stdout: '42\n', stderr: '', exitCode: 0,
    artifacts: [{ artifactId: 'artifact-1', path: 'answer.json', size: 2, sha256: 'a'.repeat(64) }],
  };
}

async function setup(overrides: Partial<HarnessRuntimeOptions> = {}) {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime).await();
  await ctx.plugin(ToolExecutorNative).await();
  await ctx.plugin(SessionProjection).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  const root = await ctx.agents.create({
    sessionId: SessionId('root-session'),
    agentOptions: { provider: 'unused', model: 'unused' },
  });
  cleanups.push(() => root.dispose());
  const binding: HarnessRunBinding = {
    runId: 'run-1', inputs: [{ path: 'input.csv', content: Uint8Array.from([1, 2, 3]) }],
  };
  const executeCode = vi.fn<HarnessRuntimeOptions['executor']['executeCode']>().mockResolvedValue(result());
  const resolveRun = vi.fn<HarnessRuntimeOptions['resolveRun']>().mockReturnValue(binding);
  const plugin = createHarnessRuntimePlugin({ executor: { executeCode }, resolveRun, ...overrides });
  const fiber = ctx.plugin(plugin);
  await fiber.await();
  async function call(args: unknown = { code: 'print(42)' }, signal = new AbortController().signal, id = 'call-1') {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(id), name: RUNTIME_PYTHON_TOOL, arguments: JSON.stringify(args) }],
      agent: root.agent, signal,
    });
    return batch.results[0]!.result;
  }
  return { ctx, root, fiber, binding, executeCode, resolveRun, call };
}

describe('Harness runtime bridge (real host modules; fake runtime executor)', () => {
  it('resolves trusted session inputs and returns schema-checked artifact references', async () => {
    const { call, resolveRun, executeCode, binding, ctx } = await setup();
    const outcome = await call();
    expect(outcome).toMatchObject({ isError: false, value: result() });
    expect(resolveRun).toHaveBeenCalledWith('root-session', undefined, expect.any(AbortSignal));
    expect(executeCode).toHaveBeenCalledWith({
      runId: 'run-1', stepId: runtimeStepId('root-session', 'call-1'),
      code: 'print(42)', inputs: binding.inputs,
    }, expect.any(AbortSignal));
    const sent = executeCode.mock.calls[0]![0].inputs[0]!;
    expect(sent.content).not.toBe(binding.inputs[0]!.content);
    sent.content[0] = 99;
    expect(binding.inputs[0]!.content[0]).toBe(1);
    expect(ctx.tools.get(RUNTIME_PYTHON_TOOL)?.isConcurrencySafe).toBeUndefined();
  });

  it('projects stored artifact metadata into canonical model-visible references', async () => {
    const { call, executeCode } = await setup();
    const artifact: ArtifactRecord = { ...result().artifacts[0]!, runId: 'run-1', attemptId: 'attempt-1' };
    executeCode.mockResolvedValue({ ...result(), artifacts: [artifact] });
    const outcome = await call();
    expect(outcome).toMatchObject({ isError: false, value: result() });
    expect(outcome.value).toEqual(result());
    expect(artifact).toMatchObject({ runId: 'run-1', attemptId: 'attempt-1' });
  });

  it.each([
    { accepted: true, exitCode: 0, artifacts: true, concludes: true, checks: 1 },
    { accepted: false, exitCode: 0, artifacts: true, concludes: undefined, checks: 1 },
    { accepted: true, exitCode: 1, artifacts: true, concludes: undefined, checks: 0 },
    { accepted: true, exitCode: 0, artifacts: false, concludes: undefined, checks: 0 },
  ])('requires independent acceptance of a successful artifact delivery before concluding: %j', async spec => {
    const acceptResult = vi.fn<NonNullable<HarnessRuntimeOptions['acceptResult']>>().mockResolvedValue(spec.accepted);
    const { call, executeCode } = await setup({ acceptResult });
    executeCode.mockResolvedValue({ ...result(), exitCode: spec.exitCode, artifacts: spec.artifacts ? result().artifacts : [] });
    const outcome = await call();
    expect(outcome.isError).toBe(false);
    expect(outcome.concludesTurn).toBe(spec.concludes);
    expect(acceptResult).toHaveBeenCalledTimes(spec.checks);
    if (spec.checks) expect(acceptResult).toHaveBeenCalledWith('run-1', expect.objectContaining({ attemptId: 'attempt-1' }), expect.any(AbortSignal));
  });

  it('does not conclude a successful execution when caller cancellation races with independent validation', async () => {
    const started = deferred<void>(); const finish = deferred<void>();
    const acceptResult: NonNullable<HarnessRuntimeOptions['acceptResult']> = async () => { started.resolve(); await finish.promise; return true; };
    const { call } = await setup({ acceptResult }); const controller = new AbortController();
    const pending = call({ code: 'print(42)' }, controller.signal);
    await started.promise; controller.abort(new Error('operator cancelled during validation')); finish.resolve();
    const outcome = await pending;
    expect(outcome.isError).toBe(true);
    expect(outcome.concludesTurn).toBeUndefined();
  });

  it.each([
    { code: 'print(42)', runId: 'other-run' },
    { code: 'print(42)', budgetScopeKey: 'fresh-credit' },
    { code: 'print(42)', hostPath: 'C:/private' },
    { code: 42 },
    { code: '' },
  ])('rejects invalid or authority-bearing arguments before scheduling: %j', async args => {
    const { call, executeCode, resolveRun } = await setup();
    expect((await call(args)).isError).toBe(true);
    expect(executeCode).not.toHaveBeenCalled();
    expect(resolveRun).not.toHaveBeenCalled();
  });

  it('enforces UTF-8 bytes for multibyte code', async () => {
    const { call, executeCode } = await setup({ maxCodeBytes: 5 });
    expect((await call({ code: '中文' })).isError).toBe(true);
    expect(executeCode).not.toHaveBeenCalled();
  });

  it.each([[], ['failed', 'failed'], ['../other-run'], Array.from({ length: 9 }, (_, i) => `failed-${i}`), 'failed'].map(repairOf => ({ repairOf })))('rejects malformed repair references before execution: %j', async ({ repairOf }) => {
    const { call, executeCode } = await setup();
    expect((await call({ code: 'repair()', repairOf })).isError).toBe(true);
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('binds the host obligation while forwarding only explicit repair targets from model arguments', async () => {
    const { call, executeCode, binding } = await setup(); binding.obligationId = 'trusted-acceptance';
    expect((await call({ code: 'repair()', repairOf: ['failed-step'] })).isError).toBe(false);
    expect(executeCode).toHaveBeenCalledWith(expect.objectContaining({ obligationId: 'trusted-acceptance', repairOf: ['failed-step'] }), expect.any(AbortSignal));
    expect((await call({ code: 'repair()', obligationId: 'forged-acceptance' })).isError).toBe(true);
    expect(executeCode).toHaveBeenCalledTimes(1);
  });

  it('denies missing session bindings without allocating a new run or budget', async () => {
    const { call, executeCode } = await setup({ resolveRun: () => undefined });
    expect((await call()).isError).toBe(true);
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('requires a host agent, even when invoked directly through the registry', async () => {
    const { ctx, executeCode, resolveRun } = await setup();
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('no-agent'), name: RUNTIME_PYTHON_TOOL, arguments: JSON.stringify({ code: 'print(42)' }) }],
      signal: new AbortController().signal,
    });
    const outcome = batch.results[0]!.result;
    expect(outcome.isError).toBe(true);
    expect(resolveRun).not.toHaveBeenCalled();
    expect(executeCode).not.toHaveBeenCalled();
  });

  it('passes child lineage to the trusted resolver and gives nested calls distinct step IDs', async () => {
    const { ctx, root, resolveRun, executeCode } = await setup();
    const child = await root.agent.ctx.agents.create({
      sessionId: SessionId('child-session'),
      meta: { parentSession: root.agent.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'unused', model: 'unused' },
    });
    cleanups.push(() => child.dispose());
    await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('nested-call-1'), name: RUNTIME_PYTHON_TOOL, arguments: JSON.stringify({ code: 'print(42)' }) }],
      agent: child.agent, signal: new AbortController().signal,
    });
    expect(resolveRun).toHaveBeenCalledWith('child-session', 'root-session', expect.any(AbortSignal));
    expect(executeCode.mock.calls[0]![0].stepId).toBe(runtimeStepId('child-session', 'nested-call-1'));
    expect(runtimeStepId('child-session', 'nested-call-1')).not.toBe(runtimeStepId('child-session', 'nested-call-2'));
    expect(runtimeStepId('child-session', 'nested-call-1')).not.toBe(runtimeStepId('root-session', 'nested-call-1'));
  });

  it('does not report a result that violates the declared canonical output', async () => {
    const { call, executeCode } = await setup();
    executeCode.mockResolvedValue({ ...result(), artifacts: [{ ...result().artifacts[0]!, size: -1 }] });
    expect((await call()).isError).toBe(true);
  });

  it('forwards caller cancellation and waits for executor cleanup before settling', async () => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const stopped = deferred<void>();
    const executeCode = vi.fn<HarnessRuntimeOptions['executor']['executeCode']>(async (_input, signal) => {
      signal!.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await stopped.promise;
      signal!.throwIfAborted();
      return result();
    });
    const { call } = await setup({ executor: { executeCode } });
    const controller = new AbortController();
    let settled = false;
    const outcome = call({ code: 'while True: pass' }, controller.signal).then(value => { settled = true; return value; });
    await started.promise;
    controller.abort(new Error('operator cancelled'));
    await aborted.promise;
    expect(settled).toBe(false);
    stopped.resolve();
    expect((await outcome).isError).toBe(true);
  });

  it('unregisters and waits for active execution cleanup when its plugin unloads', async () => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const stopped = deferred<void>();
    const executeCode = vi.fn<HarnessRuntimeOptions['executor']['executeCode']>(async (_input, signal) => {
      signal!.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await stopped.promise;
      signal!.throwIfAborted();
      return result();
    });
    const { call, fiber, ctx } = await setup({ executor: { executeCode } });
    const outcome = call();
    await started.promise;
    let disposed = false;
    const disposing = fiber.dispose().then(() => { disposed = true; });
    await aborted.promise;
    expect(ctx.tools.get(RUNTIME_PYTHON_TOOL)).toBeUndefined();
    expect(disposed).toBe(false);
    stopped.resolve();
    await disposing;
    expect((await outcome).isError).toBe(true);
  });

  it('does not dispatch a call whose async binding resolution races with unload', async () => {
    const resolving = deferred<void>();
    const binding = deferred<HarnessRunBinding>();
    const resolveRun: HarnessRuntimeOptions['resolveRun'] = () => {
      resolving.resolve();
      return binding.promise;
    };
    const { call, fiber, executeCode } = await setup({ resolveRun });
    const outcome = call();
    await resolving.promise;
    const disposing = fiber.dispose();
    binding.resolve({ runId: 'run-1', inputs: [] });
    await disposing;
    expect((await outcome).isError).toBe(true);
    expect(executeCode).not.toHaveBeenCalled();
  });
});
