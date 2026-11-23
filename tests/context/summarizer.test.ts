import { describe, expect, it, vi } from 'vitest';
import { summarizeContext, type MeteredSummaryResult, type SummaryState } from '../../src/context/summarizer.js';
import type { BudgetControlPort, BudgetSnapshot } from '../../src/contracts/budget.js';
import type { ContextEntry, ContextMessage, ContextWindow } from '../../src/context/assembler.js';

const result = (): MeteredSummaryResult => ({
  text: 'Old attempts failed; input schema is now verified.',
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  receipt: { eventId: 'event-1', reservationId: 'reservation-1', scopeKey: 'root' },
});
function setup() {
  const allocation = { limitTokens: 10000, usedTokens: 0, reservedTokens: 0, availableTokens: 10000 };
  const snapshot: BudgetSnapshot = {
    ...allocation, scopeKey: 'root', ledgerSeq: 0, unknownCalls: 0, exhausted: false, meteringComplete: true,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, work: { ...allocation }, finalize: { ...allocation, limitTokens: 0, availableTokens: 0 },
  };
  const unused = () => { throw new Error('The context layer must not duplicate ledger writes'); };
  const budget: BudgetControlPort = {
    scopeForSession: () => 'root', snapshot: () => snapshot,
    reserve: unused, markDispatched: unused, settle: unused, releaseUnsent: unused, markUnknown: unused, allocate: unused,
    eventsAfter: () => [], withPurpose: (_session, _purpose, callback) => callback(), withCallIdentity: (_session, _id, callback) => callback(),
  };
  const entries: ContextEntry[] = [
    { id: 'system', revision: 1, layer: 'system', text: 'Do not change permissions', sourceRefs: [] },
    { id: 'task', revision: 1, layer: 'task', text: 'Compute required metric', sourceRefs: ['task:1'] },
    { id: 'history', revision: 1, layer: 'history', text: 'old failed attempt '.repeat(80), sourceRefs: ['log:1'] },
    { id: 'recent', revision: 1, layer: 'tool', toolName: 'python', callId: 'recent-call', arguments: '{}', result: 'schema valid', sourceRefs: ['check:1'] },
  ];
  const countTokens = (messages: readonly ContextMessage[]) => messages.reduce((sum, item) => sum + item.content.length + (item.toolCall?.arguments.length ?? 0) + 1, 0);
  const window: ContextWindow = { modelWindowTokens: 2500, outputReserveTokens: 100, safetyReserveTokens: 10, countTokens, protectRecentTools: 1 };
  const summarize = vi.fn().mockResolvedValue(result());
  const saveState = vi.fn().mockResolvedValue(undefined);
  const commitSummary = vi.fn().mockResolvedValue(undefined);
  return {
    input: {
      entries, window, sessionId: 'session-1', scopeKey: 'root', budget, model: { summarize },
      persistence: { saveState, commitSummary }, options: { triggerRatio: 0.5, maxOutputTokens: 100, countRequestTokens: () => 300 },
    },
    snapshot, summarize, saveState, commitSummary,
  };
}

