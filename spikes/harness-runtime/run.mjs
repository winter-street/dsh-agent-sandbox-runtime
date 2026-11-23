import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { RuntimeStore } from '../../src/storage/index.ts';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { RuntimeService } from '../../src/core/service.ts';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.ts';
import { connectBudgetService } from '../../src/adapters/budget/index.ts';
import { BudgetReceiptSynchronizer } from '../../src/adapters/budget/receipts.ts';
import { createRuntimeHarnessIntegration } from '../../src/adapters/harness/composition.ts';
import { loadConfig } from '../../src/config.ts';
import { DeepSeekAcceptanceAdapter, callChunks, textChunks } from './deepseek-adapter.mjs';

const mode = process.env.HARNESS_RUNTIME_MODE ?? 'controlled';
if (!['controlled', 'deepseek'].includes(mode)) throw new Error('HARNESS_RUNTIME_MODE must be controlled or deepseek');
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const modelKey = process.env.DEEPSEEK_API_KEY;
const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
if (!domain || !image || !apiKey) throw new Error('Set OPEN_SANDBOX_DOMAIN, OPEN_SANDBOX_IMAGE and OPEN_SANDBOX_API_KEY');
if (mode === 'deepseek' && !modelKey) throw new Error('DeepSeek mode requires DEEPSEEK_API_KEY; no controlled fallback');

const runId = `harness-${randomUUID()}`;
const rootId = `${runId}-root`;
const childId = `${runId}-child`;
const rootDirectory = resolve('/reports', runId);
await mkdir(rootDirectory, { recursive: true });
const reportPath = resolve('/reports', `harness-runtime-${mode}.json`);
const code = [
  'import os, json, pathlib',
  'source = pathlib.Path(os.environ["AGENT_INPUT_DIR"]) / "numbers.json"',
  'numbers = json.loads(source.read_text())["numbers"]',
  'out = pathlib.Path(os.environ["AGENT_OUTPUT_DIR"]) / "result.json"',
  'out.write_text(json.dumps({"sum": sum(numbers)}))',
  'print("sum=" + str(sum(numbers)))',
].join('\n');
const checks = [];
const requests = [];
const handles = [];
let store;
let budget;
let service;
let failed = false;
const report = {
  checkedAt: new Date().toISOString(), mode, runId, realSandbox: true,
  provider: mode === 'controlled' ? 'deterministic local adapter; synthetic token usage; no external model' : 'DeepSeek HTTPS Chat Completions; buffered response, not provider SSE',
  metering: mode === 'controlled' ? 'synthetic usage for accounting integration only' : 'provider response usage mapped to disjoint input/cache/output buckets',
  monetaryCost: null,
  monetaryCostNote: 'No currency conversion or invoice reconciliation. Token total is not currency cost; provider pricing and cache discounts are not modeled.',
  limits: { maxProviderCalls: 4, outputCapPerCall: 1024, totalTokenBudget: 50_000, sandboxTtlSeconds: 300 },
  checks,
};
const ctx = new Context();
const artifacts = new ArtifactStore(resolve(rootDirectory, 'artifacts'));
const sandbox = new OpenSandboxAdapter({ connection: { domain, apiKey, requestTimeoutSeconds: 60, disableMetrics: true },
  pollIntervalMs: 150, cancelTimeoutMs: 10_000 });

