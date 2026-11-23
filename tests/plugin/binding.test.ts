import { afterEach, describe, expect, it } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createPluginTestHost, type PluginTestHost } from './helpers.js';

const hosts: PluginTestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0).reverse()) await host.dispose(); });
async function host(): Promise<PluginTestHost> {
  const created = await createPluginTestHost();
  hosts.push(created);
  return created;
}
function runs(h: PluginTestHost) { return h.store.listRuns(); }
function reviewStepId(h: PluginTestHost, runId: string): string {
  return h.store.listSteps(runId).find(step => step.kind === 'review' && step.required)!.stepId;
}

describe('plugin task-scoped run binding', () => {
  it('reuses the run while the task is unfinished', async () => {
    const h = await host();
    h.say('first task');
    await h.call('print(1)');
    const first = runs(h);
    expect(first).toHaveLength(1);
    expect(first[0]!.task).toBe('first task');
    const firstId = first[0]!.runId;

    h.say('please continue');
    await h.call('print(2)');
    expect(runs(h).map(run => run.runId)).toEqual([firstId]);
    expect(runs(h)[0]!.task).toBe('first task');
  });

  it('rotates to a new run after the previous delivery is accepted', async () => {
    const h = await host();
    h.say('first task');
    await h.call('print(1)');
    const firstId = runs(h)[0]!.runId;
    h.store.recordValidation(reviewStepId(h, firstId), true, { accepted: true });

    h.say('second task');
    await h.call('print(2)');
    const all = runs(h);
    expect(all).toHaveLength(2);
    const second = all.find(run => run.runId !== firstId)!;
    expect(second.task).toBe('second task');
    const binding = h.store.listComponentState<{ messageId?: string }>(second.runId, 'sessions')[0]!;
    expect(binding.messageId).toBeTruthy();
    expect(h.store.listComponentState(firstId, 'sessions')).toHaveLength(0);
  });

  it('starts a new generation for the same message after a terminal run', async () => {
    const h = await host();
    h.say('retry task');
    await h.call('print(1)');
    const first = runs(h)[0]!;
    const cancelling = h.store.transitionRun(first.runId, 'CANCELLING', first.revision);
    h.store.transitionRun(first.runId, 'CANCELLED', cancelling.revision);
    await h.call('print(2)');
    const all = runs(h);
    expect(all).toHaveLength(2);
    expect(all.some(run => run.runId !== first.runId)).toBe(true);
  });

  it('binds child sessions to the root run without rotating it', async () => {
    const h = await host();
    h.say('root task');
    await h.call('print(1)');
    const first = runs(h)[0]!;
    const child = await h.child();
    const outcome = await h.call('print(2)', child);
    expect(outcome.isError).toBe(false);
    expect(runs(h).map(run => run.runId)).toEqual([first.runId]);
    const childBinding = h.store.listComponentState<{ runId: string }>(first.runId, 'sessions');
    expect(childBinding.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores injected user-role context when choosing the task message', async () => {
    const h = await host();
    h.say('real human task');
    h.root.agent.session.append('user/message', createUserMessage({
      source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'injected reminder' }],
    }), { surfaceOp: 'append' });
    await h.call('print(1)');
    expect(runs(h)[0]!.task).toBe('real human task');
  });

  it('backfills a legacy binding without rotating the run', async () => {
    const h = await host();
    h.say('legacy task');
    await h.call('print(1)');
    const first = runs(h)[0]!;
    const binding = h.store.listComponentState<Record<string, unknown>>(first.runId, 'sessions')[0]!;
    h.store.setComponentState(first.runId, 'sessions', 'root-session', { ...binding, messageId: undefined });
    await h.call('print(2)');
    expect(runs(h).map(run => run.runId)).toEqual([first.runId]);
    const updated = h.store.listComponentState<{ messageId?: string }>(first.runId, 'sessions')[0]!;
    expect(updated.messageId).toBeTruthy();
  });
});
