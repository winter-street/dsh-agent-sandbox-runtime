import { describe, expect, it } from 'vitest';
import { normalizeResourceSample } from '../../src/resources/index.js';
import { ResourcePolicy } from '../../src/resources/policy.js';
import type { ResourcePolicyConfig, ResourcePolicyState } from '../../src/resources/policy.js';
import type { ExecutionRef } from '../../src/contracts/sandbox.js';

const execution: ExecutionRef = { runId: 'run-1', sandboxId: 'sandbox-1', attemptId: 'attempt-1', executionId: 'execution-1', workDir: '/tmp/run-1' };
const deployment = { evidenceRef: 'test fixture only; no real deployment verified', cpuCores: 1, memoryMiB: 512 };
const metrics = (timestamp = 10000, pressure = 0.9) => ({ timestamp, cpuCount: 1, cpuUsedPercentage: pressure * 100, memoryUsedMiB: 512 * pressure, memoryTotalMiB: 512 });
const sample = (timestamp = 10000, pressure = 0.9) => normalizeResourceSample({ execution, deployment, observedAt: timestamp, metrics: metrics(timestamp, pressure) });
const config: ResourcePolicyConfig = { mode: 'enforce', maxConcurrency: 4, reducedConcurrency: 1, highRatio: 0.8,
  recoverRatio: 0.6, consecutiveHigh: 3, consecutiveLow: 2, maxSampleAgeMs: 5000, signals: ['memory', 'cpu'], limits: {} };

describe('resource normalization from published SDK fields', () => {
  it('preserves source, units and deployment provenance without inventing unsupported counters', () => {
    const result = normalizeResourceSample({ execution, observedAt: 10000, deployment, metrics: metrics(),
      commandStatus: { running: false, startedAt: new Date(2000), finishedAt: new Date(3456) } });
    expect(result.cpuUtilization).toMatchObject({ status: 'known', value: 0.9, unit: 'ratio' });
    expect(result.memoryUsed).toMatchObject({ status: 'known', value: Math.round(460.8 * 1048576), unit: 'bytes' });
    expect(result.wallTime).toMatchObject({ status: 'known', value: 1456, quality: 'exact' });
    expect(result.cpuTime).toEqual({ status: 'unknown', unit: 'ms', reason: 'not-supported' });
    expect(result.peakMemory).toMatchObject({ status: 'unknown', reason: 'not-supported' });
    expect(result.deploymentEvidence).toBe(deployment.evidenceRef);
  });

  it('treats missing and SDK-default zero readings as unknown, while collector zero is exact', () => {
    const result = normalizeResourceSample({ execution, observedAt: 10000, deployment,
      metrics: { ...metrics(), cpuUsedPercentage: 0, memoryUsedMiB: undefined },
      collected: { retainedLogBytes: 0, logsTruncated: false, outputBytes: 0, outputFiles: 0 } });
    expect(result.cpuUtilization).toMatchObject({ status: 'unknown', reason: 'sdk-zero-ambiguous' });
    expect(result.memoryUsed).toMatchObject({ status: 'unknown', reason: 'missing' });
    expect(result.outputBytes).toMatchObject({ status: 'known', value: 0, quality: 'exact' });
    expect(result.retainedLogBytes).toMatchObject({ status: 'known', value: 0 });
  });

  it('requires verified deployment scope and rejects host-capacity fallback', () => {
    expect(normalizeResourceSample({ execution, observedAt: 10000, metrics: metrics() }).cpuUtilization)
      .toMatchObject({ status: 'unknown', reason: 'scope-unverified' });
    const result = normalizeResourceSample({ execution, observedAt: 10000, deployment,
      metrics: { ...metrics(), cpuCount: 64, memoryTotalMiB: 131072 } });
    expect(result.cpuUtilization).toMatchObject({ status: 'unknown', reason: 'scope-unverified' });
    expect(result.memoryUsed).toMatchObject({ status: 'unknown', reason: 'scope-unverified' });
  });

  it('does not use stale, future-clock or invalid resource readings', () => {
    for (const timestamp of [1, 20000]) expect(normalizeResourceSample({ execution, observedAt: 10000, deployment, metrics: metrics(timestamp) }).memoryUsed)
      .toMatchObject({ status: 'unknown', reason: 'stale' });
    const result = normalizeResourceSample({ execution, observedAt: 10000, deployment,
      metrics: { ...metrics(), cpuUsedPercentage: NaN, memoryUsedMiB: 999 } });
    expect(result.cpuUtilization).toMatchObject({ status: 'unknown', reason: 'invalid' });
    expect(result.memoryUsed).toMatchObject({ status: 'unknown', reason: 'invalid' });
  });

  it('uses remote timestamps for elapsed lower bounds and never substitutes local request duration', () => {
    const running = normalizeResourceSample({ execution, observedAt: 10000, metrics: metrics(), commandStatus: { running: true, startedAt: new Date(8000) } });
    expect(running.wallTime).toMatchObject({ status: 'known', value: 2000, quality: 'lower-bound' });
    const absent = normalizeResourceSample({ execution, observedAt: 10000, commandStatus: { running: true, startedAt: new Date(8000) } });
    expect(absent.wallTime).toMatchObject({ status: 'unknown', reason: 'execution-running' });
    const invalid = normalizeResourceSample({ execution, observedAt: 10000, commandStatus: { running: false, startedAt: new Date(8000), finishedAt: new Date(7000) } });
    expect(invalid.wallTime).toMatchObject({ status: 'unknown', reason: 'invalid' });
  });

  it('marks truncated logs as a lower bound without inventing their full size', () => {
    const result = normalizeResourceSample({ execution, observedAt: 10000, metricsFailure: 'request-failed',
      collected: { retainedLogBytes: 2048, logsTruncated: true, outputBytes: 31, outputFiles: 2 } });
    expect(result.memoryUsed).toMatchObject({ status: 'unknown', reason: 'request-failed' });
    expect(result.retainedLogBytes).toMatchObject({ status: 'known', value: 2048, quality: 'lower-bound' });
    expect(result.outputFiles).toMatchObject({ status: 'known', value: 2, quality: 'exact' });
  });
});

