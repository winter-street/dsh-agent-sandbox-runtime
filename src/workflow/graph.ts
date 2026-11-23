import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IdSchema, RuntimeError } from '../contracts/runtime.js';
import type { RuntimeStore } from '../storage/index.js';
import { argumentHash } from '../core/approvals.js';

const nodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const condition = z.strictObject({ node: nodeId, field: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/), equals: z.union([z.string(), z.boolean(), z.number().finite(), z.null()]) });
export const WorkflowGraphSchema = z.strictObject({
  version: z.literal(1), graphId: IdSchema,
  nodes: z.array(z.strictObject({ id: nodeId, required: z.boolean(), dependencies: z.array(nodeId).max(100), condition: condition.optional() })).min(1).max(100),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
export type GraphNode = WorkflowGraph['nodes'][number];
const resultSchema = z.strictObject({
  data: z.record(z.string(), z.json()),
  artifacts: z.array(z.strictObject({ path: z.string().min(1).max(512), sha256: digest, size: z.int().nonnegative().safe(),
    source: z.strictObject({ runId: IdSchema, attemptId: IdSchema, artifactId: IdSchema }).optional(),
  })).max(100),
});
export type GraphNodeResult = z.infer<typeof resultSchema>;
const nodeStateSchema = z.strictObject({
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped', 'unknown', 'cancelled']),
  claimId: z.string().min(1).optional(), result: resultSchema.optional(), reason: z.string().min(1).max(2000).optional(),
}).refine(s => s.status === 'done' ? !!s.result && !s.reason && !!s.claimId
  : s.status === 'pending' ? !s.result && !s.reason && !s.claimId
    : s.status === 'running' ? !!s.claimId && !s.result && !s.reason : !s.result && !!s.reason);
const stateSchema = z.strictObject({ version: z.literal(2), graphHash: digest, bindingHash: digest,
  revision: z.int().nonnegative().safe(), owner: z.string().min(1).nullable(), nodes: z.record(nodeId, nodeStateSchema) });
export type GraphState = z.infer<typeof stateSchema>;
export type NodeState = GraphState['nodes'][string];
const localOwners = new Set<string>();

export function validateGraph(value: unknown): WorkflowGraph {
  const graph = WorkflowGraphSchema.parse(value); const byId = new Map(graph.nodes.map(n => [n.id, n]));
  if (byId.size !== graph.nodes.length) throw new RuntimeError('INVALID_INPUT', 'Duplicate graph node');
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new RuntimeError('INVALID_INPUT', 'Workflow graph has a cycle');
    if (visited.has(id)) return; const node = byId.get(id);
    if (!node) throw new RuntimeError('INVALID_INPUT', 'Missing dependency');
    if (new Set(node.dependencies).size !== node.dependencies.length) throw new RuntimeError('INVALID_INPUT', 'Duplicate dependency');
    visiting.add(id); for (const dep of node.dependencies) visit(dep);
    if (node.condition && !node.dependencies.includes(node.condition.node)) throw new RuntimeError('INVALID_INPUT', 'Condition must reference a direct dependency');
    if (node.required && (node.condition || node.dependencies.some(dep => !byId.get(dep)!.required))) throw new RuntimeError('INVALID_INPUT', 'Required nodes cannot depend on optional or conditional work');
    visiting.delete(id); visited.add(id);
  }
  for (const node of graph.nodes) visit(node.id);
  return graph;
}
export function conditionMatches(node: GraphNode, state: GraphState): boolean {
  if (!node.condition) return true;
  const dependency = state.nodes[node.condition.node];
  if (dependency?.status !== 'done') return false;
  let value: unknown = dependency.result!.data;
  for (const part of node.condition.field.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return false;
    value = (value as Record<string, unknown>)[part];
  }
  return value === node.condition.equals;
}
export function validateBranchResult(branchId: string, value: unknown): GraphNodeResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new RuntimeError('ARTIFACT_INVALID', 'Invalid branch result schema');
  const result = parsed.data; const paths = new Set<string>();
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) throw new RuntimeError('ARTIFACT_INVALID', 'Branch result exceeds limit');
  for (const artifact of result.artifacts) {
    const path = artifact.path; const parts = path.split('/'); const normalized = path.toLowerCase();
    if (!path.startsWith(`branches/${branchId}/`) || parts.some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' '))
      || path !== path.normalize('NFC') || /[\\<>:"|?*\x00-\x1f\x7f]/.test(path)
      || parts.some(p => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|clock\$|conin\$|conout\$)(?:\.|$)/i.test(p))
      || paths.has(normalized)) throw new RuntimeError('ARTIFACT_INVALID', 'Branch artifact namespace invalid');
    paths.add(normalized);
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw new RuntimeError('ARTIFACT_INVALID', 'Branch artifact file/directory conflict');
  }
  return result;
}

