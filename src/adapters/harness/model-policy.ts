import type { Plugin } from '@deepseek-ai/cordis';
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RuntimeConfig } from '../../config.js';
import type { BudgetControlPort, BudgetPurpose } from '../../contracts/budget.js';
import { PolicyEngine, type ModelAdmissionEvidence, type PolicyAction, type PolicyDecision, type PolicySnapshot, type PolicyState } from '../../policy/engine.js';

/** Supplied by trusted application state; never derive purpose/permissions from model text. */
export interface ModelPolicyBinding {
  runId: string;
  budgetScopeKey: string;
  cancelled: boolean;
  deadline: number;
  stepBoundary: number;
  settlementBoundary: number;
  required: boolean;
  purpose: BudgetPurpose;
  intent: 'work' | 'summary' | 'final-report';
  requiredWorkComplete?: boolean;
  permissionDenied?: boolean;
  output?: { kind: 'prose' | 'code' | 'structured'; minTokens: number; defaultMaxTokens: number };
}
type MaybePromise<T> = T | Promise<T>;
export interface HarnessModelPolicyOptions {
  config: RuntimeConfig['policy'];
  budget: BudgetControlPort;
  resolveRun(sessionId: string): MaybePromise<ModelPolicyBinding | undefined>;
  readState(runId: string): MaybePromise<PolicyState | undefined>;
  /** Persist the state and its decision/notification events in one local transaction. */
  commitDecision(runId: string, decision: PolicyDecision, phase: 'request' | 'dispatch' | 'spawn', admission?: ModelAdmissionEvidence): MaybePromise<void>;
  /** Hosts that bind only runtime sessions may leave ordinary sessions without a policy binding. */
  allowUnbound?: boolean;
  now?: () => number;
  /** Host infrastructure gate checked before any new provider request. */
  assertInfrastructureAvailable?: (runId: string) => void;
}

export class ModelPolicyError extends Error {
  readonly code = 'RUNTIME_MODEL_POLICY_BLOCKED';
  constructor(readonly decision: PolicyDecision) {
    super(`Model policy ${decision.disposition}: ${decision.reasons.map(reason => reason.code).join(', ')}`);
    this.name = 'ModelPolicyError';
  }
  get retryable(): boolean { return this.decision.disposition === 'wait'; }
}

/** Conservative reservation estimate shared with the budget plugin; actual usage is owned there. */
export function estimateModelTokens(request: GenerateOptions): number {
  if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens! < 1) throw new TypeError('Model policy requires a positive output token cap');
  const baseline = Math.ceil(Buffer.byteLength(JSON.stringify({ messages: request.messages, system: request.system, tools: request.tools }), 'utf8') / 3) + 256 + request.maxTokens!;
  const total = Math.ceil(baseline * 1.25);
  if (!Number.isSafeInteger(total)) throw new TypeError('Model request estimate exceeds safe integer range');
  return total;
}

