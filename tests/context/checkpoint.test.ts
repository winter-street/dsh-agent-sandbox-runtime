import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import { ContextCheckpointStore, createSummarySettlementVerifier } from '../../src/context/checkpoint.js';
import { summarizeContext, type SummaryState } from '../../src/context/summarizer.js';
import { contextFingerprint, type ContextEntry, type ContextWindow } from '../../src/context/assembler.js';
import { FakeBudget } from '../support/fakes.js';

const roots: string[] = []; const stores = new Set<RuntimeStore>();
afterEach(() => { vi.restoreAllMocks(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'context-checkpoint-')); roots.push(root);
  const store = new RuntimeStore(root); stores.add(store);
  const run = { runId: 'run', rootSessionId: 'session', budgetScopeKey: 'scope', inputHash: 'a'.repeat(64), policyVersion: 'v1', task: 'Rank chargers by alert count, descending; output CSV', deadline: Date.now() + 100000 };
  store.createRun(run);
  const entries: ContextEntry[] = [
    { id: 'system', revision: 1, layer: 'system', text: 'Keep sandbox permissions unchanged', sourceRefs: [] },
    { id: 'task', revision: 1, layer: 'task', text: run.task, sourceRefs: ['input:charging-fixture@1'] },
    { id: 'artifacts', revision: 1, layer: 'artifacts', text: 'verified-input.csv sha256:abc', sourceRefs: ['artifact:input@1'] },
    ...Array.from({ length: 12 }, (_, i): ContextEntry => ({ id: `history-${i}`, revision: 1, layer: 'history', text: `Attempt ${i}: diagnostic log ` + 'detail '.repeat(25), sourceRefs: [`log:${i}`] })),
    { id: 'recent', revision: 1, layer: 'tool', callId: 'check-schema', toolName: 'python', arguments: '{}', result: 'verified schema: charger_id, alert_count', sourceRefs: ['check:schema@1'] },
  ];
  const window: ContextWindow = { modelWindowTokens: 4000, outputReserveTokens: 200, safetyReserveTokens: 20, protectRecentTools: 1,
    countTokens: messages => messages.reduce((sum, message) => sum + message.content.length + (message.toolCall?.arguments.length ?? 0) + 1, 0) };
  const repository = new ContextCheckpointStore(store, 'run'); repository.initialize(entries);
  const budget = new FakeBudget({ scopeKey: 'scope', sessionIds: ['session'], limitTokens: 10000 });
  const verify = vi.fn(createSummarySettlementVerifier(budget, 'session', 'scope'));
  const model = { summarize: vi.fn(async (request: { estimatedTokens: number }) => {
    const decision = budget.reserve({ sessionId: 'session', scopeKey: 'scope', modelCallId: `summary-${budget.events.length}`, provider: 'fixture', model: 'fixture', purpose: 'work', estimatedTokens: request.estimatedTokens });
    if (!decision.allowed) throw new Error('Fixture budget rejected');
    budget.markDispatched(decision.reservation.reservationId);
    const usage = { inputTokens: 200, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 20 };
    budget.settle(decision.reservation.reservationId, usage);
    return { text: 'Prior diagnostics completed. Input schema verified; retain descending ranking, CSV output and evidence references.', usage,
      receipt: { eventId: budget.events.at(-1)!.eventId, reservationId: decision.reservation.reservationId, scopeKey: 'scope' } };
  }) };
  const input = { entries, window, sessionId: 'session', scopeKey: 'scope', budget, model,
    persistence: repository.summaryPersistence(window, verify), options: { triggerRatio: 0.5, maxOutputTokens: 100, countRequestTokens: () => 600 } };
  return { root, store, run, entries, repository, window, budget, verify, model, input };
}
function reopen(root: string, old: RuntimeStore): RuntimeStore { old.close(); stores.delete(old); const store = new RuntimeStore(root); stores.add(store); return store; }

