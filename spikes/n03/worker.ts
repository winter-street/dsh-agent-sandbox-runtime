import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { ARTIFACT_FORMAT_INSTRUCTIONS, validateArtifacts } from '../../eval/artifact-validation.js';
import { connectBudgetService } from '../../src/adapters/budget/index.js';
import { BudgetReceiptSynchronizer } from '../../src/adapters/budget/receipts.js';
import { createRuntimeHarnessIntegration } from '../../src/adapters/harness/composition.js';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import { createRuntimeServer } from '../../src/api/server.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { loadConfig } from '../../src/config.js';
import { ContextCheckpointStore } from '../../src/context/checkpoint.js';
import { RuntimeService } from '../../src/core/service.js';
import { DeepSeekAdapter } from '../../src/models/deepseek.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { SerialWorkflow, type WorkflowRole } from '../../src/workflow/serial.js';

export const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const model = 'deepseek-flash';
export const maxCalls = 5;
export const domain = 'http://127.0.0.1:8090';
export const pluginUrl = new URL('../../.sources/budget/lib/index.js', import.meta.url);
const roles = ['planner', 'executor', 'reviewer'] as const;
const session = (role: WorkflowRole) => 'n03-' + role;
const rootId = 'n03-root';
export function env(name: string) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error('Missing ' + name);
  return value;
}
export function safeError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of ['DEEPSEEK_API_KEY', 'OPEN_SANDBOX_API_KEY', 'N03_HTTP_TOKEN']) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[redacted]');
  }
  return message;
}

