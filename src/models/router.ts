import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BudgetPurpose, BudgetSnapshot } from '../contracts/budget.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ModelProfileSchema = z.strictObject({
  id: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  modelWindowTokens: positive, maxOutputTokens: positive,
  taskTypes: z.array(z.string().min(1)).min(1),
  toolCalling: z.boolean(), structuredOutput: z.boolean(),
  validatedToolSchemaHashes: z.array(digest), validatedOutputSchemaHashes: z.array(digest),
  reasoningEfforts: z.array(z.string().min(1)).default([]),
  verification: z.enum(['controlled', 'remote']), verifiedAt: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).min(1),
  pricing: z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), inputPerMillion: z.number().finite().nonnegative(), outputPerMillion: z.number().finite().nonnegative() }).optional(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export const ModelRoutingConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), enabled: z.boolean().default(false),
  baselineId: z.string().min(1), candidates: z.array(z.string().min(1)),
  safetyReserveTokens: count.default(256), minimumStableSteps: count.default(2), maxSwitches: count.default(1),
  allowControlledProfiles: z.boolean().default(false),
});
export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1), configFingerprint: digest, runId: z.string().min(1), selectedId: z.string().min(1),
  revision: count, switches: count, lastSwitchStep: count, lastObservedStep: count,
});
export type ModelRoutingState = z.infer<typeof stateSchema>;
export interface ModelRequirements {
  taskType: string;
  toolSchemaHashes: string[];
  outputSchemaHash?: string;
  reasoningEffort?: string;
  desiredOutputTokens: number;
  minimumOutputTokens: number;
}
export interface ModelRouteRequest {
  runId: string;
  stepBoundary: number;
  /** Only a request boundary with no open model work can switch. */
  atRequestBoundary: boolean;
  inflightModelCalls: number;
  unresolvedToolCalls: number;
  requestEconomy: boolean;
  purpose: BudgetPurpose;
  budget: BudgetSnapshot;
  requirements: ModelRequirements;
  /** Full unchanged request including system and schemas, counted for each candidate. */
  countInputTokens(profile: Readonly<ModelProfile>): number;
}
export interface ModelRouteAssessment {
  profileId: string;
  eligible: boolean;
  reasons: string[];
  inputTokens?: number;
  outputTokens?: number;
  estimatedTokens?: number;
  estimatedCost?: { currency: string; amount: number };
}
export type ModelRouteDecision = {
  allowed: false; reason: string; state: ModelRoutingState; assessments: ModelRouteAssessment[];
} | {
  allowed: true; changed: boolean; reason: string; state: ModelRoutingState;
  profile: ModelProfile; inputTokens: number; outputTokens: number; estimatedTokens: number;
  assessments: ModelRouteAssessment[];
};

/** Stable JSON schema identity; task adapters validate the actual schema separately. */
export function schemaFingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]));
    }
    throw new TypeError('Schema must contain only JSON values');
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function safeCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}

