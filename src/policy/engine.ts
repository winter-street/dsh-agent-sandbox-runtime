import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';
import type { BudgetPurpose, BudgetSnapshot } from '../contracts/budget.js';

export type PolicyStage = 'normal' | 'notice' | 'conserve' | 'focus' | 'finalize';
export type PolicyMode = 'observe' | 'enforce';
export interface PolicySnapshot {
  budget: BudgetSnapshot;
  cancelled: boolean;
  deadlineExceeded: boolean;
  inflightModelCalls: number;
  /** Monotonic counts persisted by the caller; they are not elapsed clock time. */
  stepBoundary: number;
  settlementBoundary: number;
  permissionDenied?: boolean;
  requiredWorkComplete?: boolean;
}
/** Evidence recorded with a rejected model policy decision, before any reservation. */
export interface ModelAdmissionEvidence {
  schemaVersion: 1;
  sessionId: string;
  purpose: BudgetPurpose;
  required: boolean;
  intent: 'work' | 'summary' | 'final-report';
  /** The request hook runs before message assembly, so it has no full estimate. */
  estimatedTokens: number | null;
  requestedMaxTokens: number;
  rulesFingerprint: string;
  snapshot: Omit<PolicySnapshot, 'budget'> & {
    budget: Pick<BudgetSnapshot, 'limitTokens' | 'usedTokens' | 'reservedTokens' | 'availableTokens'
      | 'work' | 'finalize' | 'ledgerSeq' | 'unknownCalls' | 'meteringComplete' | 'exhausted'>;
  };
}
export type PolicyAction =
  | {
    kind: 'model'; purpose: BudgetPurpose; required: boolean; estimatedTokens: number;
    /** Finalize permits one of these trusted intents, never general work. */
    intent?: 'work' | 'summary' | 'final-report';
    output?: { kind: 'prose' | 'code' | 'structured'; maxTokens: number; minTokens: number };
  }
  | { kind: 'tool'; required: boolean; finalizeAllowed?: boolean }
  | { kind: 'spawn-agent'; required: boolean }
  | { kind: 'collect' | 'checkpoint' | 'cleanup'; required?: boolean };

const stages: PolicyStage[] = ['normal', 'notice', 'conserve', 'focus', 'finalize'];
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1), policyVersion: z.string().min(1), rulesFingerprint: z.string().length(64),
  stage: z.enum(['normal', 'notice', 'conserve', 'focus', 'finalize']),
  finalized: z.boolean(), notifiedStages: z.array(z.enum(['normal', 'notice', 'conserve', 'focus', 'finalize'])),
  lastTransitionStep: z.int().nonnegative(), lastTransitionSettlement: z.int().nonnegative(),
  lastStepBoundary: z.int().nonnegative(), lastSettlementBoundary: z.int().nonnegative(),
  evaluationCount: z.int().nonnegative(), lastOperatorReason: z.string().optional(),
});
export type PolicyState = z.infer<typeof stateSchema>;
export type PolicyReasonCode =
  | 'CANCELLED' | 'PERMISSION_DENIED' | 'DEADLINE_EXCEEDED' | 'USAGE_UNKNOWN'
  | 'GLOBAL_BUDGET_UNAVAILABLE' | 'WORK_BUDGET_UNAVAILABLE' | 'FINALIZE_BUDGET_UNAVAILABLE'
  | 'WAIT_INFLIGHT' | 'MODEL_CONCURRENCY_LIMIT' | 'BUDGET_PRESSURE'
  | 'OPTIONAL_WORK_BLOCKED' | 'NEW_AGENT_BLOCKED' | 'FINALIZE_ONLY'
  | 'FINALIZE_INTENT_REQUIRED' | 'REQUIRED_WORK_COMPLETE' | 'OUTPUT_CAP_REDUCED';