export async function boot(directory: string, runId: string, deadline: number, portNumber: number) {
  const restart = portNumber !== 0;
  const input = readFileSync('examples/charging-analysis/normal.csv');
  const inputHash = sha(input);
  const task = [readFileSync('examples/charging-analysis/TASK.md', 'utf8'), ARTIFACT_FORMAT_INSTRUCTIONS,
    'Input CSV headers: alert_id, device_id, occurred_at, severity, review_state. All five headers are required. Use occurred_at for the timestamp; never expect a timestamp column. Empty review_state means pending; empty severity means unknown.',
    'The Executor must return the complete Python program as JSON; the host runs it once. The Reviewer gets independent artifact validation in the tool result, and should use that evidence.'].join('\n\n');
  const ctx = new Context();
  const store = new RuntimeStore(join(directory, 'database'));
  const artifacts = new ArtifactStore(join(directory, 'artifacts'));
  const cleanups: Array<() => unknown> = [() => store.close(), () => ctx.fiber.dispose()];
  const close = async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); };
  try {
    await ctx.plugin(LlmRuntime).await(); await ctx.plugin(SessionStore).await(); await ctx.plugin(SystemPrompt).await();
    await ctx.plugin(ToolRuntime).await(); await ctx.plugin(AgentRegistry).await(); await ctx.plugin(AgentLoop, { agents: [] }).await();
    const plugin = await import(pluginUrl.href) as { name: string; inject: string[]; apply(ctx: Context, config: unknown): void };
    const ledger = join(directory, 'budget');
    await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
      maxTokens: 50_000, reservationMode: true, pressurePrompt: false, storageDir: ledger, maxConcurrentCalls: 1,
    }).await();
    const budget = connectBudgetService(ctx).control;
    const agentOptions = { provider: 'deepseek', model };
    const root = await ctx.agents.create({ sessionId: SessionId(rootId), agentOptions }); cleanups.push(() => root.dispose());
    for (const role of roles) {
      const child = await root.agent.ctx.agents.create({ sessionId: SessionId(session(role)), agentOptions,
        meta: { parentSession: root.agent.id, origin: 'subagent', delegationDepth: 1 } }); cleanups.push(() => child.dispose());
    }
    const scopeKey = await budget.scopeForSession(rootId);
    const dispatches = () => store.getComponentState<number>(runId, 'n03', 'provider-dispatches') ?? 0;
    ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({ apiKey: env('DEEPSEEK_API_KEY'), thinking: 'disabled', maxCalls, requestTimeoutMs: 90_000,
      fetch: async (url, init) => {
        init?.signal?.throwIfAborted();
        // The total HTTP dispatch limit survives loss of the worker process.
        store.transaction(() => {
          const count = dispatches(); assert(count < maxCalls, 'N03 total model dispatch cap reached');
          store.setComponentState(runId, 'n03', 'provider-dispatches', count + 1);
        });
        return fetch(url, init);
      } }));
    const sandbox = new OpenSandboxAdapter({ connection: { domain, apiKey: env('OPEN_SANDBOX_API_KEY'),
      useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 60 }, pollIntervalMs: 150, cancelTimeoutMs: 10_000 });
    const validate = () => validateArtifacts(input, store.listArtifacts(runId), artifacts);
    const service = new RuntimeService(store, artifacts, sandbox, budget, loadConfig('config/runtime-hard.json'), { validate: async () => {
      const evidence = await validate(); return { passed: evidence.passed, evidence };
    } });
    if (restart) {
      const prior = store.getRun(runId);
      assert.equal(prior.budgetScopeKey, scopeKey); assert.equal(prior.deadline, deadline); assert.equal(prior.inputHash, inputHash); assert.equal(prior.task, task);
      await service.recover(runId);
    } else await service.createRun({ runId, rootSessionId: rootId, budgetScopeKey: scopeKey, task, deadline, inputHash, policyVersion: 'n03-v1' });
    const inputs = async () => [{ path: 'input.csv', content: input }];
    const sync = new BudgetReceiptSynchronizer(store, budget, ledger);
    const context = new ContextCheckpointStore(store, runId);
    const snapshot = async () => {
      const receiptSync = await sync.sync(runId);
      const run = await service.getRun(runId); const checkpoint = context.load();
      const receipts = (await budget.eventsAfter(0)).filter(event => event.scopeKey === scopeKey && event.type === 'settle')
        .map(({ eventId, cursor, payload }) => ({ eventId, cursor, reservationId: payload.reservationId }));
      const roleRecords = roles.map(role => ({ role, record: store.getComponentState<{ status: string; receiptId?: string; modelCallId?: string }>(runId, 'role-calls', role + '-0') }))
        .map(({ role, record }) => ({ role, status: record?.status, receiptId: record?.receiptId, modelCallId: record?.modelCallId }));
      return { pid: process.pid, runId, rootId, scopeKey, inputHash, deadline, status: run.status, attemptIds: run.attempts.map(a => ({
        attemptId: a.attemptId, executionId: a.executionId, status: a.status,
      })), artifacts: run.artifacts, budget: run.budget, receiptSync, receipts, roleRecords, cursor: run.lastEventSeq,
        providerDispatches: dispatches(), sandboxReleased: !store.getSandbox(runId), validation: await validate(),
        context: checkpoint && { version: checkpoint.version, contentHash: checkpoint.contentHash, coverages: checkpoint.coverages,
          entries: checkpoint.entries.map(({ id, layer, required, sourceRefs }) => ({ id, layer, required, sourceRefs })) },
      };
    };
    const integration = createRuntimeHarnessIntegration(service, budget, { inputs,
      output: { kind: 'structured', minTokens: 128, defaultMaxTokens: 4096 } });
    await ctx.plugin(integration.plugin).await();
    for (const id of [rootId, ...roles.map(session)]) await integration.bindSession(runId, id);
    const port = integration.createRolePort(ctx, { provider: 'deepseek', model, maxOutputTokens: 4096, context: {
      modelWindowTokens: 16_384, safetyReserveTokens: 256, protectRecentTools: 1,
      countRequestTokens: request => Math.ceil(Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })) / 3) + 64,
      summary: { triggerRatio: 0.05, maxOutputTokens: 2048, maxAttemptsTotal: 2 },
      initialEntries: () => [{ id: 'task-boundary', revision: 1, layer: 'system', required: true,
        text: 'Use only the attached synthetic input. Do not expand sandbox permissions. Host artifact validation is authoritative.', sourceRefs: [] }],
    } });
    const workflow = new SerialWorkflow(service, budget, port, { maxRepairs: 0, sessionForRole: (_id, role) => session(role), inputs,
      executor: { async executeCode(request, signal) {
        const result = await service.executeCode(request, signal);
        if (!restart) {
          assert.equal(result.exitCode, 0, 'Sandbox command failed');
          const validation = await validate();
          if (!validation.passed) throw new Error('Artifact validation failed: ' + validation.problems.join('; '));
          const checkpoint = context.load(); assert(checkpoint);
          context.replace(checkpoint.version, [...checkpoint.entries, { id: 'validated-sandbox-output', revision: 1,
            layer: 'tool', callId: 'n03-execution', toolName: 'runtime_python', arguments: '{}',
            result: JSON.stringify({ result, hostValidation: { passed: validation.passed, ...validation.checks, statistics: validation.statistics } }),
            sourceRefs: store.listArtifacts(runId).map(a => 'artifact:' + a.artifactId + ':' + a.sha256),
          }]);
          process.send?.({ phase: 'committed', snapshot: await snapshot() });
          await new Promise<never>((_done, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return result;
      } },
    });
    const server = createRuntimeServer(service, { token: env('N03_HTTP_TOKEN'), client: true, eventPollMs: 100 });
    server.listen(portNumber, '127.0.0.1'); await once(server, 'listening');
    cleanups.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
    const address = server.address(); assert(address && typeof address !== 'string');
    return { service, workflow, snapshot, close, url: 'http://127.0.0.1:' + address.port };
  } catch (error) { await close(); throw error; }
}

export type Snapshot = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['snapshot']>>;
export type WorkerMessage = { phase: 'ready'; url: string } | { phase: 'committed'; snapshot: Snapshot }
  | { phase: 'finished'; snapshot: Snapshot } | { phase: 'failed'; error: string; snapshot?: Snapshot };
export async function worker(directory: string, runId: string, deadline: number, port: number) {
  const host = await boot(directory, runId, deadline, port);
  const controller = new AbortController();
  let active: Promise<void> | undefined;
  process.once('message', command => {
    if (command !== 'run') return;
    active = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
        await host.workflow.run(runId, signal);
        process.send?.({ phase: 'finished', snapshot: await host.snapshot() } satisfies WorkerMessage);
      } catch (error) {
        const snapshot = await host.snapshot().catch(() => undefined);
        if (process.connected) process.send?.({ phase: 'failed', error: safeError(error), ...(snapshot ? { snapshot } : {}) } satisfies WorkerMessage);
      }
    })();
  });
  process.once('disconnect', () => { void (async () => {
    controller.abort(); await Promise.race([active, new Promise(done => setTimeout(done, 2500).unref())]);
    try { await host.service.cancelRun(runId, 'n03-cleanup', { reason: 'Acceptance worker shutdown' }); } catch { /* Sandbox TTL bounds uncertain cleanup. */ }
    await host.close();
  })().catch(() => { process.exitCode = 1; }); });
  process.send?.({ phase: 'ready', url: host.url } satisfies WorkerMessage);
}