describe('consecutive resource pressure and recovery', () => {
  it('throttles only after distinct consecutive high samples and survives a policy instance restart', () => {
    let policy = new ResourcePolicy(config); let state: ResourcePolicyState | undefined;
    for (let i = 0; i < 2; i++) { const result = policy.evaluate(sample(10000 + i), 10000 + i, state); state = result.state; expect(result.maxNewConcurrency).toBe(4); }
    policy = new ResourcePolicy(config);
    const third = policy.evaluate(sample(10002), 10002, JSON.parse(JSON.stringify(state)) as ResourcePolicyState);
    expect(third.maxNewConcurrency).toBe(1); expect(third.affects).toBe('new-dispatch-only');
    expect(third.reasons).toContain('RESOURCE_CONCURRENCY_REDUCED');
  });

  it('does not count repeat polling of the same source observation', () => {
    const policy = new ResourcePolicy(config); const first = policy.evaluate(sample(), 10000);
    const repeated = policy.evaluate({ ...sample(), observedAt: 10001 }, 10001, first.state);
    expect(repeated.telemetry).toBe('duplicate'); expect(repeated.state.highSamples).toBe(1);
  });

  it('resets a high streak on a low sample and recovers only below the lower threshold', () => {
    const policy = new ResourcePolicy({ ...config, consecutiveHigh: 2 });
    const first = policy.evaluate(sample(10000), 10000);
    const interrupted = policy.evaluate(sample(10001, 0.4), 10001, first.state);
    const second = policy.evaluate(sample(10002), 10002, interrupted.state); expect(second.state.throttled).toBe(false);
    const high = policy.evaluate(sample(10003), 10003, second.state); expect(high.state.throttled).toBe(true);
    const middle = policy.evaluate(sample(10004, 0.7), 10004, high.state); expect(middle.state.throttled).toBe(true);
    const low = policy.evaluate(sample(10005, 0.4), 10005, middle.state); expect(low.maxNewConcurrency).toBe(1);
    const recovered = policy.evaluate(sample(10006, 0.4), 10006, low.state); expect(recovered.maxNewConcurrency).toBe(4);
  });

  it('does not release an existing throttle when telemetry becomes missing or stale', () => {
    const policy = new ResourcePolicy({ ...config, consecutiveHigh: 1 });
    const high = policy.evaluate(sample(), 10000);
    const missing = normalizeResourceSample({ execution, observedAt: 10001, metricsFailure: 'request-failed' });
    const unknown = policy.evaluate(missing, 10001, high.state);
    expect(unknown.telemetry).toBe('unknown'); expect(unknown.maxNewConcurrency).toBe(1);
    expect(policy.evaluate(sample(10002), 30000, unknown.state).maxNewConcurrency).toBe(1);
  });

  it('allows a confirmed high signal to throttle but requires every configured signal for recovery', () => {
    const policy = new ResourcePolicy({ ...config, consecutiveHigh: 1, consecutiveLow: 1 });
    const partial = sample(); partial.cpuUtilization = { status: 'unknown', unit: 'ratio', reason: 'missing' };
    const high = policy.evaluate(partial, 10000); expect(high.telemetry).toBe('partial'); expect(high.maxNewConcurrency).toBe(1);
    const low = sample(10001, 0.4); low.cpuUtilization = { status: 'unknown', unit: 'ratio', reason: 'missing' };
    expect(policy.evaluate(low, 10001, high.state).maxNewConcurrency).toBe(1);
  });

  it('observe reports proposed pressure limits without changing effective concurrency', () => {
    const policy = new ResourcePolicy({ ...config, mode: 'observe', consecutiveHigh: 1 });
    const result = policy.evaluate(sample(), 10000);
    expect(result.proposedConcurrency).toBe(1); expect(result.maxNewConcurrency).toBe(4);
  });

  it('does not use a truncated lower-bound log count as evidence to recover', () => {
    const policy = new ResourcePolicy({ ...config, signals: ['logs'], limits: { logBytes: 100 }, consecutiveHigh: 1, consecutiveLow: 1 });
    const create = (observedAt: number, retainedLogBytes: number, logsTruncated: boolean) => normalizeResourceSample({ execution, observedAt,
      collected: { retainedLogBytes, logsTruncated, outputBytes: 0, outputFiles: 0 } });
    const high = policy.evaluate(create(10000, 90, true), 10000);
    expect(high.maxNewConcurrency).toBe(1);
    const low = policy.evaluate(create(10001, 10, true), 10001, high.state);
    expect(low.maxNewConcurrency).toBe(1);
    expect(policy.evaluate(create(10002, 10, false), 10002, low.state).maxNewConcurrency).toBe(4);
  });

  it('rejects implicit config or execution identity migration and invalid thresholds', () => {
    const state = new ResourcePolicy(config).evaluate(sample(), 10000).state;
    expect(() => new ResourcePolicy({ ...config, reducedConcurrency: 2 }).evaluate(sample(10001), 10001, state)).toThrow('migration');
    const other = sample(10001); other.execution.executionId = 'another-execution';
    expect(() => new ResourcePolicy(config).evaluate(other, 10001, state)).toThrow('migration');
    expect(() => new ResourcePolicy({ ...config, recoverRatio: 0.9 })).toThrow('thresholds');
    expect(() => new ResourcePolicy({ ...config, signals: ['wall'] })).toThrow('limit');
  });
});
