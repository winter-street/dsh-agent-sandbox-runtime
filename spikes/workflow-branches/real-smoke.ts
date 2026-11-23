import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native';
import { connectBudgetService } from '../../src/adapters/budget/index.js';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { loadConfig } from '../../src/config.js';
import { normalizeUsage } from '../../src/contracts/budget.js';
import type { ArtifactRecord } from '../../src/contracts/runtime.js';
import type { ExecutionPolicy, ExecutionRef, ExecutionRequest, SandboxPort, SandboxRef } from '../../src/contracts/sandbox.js';
import { RuntimeService } from '../../src/core/service.js';
import { normalizeResourceSample } from '../../src/resources/index.js';
import { ResourcePolicy } from '../../src/resources/policy.js';
import { RuntimeStore } from '../../src/storage/index.js';
import type { WorkflowGraph } from '../../src/workflow/graph.js';
import { RuntimeBranchWorkflow, type RuntimeBranchBinding, type RuntimeBranchesOptions } from '../../src/workflow/runtime-branches.js';

const domain = process.env.OPEN_SANDBOX_DOMAIN ?? 'http://127.0.0.1:8090';
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const directory = resolve(process.argv[3] ?? '.runtime/workflow-branches-real-smoke');
const timeoutMs = Number(process.argv[4] ?? 240_000);
const rootSessionId = 'workflow-branches-root';
const branchSessions = ['workflow-branches-a', 'workflow-branches-b', 'workflow-branches-c'];
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [apiKey, process.env.DEEPSEEK_API_KEY]) if (key) message = message.replaceAll(key, '[REDACTED]');
  return message.slice(0, 4000);
}

async function preflight() {
  assert(apiKey, 'OPEN_SANDBOX_API_KEY must be configured');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 120_000 && timeoutMs <= 300_000, 'Probe timeout must be 120000..300000 ms');
  await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href);
  const health = await fetch(domain + '/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200); await health.body?.cancel();
  const response = await fetch(domain + '/sandboxes?pageSize=1', {
    headers: { 'OPEN-SANDBOX-API-KEY': apiKey }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200); await response.body?.cancel();
}

interface Observation { at: number; type: string; detail: unknown }
/** Records actual SDK identities/statuses while preserving the production adapter calls. */
class ObservedSandbox implements SandboxPort {
  readonly created: SandboxRef[] = [];
  readonly executions: ExecutionRef[] = [];
  readonly observations: Observation[] = [];
  readonly active = new Map<string, ExecutionRef>();
  readonly live = new Set<string>();
  readonly terminalAt = new Map<string, number>();
  readonly dispatchedAt = new Map<string, number>();
  readonly confirmedCancels = new Set<string>();
  readonly overlap: Array<{ at: number; executions: ExecutionRef[]; states: string[] }> = [];
  peakLiveSandboxes = 0;
  private readonly statuses = new Map<string, string>();
  constructor(readonly adapter: OpenSandboxAdapter) {}
  private record(type: string, detail: unknown) { this.observations.push({ at: Date.now(), type, detail }); }
  async create(runId: string, policy: ExecutionPolicy) {
    const ref = await this.adapter.create(runId, policy);
    this.created.push(ref); this.live.add(ref.sandboxId);
    this.peakLiveSandboxes = Math.max(this.peakLiveSandboxes, this.live.size);
    this.record('created', ref); return ref;
  }
  async execute(request: ExecutionRequest) {
    const ref = await this.adapter.execute(request);
    this.executions.push(ref); this.active.set(ref.executionId, ref); this.dispatchedAt.set(ref.runId, Date.now());
    this.record('dispatched', ref);
    if (this.active.size >= 2) {
      const executions = [...this.active.values()];
      const statuses = await Promise.all(executions.map(item => this.adapter.inspect(item)));
      const observation = { at: Date.now(), executions, states: statuses.map(status => status.state) };
      this.overlap.push(observation); this.record('concurrent-status-probe', observation);
    }
    return ref;
  }
  async inspect(ref: ExecutionRef) {
    const status = await this.adapter.inspect(ref);
    if (this.statuses.get(ref.executionId) !== status.state) {
      this.record('status', { execution: ref, status }); this.statuses.set(ref.executionId, status.state);
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.state)) {
      this.active.delete(ref.executionId); this.terminalAt.set(ref.runId, Date.now());
    }
    return status;
  }
  async cancel(ref: ExecutionRef) {
    const result = await this.adapter.cancel(ref); this.record('cancel', { execution: ref, result });
    if (result.confirmed) { this.active.delete(ref.executionId); this.confirmedCancels.add(ref.executionId); }
    return result;
  }
  collect(ref: ExecutionRef, policy: ExecutionPolicy) { return this.adapter.collect(ref, policy); }
  async destroy(ref: SandboxRef) {
    await this.adapter.destroy(ref); this.live.delete(ref.sandboxId); this.record('destroyed', ref);
  }
}

