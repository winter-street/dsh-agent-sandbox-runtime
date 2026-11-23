import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import type { createRuntimeHarnessIntegration } from '../adapters/harness/composition.js';
import { estimateModelTokens } from '../adapters/harness/model-policy.js';
import type { BudgetControlPort } from '../contracts/budget.js';
import { RuntimeError } from '../contracts/runtime.js';
import type { SandboxInput } from '../contracts/sandbox.js';
import type { RuntimeService } from '../core/service.js';
import { DurableToolCallStore, type DurableToolRules } from '../tools/durable.js';
import { McpToolConnection } from '../tools/mcp/client.js';
import { ToolRegistry } from '../tools/registry.js';
import { RegisteredPythonExecutor, pythonToolLimits } from '../tools/python.js';
import { ApprovedCodeExecutor } from '../workflow/approved-executor.js';
import { DurableRetryExecutor } from '../workflow/retry-executor.js';
import { RoleNotDispatchedError, SerialWorkflow, type WorkflowRole } from '../workflow/serial.js';

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'runtime/application-session': { version: 1; runId: string; role: 'root' | WorkflowRole };
  }
}

/** Informational seed keeps otherwise-empty sessions durable and is never model-visible. */
export function applicationSessionSeed(runId: string, role: 'root' | WorkflowRole): SessionEvent[] {
  return [{ type: 'runtime/application-session', seq: SessionSeq(0), time: Date.now(), ignorable: true, data: { version: 1, runId, role } }];
}

export const serialApplicationSchema = z.strictObject({
  mode: z.literal('serial'),
  maxRepairs: z.int().min(0).max(5),
  approval: z.strictObject({ reason: z.string().trim().min(1).max(1024), ttlMs: z.int().min(1000).max(86400000) }),
  retry: z.strictObject({ maxAttempts: z.int().min(1).max(5), baseDelayMs: z.int().min(0).max(10000), maxDelayMs: z.int().min(0).max(60000) })
    .refine(value => value.maxDelayMs >= value.baseDelayMs, 'Retry delay bounds are inconsistent'),
  context: z.strictObject({
    modelWindowTokens: z.int().min(2048).max(1000000), safetyReserveTokens: z.int().min(0).max(100000),
    summary: z.strictObject({ triggerRatio: z.number().min(0.1).max(0.95), maxOutputTokens: z.int().min(128).max(2048) }).optional(),
  }),
  reference: z.strictObject({ key: z.enum(['ranking', 'missing_value']) }).optional(),
});
export type SerialApplicationConfig = z.infer<typeof serialApplicationSchema>;
const roles: WorkflowRole[] = ['planner', 'executor', 'reviewer'];

/** Uses the same conservative framing estimate as admission, not a provider tokenizer. */
function countRequestTokens(request: Readonly<GenerateOptions>): number {
  return estimateModelTokens({ ...request, maxTokens: 1 });
}

