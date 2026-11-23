import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../contracts/runtime.js';
import { argumentHash } from '../core/approvals.js';
import { conditionMatches, GraphStateStore, validateBranchResult, validateGraph, type GraphNode, type GraphNodeResult, type WorkflowGraph, type NodeState } from './graph.js';

export interface BranchContext {
  runId: string; budgetScopeKey: string; graphId: string; branchId: string; dispatchId: string; namespace: string; signal: AbortSignal;
}
export interface ParallelOptions {
  maxConcurrency: number;
  /** Trusted code/validator/input binding identity; changed bindings cannot reuse stored results. */
  identity?: string;
  cancellationTimeoutMs?: number;
  /** Re-evaluated before each launch; combines budget and resource soft limits. Zero pauses new launches. */
  currentLimit: (runId: string) => Promise<number>;
  assertAdmission: (context: BranchContext) => Promise<void>;
  execute: (node: GraphNode, context: BranchContext, dependencies: Record<string, GraphNodeResult>) => Promise<GraphNodeResult>;
  verifyArtifact: (context: BranchContext, artifact: GraphNodeResult['artifacts'][number]) => Promise<void>;
  /** True means every remote command is confirmed stopped. Local abort alone is insufficient. */
  cancel: (context: BranchContext) => Promise<boolean>;
}
const unknown = (error: unknown) => error instanceof RuntimeError && ['EXECUTION_UNKNOWN', 'CANCEL_UNCONFIRMED', 'USAGE_UNKNOWN'].includes(error.code);
const reason = (error: unknown) => (error instanceof Error ? error.message : 'Branch failed').slice(0, 2000) || 'Branch failed';
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}
async function bounded<T>(promise: Promise<T>, timeout: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeout); })]); }
  catch { return fallback; }
  finally { if (timer) clearTimeout(timer); }
}

/** Each execution callback must own an isolated remote sandbox and child run. */
export class ParallelWorkflow {
  readonly identity: string;
  private readonly cancellationTimeout: number;
  constructor(private readonly persistence: GraphStateStore, private readonly options: ParallelOptions) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 8) throw new TypeError('Parallel limit must be 1..8');
    this.cancellationTimeout = options.cancellationTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.cancellationTimeout) || this.cancellationTimeout < 1 || this.cancellationTimeout > 60_000) throw new TypeError('Cancellation bound must be 1..60000ms');
    this.identity = argumentHash({ version: 2, maxConcurrency: options.maxConcurrency, cancellationTimeoutMs: this.cancellationTimeout, host: options.identity ?? 'parallel-v2' });
  }
  async run(runId: string, budgetScopeKey: string, value: WorkflowGraph, signal?: AbortSignal) {
    const graph = validateGraph(value);
    let state = this.persistence.claim(runId, graph, budgetScopeKey, this.identity); const owner = state.owner!;
    const controller = new AbortController(); const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let closing = false;
    let internalFailure: unknown;
    let released = false;
    const operations = new Set<Promise<unknown>>();
    const track = <T>(promise: Promise<T>): Promise<T> => {
      operations.add(promise);
      const settled = () => { operations.delete(promise); if (released && operations.size === 0) this.persistence.markQuiescent(owner); };
      void promise.then(settled, settled); return promise;
    };
    const active = new Map<string, { context: BranchContext; promise: Promise<void>; dispatched: boolean }>();
    const cancels = new Map<string, Promise<boolean>>();
    const contextFor = (id: string, dispatchId: string): BranchContext => ({ runId, budgetScopeKey, graphId: graph.graphId,
      branchId: id, dispatchId, namespace: `branches/${id}/`, signal: combined });
    const update = (id: string, next: NodeState, event: string) => {
      state = this.persistence.update(runId, graph, budgetScopeKey, this.identity, owner, s => { s.nodes[id] = next; }, event, { nodeId: id });
    };
    const cancel = (context: BranchContext) => {
      let promise = cancels.get(context.branchId);
      if (!promise) { promise = bounded(track(Promise.resolve().then(() => this.options.cancel(context))), this.cancellationTimeout, false); cancels.set(context.branchId, promise); }
      return promise;
    };
    const cleanup = async () => {
      closing = true; controller.abort(); const pending = [...active.values()];
      await Promise.all(pending.map(async item => {
        const confirmed = !item.dispatched || await cancel(item.context);
        const old = state.nodes[item.context.branchId]!;
        if (old.status === 'running') update(item.context.branchId, { status: confirmed ? 'cancelled' : 'unknown', claimId: item.context.dispatchId,
          reason: confirmed ? 'Cancellation confirmed' : 'Cancellation not confirmed' }, 'branch.cancelled');
      }));
      // Do not await a remote promise forever; fenced late callbacks cannot mutate persisted graph state.
    };
    const launch = (node: GraphNode) => {
      const context = contextFor(node.id, randomUUID());
      update(node.id, { status: 'running', claimId: context.dispatchId }, 'branch.dispatch_intent');
      const item = { context, promise: Promise.resolve(), dispatched: false }; active.set(node.id, item);
      item.promise = track((async () => {
        try {
          await this.options.assertAdmission(context); combined.throwIfAborted(); this.persistence.assertRunning(runId, budgetScopeKey);
          if (closing) return;
          item.dispatched = true;
          const result = validateBranchResult(node.id, await this.options.execute(node, context,
            structuredClone(Object.fromEntries(node.dependencies.map(id => [id, state.nodes[id]!.result!])))));
          for (const artifact of result.artifacts) await this.options.verifyArtifact(context, artifact);
          if (closing || combined.aborted) return;
          update(node.id, { status: 'done', claimId: context.dispatchId, result }, 'branch.completed');
        } catch (error) {
          if (closing || combined.aborted) return;
          const uncertain = unknown(error) || (item.dispatched && !await cancel(context));
          if (closing || combined.aborted) return;
          update(node.id, { status: uncertain ? 'unknown' : 'failed', claimId: context.dispatchId, reason: reason(error) }, 'branch.failed');
          if (node.required || uncertain) controller.abort();
        } finally {
          // During cancellation keep the item until confirmation is recorded.
          if (!combined.aborted && !closing) active.delete(node.id);
        }
      })().catch(error => { internalFailure = error; controller.abort(); }));
    };
    try {
      while (!combined.aborted) {
        this.persistence.assertRunning(runId, budgetScopeKey);
        const proposed = await abortable(Promise.resolve().then(() => this.options.currentLimit(runId)), combined);
        combined.throwIfAborted(); this.persistence.assertRunning(runId, budgetScopeKey);
        if (!Number.isSafeInteger(proposed) || proposed < 0) throw new RuntimeError('INVALID_INPUT', 'Invalid dynamic concurrency');
        const limit = Math.min(this.options.maxConcurrency, proposed); let launched = false;
        for (const node of graph.nodes) {
          if (state.nodes[node.id]!.status !== 'pending') continue;
          const deps = node.dependencies.map(id => state.nodes[id]!.status);
          if (deps.some(status => ['failed', 'skipped', 'cancelled'].includes(status))) {
            update(node.id, { status: node.required ? 'failed' : 'skipped', reason: 'Dependency did not complete' }, 'branch.skipped'); continue;
          }
          if (deps.some(status => status !== 'done')) continue;
          if (!conditionMatches(node, state)) { update(node.id, { status: 'skipped', reason: 'Condition false' }, 'branch.skipped'); continue; }
          if (active.size >= limit) break;
          launch(node); launched = true; break;
        }
        if (launched) continue;
        if (!active.size) break;
        // Wake periodically so host pause/cancel and the original deadline also stop a hung callback.
        let wake: ReturnType<typeof setTimeout> | undefined;
        try {
          await abortable(Promise.race([...active.values()].map(a => a.promise).concat([
            new Promise<void>(resolve => { wake = setTimeout(resolve, 100); }),
          ])), combined);
        } finally { if (wake) clearTimeout(wake); }
      }
      if (combined.aborted) await cleanup();
      if (internalFailure) throw internalFailure;
      // Every retained result, including prior-process results, must still pass content verification.
      const artifacts: GraphNodeResult['artifacts'] = [];
      for (const node of graph.nodes) {
        const item = state.nodes[node.id]!;
        if (item.status !== 'done') continue;
        const context = contextFor(node.id, item.claimId!);
        try {
          for (const artifact of item.result!.artifacts) {
            if (combined.aborted) break;
            await abortable(Promise.resolve().then(() => this.options.verifyArtifact(context, artifact)), combined); artifacts.push(artifact);
          }
        } catch (error) {
          if (!combined.aborted) {
            state = this.persistence.update(runId, graph, budgetScopeKey, this.identity, owner, s => {
              const invalid = new Set([node.id]);
              for (let i = 0; i < graph.nodes.length; i++) for (const candidate of graph.nodes) {
                if (candidate.dependencies.some(dep => invalid.has(dep))) invalid.add(candidate.id);
              }
              for (const id of invalid) if (s.nodes[id]!.status === 'done') s.nodes[id] = { status: 'unknown', claimId: s.nodes[id]!.claimId!, reason: reason(error) };
            }, 'branch.merge_invalid', { nodeId: node.id });
          }
          throw error;
        }
      }
      if (new Set(artifacts.map(a => a.path.toLowerCase())).size !== artifacts.length) throw new RuntimeError('ARTIFACT_INVALID', 'Merge has conflicting paths');
      if (!combined.aborted) this.persistence.assertRunning(runId, budgetScopeKey);
      const complete = !combined.aborted && graph.nodes.filter(n => n.required).every(n => state.nodes[n.id]!.status === 'done')
        && Object.values(state.nodes).every(n => !['running', 'pending', 'unknown'].includes(n.status));
      state = this.persistence.update(runId, graph, budgetScopeKey, this.identity, owner, () => {}, 'graph.snapshot', { complete, artifacts });
      return { complete, state, artifacts };
    } catch (error) {
      await cleanup();
      if (!signal?.aborted && !(controller.signal.aborted && error === combined.reason)) throw error;
      return { complete: false, state, artifacts: [] as GraphNodeResult['artifacts'] };
    } finally {
      closing = true;
      Object.assign(state, this.persistence.release(runId, graph, budgetScopeKey, this.identity, owner, operations.size === 0));
      released = true;
    }
  }
}