/** Graph-wide durable claim fences every asynchronous branch runner. No automatic stale-owner reset. */
export class GraphStateStore {
  constructor(readonly store: RuntimeStore, private readonly now: () => number = Date.now) {}
  assertRunning(runId: string, scope: string): void {
    const run = this.store.getRun(runId);
    if (run.budgetScopeKey !== scope) throw new RuntimeError('CONFLICT', 'Graph escaped original root scope');
    if (run.status !== 'RUNNING') throw new RuntimeError('CONFLICT', 'Graph run is paused or terminal');
    if (this.now() >= run.deadline) throw new RuntimeError('EXECUTION_TIMEOUT', 'Original graph deadline elapsed');
  }
  load(runId: string, graph: WorkflowGraph, scope = this.store.getRun(runId).budgetScopeKey, identity = 'parallel-v2'): GraphState {
    validateGraph(graph); const root = this.store.getRun(runId);
    if (root.budgetScopeKey !== scope) throw new RuntimeError('CONFLICT', 'Graph scope mismatch');
    const graphHash = argumentHash(graph);
    const bindingHash = argumentHash({ scope, identity, inputHash: root.inputHash, rootSessionId: root.rootSessionId,
      deadline: root.deadline, policyVersion: root.policyVersion, runtime: this.store.getComponentState(runId, 'runtime', 'identity') ?? null });
    const raw = this.store.getComponentState(runId, 'graphs', graph.graphId);
    if (raw === undefined) return { version: 2, graphHash, bindingHash, revision: 0, owner: null,
      nodes: Object.fromEntries(graph.nodes.map(n => [n.id, { status: 'pending' as const }])) };
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success || parsed.data.graphHash !== graphHash || parsed.data.bindingHash !== bindingHash) throw new RuntimeError('VERSION_MISMATCH', 'Graph state, identity or original inputs changed');
    const state = parsed.data;
    if (Object.keys(state.nodes).length !== graph.nodes.length || graph.nodes.some(n => !Object.hasOwn(state.nodes, n.id))) throw new RuntimeError('VERSION_MISMATCH', 'Persisted graph nodes differ');
    for (const node of graph.nodes) {
      const item = state.nodes[node.id]!;
      if (item.status === 'done') {
        validateBranchResult(node.id, item.result);
        if (node.dependencies.some(dep => state.nodes[dep]!.status !== 'done') || !conditionMatches(node, state)) throw new RuntimeError('VERSION_MISMATCH', 'Completed branch has incompatible dependency evidence');
      }
      if (node.required && item.status === 'skipped') throw new RuntimeError('VERSION_MISMATCH', 'Required branch cannot be skipped');
    }
    return state;
  }
  claim(runId: string, graph: WorkflowGraph, scope: string, identity: string): GraphState {
    const state = this.store.transaction(() => {
      this.assertRunning(runId, scope); const state = this.load(runId, graph, scope, identity);
      if (Object.values(state.nodes).some(n => n.status === 'running' || n.status === 'unknown')) throw new RuntimeError('EXECUTION_UNKNOWN', 'Graph has unresolved remote work');
      if (state.owner) throw new RuntimeError('CONFLICT', 'Graph owner requires reconciliation');
      state.owner = randomUUID(); state.revision++;
      this.write(runId, graph, state, 'graph.claimed', {}); return state;
    });
    localOwners.add(state.owner!); return state;
  }
  update(runId: string, graph: WorkflowGraph, scope: string, identity: string, owner: string,
    mutate: (state: GraphState) => void, event: string, detail: unknown): GraphState {
    return this.store.transaction(() => {
      const state = this.load(runId, graph, scope, identity);
      if (state.owner !== owner) throw new RuntimeError('CONFLICT', 'Graph claim lost');
      mutate(state); state.revision++; this.write(runId, graph, state, event, detail); return this.load(runId, graph, scope, identity);
    });
  }
  markQuiescent(owner: string): void { localOwners.delete(owner); }
  release(runId: string, graph: WorkflowGraph, scope: string, identity: string, owner: string, quiescent = true): GraphState {
    try { return this.update(runId, graph, scope, identity, owner, s => {
      if (!Object.values(s.nodes).some(n => n.status === 'running' || n.status === 'unknown')) s.owner = null;
    }, 'graph.released', {}); }
    finally { if (quiescent) localOwners.delete(owner); }
  }
  /** Trusted host supplies externally verified outcomes, never a model tool or blind retry reset. */
  assertReconciliationAllowed(state: GraphState, revision: number): void {
    if (state.revision !== revision || (state.owner && localOwners.has(state.owner))) throw new RuntimeError('CONFLICT', 'Graph revision or active owner conflict');
  }
  /** Must precede all asynchronous recovery side effects, not just their final database commit. */
  claimReconciliation(runId: string, graph: WorkflowGraph, scope: string, identity: string, revision: number, evidence: string): GraphState {
    if (!evidence.trim()) throw new RuntimeError('INVALID_INPUT', 'Reconciliation evidence is required');
    const state = this.store.transaction(() => {
      const state = this.load(runId, graph, scope, identity); this.assertReconciliationAllowed(state, revision);
      state.owner = randomUUID(); state.revision++;
      this.write(runId, graph, state, 'graph.reconciliation_claimed', { evidence }); return state;
    });
    localOwners.add(state.owner!); return state;
  }
  reconcile(runId: string, graph: WorkflowGraph, scope: string, identity: string, revision: number,
    outcomes: Record<string, NodeState>, evidence: string): GraphState {
    let owner: string | undefined;
    try { return this.store.transaction(() => {
      const claimed = this.claimReconciliation(runId, graph, scope, identity, revision, evidence); owner = claimed.owner!;
      return this.commitReconciliation(runId, graph, scope, identity, owner, claimed.revision, outcomes, evidence);
    }); } finally { if (owner) localOwners.delete(owner); }
  }
  commitReconciliation(runId: string, graph: WorkflowGraph, scope: string, identity: string, owner: string, revision: number,
    outcomes: Record<string, NodeState>, evidence: string): GraphState {
    if (!evidence.trim()) throw new RuntimeError('INVALID_INPUT', 'Reconciliation evidence is required');
    const committed = this.store.transaction(() => {
      const state = this.load(runId, graph, scope, identity);
      if (state.owner !== owner || state.revision !== revision || !localOwners.has(owner)) throw new RuntimeError('CONFLICT', 'Reconciliation claim or revision changed');
      const unresolved = Object.entries(state.nodes).filter(([, s]) => s.status === 'running' || s.status === 'unknown').map(([id]) => id);
      if (Object.keys(outcomes).length !== unresolved.length || unresolved.some(id => !Object.hasOwn(outcomes, id))) throw new RuntimeError('INVALID_INPUT', 'Every unresolved branch requires an outcome');
      for (const id of unresolved) {
        const next = outcomes[id]!;
        if (!['done', 'failed', 'cancelled', 'unknown'].includes(next.status)) throw new RuntimeError('INVALID_INPUT', 'Cannot redispatch unresolved work');
        state.nodes[id] = next;
      }
      state.owner = null; state.revision++; this.write(runId, graph, state, 'graph.reconciled', { evidence });
      return this.load(runId, graph, scope, identity);
    });
    localOwners.delete(owner); return committed;
  }
  private write(runId: string, graph: WorkflowGraph, state: GraphState, event: string, detail: unknown): void {
    if (!stateSchema.safeParse(state).success) throw new RuntimeError('VERSION_MISMATCH', 'Invalid graph state mutation');
    this.store.setComponentState(runId, 'graphs', graph.graphId, state);
    this.store.appendEvent(runId, event, { graphId: graph.graphId, revision: state.revision, detail });
  }
}