/** Trusted application composition. MCP is a fixed read-only prefetch, never a model-selected host command. */
export class SerialApplicationWorkflow {
  private readonly handles = new Map<string, AgentHandle[]>();
  private readonly workflows = new Map<string, SerialWorkflow>();
  private readonly registry: ToolRegistry;
  private readonly executor: RegisteredPythonExecutor;
  private mcp: McpToolConnection | undefined;
  private connecting: Promise<void> | undefined;
  constructor(private readonly options: {
    ctx: Context; service: RuntimeService; budget: BudgetControlPort;
    integration: ReturnType<typeof createRuntimeHarnessIntegration>; rules: DurableToolRules;
    config: SerialApplicationConfig; model: { provider: string; name: string; maxOutputTokens: number };
    inputs(runId: string): Promise<SandboxInput[]>;
    finalize: RuntimeService['finalize'];
  }) {
    this.registry = new ToolRegistry(new DurableToolCallStore(options.service.store));
    this.executor = new RegisteredPythonExecutor(
      new ApprovedCodeExecutor(options.service, new DurableRetryExecutor(options.service, options.config.retry), options.rules, options.config.approval),
      this.registry, pythonToolLimits(options.service.config.sandbox),
    );
  }
  private async connectReference(): Promise<void> {
    if (!this.connecting) {
      const source = fileURLToPath(new URL(`../tools/mcp/reference-server.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));
      this.mcp = new McpToolConnection({ command: process.execPath, args: source.endsWith('.ts') ? ['--import', 'tsx', source] : [source] });
      this.connecting = this.mcp.connect(this.registry, [{ name: 'lookup_rule', permissions: ['reference:read'],
        timeoutMs: 2000, maxOutputBytes: 4096, idempotency: 'read-only' }]);
    }
    await this.connecting;
  }
  async run(runId: string, root: AgentHandle, signal: AbortSignal): Promise<void> {
    const { service, budget, integration, config, model, inputs, rules } = this.options;
    const store = service.store;
    const run = store.getRun(runId);
    let workflow = this.workflows.get(runId);
    if (!workflow) {
      const handles = this.handles.get(runId) ?? []; this.handles.set(runId, handles);
      for (const role of roles) {
        signal.throwIfAborted();
        const sessionId = `${run.rootSessionId}-${role}`;
        if (handles.some(handle => handle.agent.id === sessionId)) continue;
        const bound = store.getComponentState(runId, 'sessions', sessionId);
        const agentOptions = { provider: model.provider, model: model.name, maxTokens: model.maxOutputTokens };
        const child = bound
          ? await root.agent.ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions })
          : await root.agent.ctx.agents.create({ sessionId: SessionId(sessionId),
            seed: applicationSessionSeed(runId, role),
            meta: { parentSession: root.agent.id, origin: 'subagent', delegationDepth: 1 }, agentOptions });
        handles.push(child);
        // Persist lineage before binding the child or admitting its first provider request.
        await this.options.ctx.sessions.flush(child.agent.session);
        await integration.bindSession(runId, sessionId);
      }
      const port = integration.createRolePort(this.options.ctx, { provider: model.provider, model: model.name, maxOutputTokens: model.maxOutputTokens,
        context: { modelWindowTokens: config.context.modelWindowTokens, safetyReserveTokens: config.context.safetyReserveTokens,
          ...(config.context.summary ? { summary: config.context.summary } : {}), countRequestTokens, initialEntries: async request => {
          if (!config.reference) return [];
          try {
            await this.connectReference();
            request.signal?.throwIfAborted();
            const action = { callId: 'application-reference', toolName: 'mcp.lookup_rule', arguments: { key: config.reference.key },
              inputVersion: run.inputHash, progressVersion: run.inputHash };
            const admission = rules.admit(runId, action);
            if (!admission.allowed) throw new RuntimeError('POLICY_TOOL_BLOCKED', admission.reason ?? 'Reference quota rejected');
            const reference = await this.registry.execute({ ...action, runId, grantedPermissions: ['reference:read'],
              ...(request.signal ? { signal: request.signal } : {}), authorize: () => {
                service.assertInfrastructureAvailable();
                const current = store.getRun(runId);
                return { allowed: current.status === 'RUNNING' && current.deadline > Date.now(), reason: 'Task is paused, cancelled or expired' };
              } }, action.toolName, action.arguments);
            rules.record(runId, action, { ok: reference.ok, progressVersion: action.progressVersion,
              ...(!reference.ok ? { errorSignature: reference.error.code } : {}) });
            if (!reference.ok) throw new RuntimeError(reference.error.code === 'EXECUTION_UNKNOWN' ? 'EXECUTION_UNKNOWN' : 'CONFLICT', 'Reference lookup did not complete');
            return [{ id: 'application-reference', revision: 1, layer: 'tool', toolName: action.toolName, callId: reference.callId,
              arguments: JSON.stringify(action.arguments), result: JSON.stringify(reference.value), required: true, sourceRefs: [`tool-call:${reference.callId}`] }];
          } catch (cause) {
            const failure = cause instanceof RuntimeError ? cause : new RuntimeError('EXECUTION_UNKNOWN', 'Required reference status is unknown');
            const error = new RoleNotDispatchedError('Required MCP reference is unavailable; reconcile before continuing');
            Object.assign(error, { code: failure.code, cause: failure });
            throw error;
          }
        } },
      });
      workflow = new SerialWorkflow(service, budget, port, { sessionForRole: (_id, role) => `${run.rootSessionId}-${role}`,
        maxRepairs: config.maxRepairs, inputs, executor: this.executor, finalizer: { finalize: this.options.finalize } });
      this.workflows.set(runId, workflow);
    }
    await workflow.run(runId, signal);
  }
  async disposeRun(runId: string): Promise<void> {
    this.workflows.delete(runId);
    for (const handle of (this.handles.get(runId) ?? []).reverse()) {
      await this.options.ctx.sessions.flush(handle.agent.session).catch(() => undefined);
      await handle.dispose().catch(() => undefined);
    }
    this.handles.delete(runId);
  }
  async close(): Promise<void> {
    for (const runId of this.handles.keys()) await this.disposeRun(runId);
    await this.mcp?.close();
    this.executor.dispose();
  }
}
