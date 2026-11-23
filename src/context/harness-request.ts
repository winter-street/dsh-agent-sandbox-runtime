import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, createToolResultMessage, createUserMessage, type ContextFormed, type GenerateOptions, type Message, type ToolCallId } from '@deepseek-ai/dsh-llm';
import type { BudgetControlPort } from '../contracts/budget.js';
import type { RuntimeStore } from '../storage/index.js';
import { RoleNotDispatchedError, type RoleRequest } from '../workflow/serial.js';
import { assembleContext, type ContextEntry, type ContextMessage, type ContextWindow } from './assembler.js';
import { ContextCheckpointStore, createSummarySettlementVerifier } from './checkpoint.js';
import { createHarnessSummaryPort, harnessSummaryRequest } from './harness-summary.js';
import { summarizeContext, type SummaryOptions } from './summarizer.js';
import { retrieveEntityContext, type EntityRecallOptions } from './entity-context.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Trusted runtime recall injected before a role request. */
    'runtime-recall': { kind: 'runtime-recall' } & ContextFormed;
  }
}

export interface HarnessRoleContextOptions {
  store: RuntimeStore;
  modelWindowTokens: number;
  safetyReserveTokens: number;
  protectRecentTools?: number;
  /** Trusted provider counter: include translated system/messages/tools and provider framing. */
  countRequestTokens(request: Readonly<GenerateOptions>): number;
  /** Called only when initializing this run. Layer classification belongs to the trusted host. */
  initialEntries?(request: RoleRequest): readonly ContextEntry[] | Promise<readonly ContextEntry[]>;
  /** Disabled unless explicitly configured; always debited to original root-session work allocation. */
  summary?: Omit<SummaryOptions, 'countRequestTokens'>;
  /** Optional untrusted recall, selected by the host separately for each role request. */
  entities?: EntityRecallOptions;
}
export type RoleContextBlockCode = 'CONTEXT_REQUIRED_TOO_LARGE' | 'CONTEXT_SUMMARY_PENDING' | 'CONTEXT_USAGE_UNKNOWN';
export class RoleContextError extends RoleNotDispatchedError {
  readonly retryable = false;
  constructor(readonly code: RoleContextBlockCode, readonly runId: string) { super(`${code}: context request requires an explicit safe-boundary decision`); this.name = 'RoleContextError'; }
}

/** Only trusted system-layer entries enter system; tool pairs retain Harness correlation. */
export function translateHarnessContext(messages: readonly ContextMessage[], base: GenerateOptions): GenerateOptions {
  const system = [base.system ?? '']; const translated: Message[] = [];
  for (const message of messages) {
    if (message.role === 'system') { system.push(message.content); continue; }
    if (message.toolCall) translated.push(createAssistantMessage({ source: { provider: base.provider, model: base.model },
      content: [{ type: 'tool-call', id: message.toolCall.id as ToolCallId, name: message.toolCall.name, arguments: message.toolCall.arguments }] }));
    else if (message.role === 'tool') translated.push(createToolResultMessage({ callId: message.toolCallId! as ToolCallId, isError: false,
      content: [{ type: 'text', text: message.content }] }));
    else translated.push(createUserMessage({ source: { kind: 'runtime-recall', form: 'recall' }, content: [{ type: 'text', text: message.content }] }));
  }
  return { ...base, system: system.filter(Boolean).join('\n\n'), messages: [...translated, ...base.messages] };
}
function pending(entries: Record<string, { status: string }>): boolean { return Object.values(entries).some(value => value.status === 'pending'); }

