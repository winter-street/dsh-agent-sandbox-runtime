import { Context, type Plugin } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, type GenerateOptions, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeConfigSchema } from '../../src/config.js';
import type { BudgetControlPort, BudgetSnapshot } from '../../src/contracts/budget.js';
import type { PolicyDecision, PolicyState } from '../../src/policy/engine.js';
import { createHarnessModelPolicy, ModelPolicyError, type ModelPolicyBinding } from '../../src/adapters/harness/model-policy.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const alloc = (limit: number, used = 0) => ({ limitTokens: limit, usedTokens: used, reservedTokens: 0, availableTokens: limit - used });
function snapshot(used = 0): BudgetSnapshot {
  return { ...alloc(10000, used), scopeKey: 'root', ledgerSeq: 0, unknownCalls: 0, exhausted: false,
    meteringComplete: true, usage: { inputTokens: used, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    work: alloc(9500, used), finalize: alloc(500) };
}
class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = [];
  gate?: Promise<void>;
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options);
    yield { type: 'text-delta', index: 0, text: 'answer' };
    if (this.gate) await this.gate;
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function setup(used = 0, mode: 'observe' | 'enforce' = 'enforce', realBudget = false) {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime).await();
  await ctx.plugin(SessionProjection).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(AgentLoop, { agents: [] }).await();
  const current = snapshot(used);
  let budget: BudgetControlPort = {
    scopeForSession: () => 'root', snapshot: () => current, eventsAfter: () => [],
    reserve: vi.fn(() => { throw new Error('policy must never reserve'); }),
    markDispatched: vi.fn(), settle: vi.fn(), releaseUnsent: vi.fn(), markUnknown: vi.fn(), allocate: vi.fn(),
    withPurpose: (_session, _purpose, callback) => callback(), withCallIdentity: (_session, _id, callback) => callback(),
  };
  if (realBudget) {
    const plugin = await import(new URL('../../.sources/budget/lib/index.js', import.meta.url).href) as {
      name: string; inject: Plugin.Object['inject']; apply(ctx: Context, config: unknown): void;
    };
    await ctx.plugin({ name: plugin.name, inject: plugin.inject ?? [], apply: plugin.apply }, {
      maxTokens: 10000, reservationMode: true, pressurePrompt: false,
      storageDir: mkdtempSync(join(tmpdir(), 'runtime-model-policy-')),
    }).await();
    budget = ctx.get('agentBudget') as BudgetControlPort;
  }
  const rootHandle = await ctx.agents.create({ sessionId: SessionId('root'), agentOptions: { provider: 'controlled', model: 'controlled' } });
  cleanups.push(() => rootHandle.dispose());
  const root = rootHandle.agent.session;
  if (realBudget) await budget.scopeForSession('root');
  const binding: ModelPolicyBinding = { runId: 'run', budgetScopeKey: 'root', cancelled: false, deadline: Date.now() + 60000,
    stepBoundary: 0, settlementBoundary: 0, required: true, purpose: 'work', intent: 'work',
    output: { kind: 'prose', minTokens: 128, defaultMaxTokens: 1000 } };
  const state = new Map<string, PolicyState>();
  const decisions: PolicyDecision[] = [];
  const controller = createHarnessModelPolicy({
    config: RuntimeConfigSchema.parse({ schemaVersion: 1, sandbox: { image: 'python' }, policy: { mode } }).policy,
    budget, resolveRun: () => ({ ...binding }), readState: run => state.get(run),
    commitDecision: (run, decision) => { state.set(run, structuredClone(decision.state)); decisions.push(decision); },
  });
  const fiber = ctx.plugin(controller.plugin);
  await fiber.await();
  const adapter = new Adapter();
  ctx.llm.registerAdapter(['controlled'], adapter);
  const request = (maxTokens = 1000): Promise<LlmCallConfig> => ctx.waterfall('agent/request', {
    agent: rootHandle.agent, turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => Object.freeze({ provider: 'controlled', model: 'controlled', maxTokens }));
  const stream = (maxTokens = 500) => ctx.llm.stream(Object.freeze({ provider: 'controlled', model: 'controlled', sessionId: root.id, messages: [], maxTokens }));
  async function consume(maxTokens = 500) { const out: StreamChunk[] = []; for await (const chunk of stream(maxTokens)) out.push(chunk); return out; }
  return { ctx, current, budget, binding, state, decisions, controller, adapter, request, stream, consume, fiber };
}

