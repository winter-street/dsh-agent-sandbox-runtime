import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native';
import { connectBudgetService } from '../../src/adapters/budget/index.js';
import { BudgetReceiptSynchronizer } from '../../src/adapters/budget/receipts.js';
import { RuntimeStore } from '../../src/storage/index.js';

interface PatchedBudgetModule {
  name: string;
  inject: string[];
  apply(ctx: Context, config: { maxTokens: number; reservationMode: boolean; pressurePrompt: boolean; storageDir: string }): void;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('patched budget plugin + real Harness session tree + runtime receipt replay', () => {
  it.skipIf(!existsSync(resolve('.sources/budget/lib/index.js')))('shares root scope with a child and restores receipt cursor after runtime SQLite reopen', async () => {
    const pluginPath = pathToFileURL(resolve('.sources/budget/lib/index.js')).href;
    const budgetModule = await import(pluginPath) as PatchedBudgetModule;
    const budgetDir = mkdtempSync(join(tmpdir(), 'budget-harness-ledger-'));
    const runtimeDir = mkdtempSync(join(tmpdir(), 'budget-harness-runtime-'));
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
    await ctx.plugin({ name: budgetModule.name, inject: budgetModule.inject, apply: budgetModule.apply }, {
      maxTokens: 1_000, reservationMode: true, pressurePrompt: false, storageDir: budgetDir,
    }).await();

    const root = await ctx.agents.create({ sessionId: SessionId('integration-root'), agentOptions: { provider: 'unused', model: 'unused' } });
    cleanups.push(() => root.dispose());
    const child = await root.agent.ctx.agents.create({
      sessionId: SessionId('integration-child'),
      meta: { parentSession: root.agent.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'unused', model: 'unused' },
    });
    cleanups.push(() => child.dispose());

    const bridge = connectBudgetService(ctx);
    const rootScope = await bridge.port.scopeForSession('integration-root');
    expect(await bridge.reader.scopeForSession('integration-child')).toBe(rootScope);
    expect((await bridge.reader.snapshot(rootScope)).limitTokens).toBe(1_000);

    const decision = await bridge.port.reserve({
      scopeKey: rootScope, modelCallId: 'harness-child-call-1', sessionId: 'integration-child',
      provider: 'controlled-provider', model: 'controlled-model', purpose: 'work', estimatedTokens: 40,
    });
    expect(decision).toMatchObject({ allowed: true, replayed: false });
    if (!decision.allowed) throw new Error(`Unexpected budget denial: ${decision.reason}`);
    await bridge.port.markDispatched(decision.reservation.reservationId);
    await bridge.port.settle(decision.reservation.reservationId, { inputTokens: 24, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(await bridge.reader.snapshot(rootScope)).toMatchObject({ usedTokens: 32, reservedTokens: 0, availableTokens: 968 });

    const runtimeStore = new RuntimeStore(runtimeDir);
    cleanups.push(async () => runtimeStore.close());
    runtimeStore.createRun({ runId: 'integration-run', rootSessionId: 'integration-root', budgetScopeKey: rootScope,
      task: 'budget integration', deadline: Date.now() + 60_000, policyVersion: 'test-v1', inputHash: 'b'.repeat(64) });
    const sync = new BudgetReceiptSynchronizer(runtimeStore, bridge.reader, 'local-integration-ledger');
    const first = await sync.sync('integration-run');
    expect(first).toMatchObject({ imported: 4, cursor: 4 });
    const trace = runtimeStore.eventsAfter('integration-run').filter(event => event.type === 'budget.receipt');
    expect(trace.map(event => (event.payload as { eventType: string }).eventType)).toEqual(['open', 'reserve', 'dispatch', 'settle']);
    expect(JSON.stringify(trace)).not.toContain('controlled-provider');

    runtimeStore.close();
    const reopened = new RuntimeStore(runtimeDir);
    cleanups.pop();
    cleanups.push(async () => reopened.close());
    const replay = new BudgetReceiptSynchronizer(reopened, bridge.reader, 'local-integration-ledger');
    expect(await replay.sync('integration-run')).toEqual({ cursor: 4, imported: 0, scanned: 0 });
    expect(reopened.eventsAfter('integration-run').filter(event => event.type === 'budget.receipt')).toHaveLength(4);
  });
});
