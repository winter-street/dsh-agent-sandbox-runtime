import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { BudgetControlPort } from '../../contracts/budget.js';
import { RuntimeError, TERMINAL_RUN_STATES } from '../../contracts/runtime.js';
import type { SandboxInput } from '../../contracts/sandbox.js';
import type { RuntimeService } from '../../core/service.js';
import type { PolicyState } from '../../policy/engine.js';
import { createHarnessRuntimePlugin, type HarnessRuntimeOptions, type RuntimeCodeExecutor } from './index.js';
import { createHarnessModelPolicy, type ModelPolicyBinding } from './model-policy.js';
import { createHarnessRolePort, type HarnessRolePortOptions } from './roles.js';
import { DurableToolCallStore, type DurableToolRules } from '../../tools/durable.js';
import { ToolRegistry } from '../../tools/registry.js';
import { pythonToolLimits } from '../../tools/python.js';

interface SessionBinding { runId: string; sessionId: string; purpose: 'work' | 'finalize'; intent: 'work' | 'summary' | 'final-report' }
/** Bind only trusted host sessions. No budget creation, reset, or role selection is exposed as a tool. */
export function createRuntimeHarnessIntegration(service: RuntimeService, budget: BudgetControlPort, options: {
  inputs: (runId: string) => Promise<SandboxInput[]>;
  executor?: RuntimeCodeExecutor;
  toolRules?: DurableToolRules;
  acceptResult?: HarnessRuntimeOptions['acceptResult'];
  describeResult?: HarnessRuntimeOptions['describeResult'];
  authorize?: HarnessRuntimeOptions['authorize'];
  /** Lazily create and persist the run binding before a runtime tool call. */
  ensureRun?: (sessionId: string, parentSession: string | undefined, signal?: AbortSignal) => Promise<void>;
  /** Skip model policy for sessions that never bind a runtime run. */
  allowUnbound?: boolean;
  /** Interactive hosts keep the sandbox deadline out of model admission. */
  ignoreModelDeadline?: boolean;
  output?: ModelPolicyBinding['output']; now?: () => number;
}) {
  function lookup(sessionId: string): SessionBinding | undefined {
    const matches = service.store.listRuns().flatMap(run => service.store.listComponentState<SessionBinding>(run.runId, 'sessions')).filter(s => s.sessionId === sessionId);
    if (matches.length > 1) throw new RuntimeError('CONFLICT', 'Session is bound to multiple runs');
    return matches[0];
  }
  async function bindSession(runId: string, sessionId: string, purpose: SessionBinding['purpose'] = 'work', intent: SessionBinding['intent'] = 'work') {
    const run = service.store.getRun(runId);
    if (await budget.scopeForSession(sessionId, { create: false }) !== run.budgetScopeKey) throw new RuntimeError('CONFLICT', 'Child session must inherit the original root budget');
    const previous = lookup(sessionId);
    if (previous && previous.runId !== runId) throw new RuntimeError('CONFLICT', 'Session already bound');
    if (purpose === 'finalize' && intent !== 'final-report') throw new RuntimeError('INVALID_INPUT', 'Finalize purpose is reserved for reports');
    service.store.transaction(() => {
      service.store.setComponentState(runId, 'sessions', sessionId, { runId, sessionId, purpose, intent });
      service.store.appendEvent(runId, 'session.bound', { sessionId, purpose, intent });
    });
  }
  const modelPolicy = createHarnessModelPolicy({
    config: service.config.policy, budget, ...(options.now ? { now: options.now } : {}),
    ...(options.allowUnbound ? { allowUnbound: true } : {}),
    assertInfrastructureAvailable: () => service.assertInfrastructureAvailable(),
    resolveRun: async sessionId => {
      const binding = lookup(sessionId); if (!binding) return undefined;
      const run = service.store.getRun(binding.runId); const snapshot = await budget.snapshot(run.budgetScopeKey);
      const steps = service.store.listSteps(run.runId);
      return { runId: run.runId, budgetScopeKey: run.budgetScopeKey,
        cancelled: run.status === 'CANCELLING' || TERMINAL_RUN_STATES.has(run.status),
        permissionDenied: run.status !== 'RUNNING', deadline: options.ignoreModelDeadline ? Number.MAX_SAFE_INTEGER : run.deadline,
        stepBoundary: steps.filter(s => s.status === 'SUCCEEDED' || s.status === 'FAILED').length,
        settlementBoundary: snapshot.ledgerSeq, required: true, purpose: binding.purpose, intent: binding.intent,
        requiredWorkComplete: steps.length > 0 && steps.every(s => !s.required || s.status === 'SUCCEEDED'),
        // No output contract unless the host declares one: the runtime must not
        // truncate an answer behind the user's back with a generic default.
        ...(options.output ? { output: options.output } : {}) };
    },
    readState: runId => service.store.getPolicyState<PolicyState>(runId),
    commitDecision: (runId, decision, phase, admission) => service.commitPolicyDecision(runId, decision, phase, admission),
  });
  const runtimeTool = createHarnessRuntimePlugin({ executor: options.executor ?? service,
    registry: new ToolRegistry(new DurableToolCallStore(service.store)), pythonLimits: pythonToolLimits(service.config.sandbox), ...(options.toolRules ? { toolRules: options.toolRules } : {}),
    ...(options.describeResult ? { describeResult: options.describeResult } : {}),
    ...(options.acceptResult ? { acceptResult: options.acceptResult } : {}), ...(options.authorize ? { authorize: options.authorize } : {}), resolveRun: async (sessionId, parentSession, signal) => {
    await options.ensureRun?.(sessionId, parentSession, signal);
    const binding = lookup(sessionId); if (!binding || binding.purpose !== 'work') return undefined;
    // A conclusion drains its current result batch. Do not dispatch queued
    // sibling calls after this host has committed independent acceptance.
    if (options.acceptResult && service.store.listSteps(binding.runId).some(step => step.kind === 'review' && step.required && step.status === 'SUCCEEDED')) return undefined;
    const obligation = service.store.listSteps(binding.runId).find(step => step.kind === 'review' && step.required);
    return { runId: binding.runId, inputs: await options.inputs(binding.runId), ...(obligation ? { obligationId: obligation.stepId } : {}) };
  } });
  const plugin: Plugin.Object<void> = { name: 'runtime-composition', inject: ['tools', 'agents', 'llm'], apply(ctx) {
    ctx.plugin(modelPolicy.plugin); ctx.plugin(runtimeTool);
  } };
  /** Role context is opt-in host configuration and shares the service's existing durable store. */
  function createRolePort(ctx: Context, roleOptions: Omit<HarnessRolePortOptions, 'ctx' | 'budget' | 'context'> & {
    context?: Omit<NonNullable<HarnessRolePortOptions['context']>, 'store'>;
  }) {
    const { context, onContextBlocked, ...rest } = roleOptions;
    return createHarnessRolePort({ ...rest, ctx, budget,
      ...(context ? { context: { ...context, store: service.store } } : {}),
      onContextBlocked: async (request, error) => {
        service.pauseForContext(request.runId, error.code);
        await onContextBlocked?.(request, error);
      } });
  }
  return { plugin, bindSession, modelPolicy, createRolePort };
}
