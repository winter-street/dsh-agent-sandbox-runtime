import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
import { RuntimeStore } from '../../src/storage/index.ts';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { RuntimeService } from '../../src/core/service.ts';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.ts';
import { connectBudgetService } from '../../src/adapters/budget/index.ts';
import { createHarnessRuntimePlugin, RUNTIME_PYTHON_TOOL } from '../../src/adapters/harness/index.ts';
import { loadConfig } from '../../src/config.ts';

const { OPEN_SANDBOX_DOMAIN: domain, OPEN_SANDBOX_IMAGE: image, OPEN_SANDBOX_API_KEY: apiKey } = process.env;
if (!domain || !image || !apiKey) throw new Error('Sandbox connection settings are required');
const connection = { domain, apiKey, requestTimeoutSeconds: 60, disableMetrics: true };
const runId = `plugin-disposal-${randomUUID()}`;
const sessionId = `${runId}-session`;
const directory = resolve('/reports', runId);
await mkdir(directory, { recursive: true });
const reportPath = resolve(directory, 'report.json');
const checks = [];
const ctx = new Context();
let store;
let agent;
let fiber;
let pending;
let observedRunningAfterCancel;
let failed = false;
class ObservedAdapter extends OpenSandboxAdapter {
  async cancel(ref) {
    const result = await super.cancel(ref);
    if (result.confirmed) {
      const client = await Sandbox.connect({ sandboxId: ref.sandboxId, connectionConfig: connection });
      try { observedRunningAfterCancel = (await client.commands.getCommandStatus(ref.executionId)).running; }
      finally { await client.close(); }
    }
    return result;
  }
}
const sandbox = new ObservedAdapter({ connection, pollIntervalMs: 100, cancelTimeoutMs: 10_000 });
try {
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  const originalBudget = await import('../../.sources/budget/lib/index.js');
  await ctx.plugin({ name: originalBudget.name, inject: originalBudget.inject, apply: originalBudget.apply },
    { maxTokens: 50_000, reservationMode: true, pressurePrompt: false, storageDir: resolve(directory, 'budget'), maxConcurrentCalls: 1 }).await();
  const budget = connectBudgetService(ctx);
  agent = await ctx.agents.create({ sessionId: SessionId(sessionId), agentOptions: { provider: 'unused', model: 'unused' } });
  const scopeKey = await budget.port.scopeForSession(sessionId);
  store = new RuntimeStore(resolve(directory, 'database'));
  const config = loadConfig('/workspace/config/example.json');
  Object.assign(config.sandbox, { image, ttlSeconds: 300, commandTimeoutMs: 120_000 });
  const service = new RuntimeService(store, new ArtifactStore(resolve(directory, 'artifacts')), sandbox, budget.port, config, { pollIntervalMs: 100 });
  await service.createRun({ runId, rootSessionId: sessionId, budgetScopeKey: scopeKey, task: 'Check plugin unload cleanup',
    deadline: Date.now() + 300_000, policyVersion: 'plugin-disposal-smoke-v1', inputHash: 'd'.repeat(64) });
  fiber = ctx.plugin(createHarnessRuntimePlugin({ executor: service, resolveRun: id => id === sessionId ? { runId, inputs: [] } : undefined }));
  await fiber.await();
  pending = ctx.tools.execute({ name: RUNTIME_PYTHON_TOOL, callId: CallId('disposal-call'), agent: agent.agent,
    arguments: { code: 'import time\nprint("running", flush=True)\ntime.sleep(60)\n' }, signal: new AbortController().signal });
  const deadline = Date.now() + 30_000;
  let attempt = store.listAttempts(runId)[0];
  while (Date.now() < deadline && (!attempt?.executionId || attempt.status !== 'RUNNING')) {
    await new Promise(done => setTimeout(done, 100));
    attempt = store.listAttempts(runId)[0];
  }
  assert.ok(attempt?.executionId && attempt.sandboxId, 'expected a running sandbox command');
  const client = await Sandbox.connect({ sandboxId: attempt.sandboxId, connectionConfig: connection });
  try { assert.equal((await client.commands.getCommandStatus(attempt.executionId)).running, true); }
  finally { await client.close(); }
  await fiber.dispose();
  fiber = undefined;
  const outcome = await pending;
  pending = undefined;
  assert.equal(outcome.isError, true, 'cancelled tool must not succeed');
  assert.equal(ctx.tools.get(RUNTIME_PYTHON_TOOL), undefined);
  assert.equal(observedRunningAfterCancel, false);
  assert.equal(store.getAttempt(attempt.attemptId).status, 'CANCELLED');
  assert.equal(store.getRun(runId).status, 'CANCELLED');
  assert.equal(store.getSandbox(runId), undefined);
  let deleted = false;
  try {
    const lookup = await Sandbox.connect({ sandboxId: attempt.sandboxId, connectionConfig: connection });
    try { await lookup.getInfo(); } finally { await lookup.close(); }
  } catch (error) {
    if (error instanceof SandboxApiException && error.statusCode === 404) deleted = true;
    else throw error;
  }
  assert.equal(deleted, true, 'fresh lookup must confirm deletion');
  checks.push({ name: 'plugin-disposal-stops-and-cleans-sandbox', passed: true, detail: {
    runId, attemptId: attempt.attemptId, executionId: attempt.executionId, sandboxId: attempt.sandboxId,
    remoteRunningAfterCancel: observedRunningAfterCancel, attemptStatus: 'CANCELLED', runStatus: 'CANCELLED', sandboxLookup: '404',
  } });
} catch (error) {
  failed = true;
  checks.push({ name: 'plugin-disposal-stops-and-cleans-sandbox', passed: false,
    detail: { message: (error instanceof Error ? error.message : 'unknown error').replaceAll(apiKey, '[redacted]').slice(0, 500) } });
} finally {
  try { if (fiber) await fiber.dispose(); if (pending) await pending; } catch { failed = true; checks.push({ name: 'plugin-disposal-cleanup', passed: false }); }
  if (store) {
    const ref = store.getSandbox(runId);
    if (ref) {
      try { await sandbox.destroy(ref); store.releaseSandbox(ref); checks.push({ name: 'remaining-sandbox-cleanup', passed: true, detail: { sandboxId: ref.sandboxId } }); }
      catch { failed = true; checks.push({ name: 'remaining-sandbox-cleanup', passed: false, detail: { sandboxId: ref.sandboxId } }); }
    }
  }
  try { if (agent) await agent.dispose(); await ctx.fiber.dispose(); } catch { failed = true; checks.push({ name: 'host-cleanup', passed: false }); }
  store?.close();
  const report = { checkedAt: new Date().toISOString(), passed: !failed, realSandbox: true,
    budget: 'original plugin; no provider or model calls', checks };
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (failed) process.exitCode = 1;
}