export function createHarnessModelPolicy(options: HarnessModelPolicyOptions) {
  const engine = new PolicyEngine(options.config);
  const now = options.now ?? Date.now;
  const active = new Map<string, number>();
  const locks = new Map<string, Promise<void>>();
  let closing = false;

  async function binding(sessionId: string): Promise<ModelPolicyBinding | undefined> {
    if (closing) throw new Error('Model policy plugin is unloading');
    const result = await options.resolveRun(sessionId);
    if (closing) throw new Error('Model policy plugin is unloading');
    if (!result) {
      if (options.allowUnbound) return undefined;
      throw new Error('Model session has no runtime policy binding');
    }
    const actual = await options.budget.scopeForSession(sessionId, { create: false });
    if (actual !== result.budgetScopeKey) throw new Error('Model policy budget scope binding changed');
    return result;
  }
  async function exclusive<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const before = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    locks.set(key, current);
    await before;
    try { return await callback(); }
    finally { release(); if (locks.get(key) === current) locks.delete(key); }
  }
  async function evaluate(subject: ModelPolicyBinding, action: PolicyAction, phase: 'request' | 'dispatch' | 'spawn',
    request?: { sessionId: string; maxTokens: number }) {
    options.assertInfrastructureAvailable?.(subject.runId);
    const budget = await options.budget.snapshot(subject.budgetScopeKey);
    const prior = await options.readState(subject.runId);
    const snapshot: PolicySnapshot = {
      budget, cancelled: subject.cancelled, deadlineExceeded: now() >= subject.deadline,
      inflightModelCalls: active.get(subject.budgetScopeKey) ?? 0,
      stepBoundary: subject.stepBoundary, settlementBoundary: subject.settlementBoundary,
      ...(subject.permissionDenied === undefined ? {} : { permissionDenied: subject.permissionDenied }),
      ...(subject.requiredWorkComplete === undefined ? {} : { requiredWorkComplete: subject.requiredWorkComplete }),
    };
    const decision = engine.evaluate(snapshot, action, prior);
    let admission: ModelAdmissionEvidence | undefined;
    if (!decision.allowed && action.kind === 'model' && request) {
      const { limitTokens, usedTokens, reservedTokens, availableTokens, work, finalize, ledgerSeq,
        unknownCalls, meteringComplete, exhausted } = budget;
      admission = {
        schemaVersion: 1, sessionId: request.sessionId, purpose: action.purpose, required: action.required,
        intent: subject.intent, estimatedTokens: phase === 'dispatch' ? action.estimatedTokens : null,
        requestedMaxTokens: request.maxTokens, rulesFingerprint: decision.state.rulesFingerprint,
        snapshot: { ...snapshot, budget: { limitTokens, usedTokens, reservedTokens, availableTokens, work, finalize,
          ledgerSeq, unknownCalls, meteringComplete, exhausted } },
      };
    }
    await options.commitDecision(subject.runId, decision, phase, admission);
    return decision;
  }
  function assertAllowed(decision: PolicyDecision): void {
    // Return a bounded retryable wait decision. Scheduling/backoff belongs to the runtime.
    if (!decision.allowed) throw new ModelPolicyError(decision);
  }
  async function assertCanSpawn(sessionId: string, required = false): Promise<PolicyDecision> {
    const subject = await binding(sessionId);
    if (!subject) throw new Error('Model spawn requires a runtime policy binding');
    return exclusive(subject.budgetScopeKey, async () => {
      const fresh = await binding(sessionId);
      if (!fresh) throw new Error('Model spawn lost its runtime policy binding');
      const decision = await evaluate(fresh, { kind: 'spawn-agent', required }, 'spawn');
      assertAllowed(decision);
      return decision;
    });
  }
  const plugin: Plugin.Object<void> = {
    name: 'runtime-model-policy', inject: ['llm', 'agents'],
    apply(ctx) {
      ctx.effect(() => () => { closing = true; });
      ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
        const cfg = await next();
        payload.signal.throwIfAborted();
        const sessionId = String(payload.agent.session.id);
        const subject = await binding(sessionId);
        if (!subject) return cfg;
        return exclusive(subject.budgetScopeKey, async () => {
          const fresh = await binding(sessionId);
          if (!fresh) return cfg;
          // Only a binding that declares an output contract may cap the answer,
          // and only when the caller has no bound of its own. Without either,
          // the runtime never writes a maxTokens of its own: the caller/DSH
          // decision stands and a long answer is not silently truncated.
          const output = fresh.output;
          const cap = cfg.maxTokens ?? output?.defaultMaxTokens;
          if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < (output?.minTokens ?? 1))) throw new Error('Model output cap is below the trusted minimum');
          // Messages are assembled after this hook. Cost admission uses the complete final request below.
          const decision = await evaluate(fresh, {
            kind: 'model', purpose: fresh.purpose, required: fresh.required, intent: fresh.intent,
            estimatedTokens: 1,
            ...(output ? { output: { kind: output.kind, minTokens: output.minTokens, maxTokens: output.defaultMaxTokens } } : {}),
          }, 'request', cap === undefined ? undefined : { sessionId, maxTokens: cap });
          payload.signal.throwIfAborted();
          if (closing) throw new Error('Model policy plugin is unloading');
          assertAllowed(decision);
          // Anchor to the trusted baseline, not the previous reduced persisted header.
          const limit = decision.limits.outputTokenCap;
          const effective = limit === undefined ? cfg.maxTokens : Math.min(cfg.maxTokens ?? limit, limit);
          return effective === undefined || effective === cfg.maxTokens ? cfg : { ...cfg, maxTokens: effective };
        });
      }, { prepend: true });
      ctx.on('llm/stream', (request, next) => (async function* (): AsyncGenerator<StreamChunk> {
        if (request.sessionId === undefined) throw new Error('Runtime model policy requires a session ID');
        const sessionId = String(request.sessionId);
        request.signal?.throwIfAborted();
        const subject = await binding(sessionId);
        if (!subject) {
          // Ordinary sessions stay outside the runtime policy; the budget plugin still meters the call.
          for await (const chunk of next()) yield chunk;
          return;
        }
        let accepted: ModelPolicyBinding | undefined;
        await exclusive(subject.budgetScopeKey, async () => {
          const fresh = await binding(sessionId);
          if (!fresh) throw new Error('Model policy lost its runtime binding during dispatch');
          request.signal?.throwIfAborted();
          if (fresh.output && request.maxTokens! < fresh.output.minTokens) throw new Error('Final request output cap is below the trusted minimum');
          const decision = await evaluate(fresh, {
            kind: 'model', purpose: fresh.purpose, required: fresh.required, intent: fresh.intent,
            estimatedTokens: estimateModelTokens(request),
            ...(fresh.output ? { output: { kind: fresh.output.kind, minTokens: fresh.output.minTokens, maxTokens: fresh.output.defaultMaxTokens } } : {}),
          }, 'dispatch', { sessionId, maxTokens: request.maxTokens! });
          request.signal?.throwIfAborted();
          if (closing) throw new Error('Model policy plugin is unloading');
          assertAllowed(decision);
          if (decision.limits.outputTokenCap !== undefined && request.maxTokens! > decision.limits.outputTokenCap) {
            throw new Error('Final request exceeds the policy output cap; rebuild through agent/request before dispatch');
          }
          active.set(fresh.budgetScopeKey, (active.get(fresh.budgetScopeKey) ?? 0) + 1);
          accepted = fresh;
        });
        const admitted = accepted!;
        let iterator: AsyncIterator<StreamChunk> | undefined;
        let completed = false;
        try {
          // Invoke the downstream budget hook and consume every iterator operation in the same trusted context.
          iterator = options.budget.withPurpose(sessionId, admitted.purpose, () => next()[Symbol.asyncIterator]());
          while (true) {
            const result = await options.budget.withPurpose(sessionId, admitted.purpose, () => iterator!.next());
            if (result.done) { completed = true; break; }
            yield result.value;
          }
        } finally {
          try {
            if (!completed && iterator?.return) await options.budget.withPurpose(sessionId, admitted.purpose, () => iterator!.return!());
          } finally {
            const count = (active.get(admitted.budgetScopeKey) ?? 1) - 1;
            if (count === 0) active.delete(admitted.budgetScopeKey); else active.set(admitted.budgetScopeKey, count);
          }
        }
      })(), { prepend: true });
    },
  };
  return { plugin, assertCanSpawn, inflightCalls: (scopeKey: string) => active.get(scopeKey) ?? 0 };
}