class ControlledAdapter extends LlmAdapter {
  calls = 0;
  async *stream(options) {
    assert.ok(++this.calls <= 4, 'controlled provider call limit');
    const child = String(options.sessionId) === childId;
    const hasResult = options.messages.some(message => message.content.some(block => block.type === 'tool-result'));
    if (!child && !hasResult) {
      yield* callChunks({ type: 'tool-call', id: 'controlled-python-call-1', name: 'runtime_python', arguments: JSON.stringify({ code }) });
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield* textChunks(child ? 'Child shares the original budget scope.' : 'Sandbox result is ready; independent validator must verify it.');
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
const adapter = mode === 'controlled' ? new ControlledAdapter() : new DeepSeekAcceptanceAdapter(modelKey, 4);
const prompt = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
async function idle(handle) {
  let timeout;
  try {
    await Promise.race([handle.agent.whenIdle(), new Promise((_, reject) => {
      timeout = setTimeout(() => { handle.agent.cancel({ kind: 'user' }); reject(new Error('Harness acceptance deadline exceeded')); }, 180_000);
    })]);
  } finally { clearTimeout(timeout); }
}
try {
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  const plugin = await import('../../.sources/budget/lib/index.js');
  await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
    maxTokens: 50_000, reservationMode: true, pressurePrompt: false, storageDir: resolve(rootDirectory, 'budget'), maxConcurrentCalls: 1,
  }).await();
  budget = connectBudgetService(ctx);
  ctx.llm.registerAdapter(['acceptance'], adapter);
  ctx.on('llm/stream', (options, next) => {
    requests.push({ sessionId: options.sessionId, maxTokens: options.maxTokens, frozen: Object.isFrozen(options) });
    return next();
  });
  const model = mode === 'controlled' ? 'controlled-model' : process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const root = await ctx.agents.create({ sessionId: SessionId(rootId), agentOptions: { provider: 'acceptance', model, maxTokens: 1024 } });
  handles.push(root);
  const scopeKey = await budget.port.scopeForSession(rootId);
  budget.operator.allocate(scopeKey, 2500, 'trusted finalization allowance for integration run');
  store = new RuntimeStore(resolve(rootDirectory, 'database'));
  const config = loadConfig('/workspace/config/example.json');
  Object.assign(config.sandbox, { image, ttlSeconds: 300, commandTimeoutMs: 120_000, maxOutputBytes: 1_048_576, maxOutputFiles: 8, maxLogBytes: 8_192 });
  config.policy.mode = 'enforce';
  service = new RuntimeService(store, artifacts, sandbox, budget.port, config, { pollIntervalMs: 150,
    validate: async (_run, outputs) => {
      const result = outputs.find(output => output.path === 'result.json');
      if (!result || outputs.length !== 1) return { passed: false, evidence: { expected: 'one result.json' } };
      const parsed = JSON.parse(Buffer.from(await artifacts.read(result)).toString('utf8'));
      return { passed: parsed.sum === 5, evidence: { validator: 'host-side JSON sum equals independent expected 5', sum: parsed.sum, sha256: result.sha256 } };
    },
  });
  await service.createRun({ runId, rootSessionId: rootId, budgetScopeKey: scopeKey, task: 'Add fixture numbers in sandbox and publish result.json',
    deadline: Date.now() + 300_000, policyVersion: 'harness-runtime-acceptance-v1',
    inputHash: createHash('sha256').update(code).update('[2,3]').digest('hex') });
  report.runtimeIdentity = store.getComponentState(runId, 'runtime', 'identity');
  const integration = createRuntimeHarnessIntegration(service, budget.control, {
    inputs: async () => [{ path: 'numbers.json', content: Buffer.from('{"numbers":[2,3]}') }],
    output: { kind: 'structured', minTokens: 256, defaultMaxTokens: 1024 },
  });
  await ctx.plugin(integration.plugin).await();
  await integration.bindSession(runId, rootId);
  root.agent.followup(prompt('Use runtime_python exactly once with the following Python code. Do not change the code. ' +
    'After the tool result, reply with one sentence. Code:\n' + code));
  await idle(root);
  const attempts = store.listAttempts(runId);
  assert.equal(attempts.length, 1, 'real Harness tool loop must dispatch exactly one sandbox attempt');
  assert.equal(attempts[0].status, 'SUCCEEDED');
  assert.ok(attempts[0].sandboxId && attempts[0].executionId);
  checks.push({ name: 'real-agent-loop-to-runtime-service-to-opensandbox', passed: true, sandboxId: attempts[0].sandboxId, attemptId: attempts[0].attemptId });
  assert.ok(requests.every(request => request.frozen && request.maxTokens <= 1024));

  const child = await root.agent.ctx.agents.create({ sessionId: SessionId(childId),
    meta: { parentSession: root.agent.id, origin: 'subagent', delegationDepth: 1 },
    agentOptions: { provider: 'acceptance', model, maxTokens: 1024 } });
  handles.push(child);
  await integration.bindSession(runId, childId);
  assert.equal(await budget.reader.scopeForSession(childId), scopeKey);
  child.agent.followup(prompt('Reply with only ACK. Do not call any tools.'));
  await idle(child);
  assert.ok(requests.some(request => request.sessionId === childId));
  checks.push({ name: 'root-child-share-original-budget', passed: true });

  const synchronization = new BudgetReceiptSynchronizer(store, budget.reader, resolve(rootDirectory, 'budget'));
  const first = await synchronization.sync(runId);
  assert.ok(first.imported > 0);
  const settlements = (await budget.reader.eventsAfter(0)).filter(receipt => receipt.type === 'settle');
  assert.equal(settlements.length, adapter.calls);
  const snapshot = await budget.reader.snapshot(scopeKey);
  assert.equal(snapshot.unknownCalls, 0);
  assert.equal(snapshot.reservedTokens, 0);
  if (mode === 'controlled') { assert.equal(adapter.calls, 3); assert.equal(snapshot.usedTokens, 48); }
  assert.ok(snapshot.usedTokens > 0);
  report.budget = snapshot;
  report.providerCalls = adapter.calls;
  if (mode === 'deepseek') report.providerUsage = adapter.responses;
  checks.push({ name: 'original-budget-plugin-automatically-settles-each-call-once', passed: true, calls: adapter.calls, usedTokens: snapshot.usedTokens });
  const finalized = await service.finalize(runId, true);
  assert.equal(finalized.run.status, 'SUCCEEDED');
  report.finalStatus = finalized.run.status;
  report.artifacts = finalized.artifacts.map(({ artifactId, path, sha256, size }) => ({ artifactId, path, sha256, size }));
  checks.push({ name: 'independent-host-artifact-validator-and-finalization', passed: true });
  store.close();
  store = undefined;
  store = new RuntimeStore(resolve(rootDirectory, 'database'));
  const replay = new BudgetReceiptSynchronizer(store, budget.reader, resolve(rootDirectory, 'budget'));
  assert.deepEqual(await replay.sync(runId), { cursor: first.cursor, imported: 0, scanned: 0 });
  checks.push({ name: 'runtime-sqlite-reopen-preserves-receipt-cursor', passed: true, cursor: first.cursor });
} catch (error) {
  failed = true;
  let message = error instanceof Error ? error.message : 'unknown error';
  for (const secret of [apiKey, modelKey]) if (secret) message = message.replaceAll(secret, '[redacted]');
  checks.push({ name: 'integration-error', passed: false, error: error instanceof Error ? error.name : 'UnknownError', message: message.slice(0, 500) });
} finally {
  for (const handle of handles.reverse()) { try { await handle.dispose(); } catch { failed = true; } }
  if (store) for (const run of store.listRuns()) {
    const ref = store.getSandbox(run.runId);
    if (ref) {
      try { await sandbox.destroy(ref); store.releaseSandbox(ref); checks.push({ name: 'cleanup-remaining-sandbox', passed: true }); }
      catch { failed = true; checks.push({ name: 'cleanup-remaining-sandbox', passed: false }); }
    }
  }
  store?.close();
  try { await ctx.fiber.dispose(); } catch { failed = true; }
  report.passed = !failed;
  report.limitations = [
    'No provider-native SSE disconnect or error/billing matrix was run.',
    'Receipt recovery closes/reopens SQLite in one process; no full process-kill or Harness Loader profile resume is claimed.',
    'No currency price table or invoice reconciliation was implemented.',
    ...(mode === 'controlled' ? ['Provider usage is synthetic. No external model inference or provider billing was tested.'] : []),
  ];
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failed) process.exitCode = 1;
}
