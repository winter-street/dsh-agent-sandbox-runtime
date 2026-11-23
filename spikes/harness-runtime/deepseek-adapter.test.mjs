import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepSeekAcceptanceAdapter } from './deepseek-adapter.mjs';

// Local HTTP contract tests only. They do not establish real provider billing or SSE behavior.
const baseOptions = () => ({ model: 'deepseek-chat', maxTokens: 1024,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'add numbers' }] }] });
const responseBody = (usage = { prompt_tokens: 30, completion_tokens: 5,
  prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 10 }) => ({ usage,
  choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
const consume = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { await fn(); } finally { globalThis.fetch = original; }
}

test('wire tool roundtrip and disjoint cache usage preserve Harness semantics', async () => {
  let request;
  await withFetch(async (url, init) => {
    request = { url, ...init, body: JSON.parse(init.body) };
    const body = responseBody();
    body.choices[0] = { finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'next-call', type: 'function', function: { name: 'runtime_python', arguments: '{"code":"print(5)"}' } },
    ] } };
    return { ok: true, json: async () => body };
  }, async () => {
    const options = baseOptions();
    options.system = [{ text: 'trusted system' }];
    options.temperature = 0.2;
    options.stop = ['DONE'];
    options.tools = [{ name: 'runtime_python', description: 'sandbox execution', parameters: { type: 'object' } }];
    options.messages.push({ role: 'assistant', content: [{ type: 'tool-call', id: 'previous-call', name: 'runtime_python', arguments: '{"code":"pass"}' }] });
    options.messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'previous-call', content: [{ type: 'text', text: 'sum=5' }] }] });
    const adapter = new DeepSeekAcceptanceAdapter('test-placeholder');
    const chunks = await consume(adapter.stream(options));
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.match(request.headers['user-agent'], /^deepseek-harness/);
    assert.equal(request.body.stream, false);
    assert.equal(request.body.max_tokens, 1024);
    assert.equal(request.body.temperature, 0.2);
    assert.deepEqual(request.body.stop, ['DONE']);
    assert.deepEqual(request.body.messages, [
      { role: 'system', content: 'trusted system' },
      { role: 'user', content: 'add numbers' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'previous-call', type: 'function', function: { name: 'runtime_python', arguments: '{"code":"pass"}' } }] },
      { role: 'tool', tool_call_id: 'previous-call', content: '[{"type":"text","text":"sum=5"}]' },
    ]);
    assert.deepEqual(request.body.tools[0].function, options.tools[0]);
    assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage,
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0 });
    assert.equal(chunks.filter(chunk => chunk.type === 'block-end')[0].block.id, 'next-call');
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
    assert.equal(adapter.responses.length, 1);
  });
});

test('missing, negative or inconsistent usage never emits successful completion', async () => {
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 2, completion_tokens: 1, prompt_cache_hit_tokens: 3 },
    { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 6 },
    { prompt_tokens: 10, completion_tokens: 1.5 }]) {
    const body = responseBody();
    body.usage = usage;
    await withFetch(async () => ({ ok: true, json: async () => body }), async () => {
      const adapter = new DeepSeekAcceptanceAdapter('test-placeholder');
      const emitted = [];
      await assert.rejects(async () => { for await (const chunk of adapter.stream(baseOptions())) emitted.push(chunk); });
      assert.equal(emitted.some(chunk => chunk.type === 'finish'), false);
      assert.deepEqual(adapter.responses, []);
    });
  }
});

test('HTTP failure keeps provider error body private', async () => {
  let readBody = false;
  await withFetch(async () => ({ ok: false, status: 401, json: async () => { readBody = true; throw new Error('private-body'); } }), async () => {
    await assert.rejects(consume(new DeepSeekAcceptanceAdapter('test-placeholder').stream(baseOptions())),
      error => error.message === 'DeepSeek acceptance HTTP 401' && !error.message.includes('private-body'));
    assert.equal(readBody, false);
  });
});

test('call bound rejects before a second HTTP request', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: true, json: async () => responseBody() }; }, async () => {
    const adapter = new DeepSeekAcceptanceAdapter('test-placeholder', 1);
    await consume(adapter.stream(baseOptions()));
    await assert.rejects(consume(adapter.stream(baseOptions())), /call limit reached/);
    assert.equal(calls, 1);
  });
});

test('unsupported content fails before HTTP and caller cancellation reaches fetch', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls++;
    assert.equal(init.signal.aborted, true);
    init.signal.throwIfAborted();
  }, async () => {
    const invalid = baseOptions();
    invalid.messages[0].content = [{ type: 'image', url: 'placeholder' }];
    await assert.rejects(consume(new DeepSeekAcceptanceAdapter('test-placeholder').stream(invalid)), /does not support/);
    assert.equal(calls, 0);
    const cancelled = baseOptions();
    cancelled.signal = AbortSignal.abort(new Error('caller cancelled'));
    await assert.rejects(consume(new DeepSeekAcceptanceAdapter('test-placeholder').stream(cancelled)), /caller cancelled/);
    assert.equal(calls, 1);
  });
});

test('unsupported finish reason or malformed function call never completes', async () => {
  for (const choice of [
    { message: { content: 'refusal' }, finish_reason: 'content_filter' },
    { message: { tool_calls: [{ type: 'function', id: 'bad', function: { name: 'runtime_python', arguments: {} } }] }, finish_reason: 'tool_calls' },
  ]) {
    await withFetch(async () => ({ ok: true, json: async () => ({ ...responseBody(), choices: [choice] }) }), async () => {
      const emitted = [];
      await assert.rejects(async () => { for await (const chunk of new DeepSeekAcceptanceAdapter('test-placeholder').stream(baseOptions())) emitted.push(chunk); });
      assert.equal(emitted.some(chunk => chunk.type === 'finish'), false);
    });
  }
  await withFetch(async () => ({ ok: true, json: async () => ({ ...responseBody(), choices: [
    { message: { content: { unexpected: true } }, finish_reason: 'stop' },
  ] }) }), async () => {
    const emitted = [];
    await assert.rejects(async () => { for await (const chunk of new DeepSeekAcceptanceAdapter('test-placeholder').stream(baseOptions())) emitted.push(chunk); }, /malformed message content/);
    assert.equal(emitted.length, 0);
  });
});
