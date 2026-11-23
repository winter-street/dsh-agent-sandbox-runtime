import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, type Plugin } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native';
import { z } from 'zod';
import { RuntimeConfigSchema } from '../src/config.js';
import { connectBudgetService } from '../src/adapters/budget/index.js';
import { createHarnessModelPolicy, estimateModelTokens, ModelPolicyError, type ModelPolicyBinding } from '../src/adapters/harness/model-policy.js';
import type { PolicyState } from '../src/policy/engine.js';
import { RuntimeStore } from '../src/storage/index.js';
import { RetryController } from '../src/workflow/retry.js';
import { collectLedgerCalls } from './runtime-driver.js';
import { runtimeCodeHash } from '../src/core/checkpoint.js';

export const PressurePlanSchema = z.strictObject({
  schemaVersion: z.literal(1), suiteId: z.string().min(1), mode: z.literal('controlled'),
  budgets: z.array(z.int().min(1000).max(100000)).min(1).max(6),
  variants: z.tuple([z.literal('hard-only'), z.literal('tiered'), z.literal('tiered-finalize')]),
  scenarios: z.array(z.enum(['steady', 'retry-unsent', 'unknown-usage'])).min(1).max(3), order: z.string(),
  segments: z.array(z.array(z.int().min(-1000).max(1000)).min(1).max(16)).min(2).max(16),
  optionalAfterEachSegment: z.literal(true), syntheticTokensPerCall: z.int().min(1).max(500),
  outputCap: z.int().min(128).max(512), finalizeRatio: z.number().min(0.05).max(0.25), maxRetries: z.literal(2),
  success: z.string(), denialReview: z.string(), limitations: z.array(z.string()),
}).refine(value => new Set(value.budgets).size === value.budgets.length && new Set(value.scenarios).size === value.scenarios.length, 'Duplicate pressure conditions');
type Plan = z.infer<typeof PressurePlanSchema>;

