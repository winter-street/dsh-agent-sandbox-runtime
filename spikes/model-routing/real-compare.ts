import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, type Plugin } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, type GenerateOptions, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {
  DeepSeekAdapter, ModelRouter, RuntimeStore, createHarnessModelRouter, schemaFingerprint,
  type BudgetControlPort, type ModelProfile, type ModelRoutingState, type NormalizedUsage,
} from '../../src/index.js';
import { normalizeUsage } from '../../src/contracts/budget.js';
import type { RuntimeGenerateOptions } from '../../src/models/generate-options.js';

const pricingUrl = 'https://api-docs.deepseek.com/quick_start/pricing';
const models = ['deepseek-v4-pro', 'deepseek-flash'] as const;
const limits = { maxProviderCalls: 5, outputTokensPerCall: 512, totalTokenBudget: 12000, requestTimeoutMs: 60000 };
const prompt = 'For the fixed integer list [3, 7, 11, 19], compute count, sum, minimum and maximum. Return a JSON object exactly {"count":4,"sum":40,"min":3,"max":19}. Do not include other fields or markdown.';
const expected = { count: 4, sum: 40, min: 3, max: 19 };
const outputSchema = { type: 'object', properties: { count: { type: 'integer' }, sum: { type: 'integer' }, min: { type: 'integer' }, max: { type: 'integer' } }, required: ['count', 'sum', 'min', 'max'], additionalProperties: false };
const tool = { name: 'record_statistics', description: 'Record exactly the computed integer statistics.', parameters: outputSchema };
const toolHash = schemaFingerprint({ name: tool.name, parameters: tool.parameters });
const outputHash = schemaFingerprint(outputSchema);
type CallRecord = { model: string; kind: 'tool' | 'json' | 'routed-json'; startedAt: string; durationMs: number; passed: boolean;
  text: string; toolCalls: { name: string; arguments: string }[]; finishReason: string | undefined;
  usage: NormalizedUsage | undefined; responseModels: string[]; priceRangeUsd?: { lower: number; upper: number }; error?: string };