async function openBudget() {
  const ctx = new Context();
  const handles: Array<{ dispose: () => unknown }> = [];
  let modelCalls = 0;
  const close = async () => {
    for (const handle of handles.reverse()) await handle.dispose();
    await ctx.fiber.dispose();
  };
  try {
    await ctx.plugin(LlmRuntime).await();
    await ctx.plugin(SessionStore).await();
    await ctx.plugin(SystemPrompt).await();
    await ctx.plugin(ToolRuntime).await();
    await ctx.plugin(ToolExecutorNative).await();
    await ctx.plugin(SessionProjection).await();
    await ctx.plugin(AgentRegistry).await();
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
    const plugin = await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href);
    await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
      maxTokens: 1000, reservationMode: true, pressurePrompt: false,
      storageDir: join(directory, 'budget'), maxConcurrentCalls: 2,
    }).await();
    ctx.on('llm/stream', () => { modelCalls++; throw new Error('This fixed-code acceptance forbids model inference'); });
    const root = await ctx.agents.create({ sessionId: SessionId(rootSessionId), agentOptions: { provider: 'unused', model: 'unused' } });
    handles.push(root);
    for (const sessionId of branchSessions) handles.push(await root.agent.ctx.agents.create({
      sessionId: SessionId(sessionId), meta: { parentSession: root.agent.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'unused', model: 'unused' },
    }));
    const bridge = connectBudgetService(ctx);
    const scopeKey = await bridge.port.scopeForSession(rootSessionId);
    for (const sessionId of branchSessions) assert.equal(await bridge.reader.scopeForSession(sessionId), scopeKey);
    return { bridge, scopeKey, close, modelCalls: () => modelCalls };
  } catch (error) { await close(); throw error; }
}

const graph = (graphId: string, ids: string[]): WorkflowGraph => ({
  version: 1, graphId, nodes: ids.map(id => ({ id, required: true, dependencies: [] })),
});
const numbers: Record<string, number[]> = { a: [2, 3], b: [7, 11], c: [13, 17] };
const validations: Array<{ branchId: string; passed: boolean; sha256: string | null }> = [];
function bindings(ids: string[], sleeping: boolean): Record<string, RuntimeBranchBinding> {
  return Object.fromEntries(ids.map((branchId, index) => {
    const values = numbers[branchId]!;
    const input = { branch: branchId, values };
    const seconds = sleeping ? 60 : branchId === 'c' ? 0.2 : 15;
    return [branchId, {
      sessionId: branchSessions[index]!, inputs: [{ path: 'input.json', content: Buffer.from(JSON.stringify(input)) }],
      expectedArtifacts: ['result.json'], validatorVersion: 'independent-input-sum-v1',
      code: [
        'import json, os, pathlib, time',
        'source = pathlib.Path(os.environ["AGENT_INPUT_DIR"]) / "input.json"',
        'data = json.loads(source.read_text())', `time.sleep(${seconds})`,
        'output = pathlib.Path(os.environ["AGENT_OUTPUT_DIR"])',
        'result = {"branch": data["branch"], "sum": sum(data["values"]), "inputDir": str(source.parent), "outputDir": str(output), "cwd": str(pathlib.Path.cwd())}',
        '(output / "result.json").write_text(json.dumps(result))',
        'print("workflow-branch-completed", data["branch"])',
      ].join('\n'),
      validate: async ({ artifacts, read }) => {
        const artifact = artifacts.find(item => item.path === 'result.json');
        const result = artifact ? JSON.parse(Buffer.from(await read(artifact)).toString('utf8')) as Record<string, unknown> : {};
        const passed = artifacts.length === 1 && result.branch === branchId && result.sum === values.reduce((sum, value) => sum + value, 0)
          && typeof result.inputDir === 'string' && typeof result.outputDir === 'string' && result.cwd === result.outputDir;
        validations.push({ branchId, passed, sha256: artifact?.sha256 ?? null });
        return { passed, data: { branch: branchId, sum: typeof result.sum === 'number' ? result.sum : null,
          outputDir: typeof result.outputDir === 'string' ? result.outputDir : null } };
      },
    } satisfies RuntimeBranchBinding];
  }));
}

