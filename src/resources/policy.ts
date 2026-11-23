import { createHash } from 'node:crypto';
import type { ResourceSample } from './index.js';

export interface ResourcePolicyConfig {
  mode: 'observe' | 'enforce';
  maxConcurrency: number;
  reducedConcurrency: number;
  highRatio: number;
  recoverRatio: number;
  consecutiveHigh: number;
  consecutiveLow: number;
  maxSampleAgeMs: number;
  /** Only enable signals meaningful for this workload; memory/CPU need a verified deployment. */
  signals: Array<'cpu' | 'memory' | 'wall' | 'logs' | 'outputs'>;
  limits: { wallMs?: number; logBytes?: number; outputBytes?: number };
}
export interface ResourcePolicyState {
  schemaVersion: 1;
  configFingerprint: string;
  executionId: string;
  lastSampleAt: number | null;
  lastSourceTimestamp: number | null;
  highSamples: number;
  lowSamples: number;
  throttled: boolean;
}
export interface ResourcePolicyDecision {
  state: ResourcePolicyState;
  maxNewConcurrency: number;
  proposedConcurrency: number;
  telemetry: 'known' | 'partial' | 'unknown' | 'stale' | 'duplicate';
  reasons: string[];
  /** Existing work is never interrupted or granted extra resources by this policy. */
  affects: 'new-dispatch-only';
}

export interface ResourcePolicyControllerOptions {
  policy: ResourcePolicy;
  sample: (runId: string) => Promise<ResourceSample>;
  now?: () => number;
  /** Persist the state outside this module's storage dependency. */
  loadState?: (runId: string) => ResourcePolicyState | undefined;
  saveDecision?: (runId: string, decision: ResourcePolicyDecision) => void;
  /** Scheduler identity is stable while remote execution identities may change. */
  identity?: (runId: string) => string;
}

/** Bridges sampled telemetry into a restartable scheduling decision. */
export class ResourcePolicyController {
  private readonly now: () => number;
  constructor(private readonly options: ResourcePolicyControllerOptions) {
    this.now = options.now ?? Date.now;
  }

  async evaluate(runId: string): Promise<ResourcePolicyDecision> {
    if (!runId.trim()) throw new TypeError('Resource policy runId is required');
    const observed = await this.options.sample(runId);
    // ResourcePolicy state is scoped to the scheduler, not one replaceable branch
    // execution. Keep the original execution identity in the sampled event.
    const executionId = this.options.identity?.(runId) ?? `resource-policy:${runId}`;
    const sample: ResourceSample = { ...observed, execution: { ...observed.execution, executionId } };
    const decision = this.options.policy.evaluate(sample, this.now(), this.options.loadState?.(runId));
    this.options.saveDecision?.(runId, decision);
    return decision;
  }
}