export interface PolicyReason { code: PolicyReasonCode; hard: boolean; detail: string }
export interface PolicyLimits {
  maxModelConcurrency: number;
  allowOptionalWork: boolean;
  allowNewAgents: boolean;
  outputTokenCap?: number;
}
export interface PolicyNotification { key: string; stage: PolicyStage; pressure: number; mode: PolicyMode }
export interface PolicyDecision {
  allowed: boolean;
  disposition: 'allow' | 'wait' | 'deny' | 'finalize';
  stage: PolicyStage;
  mode: PolicyMode;
  pressure: { used: number; reserved: number; total: number };
  reasons: PolicyReason[];
  /** Applied limits; observe returns baseline limits. Proposed limits are diagnostic. */
  limits: PolicyLimits;
  proposedLimits: PolicyLimits;
  requiresReestimate: boolean;
  notifications: PolicyNotification[];
  state: PolicyState;
}

function count(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
}
function rank(stage: PolicyStage): number { return stages.indexOf(stage); }
function isMaintenance(action: PolicyAction): boolean {
  return action.kind === 'collect' || action.kind === 'checkpoint' || action.kind === 'cleanup';
}

/** Pure decision logic. No clock, ledger writes, model calls or hidden mutable state. */
export class PolicyEngine {
  readonly version: string;
  readonly fingerprint: string;
  private readonly config: RuntimeConfig['policy'];
  private readonly cooldownSteps: number;

  constructor(config: RuntimeConfig['policy'], options: { version?: string; cooldownSteps?: number } = {}) {
    this.config = { ...config };
    this.version = options.version ?? 'budget-policy-v1';
    this.cooldownSteps = options.cooldownSteps ?? 2;
    count(this.cooldownSteps, 'cooldownSteps');
    if (!this.version) throw new TypeError('Policy version cannot be empty');
    const thresholds = [config.noticeRatio, config.conserveRatio, config.focusRatio, config.finalizeRatio];
    if (thresholds.some((value, i) => !Number.isFinite(value) || value < 0 || value > 1 || (i > 0 && value <= thresholds[i - 1]!))) {
      throw new TypeError('Policy usage-ratio thresholds must strictly increase within [0, 1]');
    }
    if (!Number.isFinite(config.hysteresis) || config.hysteresis <= 0 || config.hysteresis > 0.2) {
      throw new TypeError('Policy hysteresis must be within (0, 0.2]');
    }
    count(config.maxModelConcurrency, 'maxModelConcurrency');
    if (config.maxModelConcurrency === 0 || !['observe', 'enforce'].includes(config.mode)) throw new TypeError('Invalid policy mode/concurrency');
    // Mode is deliberately versioned: switching observe/enforce requires an explicit state migration.
    this.fingerprint = createHash('sha256').update(JSON.stringify([
      this.version, config.mode, ...thresholds, config.hysteresis,
      config.maxModelConcurrency, this.cooldownSteps,
    ])).digest('hex');
  }

  restoreState(value: unknown): PolicyState {
    const state = stateSchema.parse(value);
    if (state.policyVersion !== this.version || state.rulesFingerprint !== this.fingerprint) {
      // Observe mode never stops a conversation, so a configuration change
      // (notably switching enforce -> observe) must not brick a run with its
      // stale latched state. Migrate to a clean baseline instead; enforce mode
      // still requires the explicit migration.
      if (this.config.mode === 'observe') {
        return {
          schemaVersion: 1, policyVersion: this.version, rulesFingerprint: this.fingerprint,
          stage: 'normal', finalized: false, notifiedStages: [],
          lastTransitionStep: 0, lastTransitionSettlement: 0,
          lastStepBoundary: 0, lastSettlementBoundary: 0, evaluationCount: 0,
        };
      }
      throw Object.assign(new Error('Policy state requires explicit version/config migration'), { code: 'VERSION_MISMATCH' });
    }
    if (state.finalized !== (state.stage === 'finalize') || new Set(state.notifiedStages).size !== state.notifiedStages.length
      || state.lastTransitionStep > state.lastStepBoundary || state.lastTransitionSettlement > state.lastSettlementBoundary) {
      throw new TypeError('Inconsistent policy state');
    }
    return state;
  }

  /** Host/operator-only release after an audited budget/policy adjustment. */
  releaseFinalize(value: PolicyState, reason: string): PolicyState {
    if (!reason.trim()) throw new TypeError('An operator reason is required');
    const state = this.restoreState(value);
    return { ...state, stage: 'normal', finalized: false, lastOperatorReason: reason,
      lastTransitionStep: state.lastStepBoundary, lastTransitionSettlement: state.lastSettlementBoundary };
  }

  evaluate(snapshot: PolicySnapshot, action: PolicyAction, priorState?: PolicyState): PolicyDecision {
    const { budget } = snapshot;
    for (const [key, value] of Object.entries({
      limit: budget.limitTokens, used: budget.usedTokens, reserved: budget.reservedTokens,
      unknown: budget.unknownCalls, inflight: snapshot.inflightModelCalls,
      stepBoundary: snapshot.stepBoundary, settlementBoundary: snapshot.settlementBoundary,
    })) count(value, key);
    for (const [name, allocation] of [['work', budget.work], ['finalize', budget.finalize]] as const) {
      count(allocation.limitTokens, `${name}.limit`); count(allocation.usedTokens, `${name}.used`); count(allocation.reservedTokens, `${name}.reserved`);
    }
    count(budget.usedTokens + budget.reservedTokens, 'combined pressure tokens');
    if (action.kind === 'model') {
      count(action.estimatedTokens, 'estimatedTokens');
      if (action.estimatedTokens === 0) throw new TypeError('A model call requires a positive complete-request estimate');
      if (action.output) {
        count(action.output.maxTokens, 'output.maxTokens'); count(action.output.minTokens, 'output.minTokens');
        if (action.output.minTokens < 1 || action.output.minTokens > action.output.maxTokens) throw new TypeError('Invalid effective output range');
      }
    }
    const ratio = (value: number) => budget.limitTokens === 0 ? (value === 0 ? 1 : Number.MAX_VALUE) : value / budget.limitTokens;
    const pressure = { used: ratio(budget.usedTokens), reserved: budget.limitTokens === 0 ? 0 : budget.reservedTokens / budget.limitTokens, total: ratio(budget.usedTokens + budget.reservedTokens) };
    const state: PolicyState = priorState ? this.restoreState(priorState) : {
      schemaVersion: 1, policyVersion: this.version, rulesFingerprint: this.fingerprint,
      stage: 'normal', finalized: false, notifiedStages: [], lastTransitionStep: snapshot.stepBoundary,
      lastTransitionSettlement: snapshot.settlementBoundary, lastStepBoundary: snapshot.stepBoundary,
      lastSettlementBoundary: snapshot.settlementBoundary, evaluationCount: 0,
    };
    if (snapshot.stepBoundary < state.lastStepBoundary || snapshot.settlementBoundary < state.lastSettlementBoundary) {
      throw Object.assign(new Error('Policy boundary counters cannot move backwards on resume'), { code: 'VERSION_MISMATCH' });
    }
    const reasons: PolicyReason[] = [];
    const add = (code: PolicyReasonCode, hard: boolean, detail: string) => { reasons.push({ code, hard, detail }); };
    const maintenance = isMaintenance(action);
    let hardDeny = false;
    for (const [condition, code, detail] of [
      [snapshot.cancelled && !maintenance, 'CANCELLED', 'Task was cancelled'],
      [snapshot.permissionDenied === true, 'PERMISSION_DENIED', 'Action is outside granted permissions'],
      [snapshot.deadlineExceeded && !maintenance, 'DEADLINE_EXCEEDED', 'Task deadline has elapsed'],
      [(budget.unknownCalls > 0 || !budget.meteringComplete) && !maintenance, 'USAGE_UNKNOWN', 'Usage must be reconciled before new work'],
    ] as const) {
      if (condition) { hardDeny = true; add(code, true, detail); }
    }
    const globalAvailable = Math.max(0, budget.limitTokens - budget.usedTokens - budget.reservedTokens);
    const workAvailable = Math.max(0, budget.work.limitTokens - budget.work.usedTokens - budget.work.reservedTokens);
    const workAfterSettlement = Math.max(0, budget.work.limitTokens - budget.work.usedTokens);
    const estimatedWork = action.kind === 'model' && action.purpose === 'work' ? action.estimatedTokens : 0;
    const workShort = estimatedWork > workAvailable;
    const transientWorkShort = workShort && snapshot.inflightModelCalls > 0 && budget.work.reservedTokens > 0 && estimatedWork <= workAfterSettlement;
    const reservationOnlyFinalize = pressure.total >= this.config.finalizeRatio && pressure.used < this.config.finalizeRatio
      && snapshot.inflightModelCalls > 0 && budget.reservedTokens > 0;
    const waitForSettlement = !state.finalized && (transientWorkShort || reservationOnlyFinalize);

    let desired: PolicyStage = pressure.total >= this.config.finalizeRatio ? 'finalize'
      : pressure.total >= this.config.focusRatio ? 'focus'
      : pressure.total >= this.config.conserveRatio ? 'conserve'
      : pressure.total >= this.config.noticeRatio ? 'notice' : 'normal';
    // A reservation is potential spend. It must not permanently latch scope reduction.
    if (reservationOnlyFinalize) desired = state.stage;
    if ((action.kind === 'model' && action.required && workShort && !transientWorkShort) || snapshot.requiredWorkComplete) desired = 'finalize';
    if (snapshot.requiredWorkComplete) add('REQUIRED_WORK_COMPLETE', false, 'All required acceptance checks are satisfied');
    if (state.finalized) desired = 'finalize';
    if (rank(desired) < rank(state.stage)) {
      const exitThreshold = [0, this.config.noticeRatio, this.config.conserveRatio, this.config.focusRatio, this.config.finalizeRatio][rank(state.stage)]! - this.config.hysteresis;
      const cooled = snapshot.stepBoundary - state.lastTransitionStep >= this.cooldownSteps;
      const settled = snapshot.settlementBoundary > state.lastTransitionSettlement;
      if (!(pressure.total < exitThreshold && cooled && settled)) desired = state.stage;
    }
    if (desired !== state.stage) {
      state.stage = desired;
      state.lastTransitionStep = snapshot.stepBoundary;
      state.lastTransitionSettlement = snapshot.settlementBoundary;
    }
    state.finalized = state.stage === 'finalize';
    state.lastStepBoundary = snapshot.stepBoundary;
    state.lastSettlementBoundary = snapshot.settlementBoundary;
    state.evaluationCount += 1;
    const notifications: PolicyNotification[] = [];
    if (state.stage !== 'normal' && !state.notifiedStages.includes(state.stage)) {
      state.notifiedStages.push(state.stage);
      notifications.push({ key: `${this.version}:${this.fingerprint}:${state.stage}`, stage: state.stage, pressure: pressure.total, mode: this.config.mode });
    }
    if (state.stage !== 'normal') add('BUDGET_PRESSURE', false, `Stage ${state.stage}; settled ${budget.usedTokens}, reserved ${budget.reservedTokens}, limit ${budget.limitTokens}`);
    const baseline: PolicyLimits = { maxModelConcurrency: this.config.maxModelConcurrency, allowOptionalWork: true, allowNewAgents: true };
    const proposed: PolicyLimits = {
      maxModelConcurrency: rank(state.stage) >= rank('conserve') ? 1 : this.config.maxModelConcurrency,
      allowOptionalWork: rank(state.stage) < rank('conserve'),
      allowNewAgents: rank(state.stage) < rank('focus'),
    };
    if (action.kind === 'model' && action.output) {
      baseline.outputTokenCap = action.output.maxTokens;
      proposed.outputTokenCap = action.output.maxTokens;
      if (action.output.kind === 'prose' && rank(state.stage) >= rank('conserve')) {
        proposed.outputTokenCap = Math.max(action.output.minTokens, Math.floor(action.output.maxTokens * (rank(state.stage) >= rank('focus') ? 0.5 : 0.75)));
        if (proposed.outputTokenCap < action.output.maxTokens) add('OUTPUT_CAP_REDUCED', false, 'Simplify prose while preserving its minimum viable output');
      }
    }
    const limits = this.config.mode === 'enforce' ? { ...proposed } : { ...baseline };
    let softDeny = false;
    let softFinalize = false;
    let wait = false;
    if (!maintenance && !hardDeny && waitForSettlement) {
      add('WAIT_INFLIGHT', false, 'Pressure may fall when existing reservations settle');
      if (this.config.mode === 'enforce') wait = true;
    }
    if (!maintenance && !waitForSettlement) {
      if (action.kind === 'spawn-agent' && !proposed.allowNewAgents) {
        add('NEW_AGENT_BLOCKED', false, 'Do not create additional agents at this stage'); softDeny = true;
      }
      if (action.required === false && !proposed.allowOptionalWork) {
        add('OPTIONAL_WORK_BLOCKED', false, 'Prioritize the recorded required acceptance criteria'); softDeny = true;
      }
      const finalAction = action.kind === 'model'
        ? action.purpose === 'finalize' && action.intent === 'final-report'
        : action.kind === 'tool' && action.finalizeAllowed === true;
      if (state.finalized && !finalAction) {
        add('FINALIZE_ONLY', false, 'The task is latched to bounded finalization'); softFinalize = true;
      }
    }
    if (action.kind === 'model') {
      if (action.purpose === 'finalize' && (action.intent !== 'final-report' || !state.finalized)) {
        add('FINALIZE_INTENT_REQUIRED', true, 'Finalize credit requires host-authorized final report intent and finalize stage'); hardDeny = true;
      }
      const allocation = budget[action.purpose];
      const available = Math.max(0, allocation.limitTokens - allocation.usedTokens - allocation.reservedTokens);
      const requests = [
        { available: globalAvailable, after: Math.max(0, budget.limitTokens - budget.usedTokens), reserved: budget.reservedTokens, code: 'GLOBAL_BUDGET_UNAVAILABLE' as const },
        { available, after: Math.max(0, allocation.limitTokens - allocation.usedTokens), reserved: allocation.reservedTokens,
          code: action.purpose === 'work' ? 'WORK_BUDGET_UNAVAILABLE' as const : 'FINALIZE_BUDGET_UNAVAILABLE' as const },
      ];
      for (const request of requests) {
        if (action.estimatedTokens > request.available) {
          add(request.code, true, 'Complete request estimate does not fit the remaining global/class allocation');
          if (snapshot.inflightModelCalls > 0 && request.reserved > 0 && action.estimatedTokens <= request.after) wait = true;
          else hardDeny = true;
        }
      }
      if (snapshot.inflightModelCalls >= limits.maxModelConcurrency) {
        add('MODEL_CONCURRENCY_LIMIT', snapshot.inflightModelCalls >= baseline.maxModelConcurrency, 'Wait for an existing model call to finish'); wait = true;
      }
    }
    const disposition = hardDeny ? 'deny' : wait ? 'wait'
      : this.config.mode === 'enforce' && softFinalize ? 'finalize'
      : this.config.mode === 'enforce' && softDeny ? 'deny' : 'allow';
    return {
      allowed: disposition === 'allow', disposition, stage: state.stage, mode: this.config.mode,
      pressure, reasons, limits, proposedLimits: proposed,
      requiresReestimate: action.kind === 'model' && action.output !== undefined && limits.outputTokenCap !== action.output.maxTokens,
      notifications, state,
    };
  }
}