/** Deterministic whitelist routing. It does not call providers or debit the ledger. */
export class ModelRouter {
  readonly config: ModelRoutingConfig;
  readonly fingerprint: string;
  private readonly profiles: Map<string, ModelProfile>;
  constructor(config: unknown, profiles: readonly unknown[]) {
    this.config = ModelRoutingConfigSchema.parse(config);
    const parsed = profiles.map(profile => ModelProfileSchema.parse(profile));
    this.profiles = new Map(parsed.map(profile => [profile.id, profile]));
    if (this.profiles.size !== parsed.length) throw new TypeError('Duplicate model profile ID');
    const ids = [this.config.baselineId, ...this.config.candidates];
    if (new Set(ids).size !== ids.length || ids.some(id => !this.profiles.has(id))) throw new TypeError('Routing IDs must name unique known model profiles');
    this.fingerprint = schemaFingerprint({ config: this.config, profiles: parsed.sort((a, b) => a.id.localeCompare(b.id)) });
  }
  restore(value: unknown, runId: string): ModelRoutingState {
    const state = stateSchema.parse(value);
    if (state.runId !== runId || state.configFingerprint !== this.fingerprint) throw new Error('Model routing state requires explicit run/config migration');
    if (![this.config.baselineId, ...this.config.candidates].includes(state.selectedId)
      || state.lastSwitchStep > state.lastObservedStep || state.switches > this.config.maxSwitches) throw new Error('Inconsistent model routing state');
    return state;
  }
  decide(request: ModelRouteRequest, previous?: ModelRoutingState): ModelRouteDecision {
    for (const [name, value] of Object.entries({ stepBoundary: request.stepBoundary, inflightModelCalls: request.inflightModelCalls, unresolvedToolCalls: request.unresolvedToolCalls,
      desiredOutputTokens: request.requirements.desiredOutputTokens, minimumOutputTokens: request.requirements.minimumOutputTokens })) safeCount(value, name);
    if (!request.runId || request.requirements.minimumOutputTokens < 1 || request.requirements.desiredOutputTokens < request.requirements.minimumOutputTokens) throw new TypeError('Invalid run/output requirements');
    const state: ModelRoutingState = previous ? this.restore(previous, request.runId) : {
      schemaVersion: 1, configFingerprint: this.fingerprint, runId: request.runId, selectedId: this.config.baselineId,
      revision: 0, switches: 0, lastSwitchStep: request.stepBoundary, lastObservedStep: request.stepBoundary,
    };
    if (request.stepBoundary < state.lastObservedStep) throw new Error('Routing step boundary cannot move backwards');
    state.lastObservedStep = request.stepBoundary;
    const denied = (reason: string, assessments: ModelRouteAssessment[] = []): ModelRouteDecision => ({ allowed: false, reason, state, assessments });
    if (!request.budget.meteringComplete || request.budget.unknownCalls > 0) return denied('USAGE_UNKNOWN');
    const profiles = [this.config.baselineId, ...this.config.candidates].map(id => this.profiles.get(id)!);
    const assessments = profiles.map(profile => this.assess(profile, request));
    const current = assessments.find(item => item.profileId === state.selectedId)!;
    const canSwitch = this.config.enabled && request.atRequestBoundary && request.inflightModelCalls === 0
      && request.unresolvedToolCalls === 0 && request.budget.reservedTokens === 0
      && state.switches < this.config.maxSwitches && (state.switches === 0 || request.stepBoundary - state.lastSwitchStep >= this.config.minimumStableSteps);
    let choice = current;
    let reason = this.config.enabled ? 'STICKY_CURRENT' : 'SWITCHING_DISABLED';
    // Candidate order is explicitly configured; it is not inferred from token or price claims.
    if (canSwitch && (request.requestEconomy || !current.eligible)) {
      const position = profiles.findIndex(profile => profile.id === state.selectedId);
      const alternative = assessments.slice(position + 1).find(item => item.eligible);
      if (alternative) { choice = alternative; reason = request.requestEconomy ? 'REQUESTED_ECONOMY' : 'CURRENT_INCOMPATIBLE'; }
    }
    if (!choice.eligible) return denied(canSwitch ? 'NO_COMPATIBLE_CANDIDATE' : 'CURRENT_INCOMPATIBLE_SWITCH_BLOCKED', assessments);
    const changed = choice.profileId !== state.selectedId;
    if (changed) {
      state.selectedId = choice.profileId; state.switches++; state.lastSwitchStep = request.stepBoundary;
    }
    state.revision++;
    return { allowed: true, changed, reason, state, profile: structuredClone(this.profiles.get(choice.profileId)!),
      inputTokens: choice.inputTokens!, outputTokens: choice.outputTokens!, estimatedTokens: choice.estimatedTokens!, assessments };
  }
  private assess(profile: ModelProfile, request: ModelRouteRequest): ModelRouteAssessment {
    const r = request.requirements;
    const reasons: string[] = [];
    if (profile.verification !== 'remote' && !this.config.allowControlledProfiles) reasons.push('REMOTE_PROFILE_UNVERIFIED');
    if (!profile.taskTypes.includes(r.taskType)) reasons.push('TASK_TYPE_UNVERIFIED');
    if (r.toolSchemaHashes.length && !profile.toolCalling) reasons.push('TOOL_CALLING_UNSUPPORTED');
    if (r.toolSchemaHashes.some(hash => !profile.validatedToolSchemaHashes.includes(hash))) reasons.push('TOOL_SCHEMA_UNVERIFIED');
    if (r.outputSchemaHash && (!profile.structuredOutput || !profile.validatedOutputSchemaHashes.includes(r.outputSchemaHash))) reasons.push('OUTPUT_SCHEMA_UNVERIFIED');
    if (r.reasoningEffort && !profile.reasoningEfforts.includes(r.reasoningEffort)) reasons.push('REASONING_EFFORT_UNSUPPORTED');
    const outputTokens = Math.min(r.desiredOutputTokens, profile.maxOutputTokens);
    if (outputTokens < r.minimumOutputTokens) reasons.push('OUTPUT_SPACE_TOO_SMALL');
    let inputTokens: number;
    try { inputTokens = request.countInputTokens(structuredClone(profile)); safeCount(inputTokens, 'model input estimate'); }
    catch { return { profileId: profile.id, eligible: false, reasons: [...reasons, 'TOKEN_ESTIMATE_UNAVAILABLE'] }; }
    const estimatedTokens = inputTokens + outputTokens;
    if (!Number.isSafeInteger(estimatedTokens) || !Number.isSafeInteger(estimatedTokens + this.config.safetyReserveTokens)) reasons.push('TOKEN_ESTIMATE_INVALID');
    if (estimatedTokens + this.config.safetyReserveTokens > profile.modelWindowTokens) reasons.push('CONTEXT_WINDOW_TOO_SMALL');
    const globalAvailable = Math.max(0, request.budget.limitTokens - request.budget.usedTokens - request.budget.reservedTokens);
    const allocation = request.budget[request.purpose];
    const classAvailable = Math.max(0, allocation.limitTokens - allocation.usedTokens - allocation.reservedTokens);
    if (estimatedTokens > globalAvailable || estimatedTokens > classAvailable) reasons.push('RESERVATION_WOULD_NOT_FIT');
    const result: ModelRouteAssessment = { profileId: profile.id, eligible: reasons.length === 0, reasons, inputTokens, outputTokens, estimatedTokens };
    if (profile.pricing) result.estimatedCost = { currency: profile.pricing.currency,
      amount: (inputTokens * profile.pricing.inputPerMillion + outputTokens * profile.pricing.outputPerMillion) / 1_000_000 };
    return result;
  }
}