describe('model policy on actual Harness hook registry', () => {
  it('reduces prose at the request hook without mutating or repeatedly shrinking its frozen baseline', async () => {
    const s = await setup(7000);
    const first = await s.request();
    expect(first.maxTokens).toBe(750);
    expect((await s.request(750)).maxTokens).toBe(750);
    await s.consume(750);
    expect(s.adapter.calls[0]?.maxTokens).toBe(750);
    expect(s.budget.reserve).not.toHaveBeenCalled();
  });
  it('observe preserves the cap but records the proposed reduction', async () => {
    const s = await setup(7000, 'observe');
    expect((await s.request()).maxTokens).toBe(1000);
    expect(s.decisions.at(-1)?.proposedLimits.outputTokenCap).toBe(750);
    await s.consume(1000);
    expect(s.adapter.calls).toHaveLength(1);
  });
  it('preserves code/structured output space and rejects a configured cap below minimum', async () => {
    const s = await setup(8000);
    s.binding.output = { kind: 'code', minTokens: 256, defaultMaxTokens: 1000 };
    expect((await s.request()).maxTokens).toBe(1000);
    await expect(s.request(128)).rejects.toThrow('below the trusted minimum');
    await expect(s.consume(128)).rejects.toThrow('below the trusted minimum');
    expect(s.adapter.calls).toHaveLength(0);
  });
  it('rechecks complete final input cost and never dispatches an oversized or unbounded request', async () => {
    const s = await setup(9000);
    const cfg = await s.request();
    expect(cfg.maxTokens).toBe(500);
    await expect(s.consume(500)).rejects.toBeInstanceOf(ModelPolicyError);
    expect(s.adapter.calls).toHaveLength(0);
    const direct = s.ctx.llm.stream({ provider: 'controlled', model: 'controlled', sessionId: SessionId('root'), messages: [] });
    const consume = async () => { for await (const _chunk of direct) { /* drain */ } };
    await expect(consume()).rejects.toThrow('positive output token cap');
  });
  it('blocks changed/final oversized output before the downstream budget hook', async () => {
    const s = await setup(7000);
    await s.request();
    await expect(s.consume(1000)).rejects.toThrow('exceeds the policy output cap');
    expect(s.adapter.calls).toHaveLength(0);
  });
  it('tracks actual concurrent iterators, returns bounded waits, and releases slots on iterator cancellation', async () => {
    const s = await setup(7000);
    const first = s.stream()[Symbol.asyncIterator]();
    expect((await first.next()).done).toBe(false);
    expect(s.controller.inflightCalls('root')).toBe(1);
    await expect(s.consume()).rejects.toMatchObject({ retryable: true });
    expect(s.adapter.calls).toHaveLength(1);
    await first.return!();
    expect(s.controller.inflightCalls('root')).toBe(0);
    await s.consume();
    expect(s.adapter.calls).toHaveLength(2);
  });
  it('serializes simultaneous admissions so two callers cannot take one policy slot', async () => {
    const s = await setup(7000);
    const a = s.stream()[Symbol.asyncIterator]();
    const b = s.stream()[Symbol.asyncIterator]();
    const results = await Promise.allSettled([a.next(), b.next()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(s.controller.inflightCalls('root')).toBe(1);
    await a.return!(); await b.return!();
    expect(s.controller.inflightCalls('root')).toBe(0);
  });
  it.each(['unknown', 'cancel', 'deadline'] as const)('blocks %s even in observe mode', async reason => {
    const s = await setup(0, 'observe');
    if (reason === 'unknown') { s.current.unknownCalls = 1; s.current.meteringComplete = false; }
    if (reason === 'cancel') s.binding.cancelled = true;
    if (reason === 'deadline') s.binding.deadline = 1;
    await expect(s.consume()).rejects.toBeInstanceOf(ModelPolicyError);
    expect(s.adapter.calls).toHaveLength(0);
  });
  it('exposes an explicit bounded spawning gate for the workflow', async () => {
    const s = await setup(8000);
    await expect(s.controller.assertCanSpawn('root')).rejects.toBeInstanceOf(ModelPolicyError);
    expect(s.decisions.at(-1)?.reasons.map(r => r.code)).toContain('NEW_AGENT_BLOCKED');
  });
  it('releases an admitted slot when the downstream provider throws', async () => {
    const s = await setup();
    s.adapter.stream = () => { throw new Error('provider disconnected'); };
    expect(await s.consume()).toContainEqual(expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind: 'error' }) }));
    expect(s.controller.inflightCalls('root')).toBe(0);
  });
});

describe.skipIf(process.env.RUNTIME_BUDGET_INTEGRATION !== '1')('model policy with patched budget plugin', () => {
  it('keeps one reservation/settlement and meters a host-authorized finalize call', async () => {
    const s = await setup(0, 'enforce', true);
    await s.consume();
    expect((await s.budget.snapshot('root')).usedTokens).toBe(15);
    await s.budget.allocate('root', 1000, 'host report allocation');
    s.binding.requiredWorkComplete = true;
    s.binding.purpose = 'finalize';
    s.binding.intent = 'final-report';
    await s.consume(500);
    const final = await s.budget.snapshot('root');
    expect(final.usedTokens).toBe(30);
    expect(final.finalize.usedTokens).toBe(15);
    const receipts = await s.budget.eventsAfter(0);
    expect(receipts.filter(r => r.type === 'reserve')).toHaveLength(2);
    expect(receipts.filter(r => r.type === 'settle')).toHaveLength(2);
    expect(s.controller.inflightCalls('root')).toBe(0);
  });
  it('unknown after consumer interruption blocks the next request without a new reservation', async () => {
    const s = await setup(0, 'enforce', true);
    const iterator = s.stream()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return!();
    expect((await s.budget.snapshot('root')).unknownCalls).toBe(1);
    await expect(s.consume()).rejects.toBeInstanceOf(ModelPolicyError);
    expect(s.adapter.calls).toHaveLength(1);
    expect((await s.budget.eventsAfter(0)).filter(r => r.type === 'reserve')).toHaveLength(1);
  });
});