/** Pure, restartable sampling policy. Save its returned state beside the runtime checkpoint. */
export class ResourcePolicy {
  readonly fingerprint: string;
  private readonly config: ResourcePolicyConfig;
  constructor(config: ResourcePolicyConfig) {
    this.config = structuredClone(config);
    for (const key of ['maxConcurrency', 'reducedConcurrency', 'consecutiveHigh', 'consecutiveLow', 'maxSampleAgeMs'] as const) {
      if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new TypeError(`Invalid resource policy ${key}`);
    }
    if (!['observe', 'enforce'].includes(config.mode) || config.reducedConcurrency > config.maxConcurrency
      || !Number.isFinite(config.recoverRatio) || !Number.isFinite(config.highRatio)
      || config.recoverRatio < 0 || config.highRatio > 1 || config.recoverRatio >= config.highRatio
      || config.signals.length === 0 || new Set(config.signals).size !== config.signals.length
      || config.signals.some(signal => !['cpu', 'memory', 'wall', 'logs', 'outputs'].includes(signal))) throw new TypeError('Invalid resource policy thresholds/signals');
    for (const signal of config.signals) {
      const limit = signal === 'wall' ? config.limits.wallMs : signal === 'logs' ? config.limits.logBytes : signal === 'outputs' ? config.limits.outputBytes : undefined;
      if (['wall', 'logs', 'outputs'].includes(signal) && (!Number.isSafeInteger(limit) || (limit ?? 0) < 1)) throw new TypeError(`Missing resource policy limit for ${signal}`);
    }
    this.fingerprint = createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
  }
  evaluate(sample: ResourceSample, now: number, previous?: ResourcePolicyState): ResourcePolicyDecision {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(sample.observedAt) || sample.observedAt < 0) throw new TypeError('Invalid sampling time');
    const state: ResourcePolicyState = previous ? structuredClone(previous) : {
      schemaVersion: 1, configFingerprint: this.fingerprint, executionId: sample.execution.executionId,
      lastSampleAt: null, lastSourceTimestamp: null, highSamples: 0, lowSamples: 0, throttled: false,
    };
    if (state.schemaVersion !== 1 || state.configFingerprint !== this.fingerprint || state.executionId !== sample.execution.executionId
      || !Number.isSafeInteger(state.highSamples) || state.highSamples < 0 || !Number.isSafeInteger(state.lowSamples) || state.lowSamples < 0
      || (state.lastSampleAt !== null && (!Number.isSafeInteger(state.lastSampleAt) || state.lastSampleAt < 0))
      || (state.lastSourceTimestamp !== null && (!Number.isSafeInteger(state.lastSourceTimestamp) || state.lastSourceTimestamp < 0))
      || typeof state.throttled !== 'boolean') throw new TypeError('Resource policy state needs an explicit configuration/execution migration');
    const finish = (telemetry: ResourcePolicyDecision['telemetry'], reasons: string[]): ResourcePolicyDecision => {
      const proposedConcurrency = state.throttled ? this.config.reducedConcurrency : this.config.maxConcurrency;
      return { state, proposedConcurrency, maxNewConcurrency: this.config.mode === 'enforce' ? proposedConcurrency : this.config.maxConcurrency,
        telemetry, reasons, affects: 'new-dispatch-only' };
    };
    if (sample.observedAt > now || now - sample.observedAt > this.config.maxSampleAgeMs) {
      state.highSamples = 0; state.lowSamples = 0; return finish('stale', ['RESOURCE_SAMPLE_STALE']);
    }
    if ((state.lastSampleAt !== null && sample.observedAt <= state.lastSampleAt)
      || (sample.sourceTimestamp !== null && state.lastSourceTimestamp !== null && sample.sourceTimestamp <= state.lastSourceTimestamp)) {
      return finish('duplicate', ['RESOURCE_SAMPLE_ALREADY_COUNTED']);
    }
    state.lastSampleAt = sample.observedAt; state.lastSourceTimestamp = sample.sourceTimestamp ?? state.lastSourceTimestamp;
    const ratios: number[] = []; const reasons: string[] = []; let hasLowerBound = false;
    for (const signal of this.config.signals) {
      let ratio: number | undefined;
      if (signal === 'cpu' && sample.cpuUtilization.status === 'known') ratio = sample.cpuUtilization.value;
      if (signal === 'memory' && sample.memoryUsed.status === 'known' && sample.memoryCapacity.status === 'known' && sample.memoryCapacity.value > 0) ratio = sample.memoryUsed.value / sample.memoryCapacity.value;
      if (signal === 'wall' && sample.wallTime.status === 'known') ratio = sample.wallTime.value / this.config.limits.wallMs!;
      if (signal === 'logs' && sample.retainedLogBytes.status === 'known') ratio = sample.retainedLogBytes.value / this.config.limits.logBytes!;
      if (signal === 'outputs' && sample.outputBytes.status === 'known') ratio = sample.outputBytes.value / this.config.limits.outputBytes!;
      const selected = signal === 'cpu' ? [sample.cpuUtilization] : signal === 'memory' ? [sample.memoryUsed, sample.memoryCapacity]
        : signal === 'wall' ? [sample.wallTime] : signal === 'logs' ? [sample.retainedLogBytes] : [sample.outputBytes];
      if (selected.some(metric => metric.status === 'known' && metric.quality === 'lower-bound')) hasLowerBound = true;
      if (ratio !== undefined && Number.isFinite(ratio) && ratio >= 0) { ratios.push(ratio); if (ratio >= this.config.highRatio) reasons.push(`RESOURCE_HIGH_${signal.toUpperCase()}`); }
      else reasons.push(`RESOURCE_UNKNOWN_${signal.toUpperCase()}`);
    }
    const allKnown = ratios.length === this.config.signals.length;
    const high = ratios.some(ratio => ratio >= this.config.highRatio);
    const low = allKnown && !hasLowerBound && ratios.every(ratio => ratio < this.config.recoverRatio);
    state.highSamples = high ? Math.min(state.highSamples + 1, this.config.consecutiveHigh) : 0;
    state.lowSamples = low ? Math.min(state.lowSamples + 1, this.config.consecutiveLow) : 0;
    if (!state.throttled && state.highSamples >= this.config.consecutiveHigh) { state.throttled = true; reasons.push('RESOURCE_CONCURRENCY_REDUCED'); }
    if (state.throttled && state.lowSamples >= this.config.consecutiveLow) { state.throttled = false; reasons.push('RESOURCE_CONCURRENCY_RESTORED'); }
    return finish(allKnown ? 'known' : ratios.length > 0 ? 'partial' : 'unknown', reasons);
  }
}
