import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { RuntimeStore } from '../storage/index.js';
import { normalizeUsage, type BudgetPort } from '../contracts/budget.js';
import {
  assembleContext, contextFingerprint, countContextTokens, protectedContextIds, validateContextEntries,
  type ContextAssembly, type ContextEntry, type ContextWindow,
} from './assembler.js';
import { parseSummaryState, type SummaryCoverage, type SummaryPersistence, type SummaryState } from './summarizer.js';

const receiptSchema = z.strictObject({ eventId: z.string().min(1), reservationId: z.string().min(1), scopeKey: z.string().min(1) });
const coverageSchema = z.strictObject({
  schemaVersion: z.literal(1), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(z.strictObject({ id: z.string().min(1), revision: z.int().nonnegative(), sourceRefs: z.array(z.string().min(1)) })).min(1),
  beforeTokens: z.int().nonnegative(), afterTokens: z.int().nonnegative(), receipt: receiptSchema,
  usage: z.strictObject({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheReadTokens: z.int().nonnegative(), cacheWriteTokens: z.int().nonnegative() }),
});
const entriesSchema = z.array(z.unknown()).transform(value => {
  validateContextEntries(value as ContextEntry[]); return value as ContextEntry[];
});
const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), version: z.int().positive(), runId: z.string().min(1), rootSessionId: z.string().min(1),
  budgetScopeKey: z.string().min(1), inputHash: z.string().min(1), policyVersion: z.string().min(1),
  entries: entriesSchema, entriesFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summaryState: z.unknown().transform(parseSummaryState), coverages: z.array(coverageSchema),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ContextCheckpoint = z.infer<typeof snapshotSchema>;
export type VerifySummarySettlement = (coverage: SummaryCoverage) => Promise<boolean>;
/** Recheck a receipt against the owning ledger/session; never synthesize or debit usage. */
export function createSummarySettlementVerifier(budget: BudgetPort, sessionId: string, scopeKey: string): VerifySummarySettlement {
  return async coverage => {
    if (coverage.receipt.scopeKey !== scopeKey || await budget.scopeForSession(sessionId, { create: false }) !== scopeKey) return false;
    const events = await budget.eventsAfter(0);
    const reservation = events.find(event => event.type === 'reserve' && event.scopeKey === scopeKey && event.payload.reservationId === coverage.receipt.reservationId);
    const request = reservation?.payload.request;
    if (!request || typeof request !== 'object' || !('sessionId' in request) || request.sessionId !== sessionId) return false;
    const settlement = events.find(event => event.eventId === coverage.receipt.eventId && event.type === 'settle' && event.scopeKey === scopeKey
      && event.payload.reservationId === coverage.receipt.reservationId && event.cursor > reservation!.cursor);
    if (!settlement || !settlement.payload.usage || typeof settlement.payload.usage !== 'object') return false;
    const usage = settlement.payload.usage as Parameters<typeof normalizeUsage>[0];
    return isDeepStrictEqual(normalizeUsage(usage), normalizeUsage(coverage.usage));
  };
}
const emptyState = (): SummaryState => ({ schemaVersion: 1, policyVersion: 'context-summary-v1', attemptsTotal: 0, fingerprints: {} });
function digest(value: Omit<ContextCheckpoint, 'contentHash'>): string {
  const json = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en-US'))) : item);
  return createHash('sha256').update(json).digest('hex');
}
const same = isDeepStrictEqual;

/** Context-specific checkpoint in the existing SQLite component table. No ledger writes. */
export class ContextCheckpointStore {
  constructor(private readonly store: RuntimeStore, private readonly runId: string) {}

  load(): ContextCheckpoint | undefined {
    const raw = this.store.getComponentState<unknown>(this.runId, 'context', 'checkpoint');
    if (raw === undefined) return undefined;
    const value = snapshotSchema.parse(raw);
    const { contentHash, ...content } = value;
    if (digest(content) !== contentHash || contextFingerprint(value.entries) !== value.entriesFingerprint) throw new Error('Context checkpoint integrity mismatch');
    const run = this.store.getRun(this.runId);
    for (const key of ['runId', 'rootSessionId', 'budgetScopeKey', 'inputHash', 'policyVersion'] as const) {
      if (value[key] !== run[key]) throw new Error(`Context checkpoint ${key} binding changed`);
    }
    for (const coverage of value.coverages) {
      normalizeUsage(coverage.usage);
      if (coverage.receipt.scopeKey !== run.budgetScopeKey || coverage.afterTokens >= coverage.beforeTokens
        || value.summaryState.fingerprints[coverage.sourceFingerprint]?.status !== 'completed') throw new Error('Context summary coverage is inconsistent');
    }
    return structuredClone(value);
  }

  initialize(entries: readonly ContextEntry[]): ContextCheckpoint {
    validateContextEntries(entries);
    return this.store.transaction(() => {
      const old = this.load();
      if (old) {
        if (!same(old.entries, entries)) throw new Error('Context checkpoint already initialized with different entries');
        return old;
      }
      const run = this.store.getRun(this.runId);
      return this.save({ schemaVersion: 1, version: 1, runId: run.runId, rootSessionId: run.rootSessionId,
        budgetScopeKey: run.budgetScopeKey, inputHash: run.inputHash, policyVersion: run.policyVersion,
        entries: structuredClone([...entries]), entriesFingerprint: contextFingerprint(entries), summaryState: emptyState(), coverages: [] }, 'context.initialized');
    });
  }

  /** Add/update trusted context with compare-and-swap; unresolved compaction forbids replacement. */
  replace(expectedVersion: number, entries: readonly ContextEntry[]): ContextCheckpoint {
    validateContextEntries(entries);
    return this.store.transaction(() => {
      const current = this.expect(expectedVersion);
      if (Object.values(current.summaryState.fingerprints).some(item => item.status === 'pending')) throw new Error('Context has an unresolved summary attempt');
      const { contentHash: _hash, ...content } = current;
      return this.save({ ...content, version: current.version + 1, entries: structuredClone([...entries]), entriesFingerprint: contextFingerprint(entries) }, 'context.replaced');
    });
  }

  /** Recompute the assembly for the current window; never trust saved token counts. */
  async restore(window: ContextWindow, verifySettlement: VerifySummarySettlement): Promise<{ checkpoint: ContextCheckpoint; assembly: ContextAssembly }> {
    const checkpoint = this.expect();
    for (const coverage of checkpoint.coverages) {
      if (!await verifySettlement(structuredClone(coverage))) throw new Error('Context summary settlement is no longer verifiable');
    }
    // A verifier may await external ledger I/O; reject a concurrent context update.
    this.expect(checkpoint.version);
    return { checkpoint, assembly: assembleContext(checkpoint.entries, window) };
  }

