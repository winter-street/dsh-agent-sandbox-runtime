import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeError } from '../contracts/runtime.js';
import type { SandboxInput } from '../contracts/sandbox.js';
import type { BudgetControlPort } from '../contracts/budget.js';
import type { RuntimeService } from '../core/service.js';
import type { RuntimeCodeExecutor } from '../adapters/harness/index.js';
import { argumentHash } from '../core/approvals.js';

export type WorkflowRole = 'planner' | 'executor' | 'reviewer';
/** Only a trusted adapter may assert that its primary role request never started. */
export class RoleNotDispatchedError extends Error {
  constructor(message: string) { super(message); this.name = 'RoleNotDispatchedError'; }
}
export interface RoleRequest { runId: string; scopeKey: string; sessionId: string; role: WorkflowRole; callId: string; input: unknown; signal?: AbortSignal }
export interface MeteredRolePort {
  call(request: RoleRequest): Promise<{
    value: unknown;
    receiptId: string;
    /** Trusted adapter metadata linking the workflow intent to the ledger's own call ID. */
    correlation?: { callId: string; modelCallId: string };
  }>;
}
export interface SerialWorkflowOptions {
  sessionForRole: (runId: string, role: WorkflowRole) => string;
  maxRepairs: number;
  inputs: (runId: string) => Promise<SandboxInput[]>;
  /** Trusted host may supply the durable retry wrapper; the service remains the state owner. */
  executor?: RuntimeCodeExecutor;
  /** Optional budgeted prose enhancement; authoritative acceptance remains in RuntimeService. */
  finalizer?: Pick<RuntimeService, 'finalize'>;
  now?: () => number;
}
const planSchema = z.strictObject({ steps: z.array(z.string().min(1).max(2000)).min(1).max(12), checks: z.array(z.string().min(1).max(1000)).min(1).max(12) });
const codeSchema = z.strictObject({ code: z.string().min(1).max(256000) });
const reviewSchema = z.strictObject({ passed: z.boolean(), findings: z.array(z.string().max(2000)).max(20) });
interface RoleRecord { version: 1; status: 'pending' | 'not-dispatched' | 'done'; requestHash: string; value?: unknown; receiptId?: string; modelCallId?: string }
interface SerialState { version: 1; configHash: string; repair: number; status: 'running' | 'done' | 'partial' }

