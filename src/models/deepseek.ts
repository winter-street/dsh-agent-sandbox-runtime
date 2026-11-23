import { attributionHeaders, LlmAdapter, type ToolCallId, type GenerateOptions, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm';
import type { RuntimeGenerateOptions } from './generate-options.js';

export interface DeepSeekAdapterOptions {
  apiKey: string;
  /** Explicitly select the provider mode instead of inheriting changing API defaults. */
  thinking?: 'enabled' | 'disabled';
  endpoint?: string;
  maxCalls?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

type WireMessage = { role: string; content?: string | null; reasoning_content?: string; tool_calls?: unknown[]; tool_call_id?: string };
type ToolState = { id: ToolCallId; name: string; args: string; index: number };

/** Tool results are first-class `tool` messages in 0.2.2, not assistant content blocks. */
function resultText(message: Extract<GenerateOptions['messages'][number], { role: 'tool' }>): string {
  return message.content.every(block => block.type === 'text')
    ? message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    : JSON.stringify(message.content);
}

function wireMessages(options: GenerateOptions): WireMessage[] {
  const output: WireMessage[] = [];
  if (options.system) output.push({ role: 'system', content: typeof options.system === 'string' ? options.system : String(options.system) });
  for (const message of options.messages) {
    // Developer messages only carry tool add/remove bookkeeping; declarations travel in `options.tools`.
    if (message.role === 'developer') continue;
    if (message.role === 'tool') { output.push({ role: 'tool', tool_call_id: message.toolCallId, content: resultText(message) }); continue; }
    const text: string[] = []; const reasoning: string[] = []; const calls: unknown[] = [];
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'reasoning') reasoning.push(block.text);
      else if (block.type === 'tool-call') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } });
      else throw new Error(`DeepSeek adapter does not support content block ${block.type}`);
    }
    const replay = message.role === 'assistant' && reasoning.length ? { reasoning_content: reasoning.join('') } : {};
    if (calls.length) output.push({ role: 'assistant', content: text.join('\n') || null, ...replay, tool_calls: calls });
    else if (text.length || reasoning.length) output.push({ role: message.role, content: text.join('\n') || null, ...replay });
  }
  return output;
}