async function run() {
  mkdirSync(directory, { recursive: false });
  const startedAt = Date.now();
  const checks: Array<{ name: string; passed: boolean; detail: unknown }> = [];
  const report: Record<string, unknown> = {
    schema: 'workflow-branches-real-smoke/v1', startedAt: new Date(startedAt).toISOString(),
    realOpenSandbox: true, externalModelCalls: 0, checks,
    metering: 'Trusted synthetic token reservations and settlements against the original budget plugin',
    pressure: 'Controlled CPU samples drive the production resource-policy scheduling bridge',
    limits: { maxLiveSandboxes: 2, maxBranchesPerGraph: 3, cpuPerSandbox: 1, memoryMiBPerSandbox: 512,
      sandboxTtlSeconds: 180, commandTimeoutMs: 45000, totalTimeoutMs: timeoutMs },
    limitations: [
      'Fixed Python branches exercise host workflow composition. External model planning and inference quality are covered by separate evidence.',
      'Token usage and CPU pressure samples are controlled acceptance inputs. Provider billing and real resource stress are outside this probe.',
      'Recovery closes and reopens SQLite and the original budget plugin in one Node process. Process-kill recovery has separate evidence.',
      'Branch completion and the merged manifest are checked. Finalizing a parent task remains a separate host operation.',
    ],
  };
  const check = (name: string, detail: unknown) => {
    checks.push({ name, passed: true, detail }); save('report.json', report);
    console.log(`PASS ${name}`);
  };
  const sandbox = new ObservedSandbox(new OpenSandboxAdapter({
    connection: { domain, apiKey: apiKey!, useServerProxy: true, requestTimeoutSeconds: 15, disableMetrics: true },
    cancelTimeoutMs: 8000, pollIntervalMs: 150,
  }));
  const config = loadConfig('config/example.json');
  Object.assign(config.sandbox, { ttlSeconds: 180, commandTimeoutMs: 45000, maxLogBytes: 4096, maxOutputBytes: 4096, maxOutputFiles: 1 });
  config.policy.mode = 'enforce';
  const artifacts = new ArtifactStore(join(directory, 'artifacts'));
  let budget: Awaited<ReturnType<typeof openBudget>> | undefined;
  let store: RuntimeStore | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Workflow branch acceptance deadline exceeded')), timeoutMs);
  try {
    budget = await openBudget();
    const { scopeKey, bridge } = budget;
    await bridge.operator.allocate(scopeKey, 100, 'fixed acceptance finalization allowance');
    const reservations = await Promise.all(branchSessions.slice(0, 2).map((sessionId, index) => bridge.port.reserve({
      scopeKey, sessionId, modelCallId: `synthetic-branch-${index}`, provider: 'controlled-no-network',
      model: 'synthetic-usage', purpose: 'work', estimatedTokens: 400,
    })));
    assert(reservations.every(decision => decision.allowed));
    const third = await bridge.port.reserve({ scopeKey, sessionId: branchSessions[2]!, modelCallId: 'synthetic-overlap-denial',
      provider: 'controlled-no-network', model: 'synthetic-usage', purpose: 'work', estimatedTokens: 400 });
    assert.equal(third.allowed, false);
    const reserved = await bridge.reader.snapshot(scopeKey);
    assert.equal(reserved.reservedTokens, 800); assert(reserved.work.reservedTokens <= reserved.work.limitTokens);
    for (const decision of reservations) {
      assert(decision.allowed);
      await bridge.port.markDispatched(decision.reservation.reservationId);
      await bridge.port.settle(decision.reservation.reservationId, normalizeUsage({ inputTokens: 10, outputTokens: 10 }));
    }
    const settled = await bridge.reader.snapshot(scopeKey);
    const first = reservations[0]!; assert(first.allowed);
    await bridge.port.settle(first.reservation.reservationId, normalizeUsage({ inputTokens: 10, outputTokens: 10 }));
    assert.deepEqual(await bridge.reader.snapshot(scopeKey), settled);
    assert.equal(settled.usedTokens, 40); assert.equal(settled.reservedTokens, 0); assert.equal(settled.unknownCalls, 0);
    check('original-root-budget-shared-concurrent-reservations', { scopeKey, sessions: branchSessions,
      controlledUsageTokens: 40, reservedDuringOverlap: 800, workLimit: reserved.work.limitTokens, deniedThird: third });

    store = new RuntimeStore(join(directory, 'database'));
    let service = new RuntimeService(store, artifacts, sandbox, bridge.port, config, { pollIntervalMs: 150 });
    const parentRunId = 'workflow-branches-success';
    await service.createRun({ runId: parentRunId, rootSessionId, budgetScopeKey: scopeKey,
      task: 'Three fixed independent sums with actual bounded branch runtimes', deadline: startedAt + timeoutMs,
      policyVersion: 'workflow-branches-real-v1', inputHash: hash(JSON.stringify(numbers)) });
    let samples = 0;
    const options: RuntimeBranchesOptions = {
      maxConcurrency: 2, currentLimit: async () => 2, cancellationTimeoutMs: 20000,
      serviceOptions: { pollIntervalMs: 150, cancelConfirmationTimeoutMs: 10000 },
      resourcePolicy: {
        policy: new ResourcePolicy({ mode: 'enforce', maxConcurrency: 2, reducedConcurrency: 1, highRatio: 0.8,
          recoverRatio: 0.6, consecutiveHigh: 1, consecutiveLow: 2, maxSampleAgeMs: 5000, signals: ['cpu'], limits: {} }),
        sample: async () => {
          samples++; const now = Date.now();
          return normalizeResourceSample({
            execution: { runId: parentRunId, sandboxId: 'controlled-host-sample', attemptId: 'controlled', executionId: 'controlled', workDir: '/controlled' },
            observedAt: now, deployment: { evidenceRef: 'controlled-input-for-scheduler-acceptance', cpuCores: 1, memoryMiB: 512 },
            metrics: { timestamp: now, cpuCount: 1, cpuUsedPercentage: samples <= 2 ? 10 : 95, memoryUsedMiB: 128, memoryTotalMiB: 512 },
          });
        },
      },
    };
    const successGraph = graph('real-three-branches', ['a', 'b', 'c']);
    const successBindings = bindings(['a', 'b', 'c'], false);
    let workflow = new RuntimeBranchWorkflow(service, successGraph, successBindings, options);
    const completed = await workflow.run(parentRunId, controller.signal);
    save('completion-evidence.json', { completed, validations, runs: store.listRuns(),
      attempts: store.listRuns().flatMap(run => store!.listAttempts(run.runId)), events: store.eventsAfter(parentRunId) });
    assert.equal(completed.complete, true);
    const childIds = ['a', 'b', 'c'].map(id => workflow.childRunId(parentRunId, id));
    const attempts = childIds.flatMap(id => store!.listAttempts(id));
    assert.equal(attempts.length, 3); assert(attempts.every(attempt => attempt.status === 'SUCCEEDED'));
    assert.equal(new Set(attempts.map(attempt => attempt.sandboxId)).size, 3);
    assert.equal(new Set(attempts.map(attempt => attempt.workDir)).size, 3);
    assert(childIds.every(id => store!.getRun(id).budgetScopeKey === scopeKey));
    const concurrent = sandbox.overlap.find(item => item.states.length === 2 && item.states.every(state => state === 'RUNNING'));
    assert(concurrent, 'Actual SDK status must observe both independent commands RUNNING together');
    assert(sandbox.peakLiveSandboxes <= 2);
    check('actual-child-runtimes-distinct-sandboxes-and-directories', { childIds, attempts, concurrent, peakLiveSandboxes: sandbox.peakLiveSandboxes });
    assert.equal(completed.artifacts.length, 3); assert.equal(validations.length, 3); assert(validations.every(item => item.passed));
    assert.deepEqual(completed.artifacts.map(item => item.path).sort(), ['branches/a/result.json', 'branches/b/result.json', 'branches/c/result.json']);
    for (const merged of completed.artifacts) {
      assert(merged.source);
      const source = merged.source;
      const record: ArtifactRecord | undefined = store.listArtifacts(source.runId).find(item => item.artifactId === source.artifactId);
      assert(record); await artifacts.verify([record]); assert.equal(hash(await artifacts.read(record)), merged.sha256);
    }
    check('independent-required-artifact-validation-and-provenance-merge', { validations, manifest: completed.artifacts });
    const thirdStart = sandbox.dispatchedAt.get(childIds[2]!)!;
    assert(thirdStart >= Math.max(sandbox.terminalAt.get(childIds[0]!)!, sandbox.terminalAt.get(childIds[1]!)!));
    const reduced = store.eventsAfter(parentRunId).filter(event => {
      const payload = event.payload as { reasons?: string[]; maxNewConcurrency?: number };
      return event.type === 'resource.policy_decision' && payload.reasons?.includes('RESOURCE_CONCURRENCY_REDUCED');
    });
    assert(reduced.length > 0); assert(reduced.every(event => (event.payload as { maxNewConcurrency: number }).maxNewConcurrency === 1));
    check('soft-pressure-limits-future-branch-concurrency', { samples, thirdStart, firstTwoTerminalAt: childIds.slice(0, 2).map(id => sandbox.terminalAt.get(id)),
      controlledHighSample: '95 percent after the first two admission samples', firstReduction: reduced[0] });

    const originalLedger = await bridge.reader.eventsAfter(0);
    const beforeReopen = { creates: sandbox.created.length, dispatches: sandbox.executions.length,
      attempts, manifest: completed.artifacts, snapshot: await bridge.reader.snapshot(scopeKey) };
    store.close(); store = undefined;
    assert.equal(budget.modelCalls(), 0); await budget.close(); budget = undefined;
    budget = await openBudget(); assert.equal(budget.scopeKey, scopeKey);
    assert.deepEqual(await budget.bridge.reader.eventsAfter(0), originalLedger);
    assert.deepEqual(await budget.bridge.reader.snapshot(scopeKey), beforeReopen.snapshot);
    store = new RuntimeStore(join(directory, 'database'));
    service = new RuntimeService(store, artifacts, sandbox, budget.bridge.port, config, { pollIntervalMs: 150 });
    workflow = new RuntimeBranchWorkflow(service, successGraph, successBindings, options);
    const replay = await workflow.run(parentRunId, controller.signal);
    assert.equal(replay.complete, true); assert.deepEqual(replay.artifacts, beforeReopen.manifest);
    assert.deepEqual(childIds.flatMap(id => store!.listAttempts(id)), attempts);
    assert.equal(sandbox.created.length, beforeReopen.creates); assert.equal(sandbox.executions.length, beforeReopen.dispatches);
    assert.deepEqual(await budget.bridge.reader.snapshot(scopeKey), beforeReopen.snapshot);
    save('reopen-evidence.json', { beforeReopen, replay, ledger: await budget.bridge.reader.eventsAfter(0) });
    check('sqlite-and-original-budget-reopen-reuse-completed-work', { originalScope: scopeKey,
      createsBeforeAndAfter: sandbox.created.length, dispatchesBeforeAndAfter: sandbox.executions.length, attempts: attempts.map(item => item.attemptId) });

    const cancelParent = 'workflow-branches-cancel';
    await service.createRun({ runId: cancelParent, rootSessionId, budgetScopeKey: scopeKey,
      task: 'Cancel both actual in-flight independent branches', deadline: startedAt + timeoutMs,
      policyVersion: 'workflow-branches-real-v1', inputHash: hash('cancel-two-branches') });
    const cancelWorkflow = new RuntimeBranchWorkflow(service, graph('real-cancel-branches', ['a', 'b']), bindings(['a', 'b'], true), {
      maxConcurrency: 2, currentLimit: async () => 2, cancellationTimeoutMs: 20000,
      serviceOptions: { pollIntervalMs: 150, cancelConfirmationTimeoutMs: 10000 },
    });
    const cancelController = new AbortController();
    const running = cancelWorkflow.run(cancelParent, AbortSignal.any([controller.signal, cancelController.signal]));
    const cancelIds = ['a', 'b'].map(id => cancelWorkflow.childRunId(cancelParent, id));
    let ready = false;
    try {
      const readyDeadline = Math.min(startedAt + timeoutMs, Date.now() + 60000);
      while (Date.now() < readyDeadline && !controller.signal.aborted) {
        const records = cancelIds.flatMap(id => store!.listAttempts(id));
        if (records.length === 2 && records.every(attempt => attempt.status === 'RUNNING' && attempt.executionId)) {
          const refs = sandbox.executions.filter(item => cancelIds.includes(item.runId));
          const statuses = await Promise.all(refs.map(ref => sandbox.inspect(ref)));
          if (statuses.length === 2 && statuses.every(status => status.state === 'RUNNING')) { ready = true; break; }
        }
        await delay(100);
      }
    } finally { cancelController.abort(new Error('Controlled parent cancellation of two real branches')); }
    const cancelled = await running;
    assert(ready, 'Both branch executions must be durably identified and remotely RUNNING before cancellation');
    const cancelledAttempts = cancelIds.flatMap(id => store!.listAttempts(id));
    save('cancellation-evidence.json', { cancelled, runs: cancelIds.map(id => store!.getRun(id)), attempts: cancelledAttempts,
      events: cancelIds.flatMap(id => store!.eventsAfter(id)) });
    assert.equal(cancelled.complete, false);
    assert(Object.values(cancelled.state.nodes).every(node => node.status === 'cancelled'));
    assert.equal(cancelledAttempts.length, 2); assert(cancelledAttempts.every(attempt => attempt.status === 'CANCELLED'));
    assert(cancelIds.every(id => store!.getRun(id).status === 'CANCELLED'));
    assert(cancelledAttempts.every(attempt => !!attempt.executionId && sandbox.confirmedCancels.has(attempt.executionId)));
    check('parent-cancel-covers-all-identified-active-branches', { state: cancelled.state, attempts: cancelledAttempts,
      confirmedExecutionIds: [...sandbox.confirmedCancels] });
    assert.equal(budget.modelCalls(), 0); assert.equal(sandbox.peakLiveSandboxes, 2);
    assert.equal(sandbox.created.length, 5); assert.equal(sandbox.executions.length, 5);
    report.finalBudget = await budget.bridge.reader.snapshot(scopeKey);
    save('budget-events.json', await budget.bridge.reader.eventsAfter(0));
    check('bounded-probe-and-zero-model-inference', { sandboxCount: sandbox.created.length, peakLiveSandboxes: sandbox.peakLiveSandboxes,
      externalModelCalls: 0, syntheticUsedTokens: (await budget.bridge.reader.snapshot(scopeKey)).usedTokens });
  } catch (error) {
    checks.push({ name: 'probe-completed', passed: false, detail: { error: safeError(error) } });
  } finally {
    clearTimeout(timeout); controller.abort();
    const cleanup: Array<{ sandboxId: string; deleted: boolean; status?: number; error?: string }> = [];
    for (const ref of sandbox.created) {
      try {
        const active = [...sandbox.active.values()].find(item => item.sandboxId === ref.sandboxId);
        if (active) await sandbox.cancel(active);
        await sandbox.destroy(ref);
        const response = await fetch(`${domain}/sandboxes/${encodeURIComponent(ref.sandboxId)}`, {
          headers: { 'OPEN-SANDBOX-API-KEY': apiKey! }, signal: AbortSignal.timeout(10000),
        });
        const status = response.status; await response.body?.cancel();
        cleanup.push({ sandboxId: ref.sandboxId, deleted: status === 404 || status === 410, status });
      } catch (error) { cleanup.push({ sandboxId: ref.sandboxId, deleted: false, error: safeError(error) }); }
    }
    checks.push({ name: 'owned-real-sandboxes-reclaimed', passed: cleanup.length > 0 && cleanup.every(item => item.deleted), detail: cleanup });
    report.createdSandboxes = sandbox.created; report.cleanup = cleanup;
    save('remote-observations.json', sandbox.observations);
    try { store?.close(); } catch (error) { checks.push({ name: 'sqlite-close', passed: false, detail: safeError(error) }); }
    try { if (budget) { assert.equal(budget.modelCalls(), 0); await budget.close(); } }
    catch (error) { checks.push({ name: 'budget-close', passed: false, detail: safeError(error) }); }
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - startedAt;
    report.passed = checks.length >= 8 && checks.every(item => item.passed);
    save('report.json', report);
  }
  const reportPath = join(directory, 'report.json');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.map(({ name, passed }) => ({ name, passed })),
    report: reportPath, sha256: hash(readFileSync(reportPath)), elapsedMs: report.elapsedMs }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

try {
  await preflight();
  if (process.argv[2] === '--check-only') console.log('Workflow branch preflight passed. Original budget module and existing OpenSandbox service are available.');
  else { assert.equal(process.argv[2], '--run', 'Use --check-only or --run <new-evidence-directory> [timeout-ms]'); await run(); }
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }

