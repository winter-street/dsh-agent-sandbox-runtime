import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native';
import { afterEach, describe, expect, it } from 'vitest';
import { connectBudgetService } from '../../src/adapters/budget/index.js';
import { BudgetReceiptSynchronizer } from '../../src/adapters/budget/receipts.js';
import { createRuntimeHarnessIntegration } from '../../src/adapters/harness/composition.js';
import { ModelPolicyError } from '../../src/adapters/harness/model-policy.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { loadConfig } from '../../src/config.js';
import { RuntimeService } from '../../src/core/service.js';
import { FinalizationCoordinator } from '../../src/core/finalize.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeSandbox } from '../support/fakes.js';

// Real host, patched original ledger, runtime and SQLite. Model output and sandbox are controlled.
// Network requests only reach the local budget administration fixture. Provider usage is synthetic.
const cleanups: Array<() => Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
class ControlledAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'controlled response' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'controlled response' } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function openScenario(options: { directory?: string; mode?: 'observe' | 'enforce'; finalizeTokens?: number } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'runtime-scenario-'));
  if (!options.directory) roots.push(directory);
  const ctx = new Context();
  const budgetApiRoutes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
  ctx.provide('webServer', {
    register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
      budgetApiRoutes.set(route.path, route.handler);
      return () => { budgetApiRoutes.delete(route.path); };
    },
  });
  let store: RuntimeStore | undefined;
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await ctx.fiber.dispose(); store?.close(); };
  cleanups.push(close);
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime).await();
  await ctx.plugin(ToolExecutorNative).await();
  await ctx.plugin(SessionProjection).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(AgentLoop, { agents: [] }).await();
  const plugin = await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href) as {
    name: string; inject: string[]; apply(ctx: Context, config: unknown): void;
  };
  const budgetDirectory = join(directory, 'budget');
  await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
    maxTokens: 10_000, reservationMode: true, pressurePrompt: false, storageDir: budgetDirectory,
  }).await();
  const budget = connectBudgetService(ctx);
  const root = await ctx.agents.create({ sessionId: SessionId('scenario-root'), agentOptions: { provider: 'controlled', model: 'controlled' } });
  const scope = await budget.port.scopeForSession('scenario-root');
  store = new RuntimeStore(join(directory, 'database'));
  const artifacts = new ArtifactStore(join(directory, 'artifacts'));
  const config = loadConfig('config/example.json');
  config.policy.mode = options.mode ?? 'enforce';
  const sandbox = new FakeSandbox();
  const service = new RuntimeService(store, artifacts, sandbox, budget.port, config, {
    validate: async (_run, outputs) => {
      const result = outputs.find(output => output.path === 'result.json');
      const passed = outputs.length === 1 && !!result && JSON.parse(Buffer.from(await artifacts.read(result)).toString('utf8')).sum === 5;
      return { passed, evidence: { expectedSum: 5, actualArtifacts: outputs.length, controlledSandbox: true } };
    },
  });
  if (!store.listRuns().length) {
    await budget.operator.allocate(scope, options.finalizeTokens ?? 500, 'controlled scenario host allocation');
    await service.createRun({ runId: 'scenario-run', rootSessionId: 'scenario-root', budgetScopeKey: scope,
      task: 'controlled budget scenario', deadline: Date.now() + 60_000, policyVersion: 'budget-policy-v1', inputHash: 'a'.repeat(64) });
  }
  const integration = createRuntimeHarnessIntegration(service, budget.control, {
    inputs: async () => [], output: { kind: 'prose', minTokens: 64, defaultMaxTokens: 1000 },
  });
  await ctx.plugin(integration.plugin).await();
  await integration.bindSession('scenario-run', 'scenario-root');
  const adapter = new ControlledAdapter();
  ctx.llm.registerAdapter(['controlled'], adapter);
  const request = () => ctx.waterfall('agent/request', {
    agent: root.agent, turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => Object.freeze({ provider: 'controlled', model: 'controlled', maxTokens: 1000 }));
  const stream = (maxTokens = 1000, text = '') => ctx.llm.stream(Object.freeze({
    provider: 'controlled', model: 'controlled', sessionId: SessionId('scenario-root'), maxTokens,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })],
  }));
  const consume = async (maxTokens = 1000, text = '') => { const chunks = []; for await (const chunk of stream(maxTokens, text)) chunks.push(chunk); return chunks; };
  async function seedSyntheticUsage(tokens: number) {
    const decision = await budget.port.reserve({ scopeKey: scope, modelCallId: `synthetic-fixture-${tokens}`, sessionId: 'scenario-root',
      provider: 'controlled-fixture', model: 'controlled', purpose: 'work', estimatedTokens: tokens });
    if (!decision.allowed) throw new Error(`Fixture reservation denied: ${decision.reason}`);
    await budget.port.markDispatched(decision.reservation.reservationId);
    await budget.port.settle(decision.reservation.reservationId, { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }
  return { directory, ctx, store, sandbox, artifacts, service, budget, budgetDirectory, integration, adapter,
    scope, request, stream, consume, seedSyntheticUsage, close, budgetApiRoutes };
}

describe.skipIf(!existsSync(resolve('.sources/budget/lib/index.js')))('repeatable controlled-provider budget/runtime scenarios', () => {
  it('ordinary completion verifies artifacts, settles once and replays without new execution', async () => {
    const s = await openScenario();
    await s.consume();
    s.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.json', content: Buffer.from('{"sum":5}') }],
    } });
    const input = { runId: 'scenario-run', stepId: 'result-step', code: 'controlled, not executed Python', inputs: [] };
    const result = await s.service.executeCode(input);
    expect((await s.service.finalize('scenario-run', true)).run.status).toBe('SUCCEEDED');
    expect(await s.service.executeCode(input)).toEqual(result);
    expect(s.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    expect(await s.budget.reader.snapshot(s.scope)).toMatchObject({ usedTokens: 15, reservedTokens: 0, unknownCalls: 0 });
    expect((await s.budget.reader.eventsAfter(0)).filter(event => event.type === 'settle')).toHaveLength(1);
  });

  it.each(['enforce', 'observe'] as const)('%s records actual request caps and keeps notifications unique over component reconstruction', async mode => {
    const s = await openScenario({ mode });
    await s.seedSyntheticUsage(7000);
    const cfg = await s.request();
    expect(cfg.maxTokens).toBe(mode === 'enforce' ? 750 : 1000);
    await s.consume(cfg.maxTokens);
    expect(s.adapter.calls[0]?.maxTokens).toBe(mode === 'enforce' ? 750 : 1000);
    const decisions = s.store.eventsAfter('scenario-run').filter(event => event.type === 'policy.decision');
    expect(decisions.at(-1)?.payload).toMatchObject({ proposedLimits: { outputTokenCap: 750 }, limits: { outputTokenCap: mode === 'enforce' ? 750 : 1000 } });
    const notices = s.store.eventsAfter('scenario-run').filter(event => event.type === 'policy.triggered');
    expect(notices).toHaveLength(1);
    const originalSnapshot = await s.budget.reader.snapshot(s.scope);
    const state = s.store.getPolicyState('scenario-run');
    await s.close();
    const restored = await openScenario({ directory: s.directory, mode });
    expect(restored.store.getPolicyState('scenario-run')).toEqual(state);
    expect(await restored.budget.reader.snapshot(restored.scope)).toEqual(originalSnapshot);
    const restoredCfg = await restored.request();
    expect(restoredCfg.maxTokens).toBe(cfg.maxTokens);
    expect(restored.store.eventsAfter('scenario-run').filter(event => event.type === 'policy.triggered')).toEqual(notices);
  });

  it.each([0, 500])('finalize allocation %i automatically falls back to a zero-call partial template for an unaffordable report', async finalizeTokens => {
    const s = await openScenario({ finalizeTokens });
    await s.seedSyntheticUsage(9500);
    await s.integration.bindSession('scenario-run', 'scenario-root', 'finalize', 'final-report');
    const before = await s.budget.reader.snapshot(s.scope);
    await expect(s.consume(128, 'large final report input '.repeat(200))).rejects.toBeInstanceOf(ModelPolicyError);
    expect(s.adapter.calls).toHaveLength(0);
    expect(await s.budget.reader.snapshot(s.scope)).toEqual(before);
    const generate = async () => { throw new Error('Unaffordable report must never dispatch'); };
    const coordinator = new FinalizationCoordinator(s.service, {
      prepare: () => ({ provider: 'controlled', model: 'controlled', sessionId: SessionId('scenario-root'), maxTokens: 128,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'large final report input '.repeat(200) }] })] }),
      generate,
    });
    const partial = await coordinator.finalize('scenario-run', false);
    expect(partial.reportReason).toBe(finalizeTokens === 0 ? 'zero-allocation' : 'request-too-large');
    expect(partial.run.status).toBe('COMPLETED_PARTIAL');
    expect(partial.report).toContain('Partial delivery; not all requested work is verified.');
    expect(partial.report).toContain('Pending required steps: accept-');
    expect(await s.budget.reader.snapshot(s.scope)).toEqual(before);
    expect(s.sandbox.calls).toHaveLength(0);
  });

  it.each(['settle', 'interrupt'] as const)('trusted report coordinator verifies original finalize hook receipts on %s', async outcome => {
    const s = await openScenario();
    await s.seedSyntheticUsage(9500);
    await s.integration.bindSession('scenario-run', 'scenario-root', 'finalize', 'final-report');
    const coordinator = new FinalizationCoordinator(s.service, {
      prepare: () => ({ provider: 'controlled', model: 'controlled', sessionId: SessionId('scenario-root'), maxTokens: 64,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Brief report.' }] })] }),
      generate: async request => {
        const iterator = s.ctx.llm.stream(request)[Symbol.asyncIterator]();
        if (outcome === 'interrupt') { await iterator.next(); await iterator.return!(); return ''; }
        let text = '';
        while (true) {
          const next = await iterator.next(); if (next.done) break;
          if (next.value.type === 'text-delta') text += next.value.text;
        }
        return text;
      },
    });
    const result = await coordinator.finalize('scenario-run', false);
    expect(result.run.status).toBe('COMPLETED_PARTIAL');
    expect(result.reportReason).toBe(outcome === 'settle' ? 'generated' : 'unknown-usage');
    expect(s.adapter.calls).toHaveLength(1);
    const final = await s.budget.reader.snapshot(s.scope);
    expect(final.limitTokens).toBe(10000);
    expect(final.finalize.usedTokens).toBe(outcome === 'settle' ? 15 : 0);
    expect(final.unknownCalls).toBe(outcome === 'settle' ? 0 : 1);
    expect((await s.budget.reader.eventsAfter(0)).filter(event => event.type === 'reserve')).toHaveLength(2);
  });

  it('trusted limit adjustment resumes the original budget-paused task once and preserves its ledger and artifacts over reconstruction', async () => {
    const s = await openScenario();
    const originalRun = s.store.getRun('scenario-run');
    await s.consume();
    s.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.json', content: Buffer.from('{"sum":5}') }],
    } });
    const input = { runId: 'scenario-run', stepId: 'result-step', code: 'controlled fixture only', inputs: [] };
    const committed = await s.service.executeCode(input);
    const committedArtifacts = s.store.listArtifacts('scenario-run');
    await s.seedSyntheticUsage(9485);
    const nextInput = { ...input, stepId: 'continued-step' };
    await expect(s.service.executeCode(nextInput)).rejects.toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
    const paused = s.store.getRun('scenario-run');
    expect(paused.status).toBe('PAUSED_BUDGET');
    expect(s.store.getPolicyState('scenario-run')).toMatchObject({ finalized: true });
    await expect(s.service.resumeRun('scenario-run', 'before-adjustment', paused.revision))
      .rejects.toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
    expect(s.store.getRun('scenario-run')).toEqual(paused);
    expect(await s.budget.reader.snapshot(s.scope)).toMatchObject({
      limitTokens: 10000, usedTokens: 9500, availableTokens: 500, work: { availableTokens: 0 },
    });

    const beforeAdjustment = await s.budget.reader.eventsAfter(0);
    const route = s.budgetApiRoutes.get('/agent-budget/api');
    if (!route) throw new Error('Original plugin budget administration route was not registered');
    const server = createServer(route);
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local budget API has no TCP address');
    const url = `http://127.0.0.1:${address.port}/agent-budget/api/adjust-limit`;
    const body = JSON.stringify({ scopeKey: s.scope, limitTokens: 20000 });
    const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(denied.status).toBe(403);
    await denied.json();
    expect(await s.budget.reader.eventsAfter(0)).toEqual(beforeAdjustment);
    const adjusted = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Budget-Request': '1' }, body });
    expect(adjusted.status).toBe(200);
    expect(await adjusted.json()).toMatchObject({ ok: true, status: { limitTokens: 20000, usedTokens: 9500 } });
    const adjustedLedger = await s.budget.reader.eventsAfter(0);
    expect(adjustedLedger.slice(0, beforeAdjustment.length)).toEqual(beforeAdjustment);
    expect(adjustedLedger.filter(event => event.type === 'adjust')).toEqual([
      expect.objectContaining({ scopeKey: s.scope, payload: expect.objectContaining({ limitTokens: 20000 }) }),
    ]);
    const resumed = await s.service.resumeRun('scenario-run', 'after-adjustment', paused.revision);
    expect(resumed).toMatchObject({ status: 'RUNNING', budgetScopeKey: s.scope, deadline: originalRun.deadline });
    const releasedPolicy = s.store.getPolicyState('scenario-run');
    expect(releasedPolicy).toMatchObject({ stage: 'normal', finalized: false, lastOperatorReason: expect.any(String) });
    expect(s.store.latestCheckpoint('scenario-run')).toMatchObject({ revision: resumed.revision, policyState: releasedPolicy });
    const resumedEvents = s.store.eventsAfter('scenario-run');
    expect(resumedEvents.filter(event => event.type === 'policy.changed' &&
      (event.payload as { lastOperatorReason?: string }).lastOperatorReason)).toHaveLength(1);
    expect(await s.service.resumeRun('scenario-run', 'after-adjustment', paused.revision)).toEqual(resumed);
    expect(s.store.eventsAfter('scenario-run')).toEqual(resumedEvents);
    await s.close();

    const restored = await openScenario({ directory: s.directory });
    expect(restored.scope).toBe(s.scope);
    expect(restored.store.getRun('scenario-run')).toEqual(resumed);
    expect(restored.store.getPolicyState('scenario-run')).toEqual(releasedPolicy);
    expect(restored.store.listArtifacts('scenario-run')).toEqual(committedArtifacts);
    expect(await restored.budget.reader.eventsAfter(0)).toEqual(adjustedLedger);
    expect(await restored.service.resumeRun('scenario-run', 'after-adjustment', paused.revision)).toEqual(resumed);
    expect(await restored.service.executeCode(input)).toEqual(committed);
    expect(restored.sandbox.calls).toHaveLength(0);
    const receiptSync = new BudgetReceiptSynchronizer(restored.store, restored.budget.reader, restored.budgetDirectory);
    await receiptSync.sync('scenario-run');
    expect(await receiptSync.sync('scenario-run')).toMatchObject({ imported: 0 });

    const request = await restored.request();
    await restored.consume(request.maxTokens);
    restored.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'continued.json', content: Buffer.from('{"continued":true}') }],
    } });
    const continued = await restored.service.executeCode({ ...nextInput,
      inputs: [{ path: 'prior-result.json', content: await restored.artifacts.read(committedArtifacts[0]!) }],
    });
    expect(continued.exitCode).toBe(0);
    expect(restored.adapter.calls).toHaveLength(1);
    expect(restored.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(1);
    expect(restored.store.listArtifacts('scenario-run')).toEqual(expect.arrayContaining(committedArtifacts));
    expect(restored.store.getRun('scenario-run')).toMatchObject({
      status: 'RUNNING', budgetScopeKey: s.scope, deadline: originalRun.deadline,
    });
    expect(await restored.budget.reader.snapshot(s.scope)).toMatchObject({
      limitTokens: 20000, usedTokens: 9515, reservedTokens: 0, unknownCalls: 0,
      usage: { inputTokens: 9505, outputTokens: 10 },
    });
    const continuedLedger = await restored.budget.reader.eventsAfter(0);
    expect(continuedLedger.slice(0, adjustedLedger.length)).toEqual(adjustedLedger);
    expect(continuedLedger.filter(event => event.type === 'open')).toHaveLength(1);
    expect(continuedLedger.filter(event => event.type === 'adjust')).toHaveLength(1);
    expect(continuedLedger.filter(event => event.type === 'settle')).toHaveLength(3);
    expect(await receiptSync.sync('scenario-run')).toMatchObject({ imported: 3 });
    expect(await receiptSync.sync('scenario-run')).toMatchObject({ imported: 0 });
  });

  it('interruption pauses accounting and reconstruction resumes only after trusted reconciliation using original ledger/artifact', async () => {
    const s = await openScenario();
    s.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.json', content: Buffer.from('{"sum":5}') }],
    } });
    const input = { runId: 'scenario-run', stepId: 'result-step', code: 'controlled fixture only', inputs: [] };
    const result = await s.service.executeCode(input);
    const iterator = s.stream()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return!();
    const unknown = await s.budget.reader.snapshot(s.scope);
    expect(unknown).toMatchObject({ unknownCalls: 1, meteringComplete: false, usedTokens: 0 });
    const nextInput = { ...input, stepId: 'blocked-step' };
    await expect(s.service.executeCode(nextInput)).rejects.toMatchObject({ code: 'USAGE_UNKNOWN' });
    expect(s.store.getRun('scenario-run').status).toBe('PAUSED_ACCOUNTING');
    const sync = new BudgetReceiptSynchronizer(s.store, s.budget.reader, s.budgetDirectory);
    const first = await sync.sync('scenario-run');
    await s.close();
    const restored = await openScenario({ directory: s.directory });
    expect(await restored.budget.reader.snapshot(restored.scope)).toEqual(unknown);
    await restored.service.recover('scenario-run');
    const paused = restored.store.getRun('scenario-run');
    await expect(restored.service.resumeRun('scenario-run', 'premature', paused.revision)).rejects.toMatchObject({ code: 'USAGE_UNKNOWN' });
    await expect(restored.service.finalize('scenario-run', true)).rejects.toMatchObject({ code: 'USAGE_UNKNOWN' });
    const replay = new BudgetReceiptSynchronizer(restored.store, restored.budget.reader, restored.budgetDirectory);
    expect(await replay.sync('scenario-run')).toMatchObject({ cursor: first.cursor, imported: 0 });
    const receipt = (await restored.budget.reader.eventsAfter(0)).find(event => event.type === 'unknown');
    expect(typeof receipt?.payload.reservationId).toBe('string');
    // Explicit host fixture reconciliation, not a provider invoice or a model-supplied usage assertion.
    await restored.budget.port.settle(String(receipt!.payload.reservationId), { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const resumed = await restored.service.resumeRun('scenario-run', 'after-reconciliation', paused.revision);
    expect(resumed.budgetScopeKey).toBe(s.scope);
    expect(await restored.service.executeCode(input)).toEqual(result);
    expect(restored.sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(0);
    expect(restored.store.listAttempts('scenario-run')).toHaveLength(1);
    expect(await restored.budget.reader.snapshot(restored.scope)).toMatchObject({ limitTokens: 10_000, usedTokens: 15, unknownCalls: 0, reservedTokens: 0 });
  });
});
