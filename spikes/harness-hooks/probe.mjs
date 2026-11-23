import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';

// This probe executes published Harness modules with a local deterministic adapter.
// It neither calls an external model nor claims to verify provider billing.
const here = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = resolve(here, '../../.runtime/harness-probe');
await mkdir(dataRoot, { recursive: true });
const sessionRoot = await mkdtemp(join(dataRoot, 'sessions-'));
const events = [];
const requests = [];
const checks = [];
const handles = [];
const ctx = new Context();
let result;
let streamSequence = 0;
let abortStartedResolve;
const abortStarted = new Promise(resolveStart => { abortStartedResolve = resolveStart; });

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ];
}

class LocalAdapter extends LlmAdapter {
  async *stream(options) {
    requests.push({ sessionId: options.sessionId, model: options.model, maxTokens: options.maxTokens, frozen: Object.isFrozen(options) });
    events.push({ type: 'adapter.started', sessionId: options.sessionId, model: options.model });
    if (options.model === 'throw') throw new Error('probe: provider failed before usage');
    if (options.model === 'partial') {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'partial' };
      throw new Error('probe: stream disconnected before usage');
    }
    if (options.model === 'abort') {
      abortStartedResolve();
      await new Promise((_, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    const hasResult = options.messages.some(m => m.content.some(b => b.type === 'tool-result'));
    if (options.model === 'tool' && !hasResult) {
      const block = { type: 'tool-call', id: 'probe-tool-call', name: 'runtime_probe_add', arguments: '{"a":2,"b":3}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 2 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield* textChunks(hasResult ? 'The verified sum is 5.' : 'Probe completed.');
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function prompt(text) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
}

async function create(id, model, createCtx = ctx, meta = {}) {
  const handle = await createCtx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: resolve(here, '../..'), ...meta },
    agentOptions: { provider: 'probe', model, maxTokens: 400 },
  });
  handles.push(handle);
  return handle;
}

try {
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(JsonlPersistence, { root: sessionRoot, compression: 'none', packChunks: false }).await();
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  ctx.llm.registerAdapter(['probe'], new LocalAdapter());

  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next();
    events.push({ type: 'agent.request', sessionId: payload.agent.session.id, maxTokensBefore: proposed.maxTokens });
    return { ...proposed, maxTokens: 128 };
  });
  ctx.on('agent/request-error', async (payload, next) => {
    events.push({ type: 'agent.request-error', sessionId: payload.agent.id, failureCode: payload.failure.code });
    return next();
  });
  ctx.on('agent/session-start', payload => {
    events.push({ type: 'agent.session-start', sessionId: payload.agent.id, source: payload.source });
  });
  ctx.on('llm/stream', (options, next) => {
    const callId = `probe-stream-${++streamSequence}`;
    events.push({ type: 'stream.before', callId, sessionId: options.sessionId, purpose: options.purpose ?? 'conversation', frozen: Object.isFrozen(options) });
    return (async function* () {
      let usage;
      let finish;
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage;
          if (chunk.type === 'finish') finish = chunk.reason.kind;
          yield chunk;
        }
      } finally {
        events.push({ type: 'stream.finally', callId, sessionId: options.sessionId, finish: finish ?? 'none', accounting: usage ? 'known' : 'unknown', ...(usage ? { usage } : {}) });
      }
    })();
  });
  const disposeTool = ctx.tools.register({
    name: 'runtime_probe_add',
    description: 'Return the sum of two integers for the local integration probe.',
    parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      assert.ok(exec.agent);
      assert.ok(exec.signal instanceof AbortSignal);
      events.push({ type: 'tool.execute', sessionId: exec.agent.session.id, callId: exec.callId, rootCallId: exec.rootCallId });
      return { sum: args.a + args.b };
    },
  });

  const root = await create('probe-root', 'tool');
  root.agent.followup(prompt('Add 2 and 3 using the tool.'));
  await root.agent.whenIdle();
  const rootEvents = root.agent.session.events;
  assert.ok(rootEvents.some(e => e.type === 'tool/result'));
  assert.equal(events.filter(e => e.type === 'tool.execute').length, 1);
  assert.ok(requests.every(r => r.maxTokens === 128 && r.frozen));
  assert.ok(rootEvents.some(e => e.type === 'request/header' && JSON.stringify(e.data).includes('128')));
  checks.push({ name: 'real agent loop, tool registry, frozen stream, logged output cap', passed: true });

  const child = await create('probe-child', 'normal', root.agent.ctx, { parentSession: root.agent.id, origin: 'subagent', delegationDepth: 1 });
  child.agent.followup(prompt('Run the child probe.'));
  await child.agent.whenIdle();
  assert.equal(child.agent.session.header.parentSession, root.agent.id);
  assert.ok(events.some(e => e.type === 'stream.before' && e.sessionId === child.agent.id));
  checks.push({ name: 'child request session attribution and persisted parent lineage', passed: true });

  for (const mode of ['throw', 'partial']) {
    const handle = await create(`probe-${mode}`, mode);
    handle.agent.followup(prompt(`Run ${mode} probe.`));
    await handle.agent.whenIdle();
    const end = events.findLast(e => e.type === 'stream.finally' && e.sessionId === handle.agent.id);
    assert.equal(end.accounting, 'unknown');
    assert.equal(end.finish, 'error');
    assert.ok(events.some(e => e.type === 'agent.request-error' && e.sessionId === handle.agent.id));
    checks.push({ name: `${mode} normalizes error while preserving missing usage`, passed: true });
  }

  const abort = await create('probe-abort', 'abort');
  abort.agent.followup(prompt('Wait until cancelled.'));
  await abortStarted;
  abort.agent.cancel({ kind: 'user' });
  await abort.agent.whenIdle();
  const abortEnd = events.findLast(e => e.type === 'stream.finally' && e.sessionId === abort.agent.id);
  assert.equal(abortEnd.accounting, 'unknown');
  assert.equal(abortEnd.finish, 'aborted');
  checks.push({ name: 'agent cancellation reaches adapter signal and ends unknown usage', passed: true });

  await ctx.sessions.flush(root.agent.session);
  const before = root.agent.session.deriveMessages().map(m => m.id);
  await root.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('probe-root'), agentOptions: { provider: 'probe', model: 'normal', maxTokens: 400 } });
  handles.push(resumed);
  assert.equal(resumed.agent.id, 'probe-root');
  assert.deepEqual(resumed.agent.session.deriveMessages().map(m => m.id), before);
  resumed.agent.followup(prompt('Continue the original session.'));
  await resumed.agent.whenIdle();
  assert.ok(events.some(e => e.type === 'agent.session-start' && e.source === 'resume'));
  checks.push({ name: 'JSONL flush, dispose, resume same session and preserve message identities', passed: true });

  disposeTool();
  assert.equal(ctx.tools.get('runtime_probe_add'), undefined);
  checks.push({ name: 'tool registration disposer removes contribution', passed: true });

  result = {
    probeVersion: 1,
    node: process.version,
    scope: 'published Harness 0.1.0-rc.6 modules; local deterministic adapter; no external model',
    checks, requests, events,
    limitations: ['No external provider billing checked.', 'No OpenSandbox execution in this probe.', 'No budget service integrated in this probe.', 'Process crash recovery and Loader profile launch remain separate integration work.'],
  };
} finally {
  for (const handle of handles.reverse()) await handle.dispose();
  await ctx.fiber.dispose();
}
assert.deepEqual(ctx.fiber.getEffects(), []);
checks.push({ name: 'agent handles and root fiber effects dispose cleanly', passed: true });
await writeFile(join(here, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: checks.length, checks, result: 'spikes/harness-hooks/result.json' }, null, 2));
