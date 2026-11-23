import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestHost, type PluginTestHost } from './helpers.js';

const hosts: PluginTestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0).reverse()) await host.dispose(); });

function approvalService(outcomes: Array<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async request(input: Record<string, unknown>) {
      calls.push(input);
      return outcomes.shift() ?? 'unavailable';
    },
  };
}

describe('plugin DSH approval gate', () => {
  it('asks once per run and proceeds on allowed-once', async () => {
    const approval = approvalService(['allowed-once', 'allowed-once']);
    const host = await createPluginTestHost({ approval, config: { approval: { mode: 'first-execution', reason: 'test reason' } } });
    hosts.push(host);
    host.say('approved task');
    expect((await host.call('print(1)')).isError).toBe(false);
    expect((await host.call('print(2)')).isError).toBe(false);
    expect(approval.calls).toHaveLength(1);
    expect(approval.calls[0]!.toolName).toBe('runtime_python');
    expect(approval.calls[0]!.reason).toBe('test reason');
    const run = host.store.listRuns()[0]!;
    expect(host.store.getComponentState(run.runId, 'plugin', 'approval')).toBeDefined();
    expect(host.sandbox.calls.filter(call => call.method === 'create')).toHaveLength(2);
  });

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not create a sandbox when approval is %s', async outcome => {
    const approval = approvalService([outcome]);
    const host = await createPluginTestHost({ approval, config: { approval: { mode: 'first-execution' } } });
    hosts.push(host);
    host.say('denied task');
    expect((await host.call('print(1)')).isError).toBe(true);
    expect(approval.calls).toHaveLength(1);
    expect(host.sandbox.calls.some(call => call.method === 'create')).toBe(false);
    const run = host.store.listRuns()[0]!;
    expect(host.store.listAttempts(run.runId)).toHaveLength(0);
    expect(host.store.getComponentState(run.runId, 'plugin', 'approval')).toBeUndefined();
  });

  it('does not ask when approval mode is none', async () => {
    const approval = approvalService(['rejected']);
    const host = await createPluginTestHost({ approval });
    hosts.push(host);
    host.say('unapproved mode');
    expect((await host.call('print(1)')).isError).toBe(false);
    expect(approval.calls).toHaveLength(0);
  });

  it('fails activation when first-execution is configured without an approval service', async () => {
    await expect(createPluginTestHost({ config: { approval: { mode: 'first-execution' } } })).rejects.toThrow(/approval/);
  });
});
