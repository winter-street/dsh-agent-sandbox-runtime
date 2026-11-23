import type { Plugin } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { BudgetPort, BudgetPurpose } from '../contracts/budget.js';
import { ModelRouter, schemaFingerprint, type ModelProfile, type ModelRequirements, type ModelRouteDecision, type ModelRoutingState } from './router.js';

type MaybePromise<T> = T | Promise<T>;
export interface ModelRoutingBinding {
  runId: string; scopeKey: string; purpose: BudgetPurpose; stepBoundary: number;
  atRequestBoundary: boolean; inflightModelCalls: number; unresolvedToolCalls: number;
  requestEconomy: boolean; requirements: ModelRequirements;
}
export interface HarnessModelRouterOptions {
  router: ModelRouter;
  budget: BudgetPort;
  resolveRun(sessionId: string): MaybePromise<ModelRoutingBinding | undefined>;
  readState(runId: string): MaybePromise<ModelRoutingState | undefined>;
  commitDecision(runId: string, decision: ModelRouteDecision, phase: 'select' | 'verify'): MaybePromise<void>;
  countInputTokens(profile: Readonly<ModelProfile>, sessionId: string): number;
  countFinalInputTokens(profile: Readonly<ModelProfile>, request: GenerateOptions): number;
}

/** Install after budget and before model-policy so policy sees the selected config. */
export function createHarnessModelRouter(options: HarnessModelRouterOptions): Plugin.Object<void> {
  const locks = new Map<string, Promise<void>>();
  async function subject(sessionId: string) {
    const binding = await options.resolveRun(sessionId);
    if (!binding) throw new Error('Model routing requires a runtime run binding');
    if (await options.budget.scopeForSession(sessionId, { create: false }) !== binding.scopeKey) throw new Error('Model routing budget scope changed');
    return binding;
  }
  async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(done => { release = done; });
    locks.set(key, current); await before;
    try { return await work(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
  }
  return {
    name: 'runtime-model-router', inject: ['llm', 'agents'],
    apply(ctx) {
      ctx.on('agent/request', async (payload, next) => {
        const original = await next();
        const sessionId = String(payload.agent.session.id);
        const binding = await subject(sessionId);
        return locked(binding.runId, async () => {
          const current = await subject(sessionId);
          const decision = options.router.decide({
            ...current, budget: await options.budget.snapshot(current.scopeKey),
            countInputTokens: profile => options.countInputTokens(profile, sessionId),
          }, await options.readState(current.runId));
          await options.commitDecision(current.runId, decision, 'select');
          if (!decision.allowed) throw new Error(`Model routing denied: ${decision.reason}`);
          payload.signal.throwIfAborted();
          const selected = { ...original, provider: decision.profile.provider, model: decision.profile.model,
            maxTokens: Math.min(original.maxTokens ?? decision.outputTokens, decision.outputTokens) };
          if (selected.maxTokens < current.requirements.minimumOutputTokens) throw new Error('Selected output cap is below the required minimum');
          if (original.reasoningEffort && !decision.profile.reasoningEfforts.includes(original.reasoningEffort)) {
            throw new Error('Selected model does not support the effective reasoning effort');
          }
          return selected;
        });
      }, { prepend: true });
      ctx.on('llm/stream', (request, next) => (async function* () {
        if (!request.sessionId || !Number.isSafeInteger(request.maxTokens) || request.maxTokens! < 1) throw new Error('Final routed request requires a session and output cap');
        const sessionId = String(request.sessionId);
        const binding = await subject(sessionId);
        const state = await options.readState(binding.runId);
        if (!state) throw new Error('Select a model through agent/request before dispatch');
        const tools = (request.tools ?? []).map(tool => schemaFingerprint({ name: tool.name, parameters: tool.parameters })).sort();
        if (JSON.stringify(tools) !== JSON.stringify([...binding.requirements.toolSchemaHashes].sort())) throw new Error('Final request tool schemas differ from validated routing requirements');
        const decision = options.router.decide({
          ...binding, atRequestBoundary: false, requestEconomy: false,
          requirements: { ...binding.requirements, desiredOutputTokens: request.maxTokens! },
          budget: await options.budget.snapshot(binding.scopeKey),
          countInputTokens: profile => options.countFinalInputTokens(profile, request),
        }, state);
        await options.commitDecision(binding.runId, decision, 'verify');
        if (!decision.allowed) throw new Error(`Final model request denied: ${decision.reason}`);
        if (request.provider !== decision.profile.provider || request.model !== decision.profile.model
          || request.maxTokens! > decision.profile.maxOutputTokens) throw new Error('Final request does not match the selected model profile');
        request.signal?.throwIfAborted();
        for await (const chunk of next()) yield chunk;
      })(), { prepend: true });
    },
  };
}
