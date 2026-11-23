import { z } from 'zod';
import { jsonHash } from '../tools/registry.js';

export interface ToolRuleConfig {
  toolName: string;
  warnAt: number;
  maxCalls: number;
  /** Two identical failed attempts produce feedback; reject the next by default. */
  warnNoProgressAt?: number;
  stopNoProgressAt?: number;
  exception?: 'none' | 'polling' | 'expected-transient-retry';
}
const ruleStateSchema = z.strictObject({
  schemaVersion: z.literal(1), rulesHash: z.string().length(64),
  tools: z.record(z.string(), z.strictObject({
    calls: z.int().nonnegative(), warnedCount: z.boolean(), lastFailureKey: z.string().nullable(),
    repeatedFailures: z.int().nonnegative(), warnedFailureKeys: z.array(z.string()),
  })),
  admissions: z.record(z.string(), z.strictObject({ toolName: z.string(), requestHash: z.string(), allowed: z.boolean(), reason: z.string().optional() })),
  outcomes: z.record(z.string(), z.string()),
});
export type ToolRuleState = z.infer<typeof ruleStateSchema>;
export interface ToolRuleAction {
  callId: string; toolName: string; arguments: unknown; inputVersion: string; progressVersion: string;
}
export interface ToolRuleDecision {
  allowed: boolean;
  reason?: 'TOOL_CALL_LIMIT' | 'NO_PROGRESS' | 'CALL_CONFLICT';
  notifications: Array<{ key: string; message: string }>;
  state: ToolRuleState;
}

/** Pure state transitions: the owner must serialize admission + persist before dispatch. */
export class ToolRuleEngine {
  private readonly rules: Map<string, ToolRuleConfig>;
  readonly rulesHash: string;
  constructor(config: readonly ToolRuleConfig[]) {
    for (const rule of config) {
      if (!rule.toolName || !Number.isSafeInteger(rule.maxCalls) || rule.maxCalls < 1 || !Number.isSafeInteger(rule.warnAt) || rule.warnAt < 1 || rule.warnAt > rule.maxCalls
        || !Number.isSafeInteger(rule.warnNoProgressAt ?? 2) || (rule.warnNoProgressAt ?? 2) < 1
        || !Number.isSafeInteger(rule.stopNoProgressAt ?? 2) || (rule.stopNoProgressAt ?? 2) < (rule.warnNoProgressAt ?? 2)) throw new TypeError('Invalid tool rule thresholds');
    }
    this.rules = new Map(config.map(rule => [rule.toolName, { ...rule }]));
    if (this.rules.size !== config.length) throw new TypeError('Duplicate tool rule');
    this.rulesHash = jsonHash([...this.rules.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
  restore(value?: ToolRuleState): ToolRuleState {
    const state = ruleStateSchema.parse(value ?? { schemaVersion: 1, rulesHash: this.rulesHash, tools: {}, admissions: {}, outcomes: {} });
    if (state.rulesHash !== this.rulesHash) throw Object.assign(new Error('Tool rule state requires explicit migration'), { code: 'VERSION_MISMATCH' });
    return state;
  }
  private actionHash(action: ToolRuleAction): string {
    if (!action.callId || !action.toolName || !action.inputVersion || !action.progressVersion) throw new TypeError('Tool rule identities are required');
    return jsonHash([action.toolName, action.arguments, action.inputVersion, action.progressVersion]);
  }
  admit(action: ToolRuleAction, prior?: ToolRuleState): ToolRuleDecision {
    const state = this.restore(prior);
    const requestHash = this.actionHash(action);
    const previous = state.admissions[action.callId];
    if (previous) {
      if (previous.requestHash !== requestHash) return { allowed: false, reason: 'CALL_CONFLICT', notifications: [], state };
      return { allowed: previous.allowed, ...(previous.reason ? { reason: previous.reason as 'TOOL_CALL_LIMIT' | 'NO_PROGRESS' } : {}), notifications: [], state };
    }
    const rule = this.rules.get(action.toolName);
    const data = state.tools[action.toolName] ?? { calls: 0, warnedCount: false, lastFailureKey: null, repeatedFailures: 0, warnedFailureKeys: [] };
    state.tools[action.toolName] = data;
    const notifications: ToolRuleDecision['notifications'] = [];
    let reason: ToolRuleDecision['reason'];
    if (rule && data.calls >= rule.maxCalls) reason = 'TOOL_CALL_LIMIT';
    const actionKey = jsonHash([action.toolName, action.arguments, action.inputVersion, action.progressVersion]);
    const previousActionKey = data.lastFailureKey?.split(':')[0];
    const exempt = rule?.exception === 'polling' || rule?.exception === 'expected-transient-retry';
    if (!reason && rule && !exempt && previousActionKey === actionKey && data.repeatedFailures >= (rule.stopNoProgressAt ?? 2)) reason = 'NO_PROGRESS';
    if (!reason) {
      data.calls += 1;
      if (rule && data.calls >= rule.warnAt && !data.warnedCount) {
        data.warnedCount = true;
        notifications.push({ key: `${this.rulesHash}:${action.toolName}:count`, message: `${action.toolName} has used ${data.calls}/${rule.maxCalls} permitted calls` });
      }
    }
    state.admissions[action.callId] = { toolName: action.toolName, requestHash, allowed: reason === undefined, ...(reason ? { reason } : {}) };
    return { allowed: reason === undefined, ...(reason ? { reason } : {}), notifications, state };
  }
  record(action: ToolRuleAction, outcome: { ok: boolean; errorSignature?: string; progressVersion: string }, prior: ToolRuleState): ToolRuleDecision {
    const state = this.restore(prior);
    const admission = state.admissions[action.callId];
    if (!admission?.allowed || admission.requestHash !== this.actionHash(action)) throw new Error('Outcome has no matching admitted tool call');
    const outcomeHash = jsonHash(outcome);
    const previous = state.outcomes[action.callId];
    if (previous) {
      if (previous !== outcomeHash) throw new Error('Conflicting duplicate tool outcome');
      return { allowed: true, notifications: [], state };
    }
    state.outcomes[action.callId] = outcomeHash;
    const data = state.tools[action.toolName]!;
    const rule = this.rules.get(action.toolName);
    const notifications: ToolRuleDecision['notifications'] = [];
    if (outcome.ok || outcome.progressVersion !== action.progressVersion) {
      data.lastFailureKey = null; data.repeatedFailures = 0;
    } else {
      if (!outcome.errorSignature) throw new TypeError('A failed tool requires a stable error signature');
      const key = `${this.actionHash(action)}:${jsonHash(outcome.errorSignature)}`;
      data.repeatedFailures = data.lastFailureKey === key ? data.repeatedFailures + 1 : 1;
      data.lastFailureKey = key;
      if (rule && !['polling', 'expected-transient-retry'].includes(rule.exception ?? 'none')
        && data.repeatedFailures >= (rule.warnNoProgressAt ?? 2) && !data.warnedFailureKeys.includes(key)) {
        data.warnedFailureKeys.push(key);
        notifications.push({ key: `${this.rulesHash}:${action.toolName}:${key}`, message: 'Repeated identical failure without new input or progress; revise the approach before continuing' });
      }
    }
    return { allowed: true, notifications, state };
  }
}
