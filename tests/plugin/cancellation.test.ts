import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { FakeSandbox } from '../support/fakes.js';
import { createPluginTestHost, type PluginTestHost } from './helpers.js';

const hosts: PluginTestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0).reverse()) await host.dispose(); });
function runs(h: PluginTestHost) { return h.store.listRuns(); }
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
  throw new Error('condition did not settle');
}

describe('plugin cancellation and session stop', () => {
  it('cancels the remote execution and destroys the sandbox when the tool signal aborts', async () => {
    const sandbox = new FakeSandbox({ plans: [{ states: [{ state: 'RUNNING' }, { state: 'RUNNING' }, { state: 'RUNNING' }, { state: 'RUNNING' }] }] });
    const host = await createPluginTestHost({ sandbox });
    hosts.push(host);
    host.say('cancel task');
    const controller = new AbortController();
    const pending = host.call('print(1)', undefined, controller.signal);
    await waitFor(() => sandbox.calls.some(call => call.method === 'execute'));
    controller.abort(new Error('operator cancelled'));
    const outcome = await pending;
    expect(outcome.isError).toBe(true);
    const run = runs(host)[0]!;
    expect(run.status).toBe('CANCELLED');
    expect(sandbox.calls.some(call => call.method === 'destroy')).toBe(true);
    expect(host.store.getSandbox(run.runId)).toBeUndefined();
  });

  it('cancels an active root run on workspace/session-stop', async () => {
    const host = await createPluginTestHost();
    hosts.push(host);
    host.say('stop task');
    await host.call('print(1)');
    const run = runs(host)[0]!;
    host.ctx.emit('workspace/session-stop', { sessionId: SessionId('root-session') });
    await waitFor(() => host.store.getRun(run.runId).status === 'CANCELLED');
    expect(host.store.getRun(run.runId).status).toBe('CANCELLED');
  });

  it('does not cancel an accepted delivery on session stop', async () => {
    const host = await createPluginTestHost();
    hosts.push(host);
    host.say('accepted task');
    await host.call('print(1)');
    const run = runs(host)[0]!;
    const review = host.store.listSteps(run.runId).find(step => step.kind === 'review' && step.required)!;
    host.store.recordValidation(review.stepId, true, { accepted: true });
    host.ctx.emit('workspace/session-stop', { sessionId: SessionId('root-session') });
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(host.store.getRun(run.runId).status).toBe('RUNNING');
  });

  it('does not cancel the root run when a child session stops', async () => {
    const host = await createPluginTestHost();
    hosts.push(host);
    host.say('root task');
    await host.call('print(1)');
    const child = await host.child();
    await host.call('print(2)', child);
    const run = runs(host)[0]!;
    host.ctx.emit('workspace/session-stop', { sessionId: SessionId('child-session') });
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    expect(host.store.getRun(run.runId).status).toBe('RUNNING');
  });
});
