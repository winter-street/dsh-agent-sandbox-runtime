import { Context, type Plugin } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, MessageId, type GenerateOptions, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BudgetControlPort } from '../../src/contracts/budget.js';
import { ModelRouter, type ModelProfile, type ModelRoutingState } from '../../src/models/router.js';
import { createHarnessModelRouter } from '../../src/models/harness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = [];
  override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(request);
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function setup() {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime).await(); await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await(); await ctx.plugin(ToolRuntime).await();
  await ctx.plugin(SessionProjection).await();
  await ctx.plugin(AgentRegistry).await(); await ctx.plugin(AgentLoop, { agents: [] }).await();
  const plugin = await import(new URL('../../.sources/budget/lib/index.js', import.meta.url).href) as {
    name: string; inject: Plugin.Object['inject']; apply(ctx: Context, config: unknown): void;
  };
  await ctx.plugin({ name: plugin.name, inject: plugin.inject ?? [], apply: plugin.apply }, {
    maxTokens: 20000, reservationMode: true, pressurePrompt: false, storageDir: mkdtempSync(join(tmpdir(), 'router-budget-')),
  }).await();
  const handle = await ctx.agents.create({ sessionId: SessionId('root'), agentOptions: { provider: 'controlled', model: 'baseline' } });
  cleanups.push(() => handle.dispose());
  const budget = ctx.get('agentBudget') as BudgetControlPort; await budget.scopeForSession('root');
  const profile = (id: string, cap: number): ModelProfile => ({ id, provider: 'controlled', model: id,
    modelWindowTokens: 4000, maxOutputTokens: cap, taskTypes: ['report'], toolCalling: false, structuredOutput: false,
    validatedToolSchemaHashes: [], validatedOutputSchemaHashes: [], reasoningEfforts: [], verification: 'controlled',
    verifiedAt: 'fixture', evidenceRefs: ['controlled provider integration'] });
  const router = new ModelRouter({ schemaVersion: 1, enabled: true, baselineId: 'baseline', candidates: ['small'], allowControlledProfiles: true }, [profile('baseline', 1000), profile('small', 800)]);
  const states = new Map<string, ModelRoutingState>();
  const estimates: string[] = [];
  await ctx.plugin(createHarnessModelRouter({
    router, budget, resolveRun: () => ({ runId: 'run', scopeKey: 'root', purpose: 'work', stepBoundary: 0,
      atRequestBoundary: true, inflightModelCalls: 0, unresolvedToolCalls: 0, requestEconomy: true,
      requirements: { taskType: 'report', toolSchemaHashes: [], desiredOutputTokens: 1000, minimumOutputTokens: 100 } }),
    readState: run => states.get(run), commitDecision: (run, decision) => { states.set(run, decision.state); },
    countInputTokens: profile => { estimates.push(profile.id); return profile.id === 'small' ? 200 : 100; },
    countFinalInputTokens: (_profile, request) => Buffer.byteLength(JSON.stringify(request.messages), 'utf8'),
  })).await();
  const adapter = new Adapter(); ctx.llm.registerAdapter(['controlled'], adapter);
  const select = (): Promise<LlmCallConfig> => ctx.waterfall('agent/request', { agent: handle.agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => Object.freeze({ provider: 'controlled', model: 'baseline', maxTokens: 1000 }));
  const consume = async (cfg: LlmCallConfig, extra: Partial<GenerateOptions> = {}) => {
    for await (const _chunk of ctx.llm.stream(Object.freeze({ ...cfg, sessionId: handle.agent.session.id, messages: [], ...extra }))) { /* drain */ }
  };
  return { ctx, budget, adapter, states, estimates, select, consume };
}

describe.skipIf(process.env.RUNTIME_BUDGET_INTEGRATION !== '1')('model selection through real Harness and budget plugin', () => {
  it('switches before reservation, invokes only selected model and settles exactly once', async () => {
    const s = await setup(); const cfg = await s.select();
    expect(cfg).toMatchObject({ model: 'small', maxTokens: 800 });
    expect(s.estimates).toEqual(['baseline', 'small']);
    await s.consume(cfg);
    expect(s.adapter.calls.map(call => call.model)).toEqual(['small']);
    expect((await s.budget.snapshot('root')).usedTokens).toBe(23);
    const events = await s.budget.eventsAfter(0);
    expect(events.filter(event => event.type === 'reserve')).toHaveLength(1);
    expect(events.filter(event => event.type === 'settle')).toHaveLength(1);
    expect(events.find(event => event.type === 'reserve')?.payload.request).toMatchObject({ model: 'small' });
  });
  it('rejects expanded final context before any provider or reservation', async () => {
    const s = await setup(); const cfg = await s.select();
    await expect(s.consume(cfg, { messages: [{ id: MessageId('large'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(5000) }] }] })).rejects.toThrow('Final model request denied');
    expect(s.adapter.calls).toHaveLength(0);
    expect((await s.budget.eventsAfter(0)).filter(event => event.type === 'reserve')).toHaveLength(0);
  });
  it('rejects model or tool-schema mutation after the selection record', async () => {
    const s = await setup(); const cfg = await s.select();
    await expect(s.consume(cfg, { model: 'unvalidated-model' })).rejects.toThrow('selected model profile');
    await expect(s.consume(cfg, { tools: [{ name: 'new-tool', description: 'unvalidated', parameters: { type: 'object' } }] })).rejects.toThrow('tool schemas differ');
    expect(s.adapter.calls).toHaveLength(0);
    expect((await s.budget.eventsAfter(0)).filter(event => event.type === 'reserve')).toHaveLength(0);
  });
});
