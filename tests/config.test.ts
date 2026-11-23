import { describe, expect, it } from 'vitest';
import { RuntimeConfigSchema, loadConfig } from '../src/config.js';

describe('configuration validation', () => {
  it('loads explicit deny-network and observation defaults', () => {
    const c = loadConfig('config/example.json');
    expect(c.sandbox.network).toEqual({ defaultAction: 'deny', allowHosts: [] });
    expect(c.policy.mode).toBe('observe');
  });
  it('rejects unsafe unknown settings and invalid limit relationships', () => {
    const c = loadConfig('config/example.json');
    expect(() => RuntimeConfigSchema.parse({ ...c, apiKey: 'never-log-me' })).toThrow();
    expect(() => RuntimeConfigSchema.parse({ ...c, policy: { ...c.policy, focusRatio: 0.6 } })).toThrow();
    expect(() => RuntimeConfigSchema.parse({ ...c, sandbox: { ...c.sandbox, commandTimeoutMs: 300_000, ttlSeconds: 60 } })).toThrow();
    expect(() => RuntimeConfigSchema.parse({ ...c, sandbox: { ...c.sandbox, network: { defaultAction: 'allow' } } })).toThrow();
  });
});
