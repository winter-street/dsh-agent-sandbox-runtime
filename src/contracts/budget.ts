/** Structural service contract. The budget plugin owns the ledger and writes. */
export type BudgetPurpose = 'work' | 'finalize';
export interface NormalizedUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
export type ReservationStatus = 'reserved' | 'dispatched' | 'settled' | 'released_unsent' | 'unknown';
export interface ReservationRequest {
  scopeKey: string;
  modelCallId: string;
  sessionId: string;
  provider: string;
  model: string;
  purpose: BudgetPurpose;
  estimatedTokens: number;
}
export interface BudgetReservation extends ReservationRequest {
  reservationId: string;
  status: ReservationStatus;
  usage?: NormalizedUsage;
  reason?: string;
}
export interface BudgetAllocation {
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
  availableTokens: number;
}
export interface BudgetSnapshot extends BudgetAllocation {
  scopeKey: string;
  ledgerSeq: number;
  unknownCalls: number;
  exhausted: boolean;
  meteringComplete: boolean;
  usage: NormalizedUsage;
  work: BudgetAllocation;
  finalize: BudgetAllocation;
}
export type ReservationDecision =
  | { allowed: true; reservation: BudgetReservation; replayed: boolean }
  | { allowed: false; reason: 'BUDGET_UNAVAILABLE' | 'USAGE_UNKNOWN' | 'CONCURRENT_LIMIT'; snapshot: BudgetSnapshot };
export interface BudgetEventReceipt {
  cursor: number;
  eventId: string;
  scopeKey: string;
  type: string;
  payload: Readonly<Record<string, unknown>>;
}
type MaybePromise<T> = T | Promise<T>;
export interface BudgetPort {
  scopeForSession(sessionId: string, options?: { create?: boolean }): MaybePromise<string>;
  snapshot(scopeKey: string): MaybePromise<BudgetSnapshot>;
  reserve(request: ReservationRequest): MaybePromise<ReservationDecision>;
  markDispatched(reservationId: string): MaybePromise<void>;
  settle(reservationId: string, usage: NormalizedUsage): MaybePromise<void>;
  releaseUnsent(reservationId: string, reason: string): MaybePromise<void>;
  markUnknown(reservationId: string, reason: string): MaybePromise<void>;
  eventsAfter(cursor: number): MaybePromise<BudgetEventReceipt[]>;
}
/** Operator/host-only extension. Never expose these methods as model tools. */
export interface BudgetControlPort extends BudgetPort {
  allocate(scopeKey: string, finalizeTokens: number, reason: string): MaybePromise<void>;
  withPurpose<T>(sessionId: string, purpose: BudgetPurpose, callback: () => T): T;
  withCallIdentity<T>(sessionId: string, modelCallId: string, callback: () => T): T;
}

/** Providers must supply disjoint buckets; reasoning is already in output. */
export function normalizeUsage(value: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): NormalizedUsage {
  const usage: NormalizedUsage = {
    inputTokens: value.inputTokens,
    cacheReadTokens: value.cacheReadTokens ?? 0,
    cacheWriteTokens: value.cacheWriteTokens ?? 0,
    outputTokens: value.outputTokens,
  };
  for (const [key, count] of Object.entries(usage)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(`Invalid usage.${key}`);
  }
  if (!Number.isSafeInteger(Object.values(usage).reduce((a, b) => a + b, 0))) {
    throw new TypeError('Usage total exceeds safe integer range');
  }
  return usage;
}
