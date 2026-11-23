import { createHash } from 'node:crypto';
import { IdSchema, RuntimeError, type RunRecord } from '../contracts/runtime.js';
import type { RuntimeStore } from '../storage/index.js';

/** Stable JSON hashing; approvals are bound to exact normalized arguments. */
export function argumentHash(value: unknown): string {
  function canonical(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(canonical).join(',') + ']';
    if (typeof item === 'object' && item && Object.getPrototypeOf(item) === Object.prototype) {
      return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical((item as Record<string, unknown>)[key])).join(',') + '}';
    }
    throw new RuntimeError('INVALID_INPUT', 'Approval arguments must be finite JSON');
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export interface ApprovalRecord {
  version: 1; approvalId: string; runId: string; toolCallId: string;
  argumentsHash: string; reason: string; expiresAt: number; createdAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
  decisionId?: string; decidedAt?: number; consumedAt?: number;
}
export class ApprovalService {
  constructor(private readonly store: RuntimeStore, private readonly now: () => number = Date.now) {}
  list(runId: string): ApprovalRecord[] { return this.store.listComponentState(runId, 'approvals'); }
  get(runId: string, id: string): ApprovalRecord {
    const record = this.store.getComponentState<ApprovalRecord>(runId, 'approvals', id);
    if (!record) throw new RuntimeError('NOT_FOUND', 'Approval not found');
    return record;
  }
  request(input: { runId: string; approvalId: string; toolCallId: string; args: unknown; reason: string; ttlMs: number }): ApprovalRecord {
    IdSchema.parse(input.approvalId);
    if (!input.toolCallId || !input.reason || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new RuntimeError('INVALID_INPUT', 'Approval needs a reason and positive TTL');
    const argumentsHash = argumentHash(input.args);
    return this.store.transaction(() => {
      const prior = this.store.getComponentState<ApprovalRecord>(input.runId, 'approvals', input.approvalId);
      if (prior) {
        if (prior.argumentsHash !== argumentsHash || prior.toolCallId !== input.toolCallId) throw new RuntimeError('CONFLICT', 'Approval identity changed');
        return prior; // A rejection or expiry never creates another prompt automatically.
      }
      const run = this.store.getRun(input.runId);
      if (run.status !== 'RUNNING') throw new RuntimeError('CONFLICT', 'Approval requires a running task');
      if (this.store.listAttempts(input.runId).some(a => ['CREATED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'].includes(a.status))) throw new RuntimeError('CONFLICT', 'Reconcile active execution before waiting for approval');
      const record: ApprovalRecord = { version: 1, approvalId: input.approvalId, runId: input.runId,
        toolCallId: input.toolCallId, argumentsHash, reason: input.reason, createdAt: this.now(),
        expiresAt: Math.min(run.deadline, this.now() + input.ttlMs), status: 'pending' };
      this.store.setComponentState(input.runId, 'approvals', input.approvalId, record);
      this.store.transitionRun(input.runId, 'PAUSED_APPROVAL');
      this.store.appendEvent(input.runId, 'approval.requested', record);
      this.store.saveCheckpoint(input.runId);
      return record;
    });
  }
  decide(runId: string, id: string, decisionId: string, approved: boolean): ApprovalRecord {
    IdSchema.parse(decisionId);
    return this.store.transaction(() => {
      const record = this.get(runId, id);
      const desired = approved ? 'approved' : 'rejected';
      if (record.decisionId === decisionId) {
        if ((record.status === 'approved' || record.status === 'consumed') !== approved) throw new RuntimeError('CONFLICT', 'Decision ID reused with changed decision');
        return record;
      }
      if (record.status !== 'pending') throw new RuntimeError('CONFLICT', 'Approval was already decided');
      if (this.now() >= record.expiresAt) throw new RuntimeError('CONFLICT', 'Approval expired');
      if (this.store.getRun(runId).status !== 'PAUSED_APPROVAL') throw new RuntimeError('CONFLICT', 'Run no longer awaits this approval');
      const next = { ...record, status: desired, decisionId, decidedAt: this.now() } as ApprovalRecord;
      this.store.setComponentState(runId, 'approvals', id, next);
      this.store.appendEvent(runId, `approval.${desired}`, next);
      return next;
    });
  }
  /** Consume before dispatch. Crash after this point needs reconciliation, never an automatic second execution. */
  async consume(runId: string, id: string, args: unknown, assertHardLimits: (run: RunRecord) => Promise<void>): Promise<ApprovalRecord> {
    const run = this.store.getRun(runId);
    const hash = argumentHash(args);
    const record = this.get(runId, id);
    if (record.status !== 'approved' || record.argumentsHash !== hash || this.now() >= record.expiresAt) throw new RuntimeError('CONFLICT', 'Approval is unavailable, expired or parameters changed');
    await assertHardLimits(run); // Approval never relaxes budget, permissions, or deadline.
    return this.store.transaction(() => {
      const fresh = this.get(runId, id); const current = this.store.getRun(runId);
      if (fresh.status !== 'approved' || fresh.argumentsHash !== hash || this.now() >= fresh.expiresAt || this.now() >= current.deadline || current.revision !== run.revision || current.status !== 'PAUSED_APPROVAL') throw new RuntimeError('CONFLICT', 'Approval or task changed while validating');
      const consumed: ApprovalRecord = { ...fresh, status: 'consumed', consumedAt: this.now() };
      this.store.setComponentState(runId, 'approvals', id, consumed);
      this.store.appendEvent(runId, 'approval.consumed', consumed);
      this.store.transitionRun(runId, 'RUNNING', current.revision);
      this.store.saveCheckpoint(runId);
      return consumed;
    });
  }
}
