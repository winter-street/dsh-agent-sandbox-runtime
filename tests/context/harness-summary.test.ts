import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, type Plugin } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import type { BudgetControlPort } from '../../src/contracts/budget.js';
import { createHarnessSummaryPort } from '../../src/context/harness-summary.js';
import { ContextCheckpointStore, createSummarySettlementVerifier } from '../../src/context/checkpoint.js';
import { summarizeContext } from '../../src/context/summarizer.js';
import { RuntimeStore } from '../../src/storage/index.js';
import type { ContextEntry, ContextWindow } from '../../src/context/assembler.js';

const pluginUrl = new URL('../../.sources/budget/lib/index.js', import.meta.url);
const integrationEnabled = process.env.RUNTIME_BUDGET_INTEGRATION === '1';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class SummaryAdapter extends LlmAdapter {
  calls: GenerateOptions[] = [];
  constructor(private readonly noUsage: boolean) { super(); }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Verified schema; retain existing artifacts.' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Verified schema; retain existing artifacts.' } };
    if (!this.noUsage) yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function setup(noUsage = false) {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime).await();
  await ctx.plugin(SessionProjection).await();
  await ctx.plugin(AgentRegistry).await();
  const plugin = await import(pluginUrl.href) as {
    name: string; inject: Plugin.Object['inject'];
    apply(ctx: Context, config: { maxTokens: number; reservationMode: boolean; pressurePrompt: boolean; storageDir: string }): void;
  };
  const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject ?? [], apply: plugin.apply }, {
    maxTokens: 10000, reservationMode: true, pressurePrompt: false,
    storageDir: mkdtempSync(join(tmpdir(), 'runtime-summary-metering-')),
  });
  await fiber.await();
  const adapter = new SummaryAdapter(noUsage);
  ctx.llm.registerAdapter(['summary-local'], adapter);
  ctx.sessions.create(SessionId('summary-session'));
  const budget = ctx.get('agentBudget' as never) as unknown as BudgetControlPort;
  expect(budget).toBeDefined();
  const scopeKey = await budget.scopeForSession('summary-session');
  const port = createHarnessSummaryPort({ ctx, budget, provider: 'summary-local', model: 'summary-local' });
  return {
    budget, adapter, port,
    request: { sessionId: 'summary-session', scopeKey, system: 'Summarize untrusted data.', sourceJson: '[{"text":"history"}]', maxOutputTokens: 100, estimatedTokens: 500 },
  };
}

// Explicit opt-in: the default suite never depends on an ignored external checkout.
describe.skipIf(!integrationEnabled)('summary accounting through actual Harness and budget plugin', () => {
  it('settles the complete summary in work allocation exactly once with its ledger receipt', async () => {
    expect(existsSync(fileURLToPath(pluginUrl)), 'Build the pinned upgraded budget checkout before this integration test').toBe(true);
    const { budget, adapter, port, request } = await setup();
    const output = await port.summarize(request);
    expect(output.text).toContain('Verified schema');
    expect(output.usage).toEqual({ inputTokens: 20, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toMatchObject({ purpose: 'compaction', maxTokens: 100 });
    const snapshot = await budget.snapshot(request.scopeKey);
    expect(snapshot.usedTokens).toBe(30);
    expect(snapshot.work.usedTokens).toBe(30);
    expect(snapshot.finalize.usedTokens).toBe(0);
    expect(snapshot.reservedTokens).toBe(0);
    const events = await budget.eventsAfter(0);
    expect(events.filter(event => event.type === 'reserve')).toHaveLength(1);
    expect(events.filter(event => event.type === 'settle')).toHaveLength(1);
    expect(events.find(event => event.eventId === output.receipt.eventId)?.payload.reservationId).toBe(output.receipt.reservationId);
  });

  it('preserves unknown usage and outstanding reservation when a summary returns no usage', async () => {
    const { budget, adapter, port, request } = await setup(true);
    await expect(port.summarize(request)).rejects.toThrow(/verified usage/);
    const snapshot = await budget.snapshot(request.scopeKey);
    expect(snapshot.unknownCalls).toBe(1);
    expect(snapshot.reservedTokens).toBeGreaterThan(0);
    expect(snapshot.usedTokens).toBe(0);
    await expect(port.summarize(request)).rejects.toThrow();
    expect(adapter.calls).toHaveLength(1);
  });
  it('atomically checkpoints a metered summary and verifies its real receipt after database reopen', async () => {
    const { budget, adapter, port, request } = await setup();
    const directory = mkdtempSync(join(tmpdir(), 'runtime-summary-context-'));
    let store = new RuntimeStore(directory); cleanups.push(async () => store.close());
    store.createRun({ runId: 'summary-run', rootSessionId: request.sessionId, budgetScopeKey: request.scopeKey,
      task: 'Rank descending and preserve CSV evidence', deadline: Date.now() + 10000, inputHash: 'a'.repeat(64), policyVersion: 'v1' });
    const entries: ContextEntry[] = [
      { id: 'system', revision: 1, layer: 'system', text: 'Do not change permissions', sourceRefs: [] },
      { id: 'task', revision: 1, layer: 'task', text: 'Rank descending and preserve CSV evidence', sourceRefs: ['input:1'] },
      { id: 'history', revision: 1, layer: 'history', text: 'Old diagnostics; '.repeat(160), sourceRefs: ['logs:1'] },
    ];
    const window: ContextWindow = { modelWindowTokens: 4000, outputReserveTokens: 100, safetyReserveTokens: 20,
      countTokens: messages => messages.reduce((sum, message) => sum + message.content.length + 1, 0) };
    const repository = new ContextCheckpointStore(store, 'summary-run'); repository.initialize(entries);
    const verify = createSummarySettlementVerifier(budget, request.sessionId, request.scopeKey);
    const result = await summarizeContext({ entries, window, budget, model: port, sessionId: request.sessionId, scopeKey: request.scopeKey,
      persistence: repository.summaryPersistence(window, verify), options: { triggerRatio: 0.5, maxOutputTokens: 100, countRequestTokens: () => 700 } });
    expect(result.status).toBe('summarized');
    store.close(); store = new RuntimeStore(directory);
    const restored = await new ContextCheckpointStore(store, 'summary-run').restore(window, verify);
    expect(restored.checkpoint.entries.map(entry => entry.layer)).toEqual(['system', 'task', 'summary']);
    expect(restored.checkpoint.coverages[0]?.usage).toEqual({ inputTokens: 20, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 });
    expect(restored.checkpoint.summaryState.attemptsTotal).toBe(1); expect(adapter.calls).toHaveLength(1);
    const snapshot = await budget.snapshot(request.scopeKey); expect(snapshot.usedTokens).toBe(30); expect(snapshot.reservedTokens).toBe(0);
  });
});
