import { describe, expect, it } from 'vitest';
import { failureEvidence, InfrastructureCircuit, isInfrastructureFailure } from '../../src/core/infrastructure.js';

describe('sandbox infrastructure circuit', () => {
  it('opens after a host failure and resets after a successful probe', () => {
    let now = 1000;
    const circuit = new InfrastructureCircuit({ now: () => now, cooldownMs: 100 });
    circuit.recordFailure({ code: 'DOCKER::SANDBOX_START_FAILED', phase: 'sandbox.create', retryable: true, message: 'sidecar failed', observedAt: now });
    expect(circuit.snapshot().state).toBe('open');
    expect(() => circuit.assertAvailable()).toThrow('sidecar failed');
    now += 100;
    expect(circuit.snapshot().state).toBe('half-open');
    circuit.recordSuccess();
    expect(circuit.snapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0, retryAt: null });
  });

  it('recognizes OpenSandbox errors wrapped under a nested error object', () => {
    const error = Object.assign(new Error('request failed'), { error: { code: 'DOCKER::SANDBOX_START_FAILED', message: 'egress sidecar failed' } });
    expect(isInfrastructureFailure(error)).toBe(true);
    expect(failureEvidence(error, 'sandbox.create')).toMatchObject({ code: 'DOCKER::SANDBOX_START_FAILED', phase: 'sandbox.create' });
  });
});
