import { createHash } from 'node:crypto';
import type { BudgetEventReceipt, BudgetPort } from '../../contracts/budget.js';
import type { RuntimeStore } from '../../storage/index.js';
import { RuntimeError } from '../../contracts/runtime.js';

type ReceiptStore = Pick<RuntimeStore, 'transaction' | 'getRun' | 'getComponentState' | 'setComponentState' | 'appendEvent'>;
interface CursorState { schemaVersion: 1; ledgerId: string; scopeKey: string; cursor: number; anchorHash: string | null }
interface SeenReceipt { eventId: string; contentHash: string; firstCursor: number }
export interface ReceiptSyncResult { cursor: number; imported: number; scanned: number }

function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validate(receipt: BudgetEventReceipt): void {
  if (!Number.isSafeInteger(receipt.cursor) || receipt.cursor < 1 || !receipt.eventId || !receipt.scopeKey || !receipt.type
    || receipt.payload === null || typeof receipt.payload !== 'object' || Array.isArray(receipt.payload)) {
    throw new RuntimeError('INVALID_INPUT', 'Malformed budget event receipt');
  }
}
function contentHash(receipt: BudgetEventReceipt): string {
  return fingerprint({ eventId: receipt.eventId, scopeKey: receipt.scopeKey, type: receipt.type, payload: receipt.payload });
}

/** Replays accounting notifications only. It never copies or reconstructs a balance. */
export class BudgetReceiptSynchronizer {
  private readonly key: string;
  private readonly pending = new Map<string, Promise<ReceiptSyncResult>>();
  constructor(private readonly store: ReceiptStore, private readonly budget: Pick<BudgetPort, 'eventsAfter'>, readonly ledgerId: string) {
    if (!ledgerId.trim()) throw new TypeError('A stable budget ledger identity is required');
    this.key = fingerprint(ledgerId);
  }
  sync(runId: string): Promise<ReceiptSyncResult> {
    const ongoing = this.pending.get(runId);
    if (ongoing) return ongoing;
    const promise = this.syncOnce(runId).finally(() => { this.pending.delete(runId); });
    this.pending.set(runId, promise);
    return promise;
  }
  private async syncOnce(runId: string): Promise<ReceiptSyncResult> {
    const run = this.store.getRun(runId);
    const before = this.store.getComponentState<CursorState>(runId, 'budget-cursor', this.key) ?? {
      schemaVersion: 1 as const, ledgerId: this.ledgerId, scopeKey: run.budgetScopeKey, cursor: 0, anchorHash: null,
    };
    if (before.schemaVersion !== 1 || before.ledgerId !== this.ledgerId || before.scopeKey !== run.budgetScopeKey
      || !Number.isSafeInteger(before.cursor) || before.cursor < 0) throw new RuntimeError('VERSION_MISMATCH', 'Budget cursor binding changed');
    // Re-read the last imported position as an anchor. A truncated/replaced ledger must not reset the cursor.
    const receipts = await this.budget.eventsAfter(Math.max(0, before.cursor - 1));
    let offset = 0;
    if (before.cursor > 0) {
      const anchor = receipts[0];
      if (!anchor || anchor.cursor !== before.cursor || fingerprint(anchor) !== before.anchorHash) {
        throw new RuntimeError('VERSION_MISMATCH', 'Budget ledger anchor changed or disappeared; explicit reconciliation required');
      }
      offset = 1;
    }
    let expected = before.cursor + 1;
    for (const receipt of receipts.slice(offset)) {
      validate(receipt);
      if (receipt.cursor !== expected++) throw new RuntimeError('VERSION_MISMATCH', 'Budget receipt cursor gap or out-of-order delivery');
    }
    return this.store.transaction(() => {
      const current = this.store.getComponentState<CursorState>(runId, 'budget-cursor', this.key);
      if (current && fingerprint(current) !== fingerprint(before)) throw new RuntimeError('CONFLICT', 'Another synchronizer advanced this budget cursor');
      if (this.store.getRun(runId).budgetScopeKey !== before.scopeKey) throw new RuntimeError('CONFLICT', 'Run budget scope changed during replay');
      let imported = 0;
      const next = { ...before };
      for (const receipt of receipts.slice(offset)) {
        if (receipt.scopeKey === before.scopeKey) {
          const identity = fingerprint([this.ledgerId, receipt.eventId]);
          const hash = contentHash(receipt);
          const previous = this.store.getComponentState<SeenReceipt>(runId, 'budget-receipt', identity);
          if (previous && previous.contentHash !== hash) throw new RuntimeError('CONFLICT', 'Budget event identity has conflicting content');
          if (!previous) {
            this.store.setComponentState(runId, 'budget-receipt', identity, { eventId: receipt.eventId, contentHash: hash, firstCursor: receipt.cursor } satisfies SeenReceipt);
            const request = receipt.payload.request;
            const requestCallId = request && typeof request === 'object' ? (request as Record<string, unknown>).modelCallId : undefined;
            const callId = typeof requestCallId === 'string' ? requestCallId : typeof receipt.payload.callId === 'string' ? receipt.payload.callId : undefined;
            this.store.appendEvent(runId, 'budget.receipt', {
              ledgerId: this.ledgerId, ledgerSeq: receipt.cursor, receiptEventId: receipt.eventId,
              budgetScopeKey: receipt.scopeKey, eventType: receipt.type,
              ...(typeof receipt.payload.reservationId === 'string' ? { reservationId: receipt.payload.reservationId } : {}),
              ...(callId === undefined ? {} : { modelCallId: callId }),
            }, `budget-${fingerprint([runId, this.ledgerId, receipt.eventId])}`);
            imported++;
          }
        }
        // The ledger cursor is global: advance through unrelated scopes without leaking their payload.
        next.cursor = receipt.cursor; next.anchorHash = fingerprint(receipt);
      }
      this.store.setComponentState(runId, 'budget-cursor', this.key, next);
      return { cursor: next.cursor, imported, scanned: receipts.length - offset };
    });
  }
}