function save(directory: string, name: string, data: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + '\n');
}
function safeError(error: unknown): string {
  let value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const key of ['DEEPSEEK_API_KEY', 'OPEN_SANDBOX_API_KEY']) {
    const secret = process.env[key]?.trim();
    if (secret) value = value.replaceAll(secret, '[redacted]');
  }
  return value.slice(0, 2048);
}
function inputEstimate(request: GenerateOptions): number {
  // Deliberately conservative UTF-8 byte allowance, not a calibrated tokenizer.
  return Buffer.byteLength(JSON.stringify({ messages: request.messages, system: request.system ?? '', tools: request.tools ?? [] }), 'utf8') + 256;
}
function costRange(model: string, usage: NormalizedUsage) {
  const peak = model === 'deepseek-v4-pro' ? { hit: 0.044, miss: 1.32, output: 3.96 } : { hit: 0.006, miss: 0.3, output: 1.2 };
  assert.equal(usage.cacheWriteTokens, 0);
  const upper = (usage.inputTokens * peak.miss + usage.cacheReadTokens * peak.hit + usage.outputTokens * peak.output) / 1_000_000;
  return { lower: upper / 2, upper };
}
async function preflight() {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  assert(key, 'DEEPSEEK_API_KEY is required');
  const response = await fetch('https://api.deepseek.com/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'Authenticated model inventory');
  const inventory = await response.json() as { data: { id: string }[] };
  for (const model of models) assert(inventory.data.some(item => item.id === model), `Model unavailable: ${model}`);
  await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href);
  return inventory.data.map(item => item.id);
}
async function run(directory: string) {
  const inventory = await preflight();
  mkdirSync(directory, { recursive: false });
  const pricingResponse = await fetch(pricingUrl, { signal: AbortSignal.timeout(15000) });
  assert.equal(pricingResponse.status, 200);
  const pricingHtml = await pricingResponse.text();
  const pricingText = pricingHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // Fail closed if the public price table no longer matches this experiment's book.
  for (const snippet of ['deepseek-flash', 'deepseek-v4-pro', '$0.003', '$0.022', '$0.006', '$0.044', '$0.15', '$0.66', '$0.3', '$1.32', '$0.6', '$1.98', '$1.2', '$3.96']) {
    assert(pricingText.includes(snippet), `Price book changed: ${snippet}`);
  }
  writeFileSync(join(directory, 'official-pricing.html'), pricingHtml);
  save(directory, 'price-book.json', { capturedAt: new Date().toISOString(), source: pricingUrl,
    sha256: createHash('sha256').update(pricingHtml).digest('hex'), currency: 'USD', units: 'per million tokens',
    rates: { 'deepseek-v4-pro': { cacheHit: [0.022, 0.044], cacheMiss: [0.66, 1.32], output: [1.98, 3.96] },
      'deepseek-flash': { cacheHit: [0.003, 0.006], cacheMiss: [0.15, 0.3], output: [0.6, 1.2] } },
    costBasis: 'Range between published off-peak and peak rates. Actual provider usage buckets; no account invoice reconciliation.' });
  const ctx = new Context();
  let store: RuntimeStore | undefined;
  let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined;
  const calls: CallRecord[] = [];
  const captures: Promise<string[]>[] = [];
  const runId = `model-routing-${randomUUID()}`;
  try {
    await ctx.plugin(LlmRuntime).await();
    await ctx.plugin(SessionStore).await();
    await ctx.plugin(SystemPrompt).await();
    await ctx.plugin(ToolRuntime).await();
    await ctx.plugin(SessionProjection).await();
    await ctx.plugin(AgentRegistry).await();
    await ctx.plugin(AgentLoop, { agents: [] }).await();
    const originalBudget = await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href) as {
      name: string; inject: Plugin.Object['inject']; apply(ctx: Context, config: unknown): void;
    };
    await ctx.plugin({ name: originalBudget.name, inject: originalBudget.inject ?? [], apply: originalBudget.apply }, {
      maxTokens: limits.totalTokenBudget, reservationMode: true, pressurePrompt: false, storageDir: join(directory, 'budget'),
    }).await();
    const budget = ctx.get('agentBudget') as BudgetControlPort;
    handle = await ctx.agents.create({ sessionId: SessionId(runId), agentOptions: { provider: 'deepseek', model: models[0] } });
    const scopeKey = await budget.scopeForSession(runId);
    const observedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      // Keep the adapter's original streaming reader. This bounded side copy records response model identities only.
      captures.push(response.clone().text().then(text => [...new Set(text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').flatMap(line => {
        try { const item = JSON.parse(line.slice(6)) as { model?: unknown }; return typeof item.model === 'string' ? [item.model] : []; }
        catch { return []; }
      }))]));
      return response;
    };
    const adapter = new DeepSeekAdapter({ apiKey: process.env.DEEPSEEK_API_KEY!, thinking: 'disabled', maxCalls: limits.maxProviderCalls,
      requestTimeoutMs: limits.requestTimeoutMs, fetch: observedFetch });
    ctx.llm.registerAdapter(['deepseek'], adapter);
    store = new RuntimeStore(join(directory, 'database'));
    store.createRun({ runId, rootSessionId: runId, budgetScopeKey: scopeKey, task: prompt, deadline: Date.now() + 360000,
      policyVersion: 'model-routing-probe-v1', inputHash: schemaFingerprint({ prompt, expected }) });
    const request = (model: string, kind: 'tool' | 'json'): RuntimeGenerateOptions => ({
      provider: 'deepseek', model, sessionId: SessionId(runId), maxTokens: limits.outputTokensPerCall,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: kind === 'tool' ? prompt + ' Call record_statistics exactly once with those statistics. Use the tool instead of replying with text.' : prompt }] })],
      ...(kind === 'tool' ? { tools: [tool] } : { responseFormat: 'json-object' as const }),
    });
    async function call(options: RuntimeGenerateOptions, kind: CallRecord['kind']) {
      const started = Date.now();
      const record: CallRecord = { model: options.model, kind, startedAt: new Date(started).toISOString(), durationMs: 0, passed: false,
        text: '', toolCalls: [], finishReason: undefined, usage: undefined, responseModels: [] };
      try {
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === 'block-end') {
            if (chunk.block.type === 'text') record.text += chunk.block.text;
            if (chunk.block.type === 'tool-call') record.toolCalls.push({ name: chunk.block.name, arguments: chunk.block.arguments });
          }
          if (chunk.type === 'usage') { assert.equal(record.usage, undefined, 'Provider must report usage exactly once'); record.usage = normalizeUsage(chunk.usage); }
          if (chunk.type === 'finish') {
            record.finishReason = chunk.reason.kind;
            if ('failure' in chunk.reason) record.error = safeError(JSON.stringify(chunk.reason.failure));
          }
        }
        record.responseModels = await captures[captures.length - 1]!;
        assert(record.responseModels.length > 0, 'Provider response model identity');
        assert(record.usage, 'Provider usage is required');
        record.priceRangeUsd = costRange(options.model, record.usage);
        if (kind === 'tool') {
          assert.equal(record.finishReason, 'tool-calls');
          assert.equal(record.toolCalls.length, 1);
          assert.equal(record.toolCalls[0]!.name, tool.name);
          assert.deepEqual(JSON.parse(record.toolCalls[0]!.arguments), expected);
        } else {
          assert.equal(record.finishReason, 'stop');
          assert.equal(record.toolCalls.length, 0);
          assert.deepEqual(JSON.parse(record.text), expected);
        }
        record.passed = true;
      } catch (error) { record.error = safeError(error); }
      record.durationMs = Date.now() - started;
      calls.push(record);
      save(directory, 'calls.json', calls);
      return record;
    }
    for (const model of models) {
      for (const kind of ['tool', 'json'] as const) {
        const result = await call(request(model, kind), kind);
        assert(result.passed, 'Candidate capability verification failed; preserve calls.json');
      }
    }
    assert(calls.every(item => item.passed), 'Candidate capability verification failed; preserve calls.json');
    const profiles: ModelProfile[] = models.map(model => ({ id: model, provider: 'deepseek', model, modelWindowTokens: 1_000_000,
      maxOutputTokens: limits.outputTokensPerCall, taskTypes: ['fixed-integer-aggregation'], toolCalling: true, structuredOutput: true,
      validatedToolSchemaHashes: [toolHash], validatedOutputSchemaHashes: [outputHash], reasoningEfforts: [], verification: 'remote',
      verifiedAt: new Date().toISOString(), evidenceRefs: [join(directory, 'calls.json'), pricingUrl] }));
    save(directory, 'profiles.json', profiles);
    const routingConfig = { schemaVersion: 1, enabled: true, baselineId: models[0], candidates: [models[1]] };
    const router = new ModelRouter(routingConfig, profiles);
    let planned = request(models[0], 'json');
    await ctx.plugin(createHarnessModelRouter({ router, budget,
      resolveRun: () => ({ runId, scopeKey, purpose: 'work', stepBoundary: 4, atRequestBoundary: true,
        inflightModelCalls: 0, unresolvedToolCalls: 0, requestEconomy: true,
        requirements: { taskType: 'fixed-integer-aggregation', toolSchemaHashes: [], outputSchemaHash: outputHash,
          desiredOutputTokens: limits.outputTokensPerCall, minimumOutputTokens: 64 } }),
      readState: () => store!.getComponentState(runId, 'model-routing', 'state') as ModelRoutingState | undefined,
      commitDecision: (_runId, decision, phase) => store!.transaction(() => {
        store!.setComponentState(runId, 'model-routing', 'state', decision.state);
        store!.appendEvent(runId, 'model.routing', { phase, ...decision });
      }),
      countInputTokens: () => inputEstimate(planned), countFinalInputTokens: (_profile, final) => inputEstimate(final),
    })).await();
    const selected = await ctx.waterfall('agent/request', { agent: handle.agent, turn: 1, step: 5, signal: new AbortController().signal },
      async (): Promise<LlmCallConfig> => ({ provider: 'deepseek', model: models[0], maxTokens: limits.outputTokensPerCall }));
    assert.equal(selected.model, models[1]);
    planned = { ...planned, ...selected };
    assert((await call(planned, 'routed-json')).passed, 'Routed candidate output');
    const snapshot = await budget.snapshot(scopeKey);
    const ledger = (await budget.eventsAfter(0)).filter(event => event.scopeKey === scopeKey);
    assert.equal(snapshot.reservedTokens, 0);
    assert.equal(snapshot.unknownCalls, 0);
    assert(snapshot.meteringComplete);
    assert.equal(ledger.filter(event => event.type === 'reserve').length, 5);
    assert.equal(ledger.filter(event => event.type === 'settle').length, 5);
    const sum = calls.reduce((total, item) => total + Object.values(item.usage!).reduce((a, b) => a + b, 0), 0);
    assert.equal(snapshot.usedTokens, sum);
    const state = store.getComponentState(runId, 'model-routing', 'state');
    const routingEvents = store.eventsAfter(runId);
    store.close();
    store = new RuntimeStore(join(directory, 'database'));
    assert.deepEqual(store.getComponentState(runId, 'model-routing', 'state'), state);
    assert.deepEqual(store.eventsAfter(runId), routingEvents);
    assert.equal(router.restore(state, runId).selectedId, models[1]);
    const defaultRouter = new ModelRouter({ schemaVersion: 1, baselineId: models[0], candidates: [models[1]] }, profiles);
    assert.equal(defaultRouter.config.enabled, false);
    save(directory, 'report.json', { checkedAt: new Date().toISOString(), passed: true, inventory, runId, limits,
      provider: 'Actual DeepSeek SSE via DeepSeekAdapter + Harness + original budget plugin', sandboxInvoked: false,
      fixture: { prompt, expected, outputSchema, tool, toolHash, outputHash }, calls, profiles, routingConfig, routingState: state,
      budget: snapshot, ledger, routingEvents, sqliteReopenPassed: true, switchingDisabledByDefault: true,
      limitations: ['One fixed integer task, one tool and one JSON sample per model. No general quality or latency claim.',
        'Published-price range uses actual usage buckets. Peak/off-peak billing and account invoice were not reconciled.',
        'UTF-8 byte allowance is conservative and not a calibrated provider tokenizer.',
        'Profiles verify only these exact schema hashes and disabled thinking. Production app model selection remains explicitly configured.'] });
    console.log(JSON.stringify({ passed: true, providerCalls: calls.length, usedTokens: snapshot.usedTokens,
      baseline: models[0], selected: selected.model, report: join(directory, 'report.json') }, null, 2));
  } catch (error) {
    save(directory, 'failure.json', { checkedAt: new Date().toISOString(), passed: false, error: safeError(error), calls });
    throw error;
  } finally {
    store?.close();
    if (handle) await handle.dispose();
    await ctx.fiber.dispose();
  }
}
try {
  if (process.argv[2] === '--check-only') console.log(JSON.stringify({ passed: true, inventory: await preflight(), limits }));
  else {
    assert.equal(process.argv[2], '--run');
    assert(process.argv[3], 'A new evidence directory is required');
    await run(resolve(process.argv[3]));
  }
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }



