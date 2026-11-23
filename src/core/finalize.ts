import { createHash } from 'node:crypto';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { estimateModelTokens } from '../adapters/harness/model-policy.js';
import { normalizeUsage, type BudgetEventReceipt, type BudgetSnapshot } from '../contracts/budget.js';
import { RuntimeError, TERMINAL_RUN_STATES } from '../contracts/runtime.js';
import type { RuntimeService } from './service.js';

/** Trusted host port. Generate must consume one original-budget automatic finalize call, without tools or retries. */
export interface FinalReportPort {
  prepare(runId: string): Pick<GenerateOptions, 'provider' | 'model' | 'sessionId' | 'messages' | 'system' | 'maxTokens'>;
  generate(request: Readonly<GenerateOptions>): Promise<string>;
}
export type FinalReportReason = 'disabled' | 'zero-allocation' | 'request-too-large' | 'unknown-usage'
  | 'previous-attempt' | 'unverified-accounting' | 'model-error' | 'generated' | 'run-not-active';
export interface FinalizationResult extends Awaited<ReturnType<RuntimeService['finalize']>> {
  reportReason: FinalReportReason;
  /** Optional, untrusted prose. Authoritative status and acceptance remain in run/report. */
  modelReport?: string;
}
interface ReportAttempt { schemaVersion: 1; requestHash: string; status: 'started' | 'settled' | 'unverified' }
const active = new WeakMap<RuntimeService['store'], Set<string>>();
const available = (allocation: BudgetSnapshot | BudgetSnapshot['finalize']) =>
  Math.max(0, allocation.limitTokens - allocation.usedTokens - allocation.reservedTokens);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function reportRequest(value: unknown, rootSessionId: string): Readonly<GenerateOptions> {
  const fields = new Set(['provider', 'model', 'sessionId', 'messages', 'system', 'maxTokens']);
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.has(key))) {
    throw new RuntimeError('INVALID_INPUT', 'Final report request contains unsupported fields');
  }
  // Check before JSON serialization: undefined fields, signals and callbacks must not disappear silently.
  const request = JSON.parse(JSON.stringify(value)) as GenerateOptions;
  if (typeof request.sessionId !== 'string' || request.sessionId !== rootSessionId
    || typeof request.provider !== 'string' || !request.provider.trim()
    || typeof request.model !== 'string' || !request.model.trim() || !Array.isArray(request.messages)
    || (request.system !== undefined && typeof request.system !== 'string')) {
    throw new RuntimeError('INVALID_INPUT', 'Final report must use the bound root session and a bounded text request');
  }
  return freeze(request);
}
function metered(receipts: BudgetEventReceipt[], request: Readonly<GenerateOptions>, estimate: number, scopeKey: string, after: number): boolean {
  const own = receipts.filter(event => event.scopeKey === scopeKey);
  const reserves = own.filter(event => event.type === 'reserve');
  if (reserves.length !== 1) return false;
  const reservation = reserves[0]!;
  const details = reservation.payload.request as Record<string, unknown> | undefined;
  const id = reservation.payload.reservationId;
  if (typeof id !== 'string' || !id || !details || details.purpose !== 'finalize' || details.scopeKey !== scopeKey
    || typeof details.modelCallId !== 'string' || !details.modelCallId.trim()
    || details.sessionId !== request.sessionId || details.provider !== request.provider || details.model !== request.model
    || details.estimatedTokens !== estimate) return false;
  // The original ledger reducer binds dispatch/settle to the immutable reserve subject by reservationId.
  // These events do not normally repeat modelCallId/sessionId; reject inconsistent metadata if supplied.
  const related = receipts.filter(event => event.payload.reservationId === id);
  if (related.map(event => event.type).join(',') !== 'reserve,dispatch,settle') return false;
  if (new Set(related.map(event => event.eventId)).size !== 3) return false;
  let cursor = after;
  for (const event of related) {
    if (event.scopeKey !== scopeKey || !event.eventId || !Number.isSafeInteger(event.cursor) || event.cursor <= cursor) return false;
    cursor = event.cursor;
    if ((event.payload.scopeKey !== undefined && event.payload.scopeKey !== scopeKey)
      || (event.payload.sessionId !== undefined && event.payload.sessionId !== details.sessionId)
      || (event.payload.modelCallId !== undefined && event.payload.modelCallId !== details.modelCallId)) return false;
  }
  try { normalizeUsage(related[2]!.payload.usage as Parameters<typeof normalizeUsage>[0]); }
  catch { return false; }
  return true;
}

/** Optional prose enhancement; no credit allocation, reservation, settlement or model retry occurs here. */
export class FinalizationCoordinator {
  constructor(private readonly service: RuntimeService, private readonly model?: FinalReportPort) {}

  async finalize(runId: string, complete: boolean): Promise<FinalizationResult> {
    const { store, budget } = this.service;
    let running = active.get(store);
    if (!running) { running = new Set(); active.set(store, running); }
    if (running.has(runId)) throw new RuntimeError('CONFLICT', 'Finalization is already active');
    running.add(runId);
    try {
      const run = store.getRun(runId);
      if (TERMINAL_RUN_STATES.has(run.status)) throw new RuntimeError('CONFLICT', 'Run is already terminal');
      const assertUnchanged = () => {
        const current = store.getRun(runId);
        if (current.revision !== run.revision || current.status !== run.status) {
          throw new RuntimeError('CONFLICT', 'Run changed during finalization; preserve its current state');
        }
      };
      let snapshot = await budget.snapshot(run.budgetScopeKey);
      assertUnchanged();
      let reason: FinalReportReason = 'disabled';
      let modelReport: string | undefined;
      let uncertain = snapshot.unknownCalls > 0 || !snapshot.meteringComplete;
      if (complete && !uncertain && run.status === 'RUNNING' && run.deadline > Date.now()) {
        await this.service.assertCompletionReady(runId);
        assertUnchanged();
      }
      const prior = store.getComponentState<ReportAttempt>(runId, 'finalization', 'report-attempt');
      if (prior && (prior.schemaVersion !== 1 || !['started', 'settled', 'unverified'].includes(prior.status)
        || typeof prior.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(prior.requestHash))) {
        throw new RuntimeError('VERSION_MISMATCH', 'Finalization report state requires explicit migration');
      }
      if (uncertain) reason = 'unknown-usage';
      else if (run.status !== 'RUNNING' || run.deadline <= Date.now()) reason = 'run-not-active';
      else if (prior) {
        reason = 'previous-attempt';
        // A crash after intent, even before reservation, cannot silently resend an optional model call.
        uncertain = prior.status !== 'settled';
      } else if (this.model) {
        if (available(snapshot.finalize) === 0) reason = 'zero-allocation';
        else {
          // Copy a JSON-only request before estimating. Generate receives that exact immutable payload.
          const request = reportRequest(this.model.prepare(runId), run.rootSessionId);
          const estimate = estimateModelTokens(request);
          if (await budget.scopeForSession(run.rootSessionId, { create: false }) !== run.budgetScopeKey) {
            throw new RuntimeError('CONFLICT', 'Final report budget scope changed');
          }
          snapshot = await budget.snapshot(run.budgetScopeKey);
          assertUnchanged();
          if (snapshot.unknownCalls || !snapshot.meteringComplete) { uncertain = true; reason = 'unknown-usage'; }
          else if (estimate > available(snapshot) || estimate > available(snapshot.finalize)) reason = 'request-too-large';
          else {
            const attempt: ReportAttempt = { schemaVersion: 1, status: 'started',
              requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
            store.transaction(() => {
              assertUnchanged();
              if (run.deadline <= Date.now()) throw new RuntimeError('EXECUTION_TIMEOUT', 'Final report deadline elapsed');
              if (store.getComponentState(runId, 'finalization', 'report-attempt')) throw new RuntimeError('CONFLICT', 'Another report attempt exists');
              store.setComponentState(runId, 'finalization', 'report-attempt', attempt);
              store.appendEvent(runId, 'finalization.report_intent', { requestHash: attempt.requestHash, estimatedTokens: estimate });
            });
            reason = 'model-error';
            try {
              const text = await this.model.generate(request);
              const receipts = await budget.eventsAfter(snapshot.ledgerSeq);
              if (!metered(receipts, request, estimate, run.budgetScopeKey, snapshot.ledgerSeq)) { uncertain = true; reason = 'unverified-accounting'; }
              else if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 65_536) reason = 'model-error';
              else { modelReport = text; reason = 'generated'; }
            } catch {
              // Do not retry a rejected, failed or interrupted model request, or expose provider error text.
              const receipts = await budget.eventsAfter(snapshot.ledgerSeq);
              uncertain = !metered(receipts, request, estimate, run.budgetScopeKey, snapshot.ledgerSeq);
            }
            snapshot = await budget.snapshot(run.budgetScopeKey);
            uncertain ||= snapshot.unknownCalls > 0 || !snapshot.meteringComplete;
            if (snapshot.unknownCalls || !snapshot.meteringComplete) reason = 'unknown-usage';
            store.setComponentState(runId, 'finalization', 'report-attempt', { ...attempt, status: uncertain ? 'unverified' : 'settled' });
          }
        }
      }
      // RuntimeService still verifies artifacts, unresolved executions and independent required acceptance.
      // Unknown/unverified model usage can produce explicit partial delivery, never complete success.
      assertUnchanged();
      const result = await this.service.finalize(runId, complete && !uncertain && run.status === 'RUNNING' && run.deadline > Date.now());
      store.appendEvent(runId, 'finalization.report_outcome', { reason, enhanced: modelReport !== undefined, complete: result.run.status === 'SUCCEEDED' });
      return { ...result, reportReason: reason, ...(modelReport === undefined ? {} : { modelReport }) };
    } finally { running.delete(runId); }
  }
}