describe('durable context compaction and recovery', () => {
  it('restores compacted long context, constraints, sources and metered usage after database reopen', async () => {
    const t = setup(); const before = t.repository.load()!;
    const result = await summarizeContext(t.input); expect(result.status).toBe('summarized');
    expect(t.budget.snapshot('scope')).toMatchObject({ usedTokens: 225, reservedTokens: 0, unknownCalls: 0 });
    const reopened = new ContextCheckpointStore(reopen(t.root, t.store), 'run');
    const restored = await reopened.restore(t.window, t.verify);
    expect(restored.assembly.status).toBe('ready');
    expect(restored.checkpoint.version).toBe(3); expect(restored.checkpoint.summaryState.attemptsTotal).toBe(1);
    for (const id of ['system', 'task', 'artifacts', 'recent']) expect(restored.checkpoint.entries.find(entry => entry.id === id)).toEqual(before.entries.find(entry => entry.id === id));
    expect(restored.checkpoint.coverages[0]?.entries).toHaveLength(12);
    expect(restored.checkpoint.coverages[0]?.usage).toEqual({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 });
    expect(restored.checkpoint.entriesFingerprint).toBe(contextFingerprint(restored.checkpoint.entries));
    expect(t.model.summarize).toHaveBeenCalledTimes(1);
    // A different model window is recomputed on restore; required evidence pauses intact.
    const narrow = await reopened.restore({ ...t.window, modelWindowTokens: 230 }, t.verify);
    expect(narrow.assembly.status).toBe('paused'); expect(narrow.assembly.reason).toBe('REQUIRED_CONTEXT_TOO_LARGE');
    expect(narrow.assembly.retained.filter(entry => ['task', 'system', 'artifacts', 'tool'].includes(entry.layer))).toHaveLength(4);
  });
  it('retains durable pending state on commit interruption and does not retry after changed history', async () => {
    const t = setup();
    const commit = t.input.persistence.commitSummary;
    t.input.persistence.commitSummary = async value => { void value; throw new Error('commit interrupted'); };
    await expect(summarizeContext(t.input)).rejects.toThrow('commit interrupted');
    t.input.persistence.commitSummary = commit;
    const repo = new ContextCheckpointStore(reopen(t.root, t.store), 'run'); const current = repo.load()!;
    expect(current.entries).toEqual(t.entries); expect(Object.values(current.summaryState.fingerprints)[0]?.status).toBe('pending');
    expect(() => repo.replace(current.version, t.entries)).toThrow('unresolved');
    const second = await summarizeContext({ ...t.input, entries: [...t.entries, { id: 'new', revision: 1, layer: 'history', text: 'changed source', sourceRefs: [] }], priorState: current.summaryState, persistence: repo.summaryPersistence(t.window, t.verify) });
    expect(second.reason).toBe('UNRESOLVED_ATTEMPT'); expect(t.model.summarize).toHaveBeenCalledTimes(1);
    expect(t.budget.snapshot('scope').usedTokens).toBe(225);
  });
  it('rejects corruption and checkpoints copied from another run', () => {
    const t = setup(); const checkpoint = t.repository.load()!;
    t.store.setComponentState('run', 'context', 'checkpoint', { ...checkpoint, entriesFingerprint: 'b'.repeat(64) });
    expect(() => t.repository.load()).toThrow('integrity');
    t.store.createRun({ ...t.run, runId: 'foreign' }); t.store.setComponentState('foreign', 'context', 'checkpoint', checkpoint);
    expect(() => new ContextCheckpointStore(t.store, 'foreign').load()).toThrow('runId binding');
  });
  it('rejects stale writers before model dispatch and versions every trusted replacement', async () => {
    const t = setup(); const checkpoint = t.repository.load()!;
    const next = t.repository.replace(checkpoint.version, [...t.entries, { id: 'new', revision: 1, layer: 'history', text: 'new diagnostic', sourceRefs: [] }]);
    expect(next.version).toBe(2);
    expect(() => t.repository.replace(checkpoint.version, t.entries)).toThrow('version conflict');
    await expect(summarizeContext(t.input)).rejects.toThrow('version conflict'); expect(t.model.summarize).not.toHaveBeenCalled();
  });
  it('rejects dishonest provenance or altered protected evidence before committing replacement', async () => {
    for (const kind of ['provenance', 'task'] as const) {
      const t = setup(); const commit = t.input.persistence.commitSummary;
      t.input.persistence.commitSummary = value => {
        const bad = structuredClone(value);
        if (kind === 'provenance') bad.entry.sourceRefs = [];
        else { const task = bad.entries.find(entry => entry.layer === 'task')!; if (task.layer !== 'tool') task.text = 'replace constraints'; }
        return commit(bad);
      };
      await expect(summarizeContext(t.input)).rejects.toThrow(kind === 'provenance' ? 'provenance' : 'protected context');
      expect(t.repository.load()!.entries).toEqual(t.entries);
    }
  });
  it('requires verifiable settlements when committing or restoring summaries', async () => {
    const t = setup(); const original = t.verify.getMockImplementation()!;
    t.verify.mockResolvedValue(false);
    await expect(summarizeContext(t.input)).rejects.toThrow('verified owning-budget');
    expect(t.repository.load()!.entries).toEqual(t.entries);
    const other = setup(); await summarizeContext(other.input); other.verify.mockResolvedValue(false);
    await expect(other.repository.restore(other.window, other.verify)).rejects.toThrow('no longer verifiable');
    t.verify.mockImplementation(original);
  });
  it('rejects a concurrent context replacement while an asynchronous receipt verifier is pending', async () => {
    const t = setup(); await summarizeContext(t.input);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const restore = t.repository.restore(t.window, async () => { await gate; return true; });
    const current = t.repository.load()!;
    t.repository.replace(current.version, current.entries);
    release();
    await expect(restore).rejects.toThrow('version conflict');
  });
  it('checks receipt usage, owning session, scope and reservation against the ledger', async () => {
    const t = setup(); await summarizeContext(t.input);
    const coverage = t.repository.load()!.coverages[0]!;
    expect(await t.verify(coverage)).toBe(true);
    expect(await t.verify({ ...coverage, usage: { ...coverage.usage, inputTokens: 0 } })).toBe(false);
    expect(await t.verify({ ...coverage, receipt: { ...coverage.receipt, reservationId: 'invented' } })).toBe(false);
    expect(await t.verify({ ...coverage, receipt: { ...coverage.receipt, scopeKey: 'other-scope' } })).toBe(false);
    const events = await t.budget.eventsAfter(0);
    const reservation = events.find(event => event.type === 'reserve')!;
    (reservation.payload.request as { sessionId: string }).sessionId = 'other-session';
    vi.spyOn(t.budget, 'eventsAfter').mockResolvedValue(events);
    expect(await t.verify(coverage)).toBe(false);
  });
  it('rolls back state and event together when durable event publication fails', () => {
    const t = setup(); const checkpoint = t.repository.load()!; const seq = t.store.latestEventSeq('run');
    vi.spyOn(t.store, 'appendEvent').mockImplementation(() => { throw new Error('event disk failed'); });
    expect(() => t.repository.replace(checkpoint.version, t.entries)).toThrow('event disk failed');
    expect(t.repository.load()).toEqual(checkpoint); expect(t.store.latestEventSeq('run')).toBe(seq);
  });
  it('rejects summary state count tampering and pending-source mismatches before dispatch', async () => {
    const t = setup(); const fake: SummaryState = { schemaVersion: 1, policyVersion: 'context-summary-v1', attemptsTotal: 0, fingerprints: { ['a'.repeat(64)]: { attempts: 1, status: 'failed' } } };
    await expect(summarizeContext({ ...t.input, priorState: fake })).rejects.toThrow('counts');
    await expect(summarizeContext({ ...t.input, entries: t.entries.map(entry => entry.layer === 'history' ? { ...entry, text: entry.text + 'tamper' } : entry) })).rejects.toThrow('pending source');
    expect(t.model.summarize).not.toHaveBeenCalled(); expect(t.repository.load()!.version).toBe(1);
  });
});
