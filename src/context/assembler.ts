import { createHash } from 'node:crypto';

export type ContextLayer = 'system' | 'task' | 'plan' | 'history' | 'summary' | 'entities' | 'artifacts' | 'tool';
interface ContextEntryBase {
  id: string;
  revision: number;
  required?: boolean;
  sourceRefs: string[];
}
export interface TextContextEntry extends ContextEntryBase {
  layer: Exclude<ContextLayer, 'tool'>;
  text: string;
}
export interface ToolContextEntry extends ContextEntryBase {
  layer: 'tool';
  callId: string;
  toolName: string;
  arguments: string;
  result: string;
}
export type ContextEntry = TextContextEntry | ToolContextEntry;
/** Provider-neutral DTO: adapters must translate while preserving paired tool identities. */
export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  source: { entryId: string; layer: ContextLayer; revision: number; refs: string[] };
  toolCall?: { id: string; name: string; arguments: string };
  toolCallId?: string;
}
export interface ContextWindow {
  modelWindowTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  /** Must count the full translated request (including its protocol overhead) in production. */
  countTokens(messages: readonly ContextMessage[]): number;
  protectRecentTools?: number;
}
export interface ContextAssembly {
  status: 'ready' | 'paused';
  reason?: 'REQUIRED_CONTEXT_TOO_LARGE';
  messages: ContextMessage[];
  retained: ContextEntry[];
  dropped: Array<{ id: string; reason: 'duplicate' | 'window' }>;
  inputCapacityTokens: number;
  originalInputTokens: number;
  inputTokens: number;
  protectedIds: string[];
}

export function validateContextEntries(entries: readonly ContextEntry[]): void {
  const ids = new Set<string>();
  const calls = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new TypeError('Context entries require unique nonempty IDs');
    ids.add(entry.id);
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 0) throw new TypeError('Context revision must be a nonnegative integer');
    if (!Array.isArray(entry.sourceRefs) || entry.sourceRefs.some(ref => typeof ref !== 'string' || !ref)) throw new TypeError('Context source references must be nonempty strings');
    if (entry.required !== undefined && typeof entry.required !== 'boolean') throw new TypeError('Invalid required context flag');
    if (entry.layer === 'tool') {
      if (typeof entry.callId !== 'string' || !entry.callId || calls.has(entry.callId) || typeof entry.toolName !== 'string' || !entry.toolName || typeof entry.arguments !== 'string' || typeof entry.result !== 'string') {
        throw new TypeError('Tool context requires one unique complete call/result pair');
      }
      calls.add(entry.callId);
      const args: unknown = JSON.parse(entry.arguments);
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Tool arguments must be a JSON object');
    } else if (!['system', 'task', 'plan', 'history', 'summary', 'entities', 'artifacts'].includes(entry.layer) || typeof entry.text !== 'string') {
      throw new TypeError('Invalid text context layer/content');
    }
  }
}

export function contextMessages(entries: readonly ContextEntry[]): ContextMessage[] {
  validateContextEntries(entries);
  const messages: ContextMessage[] = [];
  // The trusted application owns system entries. No other layer can become a system message.
  for (const entry of [...entries.filter(item => item.layer === 'system'), ...entries.filter(item => item.layer !== 'system')]) {
    const source = { entryId: entry.id, layer: entry.layer, revision: entry.revision, refs: [...entry.sourceRefs] };
    if (entry.layer === 'tool') {
      messages.push({ role: 'assistant', content: '', source,
        toolCall: { id: entry.callId, name: entry.toolName, arguments: entry.arguments } });
      messages.push({ role: 'tool', content: entry.result, source: { ...source, refs: [...source.refs] }, toolCallId: entry.callId });
    } else {
      messages.push({ role: entry.layer === 'system' ? 'system' : 'user', content: entry.text, source });
    }
  }
  return messages;
}

/** A deterministic estimate for demos; not a provider-specific tokenizer guarantee. */
export function estimateContextTokens(messages: readonly ContextMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

export function contextFingerprint(entries: readonly ContextEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function protectedContextIds(entries: readonly ContextEntry[], protectRecentTools = 3): Set<string> {
  if (!Number.isSafeInteger(protectRecentTools) || protectRecentTools < 0) throw new TypeError('protectRecentTools must be a nonnegative integer');
  const ids = new Set(entries.filter(entry => entry.required || entry.layer === 'system' || entry.layer === 'task' || entry.layer === 'artifacts').map(entry => entry.id));
  if (protectRecentTools > 0) {
    for (const entry of entries.filter(entry => entry.layer === 'tool').slice(-protectRecentTools)) ids.add(entry.id);
  }
  return ids;
}

export function countContextTokens(entries: readonly ContextEntry[], window: ContextWindow): number {
  const count = window.countTokens(contextMessages(entries));
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Context token counter returned an invalid result');
  return count;
}

export function inputCapacity(window: ContextWindow): number {
  for (const value of [window.modelWindowTokens, window.outputReserveTokens, window.safetyReserveTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Window and reserve tokens must be nonnegative safe integers');
  }
  if (window.modelWindowTokens === 0) throw new TypeError('Model window must be positive');
  const capacity = window.modelWindowTokens - window.outputReserveTokens - window.safetyReserveTokens;
  if (capacity < 0) throw new TypeError('Output and safety reserves exceed the model window');
  return capacity;
}

function duplicateKey(entry: ContextEntry): string {
  return JSON.stringify(entry.layer === 'tool'
    ? [entry.layer, entry.toolName, entry.arguments, entry.result, entry.sourceRefs]
    : [entry.layer, entry.text, entry.sourceRefs]);
}

/** Remove whole entries/pairs, preserving mandatory context even if the request must pause. */
export function assembleContext(entries: readonly ContextEntry[], window: ContextWindow): ContextAssembly {
  validateContextEntries(entries);
  const capacity = inputCapacity(window);
  const protectedIds = protectedContextIds(entries, window.protectRecentTools);
  const originalInputTokens = countContextTokens(entries, window);
  const dropped: ContextAssembly['dropped'] = [];
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  // Keep the newest duplicate; mandatory and recent tool entries never disappear.
  for (const entry of [...entries].reverse()) {
    const key = duplicateKey(entry);
    if (seen.has(key) && !protectedIds.has(entry.id)) duplicateIds.add(entry.id);
    else seen.add(key);
  }
  let retained = entries.filter(entry => !duplicateIds.has(entry.id));
  for (const entry of entries) if (duplicateIds.has(entry.id)) dropped.push({ id: entry.id, reason: 'duplicate' });
  const removalOrder: Record<ContextLayer, number> = {
    system: 99, task: 99, artifacts: 99, tool: 0, history: 1, plan: 2, entities: 3, summary: 4,
  };
  const candidates = retained.filter(entry => !protectedIds.has(entry.id))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => removalOrder[a.entry.layer] - removalOrder[b.entry.layer] || a.index - b.index);
  let tokens = countContextTokens(retained, window);
  for (const { entry } of candidates) {
    if (tokens <= capacity) break;
    retained = retained.filter(item => item.id !== entry.id);
    dropped.push({ id: entry.id, reason: 'window' });
    tokens = countContextTokens(retained, window);
  }
  const status = tokens <= capacity ? 'ready' : 'paused';
  return {
    status, ...(status === 'paused' ? { reason: 'REQUIRED_CONTEXT_TOO_LARGE' as const } : {}),
    messages: contextMessages(retained),
    retained: structuredClone(retained), dropped, inputCapacityTokens: capacity,
    originalInputTokens, inputTokens: tokens, protectedIds: [...protectedIds],
  };
}
