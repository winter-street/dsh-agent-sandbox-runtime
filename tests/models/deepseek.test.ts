import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter } from '../../src/models/deepseek.js';
import type { RuntimeGenerateOptions } from '../../src/models/generate-options.js';

const requests: Array<{ body: Record<string, unknown>; signal: AbortSignal }> = [];
afterEach(() => { requests.length = 0; vi.restoreAllMocks(); });
const options = (): GenerateOptions => ({ provider: 'deepseek', model: 'deepseek-chat', sessionId: 'session' as never, maxTokens: 64,
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })] });
function response(frames: string[], signal?: AbortSignal): Response {
  const encoder = new TextEncoder(); const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
async function collect(adapter: DeepSeekAdapter, request = options()) { const chunks = []; for await (const chunk of adapter.stream(request)) chunks.push(chunk); return chunks; }
describe('DeepSeek SSE adapter', () => {
  it('requests JSON mode only for explicitly marked calls', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal });
      return response(['data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n']);
    });
    const adapter = new DeepSeekAdapter({ apiKey: 'secret', fetch });
    const marked: RuntimeGenerateOptions = { ...options(), responseFormat: 'json-object' };
    await collect(adapter, marked); await collect(adapter);
    expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(requests[1]!.body).not.toHaveProperty('response_format');
  });
  it('maps text/tool deltas and disjoint usage from provider SSE', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; requests.push({ body, signal: init.signal as AbortSignal });
      return response([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"runtime_python","arguments":"{\\"code\\":\\"pass\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":""}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":30,"prompt_cache_hit_tokens":20,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    const chunks = await collect(new DeepSeekAdapter({ apiKey: 'secret', fetch }));
    expect(requests[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 64, thinking: { type: 'disabled' } });
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(1);
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5, cacheWriteTokens: 0 } });
    expect(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toMatchObject({ block: { name: 'runtime_python', arguments: '{"code":"pass"}' } });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } });
  });
  it('does not synthesize usage when provider omits it', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => { requests.push({ body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal }); return response(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']); });
    const chunks = await collect(new DeepSeekAdapter({ apiKey: 'secret', fetch }));
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false);
  });
  it('preserves reasoning separately and replays it with tool-call history in explicit thinking mode', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal });
      return response([
        'data: {"choices":[{"delta":{"reasoning_content":"internal segment"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-reasoned","function":{"name":"runtime_python","arguments":"{\\"code\\":\\"pass\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":15}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    const adapter = new DeepSeekAdapter({ apiKey: 'secret', thinking: 'enabled', fetch });
    const chunks = await collect(adapter);
    expect(requests[0]!.body).toMatchObject({ thinking: { type: 'enabled' } });
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toEqual([{ type: 'reasoning-delta', index: 0, text: 'internal segment' }]);
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([]);
    const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : []);
    const next = options();
    next.messages.push(createAssistantMessage({ source: { provider: 'deepseek', model: 'deepseek-chat' }, content: blocks }));
    await collect(adapter, next);
    const messages = requests[1]!.body.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: null, reasoning_content: 'internal segment',
      tool_calls: [{ id: 'call-reasoned', function: { name: 'runtime_python', arguments: '{"code":"pass"}' } }] });
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { outputTokens: 15 } });
  });
  it('surfaces a reasoning-only length stop instead of silently producing an empty answer', async () => {
    const fetch = vi.fn(async () => response([
      'data: {"choices":[{"delta":{"reasoning_content":"unfinished work"},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":64}}\n\n',
      'data: [DONE]\n\n',
    ]));
    const chunks = await collect(new DeepSeekAdapter({ apiKey: 'secret', fetch }));
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({ block: { type: 'reasoning', text: 'unfinished work' } });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } });
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false);
  });
  it('rejects malformed reasoning deltas instead of discarding them', async () => {
    const fetch = vi.fn(async () => response(['data: {"choices":[{"delta":{"reasoning_content":123},"finish_reason":"stop"}]}\n\n']));
    await expect(collect(new DeepSeekAdapter({ apiKey: 'secret', fetch }))).rejects.toThrow('reasoning delta');
  });
  it('fails on a disconnected SSE stream without finish and propagates cancellation', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => { requests.push({ body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal }); return response(['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n']); });
    await expect(collect(new DeepSeekAdapter({ apiKey: 'secret', fetch }))).rejects.toThrow('without a finish');
    const request = options(); request.signal = AbortSignal.abort(new Error('cancelled'));
    await expect(collect(new DeepSeekAdapter({ apiKey: 'secret', fetch }), request)).rejects.toThrow('cancelled');
  });
  it('rejects malformed usage and provider HTTP errors without exposing response bodies', async () => {
    const badUsage = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => { requests.push({ body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal }); return response(['data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"prompt_cache_hit_tokens":4,"completion_tokens":1}}\n\n', 'data: [DONE]\n\n']); });
    await expect(collect(new DeepSeekAdapter({ apiKey: 'secret', fetch: badUsage }))).rejects.toThrow('cache usage');
    const failed = vi.fn(async (_url: string | URL | Request, _init: RequestInit = {}) => new Response('private-provider-body', { status: 401 }));
    await expect(collect(new DeepSeekAdapter({ apiKey: 'secret', fetch: failed }))).rejects.toThrow('DeepSeek HTTP 401');
  });
});