/** Serial roles share one existing root scope. Every role result is persisted before subsequent side effects. */
export class SerialWorkflow {
  private readonly busy = new Set<string>();
  constructor(private readonly service: RuntimeService, private readonly budget: BudgetControlPort, private readonly roles: MeteredRolePort,
    private readonly options: SerialWorkflowOptions) {
    if (!Number.isSafeInteger(options.maxRepairs) || options.maxRepairs < 0 || options.maxRepairs > 5) throw new TypeError('Repair bound must be 0..5');
  }
  private async role<T>(runId: string, role: WorkflowRole, key: string, input: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const store = this.service.store; const run = store.getRun(runId); const requestHash = argumentHash(input);
    const old = store.getComponentState<RoleRecord>(runId, 'role-calls', key);
    if (old) {
      if (old.version !== 1 || old.requestHash !== requestHash) throw new RuntimeError('VERSION_MISMATCH', 'Role call input changed');
      if (old.status === 'done') return schema.parse(old.value);
      if (old.status !== 'not-dispatched') throw new RuntimeError('USAGE_UNKNOWN', 'Previous role call needs reconciliation; it will not be replayed automatically');
    }
    const assertRunning = () => {
      signal?.throwIfAborted();
      const current = store.getRun(runId);
      if (current.status !== 'RUNNING' || current.revision !== run.revision) throw new RuntimeError('CONFLICT', 'Workflow is paused, terminal or changed');
      if ((this.options.now ?? Date.now)() >= current.deadline) throw new RuntimeError('EXECUTION_TIMEOUT', 'Original workflow deadline elapsed');
    };
    assertRunning();
    const sessionId = this.options.sessionForRole(runId, role);
    const callId = 'role-' + createHash('sha256').update(JSON.stringify([runId, key])).digest('hex');
    if (await this.budget.scopeForSession(sessionId, { create: false }) !== run.budgetScopeKey) throw new RuntimeError('CONFLICT', 'Role escaped the root budget scope');
    const before = await this.budget.snapshot(run.budgetScopeKey);
    if (before.unknownCalls || !before.meteringComplete || before.work.availableTokens <= 0) throw new RuntimeError('BUDGET_UNAVAILABLE', 'Role budget unavailable');
    store.transaction(() => {
      assertRunning();
      const claimed = store.getComponentState<RoleRecord>(runId, 'role-calls', key);
      if (claimed && (claimed.status !== 'not-dispatched' || claimed.version !== 1 || claimed.requestHash !== requestHash)) {
        throw new RuntimeError('CONFLICT', 'Role call already claimed by another runner');
      }
      store.setComponentState(runId, 'role-calls', key, { version: 1, status: 'pending', requestHash } satisfies RoleRecord);
      store.appendEvent(runId, 'workflow.role_dispatch_intent', { role, callId, sessionId, budgetScopeKey: run.budgetScopeKey });
    });
    let result: Awaited<ReturnType<MeteredRolePort['call']>>;
    try {
      result = await this.budget.withPurpose(sessionId, 'work', () => this.roles.call({ runId, scopeKey: run.budgetScopeKey, sessionId, role, callId, input, ...(signal ? { signal } : {}) }));
    } catch (error) {
      if (error instanceof RoleNotDispatchedError) store.transaction(() => {
        store.setComponentState(runId, 'role-calls', key, { version: 1, status: 'not-dispatched', requestHash } satisfies RoleRecord);
        store.appendEvent(runId, 'workflow.role_not_dispatched', { role, callId, sessionId });
      });
      throw error;
    }
    if (result.correlation && (result.correlation.callId !== callId || typeof result.correlation.modelCallId !== 'string' || !result.correlation.modelCallId)) {
      throw new RuntimeError('USAGE_UNKNOWN', 'Role adapter returned an incompatible call correlation');
    }
    const modelCallId = result.correlation?.modelCallId ?? callId;
    const receipts = await this.budget.eventsAfter(before.ledgerSeq);
    const settled = receipts.find(r => r.eventId === result.receiptId && r.scopeKey === run.budgetScopeKey && r.type === 'settle');
    const reserved = settled && receipts.find(r => {
      const request = r.payload.request as { sessionId?: string; modelCallId?: string; purpose?: string } | undefined;
      return r.type === 'reserve' && r.scopeKey === run.budgetScopeKey && r.payload.reservationId === settled.payload.reservationId
        && request?.sessionId === sessionId && request.modelCallId === modelCallId && request.purpose === 'work';
    });
    if (!settled || !reserved) throw new RuntimeError('USAGE_UNKNOWN', 'Role response has no correlated settlement in the original ledger');
    const value = schema.parse(result.value);
    store.transaction(() => {
      store.setComponentState(runId, 'role-calls', key, { version: 1, status: 'done', requestHash, value, receiptId: result.receiptId, modelCallId } satisfies RoleRecord);
      store.appendEvent(runId, 'workflow.role_completed', { role, callId, modelCallId, receiptId: result.receiptId });
    });
    return value;
  }
  async run(runId: string, signal?: AbortSignal) {
    if (this.busy.has(runId)) throw new RuntimeError('CONFLICT', 'Workflow already active');
    this.busy.add(runId);
    try {
      const store = this.service.store; const run = store.getRun(runId);
      const configHash = argumentHash({ version: 1, maxRepairs: this.options.maxRepairs, inputHash: run.inputHash,
        sessions: ['planner', 'executor', 'reviewer'].map(role => this.options.sessionForRole(runId, role as WorkflowRole)) });
      const prior = store.getComponentState<SerialState>(runId, 'workflow', 'serial');
      let state = prior ?? { version: 1 as const, configHash, repair: 0, status: 'running' as const };
      if (state.version !== 1 || state.configHash !== configHash) throw new RuntimeError('VERSION_MISMATCH', 'Workflow configuration changed');
      if (state.status !== 'running') return { run: store.getRun(runId), state };
      if (run.status === 'SUCCEEDED' || run.status === 'COMPLETED_PARTIAL') {
        if (!prior) throw new RuntimeError('CONFLICT', 'Terminal task has no serial workflow to resume');
        state = { ...state, status: run.status === 'SUCCEEDED' ? 'done' : 'partial' };
        store.setComponentState(runId, 'workflow', 'serial', state);
        return { run, state };
      }
      store.setComponentState(runId, 'workflow', 'serial', state);
      const plan = await this.role(runId, 'planner', 'planner-0', { task: run.task, inputHash: run.inputHash }, planSchema, signal);
      let findings: string[] = [];
      for (let repair = 0; repair <= this.options.maxRepairs; repair++) {
        signal?.throwIfAborted();
        const code = await this.role(runId, 'executor', `executor-${repair}`, { task: run.task, plan, findings }, codeSchema, signal);
        const stepId = 'wf-' + createHash('sha256').update(`${runId}:${repair}`).digest('hex');
        const executorKey = `executor-${repair}`;
        const executorRole = store.getComponentState<RoleRecord>(runId, 'role-calls', executorKey);
        if (executorRole?.status === 'done' && executorRole.modelCallId && executorRole.receiptId) {
          const callId = 'role-' + createHash('sha256').update(JSON.stringify([runId, executorKey])).digest('hex');
          const eventId = 'workflow-link-' + createHash('sha256').update(JSON.stringify([runId, stepId])).digest('hex');
          store.appendEvent(runId, 'workflow.executor_step_linked', {
            callId, modelCallId: executorRole.modelCallId, receiptId: executorRole.receiptId, stepId,
          }, eventId);
        }
        const result = await (this.options.executor ?? this.service).executeCode({ runId, stepId, code: code.code, inputs: await this.options.inputs(runId) }, signal);
        const review = await this.role(runId, 'reviewer', `reviewer-${repair}`, { task: run.task, checks: plan.checks, result }, reviewSchema, signal);
        state = { ...state, repair }; store.setComponentState(runId, 'workflow', 'serial', state);
        if (review.passed && result.exitCode === 0) {
          for (let old = 0; old < repair; old++) {
            const oldStep = 'wf-' + createHash('sha256').update(`${runId}:${old}`).digest('hex');
            if (store.getStep(oldStep)?.status === 'FAILED') store.supersedeFailedStep(oldStep, stepId);
          }
          // A model review is advisory; RuntimeService still requires the independent validator.
          const complete = await (this.options.finalizer ?? this.service).finalize(runId, true);
          state = { ...state, status: complete.run.status === 'SUCCEEDED' ? 'done' : 'partial' }; store.setComponentState(runId, 'workflow', 'serial', state);
          return { ...complete, state };
        }
        findings = review.findings.length ? review.findings : [`Execution exited ${result.exitCode}; required checks did not pass`];
      }
      const partial = await (this.options.finalizer ?? this.service).finalize(runId, false);
      state = { ...state, status: 'partial' }; store.setComponentState(runId, 'workflow', 'serial', state);
      return { ...partial, state };
    } finally { this.busy.delete(runId); }
  }
}
