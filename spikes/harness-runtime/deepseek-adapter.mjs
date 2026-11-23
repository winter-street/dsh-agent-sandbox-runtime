import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';

// Deliberately narrow Chat Completions adapter for this acceptance entry.
// HTTP response is buffered; this does NOT validate provider SSE/disconnect semantics.
function wireMessages(options) {
  const output = [];
  if (options.system) {
    const text = typeof options.system === 'string' ? options.system : options.system.map(p => p.text).join('\n');
    output.push({ role: 'system', content: text });
  }
  for (const message of options.messages) {
    const role = message.role;
    const text = [];
    const calls = [];
    const results = [];
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'tool-call') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } });
      else if (block.type === 'tool-result') results.push({ role: 'tool', tool_call_id: block.toolCallId,
        content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) });
      else throw new Error(`Spike adapter does not support content block ${block.type}`);
    }
    if (calls.length) output.push({ role: 'assistant', content: text.join('\n') || null, tool_calls: calls });
    else if (text.length) output.push({ role: role === 'developer' ? 'system' : role, content: text.join('\n') });
    output.push(...results);
  }
  return output;
}

export function* textChunks(text, index = 0) {
  yield { type: 'block-start', index, blockType: 'text' };
  yield { type: 'text-delta', index, text };
  yield { type: 'block-end', index, block: { type: 'text', text } };
}
export function* callChunks(block, index = 0) {
  yield { type: 'block-start', index, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index, block };
}

function token(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or invalid provider ${label}`);
  return value;
}

export class DeepSeekAcceptanceAdapter extends LlmAdapter {
  calls = 0;
  responses = [];
  constructor(apiKey, maxCalls = 4) { super(); this.apiKey = apiKey; this.maxCalls = maxCalls; }
  providerInfo(provider) { return { id: provider, name: 'DeepSeek (acceptance)' }; }
  async listModels(provider) { return [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text'] }]; }
  async *stream(options) {
    if (this.calls >= this.maxCalls) throw new Error('Acceptance provider call limit reached');
    this.calls++;
    const requestBody = { model: options.model, messages: wireMessages(options), max_tokens: options.maxTokens,
      stream: false, temperature: options.temperature ?? 0,
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? { tools: options.tools.map(t => ({ type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}) };
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { ...attributionHeaders(), authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(90_000)]),
    });
    if (!response.ok) throw new Error(`DeepSeek acceptance HTTP ${response.status}`);
    const body = await response.json();
    const choice = body.choices?.[0];
    if (!choice?.message) throw new Error('Provider response has no choice/message');
    const finishReason = choice.finish_reason;
    if (!['stop', 'tool_calls', 'length'].includes(finishReason)) throw new Error('Provider finish reason is unsupported');
    const message = choice.message;
    if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') {
      throw new Error('Provider returned malformed message content');
    }
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
      throw new Error('Provider returned malformed function calls');
    }
    // Validate every function call before yielding any response block. This
    // prevents a malformed later call from exposing a partial completion.
    const toolCalls = [];
    for (const call of message.tool_calls ?? []) {
      if (call.type !== 'function' || !call.id || !call.function?.name || typeof call.function.arguments !== 'string') {
        throw new Error('Provider returned malformed function call');
      }
      toolCalls.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    // Capture response usage only, never response body, credentials or request content.
    const raw = body.usage;
    const prompt = token(raw?.prompt_tokens, 'prompt_tokens');
    const output = token(raw?.completion_tokens, 'completion_tokens');
    const read = token(raw?.prompt_cache_hit_tokens ?? 0, 'prompt_cache_hit_tokens');
    if (read > prompt) throw new Error('Provider cache usage exceeds prompt total');
    const miss = raw?.prompt_cache_miss_tokens;
    if (miss !== undefined && token(miss, 'prompt_cache_miss_tokens') + read !== prompt) throw new Error('Provider prompt cache buckets do not sum to prompt total');
    this.responses.push({ prompt_tokens: prompt, completion_tokens: output, prompt_cache_hit_tokens: read,
      ...(miss === undefined ? {} : { prompt_cache_miss_tokens: miss }), finishReason: choice.finish_reason });
    let index = 0;
    if (message.content) yield* textChunks(message.content, index++);
    for (const call of toolCalls) {
      yield* callChunks(call, index++);
    }
    yield { type: 'usage', usage: { inputTokens: prompt - read, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: 0 } };
    yield { type: 'finish', reason: { kind: finishReason === 'tool_calls' ? 'tool-calls' : finishReason === 'length' ? 'max-tokens' : 'stop' } };
  }
}
