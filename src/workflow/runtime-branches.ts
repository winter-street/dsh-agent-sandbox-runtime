import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeService, type RuntimeServiceOptions } from '../core/service.js';
import { RuntimeError, type ArtifactRecord } from '../contracts/runtime.js';
import type { SandboxInput } from '../contracts/sandbox.js';
import { argumentHash } from '../core/approvals.js';
import { assertCheckpointCompatible, runtimeCodeHash, runtimeIdentity } from '../core/checkpoint.js';
import { GraphStateStore, validateBranchResult, validateGraph, type GraphNodeResult, type WorkflowGraph, type NodeState } from './graph.js';
import { ParallelWorkflow, type BranchContext } from './parallel.js';
import { ResourcePolicyController, ResourcePolicy, type ResourcePolicyDecision } from '../resources/policy.js';
import type { ResourceSample } from '../resources/index.js';

export interface RuntimeBranchBinding {
  /** Pre-existing trusted session belonging to the parent's original budget scope. */
  sessionId: string;
  code: string;
  inputs: SandboxInput[];
  expectedArtifacts: string[];
  validatorVersion: string;
  validate: (input: { artifacts: ArtifactRecord[]; read: (artifact: ArtifactRecord) => Promise<Uint8Array>;
    dependencies: Record<string, GraphNodeResult> }) => Promise<{ passed: boolean; data: GraphNodeResult['data'] }>;
}
export interface RuntimeBranchesOptions {
  maxConcurrency: number;
  currentLimit: (parentRunId: string) => Promise<number>;
  now?: () => number;
  cancellationTimeoutMs?: number;
  /** Explicit host timing/fault seams. Validation is always supplied by the fixed branch binding. */
  serviceOptions?: Omit<RuntimeServiceOptions, 'validate'>;
  /** Optional sampled pressure control for future branch dispatches. */
  resourcePolicy?: {
    policy: ResourcePolicy;
    sample: (parentRunId: string) => Promise<ResourceSample>;
    stateKey?: string;
  };
}
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const childSchema = z.strictObject({ version: z.literal(1), childRunId: z.string(), inputHash: z.string(), bindingHash: z.string(),
  dependenciesHash: z.string(), dispatchId: z.string(), phase: z.enum(['pending', 'done']) });
type ChildRecord = z.infer<typeof childSchema>;
const unresolved = (status: string) => ['CREATED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'].includes(status);

