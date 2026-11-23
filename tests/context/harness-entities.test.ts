import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Plugin } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarnessRolePort } from '../../src/adapters/harness/roles.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import type { BudgetControlPort } from '../../src/contracts/budget.js';
import { ContextCheckpointStore } from '../../src/context/checkpoint.js';
import { EntityIndex } from '../../src/context/entities.js';
import { createRuntimeEntityEvidence, retrieveEntityContext, type EntityInputDocument } from '../../src/context/entity-context.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { RoleNotDispatchedError, type RoleRequest } from '../../src/workflow/serial.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });
const dtoBytes = (request: Readonly<GenerateOptions>): number => Buffer.byteLength(JSON.stringify({ system: request.system,
  messages: request.messages.map(message => ({ role: message.role, content: message.content })), tools: request.tools }));
const countRequestTokens = (request: Readonly<GenerateOptions>): number => Math.ceil(dtoBytes(request) / 3) + 64;
const messages = (request: GenerateOptions): string => JSON.stringify(request.messages);
class Adapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(request);
    const text = '{"steps":["Charger Seven"],"checks":["evidence"]}';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

describe.skipIf(process.env.RUNTIME_BUDGET_INTEGRATION !== '1')('actual Harness/original budget entity recall', () => {
  it('injects source-verified request-local recall, survives SQLite reopen and rejects stale or corrupted evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harness-entities-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose());
    await ctx.plugin(LlmRuntime).await(); await ctx.plugin(SessionStore).await(); await ctx.plugin(SystemPrompt).await();
    await ctx.plugin(SessionProjection).await(); await ctx.plugin(ToolRuntime).await(); await ctx.plugin(ToolExecutorNative).await();
    await ctx.plugin(AgentRegistry).await(); ctx.sessions.create(SessionId('root'));
    const plugin = await import(new URL('../../.sources/budget/lib/index.js', import.meta.url).href) as {
      name: string; inject: Plugin.Object['inject']; apply(ctx: Context, config: unknown): void;
    };
    await ctx.plugin({ name: plugin.name, inject: plugin.inject ?? [], apply: plugin.apply }, {
      maxTokens: 20000, reservationMode: true, pressurePrompt: false, storageDir: join(directory, 'budget'),
    }).await();
    const budget = ctx.get('agentBudget') as BudgetControlPort; const scopeKey = await budget.scopeForSession('root');
    let store = new RuntimeStore(join(directory, 'runtime')); cleanups.push(() => store.close());
    for (const runId of ['baseline', 'indexed', 'other']) store.createRun({ runId, rootSessionId: 'root', budgetScopeKey: scopeKey,
      task: 'Check the source evidence for device-7.', deadline: Date.now() + 60000, inputHash: 'a'.repeat(64), policyVersion: 'budget-policy-v1' });
    const source = Buffer.from(JSON.stringify({ rows: Array.from({ length: 60 }, (_, index) => ({ id: `device-${index}`,
      label: index === 7 ? 'Charger Seven' : `Station ${index}`, alerts: index === 7 ? 3 : 0, notes: 'historical diagnostic data '.repeat(8) })) }));
    let document: EntityInputDocument = { version: 'v1', content: source }; let queryVersion = 'v1';
    const artifacts = new ArtifactStore(join(directory, 'artifacts'));
    const makeIndex = () => new EntityIndex(store, createRuntimeEntityEvidence({ store, artifacts,
      input: (runId, id) => runId === 'indexed' && id === 'input.json' ? document : undefined }));
    makeIndex().setInputVersion('indexed', 'v1'); makeIndex().setInputVersion('other', 'v1');
    const contentHash = createHash('sha256').update(source).digest('hex');
    makeIndex().put({ runId: 'indexed', entityId: 'device-7', type: 'device', label: 'Charger Seven', attributes: { alerts: 3 },
      inputVersion: 'v1', evidence: [{ kind: 'input', id: 'input.json', version: 'v1', contentHash, locator: '#/rows/7' }], extraction: { kind: 'deterministic' } });
    const adapter = new Adapter(); ctx.llm.registerAdapter(['controlled'], adapter);
    const request: RoleRequest = { runId: 'indexed', scopeKey, sessionId: 'root', role: 'planner', callId: 'indexed-1', input: { device: 'device-7' } };
    const recall = () => ({ index: makeIndex(), query: () => ({ inputVersion: queryVersion, terms: ['device'], limit: 1 }) });
    const port = (entities: boolean, modelWindowTokens = 1200) => createHarnessRolePort({ ctx, budget, provider: 'controlled', model: 'model', maxOutputTokens: 128,
      context: { store, modelWindowTokens, safetyReserveTokens: 20, countRequestTokens, initialEntries: () => [
        { id: 'permissions', revision: 1, layer: 'system', text: 'Preserve sandbox permissions.', sourceRefs: [] },
        { id: 'raw-input', revision: 1, layer: 'history', text: source.toString('utf8'), sourceRefs: [`input:${contentHash}`] },
      ], ...(entities ? { entities: recall() } : {}) } });
    await port(false).call({ ...request, runId: 'baseline', callId: 'baseline-1' });
    await port(true).call(request);
    const baseline = adapter.calls[0]!; const indexed = adapter.calls[1]!;
    expect(messages(baseline)).not.toContain('Charger Seven'); expect(messages(indexed)).toContain('Charger Seven');
    expect(messages(indexed)).toContain(contentHash); expect(messages(indexed)).toContain('#/rows/7');
    expect(indexed.system).toContain('Preserve sandbox permissions'); expect(indexed.system).not.toContain('Charger Seven');
    expect(messages(indexed)).toContain('Check the source evidence for device-7.');
    expect(countRequestTokens(indexed) + 128 + 20).toBeLessThanOrEqual(1200);
    const entries = await retrieveEntityContext(recall(), request);
    console.info('P5-03 fixed controlled comparison', JSON.stringify({ sourceBytes: source.byteLength,
      recalledBytes: Buffer.byteLength(entries[0]!.text), baselineTargetRecall: '0/1', indexedTargetRecall: '1/1',
      baselineFinalDtoBytes: dtoBytes(baseline), indexedFinalDtoBytes: dtoBytes(indexed),
      baselineEstimatedInputTokens: countRequestTokens(baseline), indexedEstimatedInputTokens: countRequestTokens(indexed),
      syntheticUsagePerCall: 30, modelQualityOrCostBenefitMeasured: false }));
    const checkpoint = new ContextCheckpointStore(store, 'indexed').load()!;
    expect(checkpoint.entries.some(entry => entry.layer === 'entities')).toBe(false);
    expect(checkpoint.entries.filter(entry => entry.id.startsWith('role-history')).map(entry => JSON.stringify(entry)).join('')).not.toContain('Charger Seven');
    store.close(); store = new RuntimeStore(join(directory, 'runtime'));
    await port(true).call({ ...request, callId: 'indexed-2', role: 'reviewer' });
    expect(messages(adapter.calls[2]!)).toContain(contentHash);
    expect(await retrieveEntityContext(recall(), { ...request, runId: 'other' })).toEqual([]);
    document = { version: 'v1', content: Buffer.from('{"rows":[]}') };
    await port(true).call({ ...request, callId: 'bad-hash' });
    expect(messages(adapter.calls[3]!)).not.toContain('Charger Seven');
    document = { version: 'v2', content: Buffer.from('{"rows":[]}') }; makeIndex().setInputVersion('indexed', 'v2');
    await expect(port(true).call({ ...request, callId: 'stale' })).rejects.toBeInstanceOf(RoleNotDispatchedError);
    expect(adapter.calls).toHaveLength(4); queryVersion = 'v2';
    await port(true).call({ ...request, callId: 'new-input' });
    expect(messages(adapter.calls[4]!)).not.toContain('Charger Seven');
    const snapshot = await budget.snapshot(scopeKey);
    expect(snapshot).toMatchObject({ scopeKey, usedTokens: 150, reservedTokens: 0, unknownCalls: 0 });
    document = { version: 'v1', content: source }; makeIndex().setInputVersion('indexed', 'v1');
    // Returning to an earlier version label creates a new generation, never resurrecting the old fact.
    queryVersion = 'v1'; expect(await retrieveEntityContext(recall(), request)).toEqual([]);
    makeIndex().put({ runId: 'indexed', entityId: 'device-7', type: 'device', label: 'Charger Seven', attributes: { alerts: 3 },
      inputVersion: 'v1', evidence: [{ kind: 'input', id: 'input.json', version: 'v1', contentHash, locator: '#/rows/7' }], extraction: { kind: 'deterministic' } });
    await port(true, 450).call({ ...request, callId: 'tight-window' });
    expect(messages(adapter.calls[5]!)).not.toContain('Charger Seven');
    expect(messages(adapter.calls[5]!)).toContain('Check the source evidence for device-7.');
    expect(adapter.calls[5]!.system).toContain('Preserve sandbox permissions');
    expect(countRequestTokens(adapter.calls[5]!) + 128 + 20).toBeLessThanOrEqual(450);
    expect(await budget.snapshot(scopeKey)).toMatchObject({ scopeKey, usedTokens: 180, reservedTokens: 0, unknownCalls: 0 });
    const events = await budget.eventsAfter(0);
    expect(events.filter(event => event.type === 'reserve')).toHaveLength(6);
    expect(events.filter(event => event.type === 'settle')).toHaveLength(6);
  });
});
