import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';
import type { BudgetPort, BudgetSnapshot } from '../contracts/budget.js';
import type { ExecutionRef, SandboxInput, SandboxPort, SandboxRef } from '../contracts/sandbox.js';
import { SandboxCreateUnsentError } from '../contracts/sandbox.js';
import { IdSchema, RuntimeError, TERMINAL_RUN_STATES, type ArtifactRecord, type AttemptRecord, type FailureEvidence, type RunInput, type RunRecord } from '../contracts/runtime.js';
import { ArtifactStore } from '../artifacts/index.js';
import { RuntimeStore } from '../storage/index.js';
import { PolicyEngine, type ModelAdmissionEvidence, type PolicyDecision, type PolicyState } from '../policy/engine.js';
import { ApprovalService } from './approvals.js';
import type { RuntimeCodeExecutor, RuntimeCodeResult } from '../adapters/harness/index.js';
import { assertCheckpointCompatible, runtimeCodeHash, runtimeIdentity } from './checkpoint.js';
import { failureEvidence, InfrastructureCircuit, isInfrastructureFailure } from './infrastructure.js';

export interface ExecuteCodeInput { runId: string; stepId: string; code: string; inputs: SandboxInput[]; required?: boolean; obligationId?: string; repairOf?: string[] }
const ContextBlockSchema = z.strictObject({
  version: z.literal(1), blockId: z.string().min(1),
  code: z.enum(['CONTEXT_REQUIRED_TOO_LARGE', 'CONTEXT_SUMMARY_PENDING', 'CONTEXT_USAGE_UNKNOWN']),
  blockedAt: z.int().nonnegative(), resolved: z.boolean(),
});
export type ContextBlock = z.infer<typeof ContextBlockSchema>;
const SandboxCleanupSchema = z.strictObject({
  version: z.literal(1), sandboxId: z.string().min(1), attemptId: z.string().min(1),
  outcome: z.enum(['CANCELLED', 'TIMED_OUT', 'COMPLETED']), pending: z.boolean(), commandStopped: z.boolean(),
});
type SandboxCleanup = z.infer<typeof SandboxCleanupSchema>;
export interface RuntimeServiceOptions {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  cancelConfirmationTimeoutMs?: number;
  inflightModelCalls?: (scopeKey: string) => number;
  fault?: (point: 'after-dispatch-intent' | 'after-execute' | 'after-cleanup-intent' | 'after-publish' | 'after-commit' | 'after-destroy') => void | Promise<void>;
  validate?: (run: RunRecord, artifacts: ArtifactRecord[], read: (artifact: ArtifactRecord) => Promise<Uint8Array>) => Promise<{ passed: boolean; evidence: unknown }>;
  /** Host-only revalidation of corrected context/summary receipts. A UI resume cannot clear it. */
  validateContextResume?: (run: RunRecord, block: Readonly<ContextBlock>) => Promise<boolean>;
  infrastructure?: { failureThreshold?: number; cooldownMs?: number };
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unsettled = (a: AttemptRecord) => ['CREATED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'].includes(a.status);
const refFor = (a: AttemptRecord): ExecutionRef | undefined => a.sandboxId && a.executionId && a.workDir
  ? { sandboxId: a.sandboxId, executionId: a.executionId, workDir: a.workDir, runId: a.runId, attemptId: a.attemptId } : undefined;

/** Coordinates durable steps. Model calls and budget writes stay in the budget plugin. */
export class RuntimeService implements RuntimeCodeExecutor {
  readonly approvals: ApprovalService;
  private readonly busy = new Set<string>();
  private readonly sandboxReleases = new Map<string, Promise<boolean>>();
  private readonly cancellations = new Set<string>();
  private readonly commands = new Map<string, Promise<RunRecord>>();
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly policy: PolicyEngine;
  private readonly cancelConfirmationTimeoutMs: number;
  private readonly codeHash: string;
  private readonly infrastructureCircuit: InfrastructureCircuit;
  constructor(
    readonly store: RuntimeStore,
    readonly artifacts: ArtifactStore,
    readonly sandbox: SandboxPort,
    readonly budget: BudgetPort,
    readonly config: RuntimeConfig,
    private readonly options: RuntimeServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.codeHash = runtimeCodeHash();
    this.infrastructureCircuit = new InfrastructureCircuit({ ...options.infrastructure, now: this.now });
    this.wait = options.wait ?? (ms => delay(ms));
    this.cancelConfirmationTimeoutMs = options.cancelConfirmationTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.cancelConfirmationTimeoutMs) || this.cancelConfirmationTimeoutMs < 1) {
      throw new TypeError('cancelConfirmationTimeoutMs must be a positive safe integer');
    }
    this.policy = new PolicyEngine(config.policy);
    this.approvals = new ApprovalService(store, this.now);
  }

  /** Host-only status used by model admission and evaluation preflight. */
  infrastructureStatus() { return this.infrastructureCircuit.snapshot(); }
  assertInfrastructureAvailable(): void { this.infrastructureCircuit.assertAvailable(); }

  /** Trusted host API for selecting one verified delivery set after exploratory attempts. */
  setDeliveryManifest(runId: string, artifactIds: readonly string[]): void {
    this.store.transaction(() => {
      const records = this.store.listArtifacts(runId);
      const known = new Set(records.map(record => record.artifactId));
      if (!artifactIds.length || artifactIds.some(id => !known.has(id)) || new Set(artifactIds).size !== artifactIds.length) {
        throw new RuntimeError('ARTIFACT_INVALID', 'Delivery manifest must reference unique committed artifacts');
      }
      this.store.appendEvent(runId, 'delivery.manifest', { schemaVersion: 1, artifactIds: [...artifactIds] });
    });
  }

  async preflight(): Promise<{ checkedAt: number; sandboxId?: string }> {
    if (!this.sandbox.preflight) return { checkedAt: this.now() };
    try {
      const result = await this.sandbox.preflight(this.config.sandbox);
      this.infrastructureCircuit.recordSuccess();
      return result;
    } catch (error) {
      const evidence = failureEvidence(error, 'sandbox.preflight', this.now());
      this.infrastructureCircuit.recordFailure(evidence);
      throw new RuntimeError('SANDBOX_UNAVAILABLE', evidence.message, { phase: evidence.phase, retryable: true, causeRef: evidence.code });
    }
  }

  async createRun(input: RunInput): Promise<RunRecord> {
    const scopeKey = await this.budget.scopeForSession(input.rootSessionId, { create: false });
    if (scopeKey !== input.budgetScopeKey) throw new RuntimeError('CONFLICT', 'Root session does not own the supplied budget scope');
    await this.budget.snapshot(scopeKey);
    return this.store.transaction(() => {
      const created = this.store.createRun(input);
      this.store.setComponentState(input.runId, 'runtime', 'identity', runtimeIdentity(this.config, this.codeHash));
      this.store.addStep({ stepId: `accept-${hash(input.runId).slice(0,32)}`, runId: input.runId, kind: 'review',
        required: true, inputHash: input.inputHash, status: 'PENDING', dependencies: [] });
      return this.store.transitionRun(created.runId, 'RUNNING', created.revision);
    });
  }

  async getRun(runId: string) {
    const run = this.store.getRun(runId);
    return { ...run, steps: this.store.listSteps(runId), attempts: this.store.listAttempts(runId),
      artifacts: this.store.listArtifacts(runId), budget: await this.budget.snapshot(run.budgetScopeKey),
      policy: this.store.getPolicyState(runId) ?? null, approvals: this.approvals.list(runId),
      contextBlock: this.readContextBlock(runId) ?? null, lastEventSeq: this.store.latestEventSeq(runId) };
  }
  private readContextBlock(runId: string): ContextBlock | undefined {
    const raw = this.store.getComponentState(runId, 'runtime', 'context-block');
    if (raw === undefined) return undefined;
    const block = ContextBlockSchema.safeParse(raw);
    if (!block.success) throw new RuntimeError('VERSION_MISMATCH', 'Context pause state is incompatible');
    return block.data;
  }
  /** Called by the trusted model adapter before another role request can be dispatched. */
  pauseForContext(runId: string, code: ContextBlock['code']): void {
    const candidate = ContextBlockSchema.parse({ version: 1, blockId: randomUUID(), code, blockedAt: this.now(), resolved: false });
    this.store.transaction(() => {
      const run = this.store.getRun(runId);
      if (!['RUNNING', 'RECOVERY_REQUIRED', 'PAUSED_ACCOUNTING'].includes(run.status)) return;
      const old = this.readContextBlock(runId);
      if (old && !old.resolved && old.code === code) return;
      this.store.setComponentState(runId, 'runtime', 'context-block', candidate);
      this.store.appendEvent(runId, 'context.blocked', { blockId: candidate.blockId, code });
      const target = code === 'CONTEXT_USAGE_UNKNOWN' ? 'PAUSED_ACCOUNTING' : 'RECOVERY_REQUIRED';
      if (run.status !== target) this.store.transitionRun(runId, target, run.revision, code);
      this.store.saveCheckpoint(runId);
    });
  }
  commitPolicyDecision(runId: string, decision: PolicyDecision, phase: string, admission?: ModelAdmissionEvidence): void {
    this.store.transaction(() => {
      this.store.savePolicyState(runId, decision.state);
      this.store.appendEvent(runId, 'policy.decision', { phase, allowed: decision.allowed, disposition: decision.disposition,
        stage: decision.stage, mode: decision.mode, limits: decision.limits, proposedLimits: decision.proposedLimits, reasons: decision.reasons,
        ...(admission ? { admission } : {}) });
      for (const notification of decision.notifications) this.store.appendEvent(runId, 'policy.triggered', notification);
    });
  }
  async requestApproval(input: Parameters<ApprovalService['request']>[0]) {
    if (this.busy.has(input.runId)) throw new RuntimeError('CONFLICT', 'Cannot wait for approval during execution');
    const approval = this.approvals.request(input);
    const sandbox = this.store.getSandbox(input.runId);
    if (sandbox && this.store.getRun(input.runId).status === 'PAUSED_APPROVAL' && !await this.releaseSandbox(sandbox)) {
      throw new RuntimeError('CANCEL_UNCONFIRMED', 'Approval sandbox destruction was not confirmed');
    }
    return approval;
  }
  async consumeApproval(runId: string, approvalId: string, args: unknown): Promise<void> {
    const sandbox = this.store.getSandbox(runId);
    if (sandbox && this.store.getRun(runId).status === 'PAUSED_APPROVAL') {
      if (this.store.listAttempts(runId).some(unsettled)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Reconcile active execution before sandbox cleanup');
      if (!await this.releaseSandbox(sandbox)) throw new RuntimeError('CANCEL_UNCONFIRMED', 'Approval sandbox destruction was not confirmed');
    }
    await this.approvals.consume(runId, approvalId, args, async run => {
      const budget = await this.checkToolAdmission({ ...run, status: 'RUNNING' });
      if (budget.availableTokens <= 0 || budget.work.availableTokens <= 0) {
        throw new RuntimeError('BUDGET_UNAVAILABLE', 'Approval cannot start new work without remaining work budget');
      }
    });
  }

  private pause(runId: string, state: 'PAUSED_ACCOUNTING' | 'PAUSED_BUDGET' | 'RECOVERY_REQUIRED', reason: string): void {
    const run = this.store.getRun(runId);
    if (run.status === 'RUNNING' || (run.status === 'RECOVERY_REQUIRED' && state !== 'RECOVERY_REQUIRED')) {
      this.store.transitionRun(runId, state, undefined, reason);
      this.store.saveCheckpoint(runId);
    }
  }
  private cleanupIntent(runId: string): SandboxCleanup | undefined {
    const value = this.store.getComponentState(runId, 'runtime', 'sandbox-cleanup');
    if (value === undefined) return undefined;
    const parsed = SandboxCleanupSchema.safeParse(value);
    if (!parsed.success) throw new RuntimeError('VERSION_MISMATCH', 'Sandbox cleanup state is incompatible');
    return parsed.data;
  }
  private beginSandboxCleanup(execution: ExecutionRef, outcome: SandboxCleanup['outcome']): void {
    this.store.transaction(() => {
      const current = this.cleanupIntent(execution.runId);
      if (current?.pending && (current.sandboxId !== execution.sandboxId || current.attemptId !== execution.attemptId)) {
        throw new RuntimeError('CONFLICT', 'Another sandbox cleanup is unresolved');
      }
      if (current?.pending) return;
      const attached = this.store.getSandbox(execution.runId);
      if (!attached || attached.sandboxId !== execution.sandboxId) throw new RuntimeError('EXECUTION_UNKNOWN', 'Execution sandbox identity is not attached');
      this.store.setComponentState(execution.runId, 'runtime', 'sandbox-cleanup', {
        version: 1, sandboxId: execution.sandboxId, attemptId: execution.attemptId, outcome, pending: true, commandStopped: false,
      });
      this.store.appendEvent(execution.runId, 'sandbox.cleanup_required', { sandboxId: execution.sandboxId, attemptId: execution.attemptId });
    });
  }
  private confirmCommandStopped(runId: string): void {
    const intent = this.cleanupIntent(runId);
    if (!intent?.pending) throw new RuntimeError('CONFLICT', 'Sandbox cleanup intent is missing');
    this.store.setComponentState(runId, 'runtime', 'sandbox-cleanup', { ...intent, commandStopped: true });
  }
  private async finishSandboxCleanup(runId: string): Promise<void> {
    const intent = this.cleanupIntent(runId);
    if (!intent?.pending) return;
    const ref = this.store.getSandbox(runId);
    if (!ref || ref.sandboxId !== intent.sandboxId) throw new RuntimeError('EXECUTION_UNKNOWN', 'Sandbox cleanup identity is unresolved');
    const attempt = this.store.getAttempt(intent.attemptId);
    if (!intent.commandStopped || (intent.outcome === 'COMPLETED' && unsettled(attempt))) {
      throw new RuntimeError('EXECUTION_UNKNOWN', 'Command result must be committed before sandbox destruction');
    }
    await this.sandbox.destroy(ref);
    await this.options.fault?.('after-destroy');
    this.store.transaction(() => {
      const current = this.cleanupIntent(runId);
      if (!current?.pending || current.sandboxId !== ref.sandboxId || current.attemptId !== intent.attemptId) {
        throw new RuntimeError('CONFLICT', 'Sandbox cleanup state changed');
      }
      const attempt = this.store.getAttempt(intent.attemptId);
      if (unsettled(attempt) && intent.outcome !== 'COMPLETED') this.store.transitionAttempt(attempt.attemptId, intent.outcome, { errorCode: intent.outcome === 'TIMED_OUT' ? 'EXECUTION_TIMEOUT' : null });
      this.store.releaseSandbox(ref);
      this.store.setComponentState(runId, 'runtime', 'sandbox-cleanup', { ...current, pending: false });
      this.store.appendEvent(runId, 'sandbox.cleanup_confirmed', { sandboxId: ref.sandboxId, attemptId: intent.attemptId });
    });
  }
  private async ensureSandbox(runId: string): Promise<SandboxRef> {
    if (this.cleanupIntent(runId)?.pending) throw new RuntimeError('EXECUTION_UNKNOWN', 'Sandbox cleanup must be reconciled before dispatch');
    const current = this.store.getSandbox(runId);
    if (current) return current;
    this.infrastructureCircuit.assertAvailable();
    let ref: SandboxRef;
    try { ref = await this.sandbox.create(runId, this.config.sandbox); }
    catch (error) {
      // Preserve ordinary, explicitly retryable adapter errors for the workflow
      // retry controller. Only host/service signatures open the infrastructure breaker.
      if (!isInfrastructureFailure(error)) throw error;
      const evidence = failureEvidence(error, 'sandbox.create', this.now());
      this.infrastructureCircuit.recordFailure(evidence);
      throw new RuntimeError('SANDBOX_CREATE_FAILED', evidence.message, { phase: evidence.phase, retryable: false, causeRef: evidence.code });
    }
    this.infrastructureCircuit.recordSuccess();
    try { this.store.saveSandbox(ref); }
    catch (error) { await this.sandbox.destroy(ref).catch(() => {}); throw error; }
    return ref;
  }
  private async releaseSandbox(ref: SandboxRef): Promise<boolean> {
    // A durable cleanup intent owns this sandbox until its result is settled.
    if (this.cleanupIntent(ref.runId)?.pending) return false;
    const existing = this.sandboxReleases.get(ref.sandboxId);
    if (existing) return existing;
    const release = (async () => {
      try { await this.sandbox.destroy(ref); this.store.releaseSandbox(ref); return true; }
      catch { this.store.appendEvent(ref.runId, 'sandbox.cleanup_required', { sandboxId: ref.sandboxId }); return false; }
    })();
    this.sandboxReleases.set(ref.sandboxId, release);
    try { return await release; } finally { this.sandboxReleases.delete(ref.sandboxId); }
  }

  private async checkToolAdmission(run: RunRecord): Promise<BudgetSnapshot> {
    if (run.status !== 'RUNNING') throw new RuntimeError('CONFLICT', `Run is ${run.status}`);
    const snapshot = await this.budget.snapshot(run.budgetScopeKey);
    const decision = this.policy.evaluate({ budget: snapshot, cancelled: this.cancellations.has(run.runId),
      deadlineExceeded: this.now() >= run.deadline, inflightModelCalls: this.options.inflightModelCalls?.(run.budgetScopeKey) ?? 0,
      stepBoundary: this.store.listAttempts(run.runId).filter(a => !unsettled(a)).length,
      settlementBoundary: snapshot.ledgerSeq,
    }, { kind: 'tool', required: true }, this.store.getPolicyState<PolicyState>(run.runId));
    this.commitPolicyDecision(run.runId, decision, 'tool');
    if (!decision.allowed) {
      const reason = decision.reasons.map(r => r.code).join(',');
      if (snapshot.unknownCalls > 0 || !snapshot.meteringComplete) this.pause(run.runId, 'PAUSED_ACCOUNTING', reason);
      else if (this.now() >= run.deadline) await this.cancelRun(run.runId, `deadline-${run.runId}`, { reason: 'deadline' });
      else if (decision.disposition !== 'wait') this.pause(run.runId, 'PAUSED_BUDGET', reason);
      throw new RuntimeError(snapshot.unknownCalls > 0 ? 'USAGE_UNKNOWN' : 'BUDGET_UNAVAILABLE', reason, { phase: 'admission', retryable: decision.disposition === 'wait' });
    }
    return snapshot;
  }

  async executeCode(input: ExecuteCodeInput, signal?: AbortSignal): Promise<RuntimeCodeResult> {
    if (this.busy.has(input.runId)) throw new RuntimeError('CONFLICT', 'A tool execution is already active for this run');
    this.busy.add(input.runId);
    let attempt: AttemptRecord | undefined;
    let sandboxRef: SandboxRef | undefined;
    try {
      signal?.throwIfAborted();
      if (!input.code || Buffer.byteLength(input.code, 'utf8') > 256_000) throw new RuntimeError('INVALID_INPUT', 'Code is empty or exceeds limit');
      const run = this.store.getRun(input.runId);
      assertCheckpointCompatible(this.store, run, runtimeIdentity(this.config, this.codeHash));
      if (this.cleanupIntent(input.runId)?.pending) throw new RuntimeError('EXECUTION_UNKNOWN', 'Sandbox cleanup must be reconciled before execution or replay');
      if (this.store.listAttempts(input.runId).some(unsettled)) throw new RuntimeError('EXECUTION_UNKNOWN', 'RECOVERY_REQUIRED: reconcile unresolved attempt before dispatch');
      const inputHash = hash(JSON.stringify([input.code, input.inputs.map(i => [i.path, hash(i.content)]),
        ...(input.obligationId || input.repairOf ? [{ obligationId: input.obligationId ?? null, repairOf: input.repairOf ?? [] }] : [])]));
      const previous = this.store.getStep(input.stepId);
      if (previous) {
        if (previous.runId !== input.runId || previous.inputHash !== inputHash) throw new RuntimeError('CONFLICT', 'Replayed tool call changed its inputs');
        if (previous.status === 'SUCCEEDED') return this.replayResult(input.runId, input.stepId);
        if (previous.status === 'FAILED' && this.store.eventsAfter(input.runId).some(e => e.type === 'tool.finished' && this.store.listAttempts(input.runId).some(a => a.stepId === input.stepId && a.attemptId === (e.payload as { attemptId?: string }).attemptId))) return this.replayResult(input.runId, input.stepId);
      }
      if (input.obligationId) {
        const obligation = this.store.getStep(input.obligationId);
        if (!obligation || obligation.runId !== input.runId || obligation.kind !== 'review' || !obligation.required) throw new RuntimeError('CONFLICT', 'Execution obligation must reference this run\'s required acceptance check');
      }
      if (input.repairOf) {
        if (input.required === false) throw new RuntimeError('INVALID_INPUT', 'A repair execution must remain required');
        this.assertCodeRepairSources(input.runId, input.stepId, input.obligationId, input.repairOf);
      }
      await this.checkToolAdmission(run);
      if (this.store.getRun(input.runId).status !== 'RUNNING') throw new RuntimeError('CONFLICT', 'Run stopped before tool dispatch');
      this.infrastructureCircuit.assertAvailable();
      this.store.addStep({ stepId: input.stepId, runId: input.runId, kind: 'python', required: input.required ?? true,
        inputHash, status: 'PENDING', dependencies: [], ...(input.obligationId ? { obligationId: input.obligationId } : {}),
        ...(input.repairOf ? { repairOf: [...input.repairOf] } : {}) });
      attempt = this.store.createAttempt(input.runId, input.stepId, hash(input.code));
      sandboxRef = await this.ensureSandbox(input.runId);
      if (this.cancellations.has(input.runId) || signal?.aborted) {
        this.store.transitionAttempt(attempt.attemptId, 'CANCELLED');
        throw new RuntimeError('CONFLICT', 'Task cancelled before dispatch');
      }
      this.store.transitionAttempt(attempt.attemptId, 'DISPATCHING', { sandboxId: sandboxRef.sandboxId });
      await this.options.fault?.('after-dispatch-intent');
      const priorArtifacts = this.store.listArtifacts(input.runId);
      const inputs: SandboxInput[] = input.inputs.map(i => ({ path: i.path, content: Uint8Array.from(i.content) }));
      for (const artifact of priorArtifacts) inputs.push({ path: `artifacts/${artifact.artifactId}/${artifact.path}`, content: await this.artifacts.read(artifact) });
      // Include dispatch latency so a remote timeout cannot expire before the local timer starts.
      const end = Math.min(run.deadline, this.now() + this.config.sandbox.commandTimeoutMs);
      const execution = await this.sandbox.execute({ sandbox: sandboxRef, ...input, inputs, attemptId: attempt.attemptId, policy: this.config.sandbox });
      await this.options.fault?.('after-execute');
      this.store.transitionAttempt(attempt.attemptId, 'RUNNING', { executionId: execution.executionId, workDir: execution.workDir });
      while (true) {
        if (signal?.aborted || this.cancellations.has(input.runId) || this.now() >= end) {
          const recorded = this.store.getAttempt(attempt.attemptId);
          if (recorded.status === 'CANCELLED') throw new RuntimeError('CONFLICT', 'Execution already cancelled');
          const timedOut = this.now() >= end && !signal?.aborted && !this.cancellations.has(input.runId);
          this.beginSandboxCleanup(execution, timedOut ? 'TIMED_OUT' : 'CANCELLED');
          const cancelled = await this.sandbox.cancel(execution);
          if (!cancelled.confirmed) {
            this.store.transitionAttempt(attempt.attemptId, 'UNKNOWN', { errorCode: 'CANCEL_UNCONFIRMED' });
            this.pause(input.runId, 'RECOVERY_REQUIRED', 'Remote cancellation was not confirmed');
            throw new RuntimeError('CANCEL_UNCONFIRMED', cancelled.reason ?? 'Remote command may still be running');
          }
          this.confirmCommandStopped(input.runId);
          try { await this.finishSandboxCleanup(input.runId); }
          catch {
            this.store.transitionAttempt(attempt.attemptId, 'UNKNOWN', { errorCode: 'CANCEL_UNCONFIRMED' });
            this.pause(input.runId, 'RECOVERY_REQUIRED', 'Sandbox destruction was not confirmed');
            throw new RuntimeError('CANCEL_UNCONFIRMED', 'Sandbox destruction was not confirmed');
          }
          if (signal?.aborted && this.store.getRun(input.runId).status === 'RUNNING') {
            this.store.transitionRun(input.runId, 'CANCELLING'); this.store.transitionRun(input.runId, 'CANCELLED');
          }
          if (this.store.getRun(input.runId).status === 'CANCELLING') this.store.transitionRun(input.runId, 'CANCELLED');
          if (timedOut && this.now() >= run.deadline && this.store.getRun(input.runId).status === 'RUNNING') {
            this.store.transitionRun(input.runId, 'CANCELLING'); this.store.transitionRun(input.runId, 'CANCELLED', undefined, 'Task deadline elapsed');
          }
          throw new RuntimeError(timedOut ? 'EXECUTION_TIMEOUT' : 'CONFLICT', timedOut ? 'Script exceeded execution deadline' : 'Execution cancelled');
        }
        const status = await this.sandbox.inspect(execution);
        // A status request can itself cross a cancellation or deadline boundary.
        if (signal?.aborted || this.cancellations.has(input.runId) || this.now() >= end) continue;
        if (status.state === 'UNKNOWN') {
          this.store.transitionAttempt(attempt.attemptId, 'UNKNOWN', { errorCode: 'EXECUTION_UNKNOWN' });
          this.pause(input.runId, 'RECOVERY_REQUIRED', status.reason);
          throw new RuntimeError('EXECUTION_UNKNOWN', status.reason);
        }
        if (status.state === 'CANCELLED') {
          this.beginSandboxCleanup(execution, 'CANCELLED');
          this.confirmCommandStopped(input.runId);
          await this.finishSandboxCleanup(input.runId);
          throw new RuntimeError('CONFLICT', 'Remote execution cancelled');
        }
        if (status.state !== 'RUNNING') {
          this.beginSandboxCleanup(execution, 'COMPLETED');
          this.confirmCommandStopped(input.runId);
          await this.options.fault?.('after-cleanup-intent');
          const result = await this.collectAndCommit(execution);
          try { await this.finishSandboxCleanup(input.runId); }
          catch {
            this.pause(input.runId, 'RECOVERY_REQUIRED', 'Sandbox destruction was not confirmed');
            throw new RuntimeError('CANCEL_UNCONFIRMED', 'Sandbox destruction was not confirmed');
          }
          return result;
        }
        await this.wait(this.options.pollIntervalMs ?? 100);
      }
    } catch (error) {
      if (attempt) {
        const current = this.store.getAttempt(attempt.attemptId);
        if (current.status === 'CREATED' && !(error instanceof SandboxCreateUnsentError)) {
          const evidence = { ...failureEvidence(error, 'sandbox.create', this.now()), retryable: false };
          this.store.transaction(() => {
            this.store.transitionAttempt(current.attemptId, 'UNKNOWN', { errorCode: 'SANDBOX_CREATE_UNKNOWN', failure: evidence });
            if (isInfrastructureFailure(error)) this.store.appendEvent(input.runId, 'sandbox.failure', evidence);
            this.store.appendEvent(input.runId, 'sandbox.creation_unknown', { attemptId: current.attemptId, runId: input.runId, phase: 'sandbox.create' });
            this.pause(input.runId, 'RECOVERY_REQUIRED', 'Sandbox creation outcome is unknown; inspect remote resources');
          });
        } else if (isInfrastructureFailure(error)) {
          const evidence: FailureEvidence = error instanceof RuntimeError && error.details.phase
            ? { ...failureEvidence(error, error.details.phase, this.now()), code: error.details.causeRef ?? error.code, retryable: error.details.retryable ?? false, ...(error.details.causeRef ? { causeRef: error.details.causeRef } : {}) }
            : failureEvidence(error, 'sandbox', this.now());
          this.store.appendEvent(input.runId, 'sandbox.failure', evidence);
          if (current.status === 'CREATED' || current.status === 'DISPATCHING') {
            this.store.transitionAttempt(current.attemptId, 'FAILED', { errorCode: evidence.code, failure: evidence });
            this.store.markStepOptional(current.stepId, evidence.code);
            if (this.store.getRun(input.runId).status === 'RUNNING') this.pause(input.runId, 'RECOVERY_REQUIRED', evidence.message);
          } else if (current.status === 'RUNNING') {
            this.store.transitionAttempt(current.attemptId, 'UNKNOWN', { errorCode: evidence.code, failure: evidence });
            this.pause(input.runId, 'RECOVERY_REQUIRED', evidence.message);
          }
        } else if (current.status === 'CREATED' && error instanceof SandboxCreateUnsentError) {
          this.store.transitionAttempt(current.attemptId, 'FAILED', {
            errorCode: 'SANDBOX_CREATE_FAILED', sandboxCreateEvidence: 'adapter-confirmed-unsent-v1',
          });
        } else if (current.status === 'DISPATCHING' || current.status === 'RUNNING') {
          this.store.transitionAttempt(current.attemptId, 'UNKNOWN', { errorCode: 'EXECUTION_UNKNOWN' });
          this.pause(input.runId, 'RECOVERY_REQUIRED', 'Execution result requires reconciliation');
        }
      }
      if (this.cleanupIntent(input.runId)?.pending) this.pause(input.runId, 'RECOVERY_REQUIRED', 'Sandbox cleanup requires reconciliation');
      throw error;
    } finally {
      this.busy.delete(input.runId);
      if (sandboxRef && !this.cleanupIntent(input.runId)?.pending && !this.cancellations.has(input.runId) && TERMINAL_RUN_STATES.has(this.store.getRun(input.runId).status)) await this.releaseSandbox(sandboxRef);
    }
  }

  private assertCodeRepairSources(runId: string, replacementId: string, obligationId: string | undefined, repairOf: readonly string[]): void {
    if (!obligationId || !repairOf.length || repairOf.length > 8 || new Set(repairOf).size !== repairOf.length) throw new RuntimeError('INVALID_INPUT', 'Repair requires a host-bound obligation and one to eight unique failed steps');
    const obligation = this.store.getStep(obligationId);
    if (!obligation || obligation.runId !== runId || obligation.kind !== 'review' || !obligation.required || obligation.status === 'SUCCEEDED') throw new RuntimeError('CONFLICT', 'Repair obligation is absent or already accepted');
    for (const id of repairOf) {
      IdSchema.parse(id);
      const source = this.store.getStep(id); const attempt = this.store.listAttempts(runId).findLast(item => item.stepId === id);
      if (id === replacementId || !source || source.runId !== runId || source.kind !== 'python' || !source.required || source.status !== 'FAILED'
        || source.obligationId !== obligationId || attempt?.status !== 'FAILED' || attempt.errorCode !== 'SCRIPT_FAILED') {
        throw new RuntimeError('CONFLICT', 'Repair may reference only confirmed script failures for the same acceptance obligation');
      }
    }
  }

  /** Trusted assessment of committed bytes. Only explicit, independently verified repairs can supersede failures. */
  async inspectCodeResult(runId: string, attemptId: string, signal?: AbortSignal) {
    if (this.busy.has(runId)) throw new RuntimeError('CONFLICT', 'Run execution or validation is already active');
    this.busy.add(runId);
    try {
      const run = this.store.getRun(runId);
      const assertActive = () => {
        signal?.throwIfAborted();
        const current = this.store.getRun(runId);
        if (current.status !== 'RUNNING' || current.revision !== run.revision || current.deadline <= this.now()) throw new RuntimeError('CONFLICT', 'Run changed during tool assessment');
        if (this.store.listAttempts(runId).some(unsettled)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Tool assessment requires resolved execution');
      };
      assertActive(); assertCheckpointCompatible(this.store, run, runtimeIdentity(this.config, this.codeHash));
      const attempt = this.store.getAttempt(attemptId); const step = this.store.getStep(attempt.stepId);
      if (attempt.runId !== runId || !step || step.kind !== 'python' || !['SUCCEEDED', 'FAILED'].includes(attempt.status)
        || this.store.listAttempts(runId).findLast(item => item.stepId === step.stepId)?.attemptId !== attemptId
        || step.status !== attempt.status) throw new RuntimeError('CONFLICT', 'Assessment requires the latest committed execution for this run');
      const records = this.store.listArtifacts(runId).filter(artifact => artifact.attemptId === attemptId);
      await this.artifacts.verify(records); assertActive();
      const validation = this.options.validate ? await this.options.validate(run, records, artifact => this.artifacts.read(artifact)) : null;
      assertActive();
      const repairedStepIds: string[] = [];
      if (attempt.status === 'SUCCEEDED' && validation?.passed && step.repairOf?.length) {
        const committed = this.store.eventsAfter(runId).some(event => event.type === 'repair.validated' && (event.payload as { attemptId?: string }).attemptId === attemptId);
        if (!committed) {
          const snapshot = await this.budget.snapshot(run.budgetScopeKey); assertActive();
          if (snapshot.unknownCalls || !snapshot.meteringComplete) throw new RuntimeError('USAGE_UNKNOWN', 'Repair requires reconciled original model usage');
          if (snapshot.reservedTokens > 0 || (this.options.inflightModelCalls?.(run.budgetScopeKey) ?? 0) > 0) throw new RuntimeError('CONFLICT', 'Repair requires settled model calls');
          this.assertCodeRepairSources(runId, step.stepId, step.obligationId, step.repairOf);
          this.store.transaction(() => {
            assertActive();
            this.store.appendEvent(runId, 'repair.validated', { attemptId, replacementId: step.stepId, obligationId: step.obligationId,
              repairOf: step.repairOf, artifactIds: records.map(artifact => artifact.artifactId), evidence: validation.evidence });
            for (const source of step.repairOf!) this.store.supersedeFailedStep(source, step.stepId);
            this.store.saveCheckpoint(runId);
          });
        }
        repairedStepIds.push(...step.repairOf);
      }
      const repairableStepIds = this.store.listSteps(runId).filter(source => source.kind === 'python' && source.required && source.status === 'FAILED'
        && source.obligationId !== undefined && source.obligationId === step.obligationId
        && this.store.listAttempts(runId).findLast(item => item.stepId === source.stepId)?.errorCode === 'SCRIPT_FAILED').map(source => source.stepId);
      this.store.appendEvent(runId, 'tool.validation', { attemptId, stepId: step.stepId, execution: attempt.status,
        passed: validation?.passed ?? null, repairedStepIds, repairableStepIds });
      return { stepId: step.stepId, revision: run.revision, validation, repairedStepIds, repairableStepIds };
    } finally { this.busy.delete(runId); }
  }

  private async collectAndCommit(execution: ExecutionRef): Promise<RuntimeCodeResult> {
    const collected = await this.sandbox.collect(execution, this.config.sandbox);
    const artifacts = await this.artifacts.publish(execution.runId, execution.attemptId, collected.outputs);
    await this.options.fault?.('after-publish');
    this.store.commitResult(execution.attemptId, artifacts, collected);
    this.store.saveCheckpoint(execution.runId);
    await this.options.fault?.('after-commit');
    return { attemptId: execution.attemptId, stdout: collected.stdout, stderr: collected.stderr, exitCode: collected.exitCode, artifacts };
  }
  private async replayResult(runId: string, stepId: string): Promise<RuntimeCodeResult> {
    const a = this.store.listAttempts(runId).findLast(a => a.stepId === stepId && (a.status === 'SUCCEEDED' || a.status === 'FAILED'));
    if (!a) throw new RuntimeError('CONFLICT', 'Successful step has no successful attempt');
    const artifacts = this.store.listArtifacts(runId).filter(item => item.attemptId === a.attemptId);
    await this.artifacts.verify(artifacts);
    const result = this.store.eventsAfter(runId).find(e => e.type === 'tool.finished' && (e.payload as { attemptId?: string }).attemptId === a.attemptId)?.payload as { stdout: string; stderr: string; exitCode: number } | undefined;
    if (!result) throw new RuntimeError('CONFLICT', 'Successful attempt is missing its result record');
    return { attemptId: a.attemptId, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, artifacts };
  }

  async cancelRun(runId: string, commandId: string, payload: { reason: string }): Promise<RunRecord> {
    const commandHash = hash(JSON.stringify(payload));
    const stored = this.store.commandResult<RunRecord>(runId, commandId, 'cancel', commandHash);
    if (stored) return stored;
    this.store.beginCommand(runId, commandId, 'cancel', commandHash);
    const key = `${runId}:${commandId}`;
    if (this.commands.has(key)) return this.commands.get(key)!;
    const promise = this.cancelOnce(runId, commandId, commandHash, payload.reason);
    this.commands.set(key, promise);
    try { return await promise; } finally { this.commands.delete(key); }
  }

  /** Request a user pause without interrupting the active model call. */
  async pauseRun(runId: string, commandId: string, payload: { reason: string }): Promise<RunRecord> {
    const payloadHash = hash(JSON.stringify(payload));
    const previous = this.store.commandResult<RunRecord>(runId, commandId, 'pause', payloadHash);
    if (previous) return previous;
    this.store.beginCommand(runId, commandId, 'pause', payloadHash);
    const run = this.store.getRun(runId);
    if (TERMINAL_RUN_STATES.has(run.status)) throw new RuntimeError('CONFLICT', 'Run is terminal');
    if (run.status === 'PAUSED_USER' || run.status === 'PAUSING') {
      const result = this.store.completeCommandTransition(runId, commandId, 'pause', payloadHash, run.status);
      return result;
    }
    if (run.status !== 'RUNNING') throw new RuntimeError('CONFLICT', `Run is ${run.status}`);
    const result = this.store.completeCommandTransition(runId, commandId, 'pause', payloadHash, 'PAUSING', run.revision);
    this.store.appendEvent(runId, 'run.pause_requested', { reason: payload.reason.slice(0, 1024) });
    return result;
  }

  /** Confirm a requested user pause after the host observes Agent idle. */
  async confirmUserPause(runId: string): Promise<RunRecord> {
    const run = this.store.getRun(runId);
    if (run.status === 'PAUSED_USER') return run;
    if (run.status !== 'PAUSING') throw new RuntimeError('CONFLICT', `Run is ${run.status}`);
    if (this.store.listAttempts(runId).some(unsettled)) {
      this.store.transitionRun(runId, 'RECOVERY_REQUIRED', undefined, 'User pause found an unresolved remote execution');
      this.store.saveCheckpoint(runId);
      throw new RuntimeError('EXECUTION_UNKNOWN', 'Cannot confirm user pause while execution is unresolved');
    }
    const budget = await this.budget.snapshot(run.budgetScopeKey);
    if (budget.unknownCalls || !budget.meteringComplete) {
      this.store.transitionRun(runId, 'PAUSED_ACCOUNTING', undefined, 'User pause requires usage reconciliation');
      this.store.saveCheckpoint(runId);
      throw new RuntimeError('USAGE_UNKNOWN', 'Cannot confirm user pause before usage reconciliation');
    }
    if (budget.reservedTokens > 0 || (this.options.inflightModelCalls?.(run.budgetScopeKey) ?? 0) > 0) {
      this.store.appendEvent(runId, 'run.pause_deferred', { reason: 'model-call-or-budget-reservation-active' });
      throw new RuntimeError('CONFLICT', 'User pause is waiting for model accounting to settle');
    }
    await this.artifacts.verify(this.store.listArtifacts(runId));
    const sandbox = this.store.getSandbox(runId);
    if (sandbox && !await this.releaseSandbox(sandbox)) throw new RuntimeError('CANCEL_UNCONFIRMED', 'User pause sandbox destruction was not confirmed');
    return this.store.transaction(() => {
      const current = this.store.getRun(runId);
      if (current.status !== 'PAUSING') return current;
      const result = this.store.transitionRun(runId, 'PAUSED_USER', current.revision, 'User requested pause');
      this.store.saveCheckpoint(runId);
      return result;
    });
  }
  private async cancelOnce(runId: string, commandId: string, payloadHash: string, reason: string): Promise<RunRecord> {
    this.cancellations.add(runId);
    let run = this.store.getRun(runId);
    if (TERMINAL_RUN_STATES.has(run.status)) return this.store.completeCommandTransition(runId, commandId, 'cancel', payloadHash, run.status);
    if (run.status !== 'CANCELLING') run = this.store.transitionRun(runId, 'CANCELLING', undefined, reason);
    let confirmed = true;
    const executionActive = this.busy.has(runId);
    if (executionActive) {
      // The active execute loop owns the remote cancel request. Sending a second
      // interrupt concurrently can make a successful cancellation look unknown.
      const deadline = this.now() + this.cancelConfirmationTimeoutMs;
      while (this.busy.has(runId) && (this.store.listAttempts(runId).some(unsettled) || this.cleanupIntent(runId)?.pending) && this.now() < deadline) {
        await this.wait(Math.min(50, Math.max(1, deadline - this.now())));
      }
      confirmed = !this.store.listAttempts(runId).some(unsettled) && !(this.busy.has(runId) && this.cleanupIntent(runId)?.pending);
    } else {
      const cleanup = this.cleanupIntent(runId);
      if (cleanup?.pending && cleanup.commandStopped && (cleanup.outcome !== 'COMPLETED' || !unsettled(this.store.getAttempt(cleanup.attemptId)))) {
        try { await this.finishSandboxCleanup(runId); }
        catch { confirmed = false; }
      }
      if (cleanup?.pending && cleanup.outcome === 'COMPLETED' && unsettled(this.store.getAttempt(cleanup.attemptId))) confirmed = false;
      for (const attempt of confirmed ? this.store.listAttempts(runId).filter(unsettled) : []) {
        const ref = refFor(attempt);
        if (ref) {
          this.beginSandboxCleanup(ref, 'CANCELLED');
          const result = await this.sandbox.cancel(ref);
          if (!result.confirmed) { confirmed = false; continue; }
          this.confirmCommandStopped(runId);
          try { await this.finishSandboxCleanup(runId); }
          catch { confirmed = false; }
        } else confirmed = false;
      }
    }
    const pendingCleanup = this.cleanupIntent(runId);
    if (confirmed && pendingCleanup?.pending) {
      if (unsettled(this.store.getAttempt(pendingCleanup.attemptId))) confirmed = false;
      else {
        try { await this.finishSandboxCleanup(runId); }
        catch { confirmed = false; }
      }
    }
    const target = confirmed ? 'CANCELLED' : 'RECOVERY_REQUIRED';
    const result = this.store.completeCommandTransition(runId, commandId, 'cancel', payloadHash, target);
    this.store.saveCheckpoint(runId);
    const sandbox = this.store.getSandbox(runId);
    if (confirmed && sandbox) await this.releaseSandbox(sandbox);
    return result;
  }

  async recover(runId: string): Promise<void> {
    if (this.busy.has(runId)) throw new RuntimeError('CONFLICT', 'Cannot recover while a local execution is active');
    const run = this.store.getRun(runId);
    this.busy.add(runId);
    try {
      if (TERMINAL_RUN_STATES.has(run.status)) {
        const sandbox = this.store.getSandbox(runId);
        if (!sandbox) return;
        if (this.store.listAttempts(runId).some(unsettled)) {
          throw new RuntimeError('EXECUTION_UNKNOWN', 'Terminal run has an unresolved execution; inspect it before sandbox cleanup');
        }
        const cleanup = this.cleanupIntent(runId);
        if (cleanup?.pending) {
          try { await this.finishSandboxCleanup(runId); }
          catch { throw new RuntimeError('CANCEL_UNCONFIRMED', 'Terminal run sandbox destruction was not confirmed'); }
        } else if (!await this.releaseSandbox(sandbox)) {
          throw new RuntimeError('CANCEL_UNCONFIRMED', 'Terminal run sandbox destruction was not confirmed');
        }
        return;
      }
      assertCheckpointCompatible(this.store, run, runtimeIdentity(this.config, this.codeHash));
      await this.artifacts.verify(this.store.listArtifacts(runId));
      const cleanupBeforeInspection = this.cleanupIntent(runId);
      if (cleanupBeforeInspection?.pending && cleanupBeforeInspection.commandStopped
        && (cleanupBeforeInspection.outcome !== 'COMPLETED' || !unsettled(this.store.getAttempt(cleanupBeforeInspection.attemptId)))) {
        try { await this.finishSandboxCleanup(runId); }
        catch {
          const current = this.store.getRun(runId);
          if (current.status === 'CANCELLING') this.store.transitionRun(runId, 'RECOVERY_REQUIRED', undefined, 'Sandbox destruction was not confirmed');
          else this.pause(runId, 'RECOVERY_REQUIRED', 'Sandbox destruction was not confirmed');
          this.store.saveCheckpoint(runId);
          return;
        }
      }
      for (const attempt of this.store.listAttempts(runId).filter(unsettled)) {
        const ref = refFor(attempt);
        if (!ref) {
          if (attempt.status !== 'UNKNOWN') this.store.transitionAttempt(attempt.attemptId, 'UNKNOWN', { errorCode: attempt.status === 'CREATED' ? 'SANDBOX_CREATE_UNKNOWN' : 'EXECUTION_UNKNOWN' });
          this.pause(runId, 'RECOVERY_REQUIRED', 'Dispatch has no confirmed execution identity');
          continue;
        }
        const status = await this.sandbox.inspect(ref);
        if (status.state === 'SUCCEEDED' || status.state === 'FAILED') {
          this.beginSandboxCleanup(ref, 'COMPLETED');
          this.confirmCommandStopped(runId);
          await this.collectAndCommit(ref);
        } else if (status.state === 'CANCELLED' && this.cleanupIntent(runId)?.outcome !== 'COMPLETED') {
          this.beginSandboxCleanup(ref, 'CANCELLED');
          this.confirmCommandStopped(runId);
          this.store.transitionAttempt(attempt.attemptId, 'CANCELLED');
        }
        else {
          if (attempt.status !== 'UNKNOWN') this.store.transitionAttempt(attempt.attemptId, 'UNKNOWN', { errorCode: status.state === 'RUNNING' ? 'REMOTE_STILL_RUNNING' : 'EXECUTION_UNKNOWN' });
          this.pause(runId, 'RECOVERY_REQUIRED', status.state === 'RUNNING' ? 'Remote execution still running; inspect again later' : status.state === 'UNKNOWN' ? status.reason : 'Completed execution result is no longer available');
        }
      }
      const cleanupAfterInspection = this.cleanupIntent(runId);
      if (cleanupAfterInspection?.pending && !unsettled(this.store.getAttempt(cleanupAfterInspection.attemptId))) {
        try { await this.finishSandboxCleanup(runId); }
        catch {
          const current = this.store.getRun(runId);
          if (current.status === 'CANCELLING') this.store.transitionRun(runId, 'RECOVERY_REQUIRED', undefined, 'Sandbox destruction was not confirmed');
          else this.pause(runId, 'RECOVERY_REQUIRED', 'Sandbox destruction was not confirmed');
          this.store.saveCheckpoint(runId);
          return;
        }
      }
      const current = this.store.getRun(runId);
      const pausedSandbox = this.store.getSandbox(runId);
      if (pausedSandbox && ['PAUSING', 'PAUSED_USER', 'PAUSED_APPROVAL'].includes(current.status)) {
        if (this.store.listAttempts(runId).some(unsettled)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Paused run has an unresolved execution');
        if (!await this.releaseSandbox(pausedSandbox)) throw new RuntimeError('CANCEL_UNCONFIRMED', 'Paused run sandbox destruction was not confirmed');
      }
      const removed = await this.artifacts.cleanupStaging(runId, this.store.listAttempts(runId).filter(a => !unsettled(a)).map(a => a.attemptId));
      if (removed.length) this.store.appendEvent(runId, 'artifacts.staging_cleaned', { count: removed.length });
      const budget = await this.budget.snapshot(run.budgetScopeKey);
      if (budget.unknownCalls || !budget.meteringComplete) {
        // An unresolved remote execution is more urgent than accounting. Keep
        // RECOVERY_REQUIRED visible until the host has an execution identity
        // (or has explicitly cleaned up the remote sandbox); otherwise a
        // later accounting pause could make an unsafe replay look resumable.
        if (this.store.getRun(runId).status !== 'RECOVERY_REQUIRED') {
          this.pause(runId, 'PAUSED_ACCOUNTING', 'Usage reconciliation required');
        }
      }
      this.store.saveCheckpoint(runId);
    } finally { this.busy.delete(runId); }
  }

  async resumeRun(runId: string, commandId: string, expectedRevision: number): Promise<RunRecord> {
    const payloadHash = hash(JSON.stringify({ expectedRevision }));
    const previous = this.store.commandResult<RunRecord>(runId, commandId, 'resume', payloadHash);
    if (previous) return previous;
    this.store.beginCommand(runId, commandId, 'resume', payloadHash);
    if (this.busy.has(runId)) throw new RuntimeError('CONFLICT', 'Execution is already active');
    const run = this.store.getRun(runId);
    if (run.revision !== expectedRevision) throw new RuntimeError('CONFLICT', 'Run revision changed');
    if (!['PAUSED_USER', 'PAUSED_BUDGET', 'PAUSED_ACCOUNTING', 'RECOVERY_REQUIRED'].includes(run.status)) throw new RuntimeError('CONFLICT', 'Pause reason requires separate handling or run is terminal');
    if (this.now() >= run.deadline) throw new RuntimeError('EXECUTION_TIMEOUT', 'Original task deadline elapsed');
    if (this.cleanupIntent(runId)?.pending) throw new RuntimeError('EXECUTION_UNKNOWN', 'Reconcile sandbox cleanup before resume');
    if (run.status === 'PAUSED_USER' && this.store.getSandbox(runId)) throw new RuntimeError('CANCEL_UNCONFIRMED', 'Reconcile paused sandbox cleanup before resume');
    if (this.store.listAttempts(runId).some(unsettled)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Reconcile unresolved execution before resume');
    const scope = await this.budget.scopeForSession(run.rootSessionId, { create: false });
    if (scope !== run.budgetScopeKey) throw new RuntimeError('CONFLICT', 'Budget scope changed');
    const budget = await this.budget.snapshot(scope);
    if (budget.unknownCalls || !budget.meteringComplete) throw new RuntimeError('USAGE_UNKNOWN', 'Usage still unknown');
    if (budget.availableTokens <= 0) throw new RuntimeError('BUDGET_UNAVAILABLE', 'No remaining budget');
    const contextBlock = this.readContextBlock(runId);
    if (contextBlock && !contextBlock.resolved
      && !await this.options.validateContextResume?.(run, Object.freeze({ ...contextBlock }))) {
      throw new RuntimeError('CONFLICT', 'Context pause requires host revalidation before resume', { phase: 'context', userAction: contextBlock.code });
    }
    assertCheckpointCompatible(this.store, run, runtimeIdentity(this.config, this.codeHash));
    const policyState = this.store.getPolicyState<PolicyState>(runId);
    if (policyState) this.policy.restoreState(policyState);
    await this.artifacts.verify(this.store.listArtifacts(runId));
    const resumed = this.store.transaction(() => {
      if (contextBlock && !contextBlock.resolved) {
        const currentBlock = this.readContextBlock(runId);
        if (!currentBlock || currentBlock.blockId !== contextBlock.blockId || currentBlock.resolved) {
          throw new RuntimeError('CONFLICT', 'Context pause changed during revalidation');
        }
      }
      const currentPolicy = this.store.getPolicyState<PolicyState>(runId);
      const releaseFinalize = run.status === 'PAUSED_BUDGET' && currentPolicy?.finalized === true;
      if (releaseFinalize && budget.work.availableTokens <= 0) {
        throw new RuntimeError('BUDGET_UNAVAILABLE', 'No remaining work budget');
      }
      const result = this.store.completeCommandTransition(runId, commandId, 'resume', payloadHash, 'RUNNING', expectedRevision);
      if (releaseFinalize) {
        this.store.savePolicyState(runId, this.policy.releaseFinalize(currentPolicy!,
          'Trusted host resumed budget-paused work after verifying the original budget'));
      }
      if (contextBlock && !contextBlock.resolved) {
        this.store.setComponentState(runId, 'runtime', 'context-block', { ...contextBlock, resolved: true });
        this.store.appendEvent(runId, 'context.unblocked', { blockId: contextBlock.blockId });
      }
      if (releaseFinalize || (contextBlock && !contextBlock.resolved)) this.store.saveCheckpoint(runId);
      return result;
    });
    this.cancellations.delete(runId);
    return resumed;
  }

  /** Check complete delivery before optional model spending; finalize rechecks after the await. */
  async assertCompletionReady(runId: string): Promise<void> {
    if (this.busy.has(runId)) throw new RuntimeError('CONFLICT', 'Run execution or finalization is already active');
    this.busy.add(runId);
    try {
      const run = this.store.getRun(runId);
      const assertUnchanged = () => {
        const current = this.store.getRun(runId);
        if (current.revision !== run.revision || current.status !== run.status) throw new RuntimeError('CONFLICT', 'Run changed during completion verification');
      };
      const artifacts = this.store.listArtifacts(runId);
      await this.artifacts.verify(artifacts);
      assertUnchanged();
      await this.verifyCompletion(run, artifacts, assertUnchanged);
    } finally { this.busy.delete(runId); }
  }

  private async verifyCompletion(run: RunRecord, artifacts: ArtifactRecord[], assertUnchanged: () => void): Promise<void> {
    const budget = await this.budget.snapshot(run.budgetScopeKey);
    assertUnchanged();
    if (budget.unknownCalls || !budget.meteringComplete) throw new RuntimeError('USAGE_UNKNOWN', 'Cannot report full completion before usage reconciliation');
    const review = this.store.listSteps(run.runId).find(s => s.kind === 'review' && s.required);
    if (!review) throw new RuntimeError('CONFLICT', 'Task has no registered acceptance check');
    if (review.status !== 'SUCCEEDED') {
      if (!this.options.validate) throw new RuntimeError('CONFLICT', 'No independent task validator configured');
      const validation = await this.options.validate(run, artifacts, artifact => this.artifacts.read(artifact));
      assertUnchanged();
      this.store.recordValidation(review.stepId, validation.passed, validation.evidence);
      if (!validation.passed) throw new RuntimeError('CONFLICT', 'Task acceptance validation failed');
    }
    const steps = this.store.listSteps(run.runId);
    if (!steps.length || steps.some(step => step.required && step.status !== 'SUCCEEDED')) throw new RuntimeError('CONFLICT', 'Required work is incomplete');
    if (this.store.listAttempts(run.runId).some(unsettled)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Cannot finalize unresolved execution');
  }

  async finalize(runId: string, complete: boolean): Promise<{ run: RunRecord; report: string; artifacts: ArtifactRecord[] }> {
    if (this.busy.has(runId)) throw new RuntimeError('CONFLICT', 'Run execution or finalization is already active');
    this.busy.add(runId);
    try {
      const run = this.store.getRun(runId);
      const assertUnchanged = () => {
        const current = this.store.getRun(runId);
        if (current.revision !== run.revision || current.status !== run.status) {
          throw new RuntimeError('CONFLICT', 'Run changed during finalization');
        }
      };
      const artifacts = this.store.listArtifacts(runId);
      await this.artifacts.verify(artifacts);
      assertUnchanged();
      if (complete) await this.verifyCompletion(run, artifacts, assertUnchanged);
      if (this.cleanupIntent(runId)?.pending) throw new RuntimeError('EXECUTION_UNKNOWN', 'Reconcile sandbox cleanup before finalization');
      const steps = this.store.listSteps(runId);
      const pending = steps.filter(s => s.required && s.status !== 'SUCCEEDED');
      if (this.store.listAttempts(runId).some(unsettled)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Cannot finalize unresolved execution');
      const report = `Task ${runId}\nCompleted steps: ${steps.filter(s => s.status === 'SUCCEEDED').length}/${steps.length}\nPending required steps: ${pending.map(s => s.stepId).join(', ') || 'none'}\nArtifacts: ${artifacts.map(a => a.path).join(', ') || 'none'}\n${complete ? 'All registered required steps passed.' : 'Partial delivery; not all requested work is verified.'}`;
      const final = this.store.transaction(() => {
        const result = this.store.transitionRun(runId, complete ? 'SUCCEEDED' : 'COMPLETED_PARTIAL', run.revision, report);
        this.store.saveCheckpoint(runId);
        return result;
      });
      const sandbox = this.store.getSandbox(runId);
      if (sandbox) await this.releaseSandbox(sandbox);
      return { run: final, report, artifacts };
    } finally { this.busy.delete(runId); }
  }
}