/** Trusted host composition: one actual service/run/sandbox/attempt directory per branch, one original ledger. */
export class RuntimeBranchWorkflow {
  readonly graph: WorkflowGraph;
  readonly persistence: GraphStateStore;
  readonly parallel: ParallelWorkflow;
  private readonly bindings: Record<string, RuntimeBranchBinding>;
  private readonly services = new Map<string, RuntimeService>();
  private readonly bindingHash: string;
  private readonly runtimeFingerprint: ReturnType<typeof runtimeIdentity>;
  private readonly resourceController?: ResourcePolicyController;
  constructor(private readonly parent: RuntimeService, graph: WorkflowGraph, bindings: Record<string, RuntimeBranchBinding>, private readonly options: RuntimeBranchesOptions) {
    this.graph = validateGraph(graph); this.persistence = new GraphStateStore(parent.store, options.now);
    if (Object.keys(bindings).length !== this.graph.nodes.length || this.graph.nodes.some(n => !Object.hasOwn(bindings, n.id))) throw new RuntimeError('INVALID_INPUT', 'Every branch needs one trusted binding');
    this.bindings = Object.fromEntries(this.graph.nodes.map(node => {
      const b = bindings[node.id]!;
      if (!b.sessionId || !b.code || !b.validatorVersion || !b.expectedArtifacts.length || typeof b.validate !== 'function') throw new RuntimeError('INVALID_INPUT', 'Incomplete branch binding');
      return [node.id, { ...b, inputs: b.inputs.map(i => ({ path: i.path, content: Buffer.from(i.content) })), expectedArtifacts: [...b.expectedArtifacts] }];
    }));
    this.runtimeFingerprint = runtimeIdentity(parent.config, runtimeCodeHash());
    this.bindingHash = argumentHash({ runtime: this.runtimeFingerprint, graph: this.graph, bindings: Object.fromEntries(Object.entries(this.bindings).map(([id, b]) => [id,
      { sessionId: b.sessionId, code: hash(b.code), inputs: b.inputs.map(i => [i.path, hash(i.content)]), expectedArtifacts: b.expectedArtifacts, validatorVersion: b.validatorVersion }])) });
    if (options.resourcePolicy) {
      const stateKey = options.resourcePolicy.stateKey ?? 'branches';
      this.resourceController = new ResourcePolicyController({
        policy: options.resourcePolicy.policy,
        sample: options.resourcePolicy.sample,
        identity: runId => `resource-policy:${this.graph.graphId}:${runId}`,
        loadState: runId => this.parent.store.getComponentState(runId, 'resource-policy', stateKey),
        saveDecision: (runId, decision) => this.saveResourceDecision(runId, stateKey, decision),
        ...(options.now ? { now: options.now } : {}),
      });
    }
    this.parallel = new ParallelWorkflow(this.persistence, { maxConcurrency: options.maxConcurrency, identity: this.bindingHash,
      ...(options.cancellationTimeoutMs === undefined ? {} : { cancellationTimeoutMs: options.cancellationTimeoutMs }),
      currentLimit: async runId => {
        const base = await options.currentLimit(runId);
        const sampled = this.resourceController ? await this.resourceController.evaluate(runId) : undefined;
        return sampled ? Math.min(base, sampled.maxNewConcurrency) : base;
      },
      assertAdmission: context => this.admit(context), execute: (_node, context, dependencies) => this.execute(context, dependencies),
      verifyArtifact: (context, artifact) => this.verify(context, artifact), cancel: context => this.cancel(context) });
  }
  private saveResourceDecision(runId: string, stateKey: string, decision: ResourcePolicyDecision): void {
    this.parent.store.transaction(() => {
      this.parent.store.setComponentState(runId, 'resource-policy', stateKey, decision.state);
      this.parent.store.appendEvent(runId, 'resource.policy_decision', {
        stateKey, telemetry: decision.telemetry, maxNewConcurrency: decision.maxNewConcurrency,
        proposedConcurrency: decision.proposedConcurrency, reasons: decision.reasons, affects: decision.affects,
      });
    });
  }
  async run(parentRunId: string, signal?: AbortSignal) {
    assertCheckpointCompatible(this.parent.store, this.parent.store.getRun(parentRunId), this.runtimeFingerprint);
    return this.parallel.run(parentRunId, this.parent.store.getRun(parentRunId).budgetScopeKey, this.graph, signal);
  }
  childRunId(parentRunId: string, branchId: string): string { return `branch-${hash(JSON.stringify([parentRunId, argumentHash(this.graph), branchId])).slice(0, 64)}`; }
  private key(branchId: string): string { return `${this.graph.graphId}:${branchId}`; }
  private record(parentId: string, branchId: string): ChildRecord | undefined {
    const raw = this.parent.store.getComponentState(parentId, 'runtime-branches', this.key(branchId));
    if (raw === undefined) return undefined;
    const parsed = childSchema.safeParse(raw);
    if (!parsed.success || parsed.data.bindingHash !== this.bindingHash || parsed.data.childRunId !== this.childRunId(parentId, branchId)) throw new RuntimeError('VERSION_MISMATCH', 'Child runtime binding changed');
    return parsed.data;
  }
  private async admit(context: BranchContext): Promise<void> {
    context.signal.throwIfAborted(); this.persistence.assertRunning(context.runId, context.budgetScopeKey);
    const session = this.bindings[context.branchId]!.sessionId;
    if (await this.parent.budget.scopeForSession(session, { create: false }) !== context.budgetScopeKey) throw new RuntimeError('CONFLICT', 'Branch session escaped original root scope');
    const budget = await this.parent.budget.snapshot(context.budgetScopeKey);
    if (budget.unknownCalls || !budget.meteringComplete) throw new RuntimeError('USAGE_UNKNOWN', 'Branch accounting unresolved');
    if (budget.work.availableTokens <= 0) throw new RuntimeError('BUDGET_UNAVAILABLE', 'Branch work budget unavailable');
    context.signal.throwIfAborted(); this.persistence.assertRunning(context.runId, context.budgetScopeKey);
  }
  private service(parentId: string, branchId: string, dependencies: Record<string, GraphNodeResult>): RuntimeService {
    const childId = this.childRunId(parentId, branchId); const existing = this.services.get(childId); if (existing) return existing;
    const binding = this.bindings[branchId]!;
    const service = new RuntimeService(this.parent.store, this.parent.artifacts, this.parent.sandbox, this.parent.budget, this.parent.config, {
      ...this.options.serviceOptions, ...(this.options.now ? { now: this.options.now } : {}),
      validate: async (_run, artifacts) => {
        const expected = binding.expectedArtifacts.every(path => artifacts.some(a => a.path === path));
        const validation = expected ? await binding.validate({ artifacts, read: a => this.parent.artifacts.read(a), dependencies }) : { passed: false, data: {} };
        const data = validateBranchResult(branchId, { data: validation.data, artifacts: [] }).data;
        return { passed: expected && validation.passed, evidence: { version: 1, bindingHash: this.bindingHash,
          branchId, dependenciesHash: argumentHash(dependencies), validatorVersion: binding.validatorVersion, data } };
      },
    });
    this.services.set(childId, service); return service;
  }
  private async dependencyInputs(parentId: string, dependencies: Record<string, GraphNodeResult>): Promise<SandboxInput[]> {
    const inputs: SandboxInput[] = [];
    for (const [id, result] of Object.entries(dependencies)) {
      const state = this.persistence.load(parentId, this.graph, undefined, this.parallel.identity);
      if (state.nodes[id]?.status !== 'done' || argumentHash(state.nodes[id]!.result) !== argumentHash(result)) throw new RuntimeError('ARTIFACT_INVALID', 'Dependency result is not committed');
      for (const artifact of result.artifacts) {
        const context = { runId: parentId, branchId: id };
        const source = this.source(context, artifact); await this.parent.artifacts.verify([source]);
        inputs.push({ path: `dependencies/${id}/${source.path}`, content: await this.parent.artifacts.read(source) });
      }
    }
    return inputs;
  }
  private async execute(context: BranchContext, dependencies: Record<string, GraphNodeResult>): Promise<GraphNodeResult> {
    const binding = this.bindings[context.branchId]!; const root = this.parent.store.getRun(context.runId);
    const inputs = [...binding.inputs.map(i => ({ path: i.path, content: Buffer.from(i.content) })), ...await this.dependencyInputs(context.runId, dependencies)];
    if (new Set(inputs.map(i => i.path.toLowerCase())).size !== inputs.length) throw new RuntimeError('INVALID_INPUT', 'Branch input path collision');
    await this.admit(context);
    const childId = this.childRunId(context.runId, context.branchId);
    const inputHash = argumentHash({ parent: root.inputHash, binding: this.bindingHash, branch: context.branchId, dependencies,
      inputs: inputs.map(i => [i.path, hash(i.content)]) });
    this.parent.store.transaction(() => {
      this.persistence.assertRunning(root.runId, root.budgetScopeKey);
      if (this.record(root.runId, context.branchId)) throw new RuntimeError('EXECUTION_UNKNOWN', 'A prior child intent requires explicit reconciliation');
      this.parent.store.setComponentState(root.runId, 'runtime-branches', this.key(context.branchId), {
        version: 1, childRunId: childId, inputHash, bindingHash: this.bindingHash, dependenciesHash: argumentHash(dependencies), dispatchId: context.dispatchId, phase: 'pending',
      } satisfies ChildRecord);
      this.parent.store.appendEvent(root.runId, 'branch.child_intent', { branchId: context.branchId, childRunId: childId, dispatchId: context.dispatchId, budgetScopeKey: root.budgetScopeKey });
    });
    const service = this.service(root.runId, context.branchId, dependencies);
    // Cancellation may happen while createRun checks its ledger. Keep the full lifecycle locally active until it returns.
    await service.createRun({ runId: childId, rootSessionId: binding.sessionId, budgetScopeKey: root.budgetScopeKey,
      task: `Workflow ${this.graph.graphId} branch ${context.branchId}`, inputHash, deadline: root.deadline, policyVersion: root.policyVersion });
    context.signal.throwIfAborted();
    const result = await service.executeCode({ runId: childId, stepId: `code-${hash(childId).slice(0, 48)}`, code: binding.code, inputs }, context.signal);
    if (result.exitCode !== 0) { await service.finalize(childId, false); throw new RuntimeError('CONFLICT', 'Branch code failed'); }
    context.signal.throwIfAborted(); await service.finalize(childId, true);
    const outcome = await this.result(root.runId, context.branchId, dependencies);
    this.parent.store.setComponentState(root.runId, 'runtime-branches', this.key(context.branchId), { ...this.record(root.runId, context.branchId)!, phase: 'done' });
    return outcome;
  }
  private source(context: Pick<BranchContext, 'runId' | 'branchId'>, artifact: GraphNodeResult['artifacts'][number]): ArtifactRecord {
    const expected = this.childRunId(context.runId, context.branchId); const source = artifact.source;
    if (!source || source.runId !== expected) throw new RuntimeError('ARTIFACT_INVALID', 'Artifact has no trusted child provenance');
    const record = this.parent.store.listArtifacts(expected).find(a => a.artifactId === source.artifactId && a.attemptId === source.attemptId);
    if (!record || `branches/${context.branchId}/${record.path}` !== artifact.path || record.sha256 !== artifact.sha256 || record.size !== artifact.size) throw new RuntimeError('ARTIFACT_INVALID', 'Child artifact manifest changed');
    return record;
  }
  private async verify(context: BranchContext, artifact: GraphNodeResult['artifacts'][number]): Promise<void> {
    const record = this.source(context, artifact); const run = this.parent.store.getRun(record.runId);
    if (run.status !== 'SUCCEEDED') throw new RuntimeError('ARTIFACT_INVALID', 'Artifact child has not passed independent acceptance');
    await this.parent.artifacts.verify([record]);
  }
  private async result(parentId: string, branchId: string, dependencies: Record<string, GraphNodeResult>): Promise<GraphNodeResult> {
    const id = this.childRunId(parentId, branchId); const child = this.parent.store.getRun(id); const record = this.record(parentId, branchId);
    if (!record || child.status !== 'SUCCEEDED' || child.inputHash !== record.inputHash || child.budgetScopeKey !== this.parent.store.getRun(parentId).budgetScopeKey
      || record.dependenciesHash !== argumentHash(dependencies)) throw new RuntimeError('EXECUTION_UNKNOWN', 'Child outcome requires reconciliation');
    const events = this.parent.store.eventsAfter(id).filter(e => e.type === 'validation.completed');
    const payload = events.at(-1)?.payload as { passed?: boolean; evidence?: { bindingHash?: string; branchId?: string; dependenciesHash?: string; data?: unknown } } | undefined;
    if (!payload?.passed || payload.evidence?.bindingHash !== this.bindingHash || payload.evidence.branchId !== branchId || payload.evidence.dependenciesHash !== argumentHash(dependencies)) throw new RuntimeError('ARTIFACT_INVALID', 'Child has no matching validation receipt');
    const artifacts = this.parent.store.listArtifacts(id); await this.parent.artifacts.verify(artifacts);
    return validateBranchResult(branchId, { data: payload.evidence.data, artifacts: artifacts.map(a => ({ path: `branches/${branchId}/${a.path}`,
      sha256: a.sha256, size: a.size, source: { runId: a.runId, attemptId: a.attemptId, artifactId: a.artifactId } })) });
  }
  private async cancel(context: BranchContext): Promise<boolean> {
    const record = this.record(context.runId, context.branchId);
    if (!record) return true;
    const child = this.parent.store.listRuns().find(r => r.runId === record.childRunId);
    // A pending createRun may still return later: absence after intent is not confirmation.
    if (!child) return false;
    if (['SUCCEEDED', 'COMPLETED_PARTIAL', 'CANCELLED', 'FAILED'].includes(child.status)) return this.confirmAndClean(child.runId);
    const service = this.services.get(child.runId);
    if (!service) return false;
    const final = await service.cancelRun(child.runId, `branch-cancel-${context.dispatchId}`, { reason: 'parent graph stopped' });
    return final.status === 'CANCELLED' && await this.confirmAndClean(child.runId);
  }
  private async confirmAndClean(childId: string): Promise<boolean> {
    if (this.parent.store.listAttempts(childId).some(a => unresolved(a.status))) return false;
    // A cancelled validator can still be unwinding locally after its execution already committed.
    // Finalization owns no remote command, so reclaim its stopped sandbox here as well.
    const sandbox = this.parent.store.getSandbox(childId);
    if (sandbox) {
      try { await this.parent.sandbox.destroy(sandbox); this.parent.store.releaseSandbox(sandbox); }
      catch { this.parent.store.appendEvent(childId, 'sandbox.cleanup_required', { sandboxId: sandbox.sandboxId }); }
    }
    return true;
  }
  /** Host-only recovery inspects existing child runs; it never calls executeCode or mints a retry. */
  async reconcile(parentId: string, expectedRevision: number, evidence: string) {
    assertCheckpointCompatible(this.parent.store, this.parent.store.getRun(parentId), this.runtimeFingerprint);
    const scope = this.parent.store.getRun(parentId).budgetScopeKey;
    const state = this.persistence.claimReconciliation(parentId, this.graph, scope, this.parallel.identity, expectedRevision, evidence);
    const owner = state.owner!; let committed = false;
    try {
    const outcomes: Record<string, NodeState> = {};
    for (const node of this.graph.nodes) {
      const old = state.nodes[node.id]!;
      if (!['running', 'unknown'].includes(old.status)) continue;
      const record = this.record(parentId, node.id); const childId = this.childRunId(parentId, node.id);
      const dependencies = Object.fromEntries(node.dependencies.filter(id => state.nodes[id]?.status === 'done').map(id => [id, state.nodes[id]!.result!]));
      if (!record) {
        outcomes[node.id] = { status: 'cancelled', ...(old.claimId ? { claimId: old.claimId } : {}), reason: 'Host confirmed no child run was created' }; continue;
      }
      if (!this.parent.store.listRuns().some(r => r.runId === childId)) {
        outcomes[node.id] = { status: 'unknown', ...(old.claimId ? { claimId: old.claimId } : {}), reason: 'Child creation intent has no confirmed outcome' }; continue;
      }
      const service = this.service(parentId, node.id, dependencies);
      await service.recover(childId);
      let child = this.parent.store.getRun(childId); const attempts = this.parent.store.listAttempts(childId);
      if (attempts.some(a => unresolved(a.status))) { outcomes[node.id] = { ...old, status: 'unknown', reason: 'Remote child remains unresolved' }; continue; }
      if (attempts.some(a => a.status === 'SUCCEEDED') && Object.keys(dependencies).length === node.dependencies.length) {
        if (['RECOVERY_REQUIRED', 'PAUSED_ACCOUNTING', 'PAUSED_BUDGET'].includes(child.status)) child = await service.resumeRun(childId, `branch-reconcile-${expectedRevision}`, child.revision);
        if (child.status === 'RUNNING') await service.finalize(childId, true);
        if (this.parent.store.getRun(childId).status === 'SUCCEEDED') {
          outcomes[node.id] = { status: 'done', claimId: old.claimId ?? record.dispatchId, result: await this.result(parentId, node.id, dependencies) }; continue;
        }
      }
      if (!['SUCCEEDED', 'COMPLETED_PARTIAL', 'CANCELLED', 'FAILED'].includes(child.status)) child = await service.cancelRun(childId,
        `branch-reconcile-cancel-${expectedRevision}`, { reason: 'host reconciled child without accepted result' });
      outcomes[node.id] = { status: child.status === 'CANCELLED' ? 'cancelled' : 'failed', ...(old.claimId ? { claimId: old.claimId } : {}), reason: 'Host inspected terminal child without accepted result' };
    }
    const result = this.persistence.commitReconciliation(parentId, this.graph, scope, this.parallel.identity, owner, state.revision, outcomes, evidence);
    committed = true; return result;
    } finally { if (!committed) this.persistence.release(parentId, this.graph, scope, this.parallel.identity, owner); }
  }
}