function tools(value: ToolSchema[] | undefined): unknown[] | undefined {
  return value?.length ? value.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : undefined;
}
function token(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`DeepSeek response has invalid ${label}`);
  return value as number;
}
function finish(reason: unknown): { kind: 'stop' | 'tool-calls' | 'max-tokens' } {
  if (reason === 'stop') return { kind: 'stop' };
  if (reason === 'tool_calls') return { kind: 'tool-calls' };
  if (reason === 'length') return { kind: 'max-tokens' };
  throw new Error('DeepSeek response has unsupported finish reason');
}
function abortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Direct DeepSeek Chat Completions adapter. It streams provider SSE without retries or buffering fallback. */
export class DeepSeekAdapter extends LlmAdapter {
  private calls = 0;
  private readonly endpoint: string;
  private readonly maxCalls: number | undefined;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;
  constructor(private readonly options: DeepSeekAdapterOptions) {
    super();
    if (!options.apiKey.trim()) throw new TypeError('DeepSeek API key is required');
    if (options.thinking !== undefined && !['enabled', 'disabled'].includes(options.thinking)) throw new TypeError('thinking must be enabled or disabled');
    this.endpoint = options.endpoint ?? 'https://api.deepseek.com/chat/completions';
    this.maxCalls = options.maxCalls;
    this.timeoutMs = options.requestTimeoutMs ?? 90_000;
    this.request = options.fetch ?? fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new TypeError('requestTimeoutMs must be positive');
    if (this.maxCalls !== undefined && (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1)) throw new TypeError('maxCalls must be positive');
  }
  override providerInfo(provider: string) { return { id: provider, name: 'DeepSeek Chat Completions' }; }
  override async listModels(provider: string) { return [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text' as const] }]; }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, inputModalities: ['text' as const] }; }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.maxCalls !== undefined && this.calls >= this.maxCalls) throw new Error('DeepSeek adapter call limit reached');
    this.calls++;
    options.signal?.throwIfAborted();
    const body: Record<string, unknown> = { model: options.model, messages: wireMessages(options), stream: true, stream_options: { include_usage: true },
      thinking: { type: this.options.thinking ?? 'disabled' }, temperature: options.temperature ?? 0 };
    if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.stop?.length) body.stop = options.stop;
    if ((options as RuntimeGenerateOptions).responseFormat === 'json-object') body.response_format = { type: 'json_object' };
    const mappedTools = tools(options.tools); if (mappedTools) body.tools = mappedTools;
    const response = await this.request(this.endpoint, { method: 'POST', headers: { ...attributionHeaders(), authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abortSignal(options.signal, this.timeoutMs) });
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    if (!response.body) throw new Error('DeepSeek response has no SSE body');
    const decoder = new TextDecoder(); let buffer = ''; const states = new Map<number, ToolState>(); let nextIndex = 0;
    let textIndex: number | undefined; let textValue = ''; let reasoningIndex: number | undefined; let reasoningValue = '';
    let terminal: { kind: 'stop' | 'tool-calls' | 'max-tokens' } | undefined; let usage: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_cache_hit_tokens?: unknown; prompt_cache_miss_tokens?: unknown } | undefined;
    const emit = (payload: unknown): StreamChunk[] => {
      if (!payload || typeof payload !== 'object') throw new Error('DeepSeek SSE payload is not an object');
      const record = payload as { choices?: unknown; usage?: unknown };
      if (record.usage !== undefined) usage = record.usage as typeof usage;
      if (!Array.isArray(record.choices)) return [];
      const result: StreamChunk[] = [];
      for (const choiceValue of record.choices) {
        if (!choiceValue || typeof choiceValue !== 'object') throw new Error('DeepSeek SSE choice is malformed');
        const choice = choiceValue as { delta?: unknown; finish_reason?: unknown };
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) terminal = finish(choice.finish_reason);
        if (!choice.delta || typeof choice.delta !== 'object') continue;
        const delta = choice.delta as { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
        if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
          if (typeof delta.reasoning_content !== 'string') throw new Error('DeepSeek reasoning delta is malformed');
          if (delta.reasoning_content) {
            if (reasoningIndex === undefined) { reasoningIndex = nextIndex++; result.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }); }
            reasoningValue += delta.reasoning_content; result.push({ type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content });
          }
        }
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== 'string') throw new Error('DeepSeek text delta is malformed');
          if (delta.content) {
            if (textIndex === undefined) { textIndex = nextIndex++; result.push({ type: 'block-start', index: textIndex, blockType: 'text' }); }
            textValue += delta.content; result.push({ type: 'text-delta', index: textIndex, text: delta.content });
          }
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error('DeepSeek tool delta is malformed');
          for (const itemValue of delta.tool_calls) {
            if (!itemValue || typeof itemValue !== 'object') throw new Error('DeepSeek tool delta is malformed');
            const item = itemValue as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
            const providerIndex = token(item.index ?? 0, 'tool index');
            let state = states.get(providerIndex);
            const name = item.function?.name; const args = item.function?.arguments;
            if (!state) { if (typeof item.id !== 'string' || !item.id || typeof name !== 'string' || !name) throw new Error('DeepSeek first tool delta is incomplete'); state = { id: item.id as ToolCallId, name, args: '', index: nextIndex++ }; states.set(providerIndex, state); result.push({ type: 'block-start', index: state.index, blockType: 'tool-call' }); }
            if (name !== undefined && typeof name !== 'string') throw new Error('DeepSeek tool name is malformed');
            if (args !== undefined && typeof args !== 'string') throw new Error('DeepSeek tool arguments are malformed');
            if (typeof args === 'string') { state.args += args; result.push({ type: 'tool-call-delta', index: state.index, id: state.id, ...(name ? { name } : {}), argumentsDelta: args }); }
          }
        }
      }
      return result;
    };
    const reader = response.body.getReader();
    try {
      while (true) {
        const read = await reader.read(); if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const value = line.slice(5).trim(); if (value === '[DONE]') continue;
          let payload: unknown; try { payload = JSON.parse(value); } catch { throw new Error('DeepSeek SSE data is invalid JSON'); }
          for (const chunk of emit(payload)) yield chunk;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error('DeepSeek SSE ended with an incomplete frame');
    } finally { try { await reader.cancel(); } catch { /* disconnect is already terminal */ } }
    if (!terminal) throw new Error('DeepSeek SSE ended without a finish reason');
    if (usage !== undefined) {
      const prompt = token(usage.prompt_tokens, 'prompt_tokens'); const output = token(usage.completion_tokens, 'completion_tokens'); const read = token(usage.prompt_cache_hit_tokens ?? 0, 'prompt_cache_hit_tokens');
      if (read > prompt) throw new Error('DeepSeek cache usage exceeds prompt total');
      if (usage.prompt_cache_miss_tokens !== undefined && token(usage.prompt_cache_miss_tokens, 'prompt_cache_miss_tokens') + read !== prompt) throw new Error('DeepSeek prompt cache buckets do not sum to prompt total');
      yield { type: 'usage', usage: { inputTokens: prompt - read, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: 0 } };
    }
    if (reasoningIndex !== undefined) yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningValue } };
    if (textIndex !== undefined) yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textValue } };
    for (const state of states.values()) yield { type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args } };
    yield { type: 'finish', reason: terminal };
  }
}
