import type { ExecutionRef } from '../contracts/sandbox.js';

export type MetricSource = 'opensandbox-execd' | 'opensandbox-command-status' | 'verified-collector';
export type UnknownMetricReason = 'not-supported' | 'not-sampled' | 'request-failed' | 'scope-unverified' | 'missing' | 'invalid' | 'stale' | 'sdk-zero-ambiguous' | 'execution-running';
export type ResourceMetric<U extends string> =
  | { status: 'known'; value: number; unit: U; source: MetricSource; quality: 'exact' | 'lower-bound' }
  | { status: 'unknown'; unit: U; reason: UnknownMetricReason };
export interface ResourceSample {
  schemaVersion: 1;
  execution: ExecutionRef;
  /** Local receipt time; not interchangeable with a remote timestamp. */
  observedAt: number;
  sourceTimestamp: number | null;
  deploymentEvidence: string | null;
  cpuUtilization: ResourceMetric<'ratio'>;
  memoryUsed: ResourceMetric<'bytes'>;
  memoryCapacity: ResourceMetric<'bytes'>;
  wallTime: ResourceMetric<'ms'>;
  /** The published metrics endpoint does not provide these per-command counters. */
  cpuTime: ResourceMetric<'ms'>;
  peakMemory: ResourceMetric<'bytes'>;
  retainedLogBytes: ResourceMetric<'bytes'>;
  outputBytes: ResourceMetric<'bytes'>;
  outputFiles: ResourceMetric<'count'>;
}
export interface MetricsDeploymentProfile {
  /** Set only after proving metric scope against the actual deployed resource boundary. */
  evidenceRef: string;
  cpuCores: number;
  memoryMiB: number;
}
export interface NormalizeResourceOptions {
  execution: ExecutionRef;
  observedAt: number;
  metrics?: unknown;
  commandStatus?: unknown;
  metricsFailure?: 'not-supported' | 'request-failed';
  deployment?: MetricsDeploymentProfile;
  maxAgeMs?: number;
  allowedClockSkewMs?: number;
  collected?: { retainedLogBytes: number; logsTruncated: boolean; outputBytes: number; outputFiles: number };
}
const unknown = <U extends string>(unit: U, reason: UnknownMetricReason): ResourceMetric<U> => ({ status: 'unknown', unit, reason });
const known = <U extends string>(value: number, unit: U, source: MetricSource, quality: 'exact' | 'lower-bound' = 'exact'): ResourceMetric<U> =>
  ({ status: 'known', value, unit, source, quality });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function time(value: unknown): number | null { return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null; }
function nonnegativeSafe(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`); }

/** Missing SDK fields become zero in 1.2.1, so zero resource readings remain ambiguous. */
export function normalizeResourceSample(options: NormalizeResourceOptions): ResourceSample {
  nonnegativeSafe(options.observedAt, 'observedAt');
  const maxAge = options.maxAgeMs ?? 5000; const skew = options.allowedClockSkewMs ?? 2000;
  nonnegativeSafe(maxAge, 'maxAgeMs'); nonnegativeSafe(skew, 'allowedClockSkewMs');
  const metric = object(options.metrics); const status = object(options.commandStatus);
  const timestamp = positive(metric.timestamp) && Number.isSafeInteger(metric.timestamp) ? metric.timestamp : null;
  const sample: ResourceSample = {
    schemaVersion: 1, execution: structuredClone(options.execution), observedAt: options.observedAt,
    sourceTimestamp: timestamp, deploymentEvidence: options.deployment?.evidenceRef ?? null,
    cpuUtilization: unknown('ratio', 'not-sampled'), memoryUsed: unknown('bytes', 'not-sampled'), memoryCapacity: unknown('bytes', 'not-sampled'),
    wallTime: unknown('ms', 'missing'), cpuTime: unknown('ms', 'not-supported'), peakMemory: unknown('bytes', 'not-supported'),
    retainedLogBytes: unknown('bytes', 'not-sampled'), outputBytes: unknown('bytes', 'not-sampled'), outputFiles: unknown('count', 'not-sampled'),
  };
  let reason: UnknownMetricReason | undefined = options.metricsFailure;
  const profile = options.deployment;
  if (!reason && (!profile?.evidenceRef.trim() || !positive(profile.cpuCores) || !positive(profile.memoryMiB))) reason = 'scope-unverified';
  if (!reason && timestamp === null) reason = 'missing';
  if (!reason && timestamp !== null && (options.observedAt - timestamp > maxAge || timestamp - options.observedAt > skew)) reason = 'stale';
  if (reason) {
    sample.cpuUtilization = unknown('ratio', reason); sample.memoryUsed = unknown('bytes', reason); sample.memoryCapacity = unknown('bytes', reason);
  } else {
    const reading = (value: unknown, unit: 'ratio' | 'bytes', scale: number, max = Number.MAX_SAFE_INTEGER): ResourceMetric<typeof unit> => {
      if (value === 0) return unknown(unit, 'sdk-zero-ambiguous');
      if (value === undefined || value === null) return unknown(unit, 'missing');
      if (!positive(value) || value > max || !Number.isFinite(value * scale) || value * scale > Number.MAX_SAFE_INTEGER) return unknown(unit, 'invalid');
      return known(unit === 'bytes' ? Math.round(value * scale) : value * scale, unit, 'opensandbox-execd');
    };
    const cpuScopeMatches = positive(metric.cpuCount) && Math.abs(metric.cpuCount - profile!.cpuCores) < 0.0001;
    const memoryScopeMatches = positive(metric.memoryTotalMiB) && Math.abs(metric.memoryTotalMiB - profile!.memoryMiB) < 0.01;
    sample.cpuUtilization = cpuScopeMatches ? reading(metric.cpuUsedPercentage, 'ratio', 0.01, 100.1) as ResourceMetric<'ratio'> : unknown('ratio', 'scope-unverified');
    sample.memoryCapacity = memoryScopeMatches ? reading(metric.memoryTotalMiB, 'bytes', 1048576) as ResourceMetric<'bytes'> : unknown('bytes', 'scope-unverified');
    sample.memoryUsed = memoryScopeMatches ? reading(metric.memoryUsedMiB, 'bytes', 1048576, metric.memoryTotalMiB as number) as ResourceMetric<'bytes'> : unknown('bytes', 'scope-unverified');
  }
  const started = time(status.startedAt); const finished = time(status.finishedAt);
  if (status.running === false && started !== null && finished !== null && finished >= started) {
    sample.wallTime = known(finished - started, 'ms', 'opensandbox-command-status');
  } else if (status.running === true && started !== null && timestamp !== null && timestamp >= started
    && options.observedAt - timestamp <= maxAge && timestamp - options.observedAt <= skew) {
    sample.wallTime = known(timestamp - started, 'ms', 'opensandbox-command-status', 'lower-bound');
  } else sample.wallTime = unknown('ms', status.running === true ? 'execution-running' : started !== null && finished !== null ? 'invalid' : 'missing');
  if (options.collected) {
    const collected = options.collected;
    for (const [key, value] of Object.entries(collected)) if (typeof value === 'number') nonnegativeSafe(value, key);
    sample.retainedLogBytes = known(collected.retainedLogBytes, 'bytes', 'verified-collector', collected.logsTruncated ? 'lower-bound' : 'exact');
    sample.outputBytes = known(collected.outputBytes, 'bytes', 'verified-collector'); sample.outputFiles = known(collected.outputFiles, 'count', 'verified-collector');
  }
  return sample;
}
