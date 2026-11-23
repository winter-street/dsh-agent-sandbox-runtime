import type { RuntimeStore } from '../storage/index.js';
import { ToolRuleEngine, type ToolRuleAction, type ToolRuleDecision, type ToolRuleState } from '../policy/tool-rules.js';
import type { ToolCallReceipt, ToolCallResult, ToolCallStore } from './registry.js';

interface DurableToolCall { schemaVersion: 1; receipt: ToolCallReceipt; result?: ToolCallResult }
export class DurableToolCallStore implements ToolCallStore {
  constructor(private readonly store: RuntimeStore) {}
  async claim(receipt: ToolCallReceipt) {
    return this.store.transaction(() => {
      this.store.getRun(receipt.runId);
      const old = this.store.getComponentState<DurableToolCall>(receipt.runId, 'tool-calls', receipt.callId);
      if (old) {
        if (old.schemaVersion !== 1) throw new Error('Unsupported tool-call state version');
        if (old.receipt.requestHash !== receipt.requestHash) return { kind: 'conflict' as const };
        return old.result ? { kind: 'result' as const, result: old.result } : { kind: 'pending' as const };
      }
      this.store.setComponentState(receipt.runId, 'tool-calls', receipt.callId, { schemaVersion: 1, receipt } satisfies DurableToolCall);
      this.store.appendEvent(receipt.runId, 'tool.claimed', receipt);
      return { kind: 'new' as const };
    });
  }
  async complete(receipt: ToolCallReceipt, result: ToolCallResult): Promise<void> {
    this.store.transaction(() => {
      const old = this.store.getComponentState<DurableToolCall>(receipt.runId, 'tool-calls', receipt.callId);
      if (!old || old.schemaVersion !== 1 || old.receipt.requestHash !== receipt.requestHash || old.result) throw new Error('Tool completion conflicts with durable claim');
      this.store.setComponentState(receipt.runId, 'tool-calls', receipt.callId, { ...old, result });
      this.store.appendEvent(receipt.runId, 'tool.completed', result);
    });
  }
}

/** Admission counters and feedback are committed together; rejected calls do not consume quota. */
export class DurableToolRules {
  constructor(private readonly store: RuntimeStore, private readonly engine: ToolRuleEngine) {}
  admit(runId: string, action: ToolRuleAction): ToolRuleDecision {
    return this.store.transaction(() => {
      this.store.getRun(runId);
      const old = this.store.getComponentState<ToolRuleState>(runId, 'tool-policy', 'state');
      const decision = this.engine.admit(action, old);
      this.store.setComponentState(runId, 'tool-policy', 'state', decision.state);
      if (!old?.admissions[action.callId]) this.store.appendEvent(runId, 'tool.policy-admission', { callId: action.callId, toolName: action.toolName, allowed: decision.allowed, reason: decision.reason ?? null });
      for (const notification of decision.notifications) this.store.appendEvent(runId, 'tool.policy-notice', notification);
      return decision;
    });
  }
  record(runId: string, action: ToolRuleAction, outcome: { ok: boolean; errorSignature?: string; progressVersion: string }): ToolRuleDecision {
    return this.store.transaction(() => {
      const old = this.store.getComponentState<ToolRuleState>(runId, 'tool-policy', 'state');
      if (!old) throw new Error('Missing durable tool admission');
      const decision = this.engine.record(action, outcome, old);
      this.store.setComponentState(runId, 'tool-policy', 'state', decision.state);
      if (!old.outcomes[action.callId]) this.store.appendEvent(runId, 'tool.policy-outcome', { callId: action.callId, ok: outcome.ok, progressVersion: outcome.progressVersion });
      for (const notification of decision.notifications) this.store.appendEvent(runId, 'tool.policy-notice', notification);
      return decision;
    });
  }
}
