import { afterEach, describe, expect, it } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { FakeSandbox } from '../support/fakes.js';
import { createPluginTestHost, type PluginTestHost } from './helpers.js';

const hosts: PluginTestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0).reverse()) await host.dispose(); });
async function host(options: Parameters<typeof createPluginTestHost>[0] = {}): Promise<PluginTestHost> {
  const created = await createPluginTestHost(options);
  hosts.push(created);
  return created;
}
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error('condition did not settle');
}

describe('plugin recovery and concurrency', () => {
  it('reopens a completed run without dispatching the sandbox again', async () => {
    const first = await host();
    first.say('persistent task');
    await first.call('print(1)');
    const run = first.store.listRuns()[0]!;
    const attempt = first.store.listAttempts(run.runId)[0]!;
    const directory = first.directory;
    await first.dispose();

    const reopened = await host({ directory });
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    expect(reopened.store.listRuns().map(item => item.runId)).toEqual([run.runId]);
    expect(reopened.store.listAttempts(run.runId).map(item => item.attemptId)).toEqual([attempt.attemptId]);
    expect(reopened.sandbox.calls.some(call => call.method === 'execute')).toBe(false);
  });

  it('rejects a concurrent execution on the same run before creating another sandbox', async () => {
    const sandbox = new FakeSandbox({ plans: [{ states: [{ state: 'RUNNING' }, { state: 'RUNNING' }, { state: 'RUNNING' }] }] });
    const first = await host({ sandbox });
    first.say('concurrent task');
    const controller = new AbortController();
    const pending = first.call('print(1)', undefined, controller.signal);
    await waitFor(() => sandbox.calls.some(call => call.method === 'execute'));
    const second = await first.call('print(2)');
    expect(second.isError).toBe(true);
    expect(sandbox.calls.filter(call => call.method === 'create')).toHaveLength(1);
    controller.abort(new Error('test cleanup'));
    await pending;
  });

  it('keeps two root sessions in independent runs and sandboxes', async () => {
    const first = await host();
    first.say('session one');
    await first.call('print(1)');
    const second = await first.ctx.agents.create({ sessionId: SessionId('second-session'), agentOptions: { provider: 'unused', model: 'unused' } });
    second.agent.session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'session two' }],
    }), { surfaceOp: 'append' });
    await first.call('print(2)', second);
    const runs = first.store.listRuns();
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(run => run.runId)).size).toBe(2);
    expect(first.sandbox.calls.filter(call => call.method === 'create')).toHaveLength(2);
  });
});