describe('bounded summary and fallback', () => {
  it('persists pending attempt before dispatch and commits provenance with protected context intact', async () => {
    const { input, summarize, saveState, commitSummary } = setup();
    const outcome = await summarizeContext(input);
    expect(outcome.status).toBe('summarized');
    expect(saveState.mock.invocationCallOrder[0]).toBeLessThan(summarize.mock.invocationCallOrder[0]!);
    expect(commitSummary).toHaveBeenCalledTimes(1);
    expect(outcome.coverage).toMatchObject({ entries: [{ id: 'history', revision: 1, sourceRefs: ['log:1'] }], receipt: result().receipt, usage: result().usage });
    expect(outcome.assembly.retained.map(item => item.layer)).toEqual(['system', 'task', 'summary', 'tool']);
    expect(outcome.assembly.messages.filter(item => item.role === 'system')).toHaveLength(1);
    expect(summarize.mock.calls[0]![0].estimatedTokens).toBe(400);
    expect(outcome.state.attemptsTotal).toBe(1);
    const dispatched = saveState.mock.calls[0]![0] as SummaryState;
    expect(Object.values(dispatched.fingerprints)[0]!.status).toBe('pending');
  });

  it('falls back deterministically without a model call when budget is unknown or insufficient', async () => {
    for (const kind of ['unknown', 'insufficient'] as const) {
      const { input, snapshot, summarize, saveState } = setup();
      if (kind === 'unknown') snapshot.unknownCalls = 1;
      else snapshot.work.limitTokens = 399;
      const outcome = await summarizeContext(input);
      expect(outcome.reason).toBe('BUDGET_UNAVAILABLE');
      expect(outcome.assembly.status).toBe('ready');
      expect(summarize).not.toHaveBeenCalled();
      expect(saveState).not.toHaveBeenCalled();
    }
  });

  it('deduplicates first and skips a now-unnecessary model summary', async () => {
    const { input, summarize } = setup();
    input.entries = [
      { id: 'a', revision: 1, layer: 'history', text: 'same'.repeat(50), sourceRefs: [] },
      { id: 'b', revision: 1, layer: 'history', text: 'same'.repeat(50), sourceRefs: [] },
    ];
    input.options.triggerRatio = 0.12;
    const outcome = await summarizeContext(input);
    expect(outcome.status).toBe('not-needed');
    expect(outcome.assembly.dropped).toEqual([{ id: 'a', reason: 'duplicate' }]);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('does not retry an unresolved pending attempt after a crash/restart', async () => {
    const { input, saveState, summarize } = setup();
    await summarizeContext(input);
    const pending = JSON.parse(JSON.stringify(saveState.mock.calls[0]![0])) as SummaryState;
    summarize.mockClear();
    const again = await summarizeContext({ ...input, priorState: pending });
    expect(again.reason).toBe('UNRESOLVED_ATTEMPT');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('limits failed/no-benefit retries across JSON state restoration', async () => {
    for (const kind of ['failed', 'longer'] as const) {
      const { input, summarize } = setup();
      if (kind === 'failed') summarize.mockRejectedValue(new Error('provider unavailable'));
      else summarize.mockResolvedValue({ ...result(), text: 'unhelpfully long '.repeat(500) });
      const first = await summarizeContext(input);
      expect(first.reason).toBe(kind === 'failed' ? 'SUMMARY_FAILED' : 'NO_BENEFIT');
      const second = await summarizeContext({ ...input, priorState: JSON.parse(JSON.stringify(first.state)) as SummaryState });
      expect(second.reason).toBe('ATTEMPT_LIMIT');
      expect(summarize).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds total attempts even if every failure changes source content', async () => {
    const { input, summarize } = setup();
    summarize.mockRejectedValue(new Error('provider unavailable'));
    const first = await summarizeContext({ ...input, options: { ...input.options, maxAttemptsTotal: 1 } });
    input.entries = input.entries.map(item => item.layer === 'history' ? { ...item, text: item.text + 'changed', revision: 2 } : item);
    const second = await summarizeContext({ ...input, priorState: first.state, options: { ...input.options, maxAttemptsTotal: 1 } });
    expect(second.reason).toBe('ATTEMPT_LIMIT');
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch if the pending-attempt durable write fails', async () => {
    const { input, summarize, saveState } = setup();
    saveState.mockRejectedValue(new Error('disk unavailable'));
    await expect(summarizeContext(input)).rejects.toThrow('disk unavailable');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('does not return successful compaction if atomic replacement commit fails', async () => {
    const { input, commitSummary, saveState } = setup();
    commitSummary.mockRejectedValue(new Error('commit interrupted'));
    await expect(summarizeContext(input)).rejects.toThrow('commit interrupted');
    const durable = saveState.mock.calls[0]![0] as SummaryState;
    expect(Object.values(durable.fingerprints)[0]!.status).toBe('pending');
  });

  it('declines requests that do not fit their own input-plus-output window', async () => {
    const { input, summarize } = setup();
    input.options.countRequestTokens = () => 2400;
    expect((await summarizeContext(input)).reason).toBe('REQUEST_TOO_LARGE');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('rejects incorrect budget lineage and unmetered summary receipts', async () => {
    const { input, summarize } = setup();
    input.budget.scopeForSession = () => 'other-root';
    await expect(summarizeContext(input)).rejects.toThrow(/binding changed/);
    expect(summarize).not.toHaveBeenCalled();
    input.budget.scopeForSession = () => 'root';
    summarize.mockResolvedValue({ ...result(), receipt: { ...result().receipt, scopeKey: 'other-root' } });
    expect((await summarizeContext(input)).reason).toBe('SUMMARY_FAILED');
  });
});
