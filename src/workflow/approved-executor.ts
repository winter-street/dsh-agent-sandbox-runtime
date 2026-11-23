import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RUNTIME_PYTHON_TOOL, type RuntimeCodeExecutor, type RuntimeCodeResult } from '../adapters/harness/index.js';
import { IdSchema, RuntimeError, RuntimeIdentitySchema } from '../contracts/runtime.js';
import { argumentHash } from '../core/approvals.js';
import type { ExecuteCodeInput, RuntimeService } from '../core/service.js';
import type { DurableToolRules } from '../tools/durable.js';
import { DurableRetryExecutor } from './retry-executor.js';

export interface ApprovedExecutorOptions {
  reason: string;
  ttlMs: number;
  now?: () => number;
}
const gateSchema = z.strictObject({
  version: z.literal(1), bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['waiting', 'dispatching', 'done']),
});
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** One approval covers one immutable command and its already-bounded safe creation retries. */
export class ApprovedCodeExecutor implements RuntimeCodeExecutor {
  private readonly approval: { reason: string; ttlMs: number };
  private readonly now: () => number;
  constructor(private readonly service: RuntimeService, private readonly executor: DurableRetryExecutor,
    private readonly rules: DurableToolRules, options: ApprovedExecutorOptions) {
    if (!options.reason || options.reason.length > 1024 || !Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new TypeError('Execution approval requires a bounded reason and positive TTL');
    }
    this.approval = Object.freeze({ reason: options.reason, ttlMs: options.ttlMs });
    this.now = options.now ?? Date.now;
  }

  async executeCode(value: ExecuteCodeInput, signal?: AbortSignal): Promise<RuntimeCodeResult> {
    IdSchema.parse(value.stepId);
    // Approval and dispatch must see identical bytes even across asynchronous admission.
    const input: ExecuteCodeInput = { ...value, inputs: value.inputs.map(item => ({ path: item.path, content: Uint8Array.from(item.content) })),
      ...(value.repairOf ? { repairOf: [...value.repairOf] } : {}) };
    const store = this.service.store;
    const run = store.getRun(input.runId);
    const identity = RuntimeIdentitySchema.parse(store.getComponentState(input.runId, 'runtime', 'identity'));
    const args = { codeHash: hash(input.code), inputs: input.inputs.map(item => ({ path: item.path, sha256: hash(item.content) })),
      required: input.required ?? true, obligationId: input.obligationId ?? null, repairOf: input.repairOf ?? [] };
    const bindingHash = argumentHash({ stepId: input.stepId, args, rootSessionId: run.rootSessionId,
      scopeKey: run.budgetScopeKey, inputHash: run.inputHash, deadline: run.deadline, identity,
      runtimeConfig: this.service.config, retryConfigHash: this.executor.configHash, approval: this.approval });
    const callId = 'approved-' + hash(JSON.stringify([input.runId, input.stepId]));
    const action = { callId, toolName: RUNTIME_PYTHON_TOOL, arguments: args, inputVersion: run.inputHash, progressVersion: run.inputHash };
    const read = () => {
      const raw = store.getComponentState(input.runId, 'approved-executor', input.stepId);
      if (raw === undefined) return undefined;
      const state = gateSchema.safeParse(raw);
      if (!state.success || state.data.bindingHash !== bindingHash) throw new RuntimeError('VERSION_MISMATCH', 'Approved command, inputs or execution configuration changed');
      return state.data;
    };
    let state = read();
    if (!state) {
      signal?.throwIfAborted();
      if (run.status !== 'RUNNING') throw new RuntimeError('CONFLICT', 'Only a running task may request execution approval');
      if (this.now() >= run.deadline) throw new RuntimeError('EXECUTION_TIMEOUT', 'Original execution deadline elapsed');
      // Commit the local limit before prompting. Approval cannot override a denied call.
      const decision = store.transaction(() => {
        const decision = this.rules.admit(input.runId, action);
        if (decision.allowed) store.setComponentState(input.runId, 'approved-executor', input.stepId,
          { version: 1, bindingHash, phase: 'waiting' } satisfies z.infer<typeof gateSchema>);
        return decision;
      });
      if (!decision.allowed) throw new RuntimeError('POLICY_TOOL_BLOCKED', decision.reason ?? 'Tool policy rejected execution');
      state = read()!;
    } else {
      const decision = this.rules.admit(input.runId, action);
      if (!decision.allowed) throw new RuntimeError('POLICY_TOOL_BLOCKED', decision.reason ?? 'Tool policy rejected execution');
    }
    if (state.phase === 'waiting') {
      signal?.throwIfAborted();
      const record = await this.service.requestApproval({ runId: input.runId, approvalId: callId, toolCallId: callId,
        args: { bindingHash }, ...this.approval });
      signal?.throwIfAborted();
      if (record.status === 'consumed') throw new RuntimeError('EXECUTION_UNKNOWN', 'Approval was consumed without a recorded dispatch; reconcile before continuing');
      if (record.status !== 'approved') throw new RuntimeError('APPROVAL_REQUIRED', 'Execution is waiting for an available one-time approval');
      await this.service.consumeApproval(input.runId, callId, { bindingHash });
      store.transaction(() => {
        if (read()?.phase !== 'waiting') throw new RuntimeError('CONFLICT', 'Approved execution was already claimed');
        store.setComponentState(input.runId, 'approved-executor', input.stepId, { ...state, phase: 'dispatching' });
      });
    } else if (!this.executor.state(input.runId, input.stepId)) {
      throw new RuntimeError('EXECUTION_UNKNOWN', 'Approved dispatch has no retry receipt; reconcile before continuing');
    }
    signal?.throwIfAborted();
    const result = await this.executor.executeCode(input, signal);
    store.transaction(() => {
      const current = read();
      if (!current || current.phase === 'waiting') throw new RuntimeError('CONFLICT', 'Approved dispatch state changed');
      if (current.phase === 'done') return;
      this.rules.record(input.runId, action, { ok: result.exitCode === 0, progressVersion: action.progressVersion,
        ...(result.exitCode === 0 ? {} : { errorSignature: hash(JSON.stringify([result.exitCode, result.stdout, result.stderr])) }) });
      store.setComponentState(input.runId, 'approved-executor', input.stepId, { ...current, phase: 'done' });
    });
    return result;
  }
}
