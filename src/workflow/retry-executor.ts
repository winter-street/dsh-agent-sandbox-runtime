import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { RuntimeCodeExecutor, RuntimeCodeResult } from '../adapters/harness/index.js';
import { RuntimeError, RuntimeIdentitySchema, type AttemptRecord } from '../contracts/runtime.js';
import type { ExecuteCodeInput, RuntimeService } from '../core/service.js';
import { argumentHash } from '../core/approvals.js';
import { RetryController, type FailureClass } from './retry.js';

export interface RetryExecutorOptions {
  /** Includes the first execution. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  inputHash: hashSchema, codeHash: hashSchema, configHash: hashSchema, runInputHash: hashSchema,
  budgetScopeKey: z.string().min(1), rootSessionId: z.string().min(1), deadline: z.int().nonnegative().safe(),
  runtimeIdentity: RuntimeIdentitySchema,
});
const stateSchema = z.strictObject({
  version: z.literal(1), binding: bindingSchema,
  phase: z.enum(['pending', 'waiting', 'blocked', 'done']),
  dispatchNo: z.int().positive().safe(), attemptNo: z.int().positive().safe(),
  attemptId: z.string().min(1).nullable(),
  failure: z.enum(['invalid-input', 'transient-unsent', 'transient-idempotent', 'budget', 'cancelled', 'unknown', 'permanent']).nullable(),
}).refine(s => s.attemptNo === s.dispatchNo
  && (s.phase === 'pending' ? s.attemptId === null && s.failure === null
    : s.phase === 'done' ? s.attemptId !== null && s.failure === null
      : s.phase === 'waiting' ? s.attemptId !== null && s.failure === 'transient-unsent' : s.failure !== null));
export type RetryExecutionState = z.infer<typeof stateSchema>;
const resultSchema = z.object({ attemptId: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.int(), artifacts: z.array(z.string()) });

/**
 * Durable, conservative wrapper around the actual RuntimeService. Only a persisted
 * sandbox-creation failure with no code execution identity permits an automatic retry.
 * An unclassified pending wrapper intent requires reconciliation after restart.
 */
export class DurableRetryExecutor implements RuntimeCodeExecutor {
  private readonly controller: RetryController;
  private readonly bounds: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(private readonly service: RuntimeService, options: RetryExecutorOptions) {
    this.bounds = Object.freeze({ maxAttempts: options.maxAttempts, baseDelayMs: options.baseDelayMs, maxDelayMs: options.maxDelayMs });
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, signal ? { signal } : undefined));
    this.controller = new RetryController(service.store, this.bounds, this.now);
  }
  get configHash(): string {
    return argumentHash({ runtime: this.service.config, retry: this.bounds });
  }

  state(runId: string, stepId: string): RetryExecutionState | undefined {
    const raw = this.service.store.getComponentState<unknown>(runId, 'retry-executor', stepId);
    if (raw === undefined) return undefined;
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) throw new RuntimeError('VERSION_MISMATCH', 'Invalid retry execution state; reconcile before dispatch');
    return parsed.data;
  }
  private key(stepId: string): string { return `code-${digest(stepId)}`; }
  private binding(input: ExecuteCodeInput): RetryExecutionState['binding'] {
    const run = this.service.store.getRun(input.runId);
    const identity = RuntimeIdentitySchema.safeParse(this.service.store.getComponentState(input.runId, 'runtime', 'identity'));
    if (!identity.success) throw new RuntimeError('VERSION_MISMATCH', 'Run has no compatible runtime identity');
    return {
      inputHash: digest(JSON.stringify([input.code, input.inputs.map(i => [i.path, digest(i.content)])])),
      codeHash: digest(input.code), configHash: this.configHash,
      runInputHash: run.inputHash, budgetScopeKey: run.budgetScopeKey, rootSessionId: run.rootSessionId,
      deadline: run.deadline, runtimeIdentity: identity.data,
    };
  }
  private assertBinding(state: RetryExecutionState, binding: RetryExecutionState['binding']): void {
    if (argumentHash(state.binding) !== argumentHash(binding)) throw new RuntimeError('VERSION_MISMATCH', 'Retry inputs, configuration, scope or original deadline changed');
  }
  private assertRunning(input: ExecuteCodeInput, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const run = this.service.store.getRun(input.runId);
    if (run.status !== 'RUNNING') throw new RuntimeError('CONFLICT', 'Retry task is paused or terminal');
    if (this.now() >= run.deadline) throw new RuntimeError('EXECUTION_TIMEOUT', 'Original retry deadline elapsed');
  }
  private attempt(input: ExecuteCodeInput, state: RetryExecutionState): AttemptRecord | undefined {
    const step = this.service.store.getStep(input.stepId);
    if (step && (step.runId !== input.runId || step.inputHash !== state.binding.inputHash || step.kind !== 'python')) {
      throw new RuntimeError('VERSION_MISMATCH', 'Retry step identity changed');
    }
    const attempts = this.service.store.listAttempts(input.runId).filter(a => a.stepId === input.stepId);
    if (attempts.length > state.attemptNo || attempts.some(a => a.codeHash !== state.binding.codeHash)) {
      throw new RuntimeError('CONFLICT', 'Retry history contains an unbound attempt');
    }
    const attempt = attempts.find(a => a.attemptNo === state.attemptNo);
    if (state.attemptId !== null && attempt?.attemptId !== state.attemptId) throw new RuntimeError('CONFLICT', 'Retry attempt identity changed');
    return attempt;
  }
  private committed(input: ExecuteCodeInput, state: RetryExecutionState): { attempt: AttemptRecord; result: z.infer<typeof resultSchema> } | undefined {
    const attempt = this.attempt(input, state);
    if (!attempt || !['SUCCEEDED', 'FAILED'].includes(attempt.status)) return undefined;
    const event = this.service.store.eventsAfter(input.runId).find(e => e.type === 'tool.finished'
      && (e.payload as { attemptId?: string }).attemptId === attempt.attemptId);
    if (!event) return undefined;
    const parsed = resultSchema.safeParse(event.payload);
    if (!parsed.success || (parsed.data.exitCode === 0) !== (attempt.status === 'SUCCEEDED')) {
      throw new RuntimeError('VERSION_MISMATCH', 'Persisted retry result is inconsistent');
    }
    return { attempt, result: parsed.data };
  }
  private async replay(input: ExecuteCodeInput, state: RetryExecutionState): Promise<RuntimeCodeResult | undefined> {
    const committed = this.committed(input, state);
    if (!committed) return undefined;
    const { attempt, result } = committed;
    const artifacts = this.service.store.listArtifacts(input.runId).filter(a => a.attemptId === attempt.attemptId);
    if (argumentHash(artifacts.map(a => a.artifactId).sort()) !== argumentHash([...result.artifacts].sort())) {
      throw new RuntimeError('ARTIFACT_INVALID', 'Committed retry artifact references differ');
    }
    await this.service.artifacts.verify(artifacts);
    this.service.store.transaction(() => {
      const current = this.state(input.runId, input.stepId);
      if (!current || current.dispatchNo !== state.dispatchNo) throw new RuntimeError('CONFLICT', 'Retry generation changed during result verification');
      this.assertBinding(current, this.binding(input));
      if (current.phase === 'waiting') throw new RuntimeError('CONFLICT', 'Retry outcome was already classified as unsent');
      if (current.phase !== 'done') {
        this.service.store.setComponentState(input.runId, 'retry-executor', input.stepId,
          { ...current, phase: 'done', failure: null, attemptId: attempt.attemptId } satisfies RetryExecutionState);
        this.service.store.appendEvent(input.runId, 'retry.execution_committed', { stepId: input.stepId, dispatchNo: current.dispatchNo, attemptId: attempt.attemptId, attemptNo: attempt.attemptNo });
      }
    });
    return { attemptId: attempt.attemptId, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, artifacts };
  }
  private canRetryCreate(attempt: AttemptRecord | undefined): boolean {
    return attempt?.status === 'FAILED' && attempt.errorCode === 'SANDBOX_CREATE_FAILED'
      && attempt.sandboxCreateEvidence === 'adapter-confirmed-unsent-v1'
      && attempt.sandboxId === null && attempt.executionId === null && attempt.workDir === null;
  }
  private classify(error: unknown, attempt: AttemptRecord | undefined, input: ExecuteCodeInput, signal?: AbortSignal): FailureClass {
    const run = this.service.store.getRun(input.runId);
    if (signal?.aborted || ['CANCELLING', 'CANCELLED'].includes(run.status) || attempt?.status === 'CANCELLED') return 'cancelled';
    if (error instanceof RuntimeError && ['BUDGET_UNAVAILABLE', 'USAGE_UNKNOWN'].includes(error.code)) return 'budget';
    if (this.canRetryCreate(attempt)) return 'transient-unsent';
    if (attempt && ['CREATED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'].includes(attempt.status)) return 'unknown';
    if (error instanceof RuntimeError && error.code === 'INVALID_INPUT') return 'invalid-input';
    return attempt ? 'permanent' : 'unknown';
  }

  async executeCode(value: ExecuteCodeInput, signal?: AbortSignal): Promise<RuntimeCodeResult> {
    // Bind immutable copies: a caller cannot replace code/input bytes during admission or backoff.
    const input: ExecuteCodeInput = { ...value, inputs: value.inputs.map(i => ({ path: i.path, content: Uint8Array.from(i.content) })) };
    const binding = this.binding(input);
    let state = this.state(input.runId, input.stepId);
    if (state) {
      this.assertBinding(state, binding);
      const replayed = await this.replay(input, state);
      if (replayed) return replayed;
      if (state.phase === 'done') throw new RuntimeError('CONFLICT', 'Committed retry outcome is missing');
      if (state.phase === 'pending') throw new RuntimeError('EXECUTION_UNKNOWN', 'Pending retry dispatch requires reconciliation; it will not be redispatched');
      if (state.phase === 'blocked') throw new RuntimeError('CONFLICT', `Previous retry failure requires explicit action: ${state.failure}`);
    }
    while (true) {
      this.assertRunning(input, signal);
      if (state) {
        const retry = this.controller.state(input.runId, this.key(input.stepId));
        if (retry.attempts !== state.dispatchNo || retry.phase !== 'failed' || retry.lastFailure !== 'transient-unsent') {
          throw new RuntimeError('CONFLICT', 'Retry controller and execution history differ');
        }
        while (this.now() < retry.nextAt) {
          this.assertRunning(input, signal);
          const before = this.now();
          await this.wait(Math.min(60_000, retry.nextAt - before, binding.deadline - before), signal);
          this.assertRunning(input, signal);
          if (this.now() <= before) throw new RuntimeError('CONFLICT', 'Retry wait did not advance the clock');
        }
      }
      const prior = state;
      state = this.service.store.transaction(() => {
        this.assertRunning(input, signal);
        const current = this.state(input.runId, input.stepId);
        if (current) this.assertBinding(current, this.binding(input));
        if (prior ? !current || current.phase !== 'waiting' || current.dispatchNo !== prior.dispatchNo : current !== undefined) {
          throw new RuntimeError('CONFLICT', 'Retry dispatch already claimed by another executor');
        }
        const attempts = this.service.store.listAttempts(input.runId).filter(a => a.stepId === input.stepId);
        if (prior) {
          const previous = this.attempt(input, prior);
          if (!this.canRetryCreate(previous)) {
            throw new RuntimeError('EXECUTION_UNKNOWN', 'Retry requires durable proof the sandbox create request was not sent');
          }
        } else if (attempts.length || this.controller.state(input.runId, this.key(input.stepId)).attempts) {
          throw new RuntimeError('CONFLICT', 'Existing attempt has no retry execution binding');
        }
        const started = this.controller.begin(input.runId, this.key(input.stepId));
        const next: RetryExecutionState = { version: 1, binding, phase: 'pending', dispatchNo: started.attempts,
          attemptNo: attempts.length + 1, attemptId: null, failure: null };
        this.service.store.setComponentState(input.runId, 'retry-executor', input.stepId, next);
        this.service.store.appendEvent(input.runId, 'retry.execution_intent', { stepId: input.stepId, dispatchNo: next.dispatchNo, attemptNo: next.attemptNo, binding });
        return next;
      });
      let failure: unknown;
      try {
        const scope = await this.service.budget.scopeForSession(binding.rootSessionId, { create: false });
        if (scope !== binding.budgetScopeKey) throw new RuntimeError('CONFLICT', 'Retry root budget scope changed');
        const budget = await this.service.budget.snapshot(scope);
        this.assertRunning(input, signal);
        if (budget.unknownCalls || !budget.meteringComplete) throw new RuntimeError('USAGE_UNKNOWN', 'Retry usage requires reconciliation');
        if (budget.availableTokens <= 0 || budget.work.availableTokens <= 0) throw new RuntimeError('BUDGET_UNAVAILABLE', 'Retry has no remaining work budget');
        await this.service.executeCode(input, signal);
        const result = await this.replay(input, state);
        if (!result) throw new RuntimeError('EXECUTION_UNKNOWN', 'Service returned without a committed retry attempt');
        return result;
      } catch (error) {
        // A local error after the service commit must replay the existing result, not create a new attempt.
        const result = await this.replay(input, state);
        if (result) return result;
        failure = error;
      }
      state = this.service.store.transaction(() => {
        const current = this.state(input.runId, input.stepId);
        if (!current || current.phase !== 'pending' || current.dispatchNo !== state!.dispatchNo) throw new RuntimeError('CONFLICT', 'Retry dispatch ownership changed');
        this.assertBinding(current, this.binding(input));
        const attempt = this.attempt(input, current);
        const kind = this.classify(failure, attempt, input, signal);
        const classified = this.controller.failed(input.runId, this.key(input.stepId), current.dispatchNo, kind);
        const next: RetryExecutionState = { ...current, phase: classified.retryable ? 'waiting' : 'blocked', failure: kind, attemptId: attempt?.attemptId ?? null };
        this.service.store.setComponentState(input.runId, 'retry-executor', input.stepId, next);
        this.service.store.appendEvent(input.runId, 'retry.execution_classified', { stepId: input.stepId, dispatchNo: next.dispatchNo,
          attemptNo: next.attemptNo, attemptId: next.attemptId, failure: kind, retryable: classified.retryable });
        return next;
      });
      if (state.phase === 'blocked') throw failure;
    }
  }
}