/** Prepare and settle optional compaction before the caller captures its role ledger cursor. */
export async function prepareHarnessRoleContext(input: {
  ctx: Context; budget: BudgetControlPort; config: HarnessRoleContextOptions; request: RoleRequest; base: GenerateOptions;
}): Promise<{ request: GenerateOptions; recordResult(value: unknown, receiptId: string): void }> {
  const { config, budget, request, base } = input;
  request.signal?.throwIfAborted();
  const run = config.store.getRun(request.runId);
  if (run.budgetScopeKey !== request.scopeKey || await budget.scopeForSession(request.sessionId, { create: false }) !== request.scopeKey
    || await budget.scopeForSession(run.rootSessionId, { create: false }) !== request.scopeKey) throw new Error('Role context run/session budget binding mismatch');
  const repository = new ContextCheckpointStore(config.store, request.runId);
  if (!repository.load()) {
    const entries = await config.initialEntries?.(request) ?? [];
    repository.initialize([{ id: 'runtime-task', revision: 1, layer: 'task', text: run.task, sourceRefs: [`input:${run.inputHash}`], required: true }, ...entries]);
  }
  const window: ContextWindow = { modelWindowTokens: config.modelWindowTokens, safetyReserveTokens: config.safetyReserveTokens,
    outputReserveTokens: base.maxTokens!, ...(config.protectRecentTools === undefined ? {} : { protectRecentTools: config.protectRecentTools }),
    countTokens: messages => config.countRequestTokens(translateHarnessContext(messages, base)) };
  const verify = createSummarySettlementVerifier(budget, run.rootSessionId, request.scopeKey);
  let restored = await repository.restore(window, verify);
  if (pending(restored.checkpoint.summaryState.fingerprints)) throw new RoleContextError('CONTEXT_SUMMARY_PENDING', request.runId);
  const entryId = `role-history-${createHash('sha256').update(request.callId).digest('hex')}`;
  if (restored.checkpoint.entries.some(entry => entry.id === entryId)) throw new Error('Role context result already recorded; reconcile instead of replaying');
  const available = await budget.snapshot(request.scopeKey);
  if (available.unknownCalls || !available.meteringComplete) throw new RoleContextError('CONTEXT_USAGE_UNKNOWN', request.runId);
  if (config.summary) {
    await summarizeContext({ entries: restored.checkpoint.entries, window, sessionId: run.rootSessionId, scopeKey: request.scopeKey, budget,
      model: createHarnessSummaryPort({ ctx: input.ctx, budget, provider: base.provider, model: base.model }),
      persistence: repository.summaryPersistence(window, verify), priorState: restored.checkpoint.summaryState,
      options: { ...config.summary, countRequestTokens: value => config.countRequestTokens(harnessSummaryRequest(base.provider, base.model, {
        ...value, sessionId: run.rootSessionId, maxOutputTokens: config.summary!.maxOutputTokens ?? 512,
      })) }, ...(request.signal ? { signal: request.signal } : {}) });
    restored = await repository.restore(window, verify);
  }
  if (pending(restored.checkpoint.summaryState.fingerprints)) throw new RoleContextError('CONTEXT_SUMMARY_PENDING', request.runId);
  const settled = await budget.snapshot(request.scopeKey);
  if (settled.unknownCalls || !settled.meteringComplete) throw new RoleContextError('CONTEXT_USAGE_UNKNOWN', request.runId);
  let recalled: Awaited<ReturnType<typeof retrieveEntityContext>> = [];
  try { if (config.entities) recalled = await retrieveEntityContext(config.entities, request); }
  catch (cause) {
    // This boundary precedes the role stream/reservation. Corrected host input can safely retry it.
    const error = new RoleNotDispatchedError(`Entity recall rejected: ${cause instanceof Error ? cause.message : 'invalid evidence'}`);
    error.cause = cause; throw error;
  }
  const assembly = assembleContext([...restored.checkpoint.entries, ...recalled], window);
  if (assembly.status !== 'ready') throw new RoleContextError('CONTEXT_REQUIRED_TOO_LARGE', request.runId);
  request.signal?.throwIfAborted();
  const translated = translateHarnessContext(assembly.messages, base);
  // Count the exact final DTO again, including fixed role instructions, current input and tools.
  const finalCount = config.countRequestTokens(translated);
  if (!Number.isSafeInteger(finalCount) || finalCount < 0) throw new TypeError('Invalid full role request token estimate');
  if (finalCount + base.maxTokens! + config.safetyReserveTokens > config.modelWindowTokens) throw new RoleContextError('CONTEXT_REQUIRED_TOO_LARGE', request.runId);
  const checkpoint = restored.checkpoint;
  return { request: translated, recordResult(value, receiptId) {
    if (checkpoint.entries.some(entry => entry.id === entryId)) throw new Error('Role context result already recorded; reconcile instead of replaying');
    repository.replace(checkpoint.version, [...checkpoint.entries, { id: entryId, revision: 1, layer: 'history',
      text: JSON.stringify(config.entities ? { role: request.role, status: 'completed', recall: 'request-scoped; see original role receipt' }
        : { role: request.role, input: request.input, result: value }), sourceRefs: [`role-call:${request.callId}`, `budget-receipt:${receiptId}`] }]);
  } };
}