  /** One invocation owns this adapter; stale adapters cannot overwrite newer context. */
  summaryPersistence(window: ContextWindow, verifySettlement: VerifySummarySettlement): SummaryPersistence {
    let version = this.expect().version;
    return {
      saveState: async next => {
        const state = parseSummaryState(next);
        const updated = this.store.transaction(() => {
          const current = this.expect(version);
          this.validateStateTransition(current.summaryState, state);
          if (Object.entries(state.fingerprints).some(([key, item]) => item.status === 'completed' && current.summaryState.fingerprints[key]?.status !== 'completed')) throw new Error('Completed summary requires an atomic context commit');
          const pending = Object.entries(state.fingerprints).find(([, item]) => item.status === 'pending');
          if (pending) {
            const fallback = assembleContext(current.entries, window);
            const compacted = current.entries.filter(entry => !fallback.dropped.some(drop => drop.id === entry.id && drop.reason === 'duplicate'));
            const protectedIds = protectedContextIds(compacted, window.protectRecentTools);
            const source = compacted.filter(entry => !protectedIds.has(entry.id) && ['history', 'tool', 'plan'].includes(entry.layer));
            if (contextFingerprint(source) !== pending[0]) throw new Error('Summary pending source does not match current context');
          }
          const { contentHash: _hash, ...content } = current;
          return this.save({ ...content, version: current.version + 1, summaryState: state }, 'context.summary-state');
        });
        version = updated.version;
      },
      commitSummary: async value => {
        const state = parseSummaryState(value.state);
        const coverage = coverageSchema.parse(value.coverage);
        normalizeUsage(coverage.usage);
        if (!await verifySettlement(structuredClone(coverage))) throw new Error('Summary requires a verified owning-budget settlement');
        const updated = this.store.transaction(() => {
          const current = this.expect(version);
          this.validateStateTransition(current.summaryState, state);
          if (coverage.receipt.scopeKey !== current.budgetScopeKey || current.coverages.some(item => item.receipt.reservationId === coverage.receipt.reservationId)) throw new Error('Summary receipt binding/reuse mismatch');
          const key = coverage.sourceFingerprint;
          if (current.summaryState.fingerprints[key]?.status !== 'pending' || state.fingerprints[key]?.status !== 'completed') throw new Error('Summary has no matching pending attempt');
          const fallback = assembleContext(current.entries, window);
          const compacted = current.entries.filter(entry => !fallback.dropped.some(drop => drop.id === entry.id && drop.reason === 'duplicate'));
          const protectedIds = protectedContextIds(compacted, window.protectRecentTools);
          const source = compacted.filter(entry => !protectedIds.has(entry.id) && ['history', 'tool', 'plan'].includes(entry.layer));
          if (contextFingerprint(source) !== key || !same(coverage.entries, source.map(entry => ({ id: entry.id, revision: entry.revision, sourceRefs: entry.sourceRefs })))) throw new Error('Summary source coverage changed');
          const expectedRefs = source.flatMap(entry => [`entry:${entry.id}@${entry.revision}`, ...entry.sourceRefs]);
          if (value.entry.layer !== 'summary' || value.entry.id !== `summary-${key}` || value.entry.revision !== 1 || !value.entry.text.trim()
            || value.entry.required || !same(value.entry.sourceRefs, expectedRefs)) throw new Error('Invalid summary replacement or provenance');
          const covered = new Set(source.map(entry => entry.id)); let inserted = false;
          const expected: ContextEntry[] = [];
          for (const entry of compacted) {
            if (!covered.has(entry.id)) expected.push(entry);
            else if (!inserted) { expected.push(value.entry); inserted = true; }
          }
          validateContextEntries(value.entries);
          if (!same(expected, value.entries) || countContextTokens(compacted, window) !== coverage.beforeTokens
            || countContextTokens(expected, window) !== coverage.afterTokens || coverage.afterTokens >= coverage.beforeTokens) throw new Error('Summary replacement changed protected context or token coverage');
          const { contentHash: _hash, ...content } = current;
          return this.save({ ...content, version: current.version + 1, entries: structuredClone(value.entries), entriesFingerprint: contextFingerprint(value.entries),
            summaryState: state, coverages: [...current.coverages, coverage] }, 'context.summarized');
        });
        version = updated.version;
      },
    };
  }

  private expect(version?: number): ContextCheckpoint {
    const current = this.load();
    if (!current) throw new Error('Context checkpoint is not initialized');
    if (version !== undefined && current.version !== version) throw new Error('Context checkpoint version conflict');
    return current;
  }
  private save(content: Omit<ContextCheckpoint, 'contentHash'>, event: string): ContextCheckpoint {
    const value = { ...content, contentHash: digest(content) };
    this.store.setComponentState(this.runId, 'context', 'checkpoint', value);
    this.store.appendEvent(this.runId, event, { version: value.version, entriesFingerprint: value.entriesFingerprint, attemptsTotal: value.summaryState.attemptsTotal });
    return structuredClone(value);
  }
  private validateStateTransition(previous: SummaryState, next: SummaryState): void {
    // Each write is either one new pending attempt or one terminal resolution.
    const added = Object.keys(next.fingerprints).filter(key => !previous.fingerprints[key]);
    const changed = Object.keys(previous.fingerprints).filter(key => !same(previous.fingerprints[key], next.fingerprints[key]));
    if (added.length + changed.length !== 1) throw new Error('Summary state must advance exactly one attempt');
    const key = (added[0] ?? changed[0])!; const old = previous.fingerprints[key]; const current = next.fingerprints[key];
    if (!current) throw new Error('Summary attempts cannot be removed');
    const newAttempt = current.status === 'pending' && old?.status !== 'pending' && current.attempts === (old?.attempts ?? 0) + 1
      && next.attemptsTotal === previous.attemptsTotal + 1 && !Object.values(previous.fingerprints).some(value => value.status === 'pending');
    const terminal = old?.status === 'pending' && current.status !== 'pending' && current.attempts === old.attempts && next.attemptsTotal === previous.attemptsTotal;
    if (!newAttempt && !terminal) throw new Error('Invalid summary attempt transition');
  }
}