class ControlledPressureProvider extends LlmAdapter {
  dispatched = 0; dropNextUsage = false;
  constructor(private readonly tokens: number) { super(); }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.dispatched++;
    const blocks = options.messages.flatMap(message => message.content);
    const text = blocks.find(block => block.type === 'text');
    const input = JSON.parse(text?.type === 'text' ? text.text : '{}') as { values?: number[]; report?: string };
    const answer = input.values ? String(input.values.reduce((a, b) => a + b, 0)) : input.report ?? 'optional detail';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: answer };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
    if (!this.dropNextUsage) yield { type: 'usage', usage: { inputTokens: this.tokens - 1, outputTokens: 1 } };
    this.dropNextUsage = false;
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function runCondition(plan: Plan, directory: string, budgetLimit: number, variant: Plan['variants'][number], scenario: Plan['scenarios'][number]) {
  mkdirSync(directory, { recursive: true });
  const ctx = new Context(); const store = new RuntimeStore(join(directory, 'runtime'));
  const runId = 'pressure-run'; const rootSession = 'pressure-session';
  let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined;
  try {
    await ctx.plugin(LlmRuntime).await(); await ctx.plugin(SessionStore).await(); await ctx.plugin(SystemPrompt).await();
    await ctx.plugin(SessionProjection).await(); await ctx.plugin(ToolRuntime).await(); await ctx.plugin(ToolExecutorNative).await();
    await ctx.plugin(AgentRegistry).await(); await ctx.plugin(AgentLoop, { agents: [] }).await();
    const plugin = await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href) as { name: string; inject: Plugin.Object['inject']; apply(ctx: Context, config: unknown): void };
    await ctx.plugin({ name: plugin.name, inject: plugin.inject ?? [], apply: plugin.apply }, { maxTokens: budgetLimit,
      reservationMode: true, pressurePrompt: false, storageDir: join(directory, 'budget'), maxConcurrentCalls: 2 }).await();
    handle = await ctx.agents.create({ sessionId: SessionId(rootSession), agentOptions: { provider: 'controlled-pressure', model: 'controlled' } });
    const budget = connectBudgetService(ctx); const scopeKey = await budget.port.scopeForSession(rootSession);
    if (variant === 'tiered-finalize') await budget.operator.allocate(scopeKey, Math.floor(budgetLimit * plan.finalizeRatio), 'fixed pressure plan');
    const deadline = Date.now() + 60000;
    store.createRun({ runId, rootSessionId: rootSession, budgetScopeKey: scopeKey, task: plan.success, deadline, policyVersion: plan.suiteId, inputHash: createHash('sha256').update(JSON.stringify(plan.segments)).digest('hex') });
    store.transitionRun(runId, 'RUNNING');
    store.addStep({ runId, stepId: 'pressure-acceptance', kind: 'review', status: 'PENDING', required: true,
      dependencies: [], inputHash: createHash('sha256').update(JSON.stringify(plan.segments)).digest('hex') });
    let stepBoundary = 0;
    const binding: ModelPolicyBinding = { runId, budgetScopeKey: scopeKey, cancelled: false, deadline, stepBoundary, settlementBoundary: 0,
      required: true, purpose: 'work', intent: 'work', output: { kind: 'structured', minTokens: 64, defaultMaxTokens: plan.outputCap } };
    const controller = createHarnessModelPolicy({
      config: RuntimeConfigSchema.parse({ schemaVersion: 1, sandbox: { image: 'unused' }, policy: { mode: variant === 'hard-only' ? 'observe' : 'enforce' } }).policy,
      budget: budget.control,
      resolveRun: async () => ({ ...binding, stepBoundary, settlementBoundary: (await budget.reader.snapshot(scopeKey)).ledgerSeq }),
      readState: id => store.getPolicyState<PolicyState>(id),
      commitDecision: (id, decision, phase) => store.transaction(() => { store.savePolicyState(id, decision.state); store.appendEvent(id, 'pressure.decision', { phase, ...decision }); }),
    });
    await ctx.plugin(controller.plugin).await();
    const provider = new ControlledPressureProvider(plan.syntheticTokensPerCall); ctx.llm.registerAdapter(['controlled-pressure'], provider);
    const retry = new RetryController(store, { maxAttempts: plan.maxRetries, baseDelayMs: 0, maxDelayMs: 0 });
    const values: Array<number | null> = [];
    const denials: Array<{ required: boolean; disposition: string; reasons: string[]; estimate: number; available: number; classAvailable: number; candidateFalseDenial: boolean }> = [];
    let optionalCalls = 0; let injectedRetries = 0; let finalization = 'disabled';
    async function call(payload: unknown, required: boolean, purpose: 'work' | 'finalize' = 'work'): Promise<string | null> {
      binding.required = required; binding.purpose = purpose; binding.intent = purpose === 'finalize' ? 'final-report' : 'work';
      const request: GenerateOptions = { provider: 'controlled-pressure', model: 'controlled', sessionId: handle!.agent.session.id,
        maxTokens: plan.outputCap, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify(payload) }] })] };
      const before = await budget.reader.snapshot(scopeKey); const estimate = estimateModelTokens(request);
      try {
        let answer = '';
        for await (const chunk of ctx.llm.stream(request)) if (chunk.type === 'text-delta') answer += chunk.text;
        stepBoundary++; return answer;
      } catch (error) {
        if (!(error instanceof ModelPolicyError)) throw error;
        const hardSafe = required && before.unknownCalls === 0 && before.meteringComplete && estimate <= before.availableTokens
          && estimate <= before[purpose].availableTokens && !binding.cancelled && Date.now() < deadline && controller.inflightCalls(scopeKey) === 0;
        denials.push({ required, disposition: error.decision.disposition, reasons: error.decision.reasons.map(r => r.code), estimate,
          available: before.availableTokens, classAvailable: before[purpose].availableTokens, candidateFalseDenial: hardSafe && purpose === 'work' });
        return null;
      }
    }
    for (const [index, segment] of plan.segments.entries()) {
      if (scenario === 'retry-unsent' && index === 1) {
        const key = `segment-${index}`; const first = retry.begin(runId, key);
        // Host fault before any provider call/reservation. It is explicitly known unsent.
        if (!retry.failed(runId, key, first.attempts, 'transient-unsent').retryable) throw new Error('Known-unsent retry was blocked');
        retry.begin(runId, key); injectedRetries++;
      }
      if (scenario === 'unknown-usage' && index === 1) provider.dropNextUsage = true;
      const answer = await call({ values: segment }, true); values.push(answer === null ? null : Number(answer));
      const snapshot = await budget.reader.snapshot(scopeKey);
      if (snapshot.unknownCalls || !snapshot.meteringComplete) {
        const before = provider.dispatched;
        if (await call({ values: segment }, true) !== null || provider.dispatched !== before) throw new Error('Unknown usage admitted new work');
        break;
      }
      if (answer === null) break;
      if (await call({ optional: 'explain the preceding segment' }, false) !== null) optionalCalls++;
    }
    const verified = values.length === plan.segments.length && values.every((value, index) => value === plan.segments[index]!.reduce((sum, n) => sum + n, 0));
    const beforeReport = await budget.reader.snapshot(scopeKey);
    if (variant === 'tiered-finalize') {
      binding.requiredWorkComplete = verified;
      // Trigger the persisted finalization decision before a host-authorized report.
      if (verified || store.getPolicyState<PolicyState>(runId)?.finalized) {
        const report = await call({ report: verified ? 'All segments independently verified.' : 'Partial: required segments remain.' }, true, 'finalize');
        finalization = report === null ? 'template-budget' : 'model';
      } else finalization = 'template-accounting';
    }
    const snapshot = await budget.reader.snapshot(scopeKey); const receipts = await budget.reader.eventsAfter(0);
    const calls = collectLedgerCalls(receipts, scopeKey);
    const knownTokens = calls.reduce((total, call) => total + (call.usage ? Object.values(call.usage).reduce((a, b) => a + b, 0) : 0), 0);
    if (knownTokens !== snapshot.usedTokens || calls.length !== provider.dispatched || snapshot.usedTokens > budgetLimit) throw new Error('Controlled pressure accounting invariant failed');
    const complete = verified && snapshot.unknownCalls === 0 && snapshot.meteringComplete && snapshot.reservedTokens === 0;
    store.recordValidation('pressure-acceptance', complete, { verified, expectedSegments: plan.segments.length, checkedSegments: values.length });
    const status = snapshot.unknownCalls ? 'PAUSED_ACCOUNTING' : complete ? 'SUCCEEDED' : 'PAUSED_BUDGET';
    store.transitionRun(runId, status);
    const result = { schemaVersion: 1, mode: 'controlled', budgetLimit, variant, scenario, status, complete, verified, values,
      providerCalls: provider.dispatched, optionalCalls, injectedRetries, finalization, snapshot, denials,
      denialReview: { reviewed: denials.length, candidateFalseDenials: denials.filter(d => d.candidateFalseDenial).length,
        rate: denials.length ? denials.filter(d => d.candidateFalseDenial).length / denials.length : null },
      scopeKey, beforeReport, calls, limitations: plan.limitations };
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(join(directory, 'ledger.json'), JSON.stringify(receipts, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(join(directory, 'trace.json'), JSON.stringify(store.eventsAfter(runId), null, 2) + '\n', { flag: 'wx' });
    return result;
  } finally { try { await handle?.dispose(); await ctx.fiber.dispose(); } finally { store.close(); } }
}

export async function runPressureEvaluation(directory: string, planPath = 'eval/pressure-plan.json') {
  const bytes = readFileSync(planPath); const plan = PressurePlanSchema.parse(JSON.parse(bytes.toString()));
  const root = resolve(directory); if (existsSync(root)) throw new Error('Pressure output directory already exists; preserve its evidence');
  mkdirSync(root, { recursive: true });
  // Write the exact plan before any dispatch; no post-result tuning of gradients/order.
  writeFileSync(join(root, 'plan.json'), bytes, { flag: 'wx' });
  const results = [];
  for (const [budgetIndex, limit] of plan.budgets.entries()) for (const scenario of plan.scenarios) {
    const variants = [...plan.variants.slice(budgetIndex % 3), ...plan.variants.slice(0, budgetIndex % 3)];
    for (const variant of variants) results.push(await runCondition(plan, join(root, `${limit}-${scenario}-${variant}`), limit, variant, scenario));
  }
  const report = { schemaVersion: 1, mode: 'controlled', planSha256: createHash('sha256').update(bytes).digest('hex'),
    executionRevision: createHash('sha256').update(runtimeCodeHash()).update(readFileSync(new URL(import.meta.url))).digest('hex'),
    conditions: results.length, results, limitations: plan.limitations };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}
