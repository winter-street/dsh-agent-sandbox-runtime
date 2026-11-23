import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import type { ExecutionRef } from '../../src/contracts/sandbox.js';
import { loadConfig } from '../../src/config.js';
import { FakeBudget } from '../../tests/support/fakes.js';

const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const reportPath = process.env.RUNTIME_DEADLINE_SMOKE_OUTPUT;
if (!domain || !image || !reportPath) throw new Error('Sandbox domain, image and report path are required');
const clockMode = process.env.RUNTIME_DEADLINE_SMOKE_MODE ?? 'advanced-clock';
if (clockMode !== 'wall-clock' && clockMode !== 'advanced-clock') throw new Error('Invalid deadline smoke clock mode');
const wallClock = clockMode === 'wall-clock';
const taskDurationMs = wallClock ? 30_000 : 300_000;
const connection = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true };
const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
const root = await mkdtemp(join(tmpdir(), 'runtime-deadline-smoke-'));
const store = new RuntimeStore(join(root, 'database'));
const runId = `deadline-${randomUUID()}`;
let offset = 0;
let cancelStartedAt: number | undefined;
let cancelElapsedMs: number | undefined;
let started = 0;
let remoteRunningAfterCancel: boolean | undefined;
let executionRef: ExecutionRef | undefined;
const abort = new AbortController();
let execution: Promise<{ value: unknown } | { error: unknown }> | undefined;
class ObservedAdapter extends OpenSandboxAdapter {
  override async cancel(ref: ExecutionRef) {
    executionRef = ref;
    cancelStartedAt = Date.now();
    cancelElapsedMs = Math.round(performance.now() - started);
    const result = await super.cancel(ref);
    if (result.confirmed) {
      const client = await Sandbox.connect({ sandboxId: ref.sandboxId, connectionConfig: connection });
      try { remoteRunningAfterCancel = (await client.commands.getCommandStatus(ref.executionId)).running; }
      finally { await client.close(); }
    }
    return result;
  }
}
const sandbox = new ObservedAdapter({ connection, cancelTimeoutMs: 10_000, pollIntervalMs: 100 });
const config = loadConfig('/workspace/config/example.json');
config.sandbox.image = image;
config.sandbox.ttlSeconds = 300;
config.sandbox.commandTimeoutMs = 120_000;
const budget = new FakeBudget({ scopeKey: 'deadline-scope', limitTokens: 10_000, sessionIds: ['deadline-session'] });
const service = new RuntimeService(store, new ArtifactStore(join(root, 'artifacts')), sandbox, budget, config,
  { pollIntervalMs: 100, ...(wallClock ? {} : { now: () => Date.now() + offset }) });
let failed = false;
try {
  started = performance.now();
  const deadline = Date.now() + taskDurationMs;
  await service.createRun({ runId, rootSessionId: 'deadline-session', budgetScopeKey: 'deadline-scope',
    task: 'Verify deadline cancellation and cleanup', deadline,
    policyVersion: 'deadline-smoke-v1', inputHash: 'd'.repeat(64) });
  execution = service.executeCode({ runId, stepId: 'deadline-step',
    code: 'import time\nprint("waiting", flush=True)\ntime.sleep(120)\n', inputs: [] }, abort.signal)
    .then(value => ({ value }), error => ({ error }));
  const waitUntil = Math.min(Date.now() + 30_000, deadline - 2_000);
  let attempt = store.listAttempts(runId)[0];
  while (Date.now() < waitUntil && (!attempt?.executionId || attempt.status !== 'RUNNING')) {
    await new Promise(done => setTimeout(done, 100));
    attempt = store.listAttempts(runId)[0];
  }
  assert.ok(attempt?.executionId && attempt.status === 'RUNNING', 'execution must start before the deadline');
  const activeSandbox = store.getSandbox(runId);
  assert.ok(activeSandbox, 'running attempt must have a registered sandbox');
  const activeClient = await Sandbox.connect({ sandboxId: activeSandbox.sandboxId, connectionConfig: connection });
  try { assert.equal((await activeClient.commands.getCommandStatus(attempt.executionId)).running, true); }
  finally { await activeClient.close(); }
  const runningObservedAt = Date.now();
  assert.ok(runningObservedAt < deadline, 'the remote command must be observed running before the original deadline');
  if (!wallClock) offset = 310_000;
  const outcome = await execution;
  assert.ok('error' in outcome, 'deadline must not produce successful execution');
  assert.equal((outcome.error as { code?: string }).code, 'EXECUTION_TIMEOUT');
  if (wallClock) {
    assert.ok(cancelStartedAt !== undefined && cancelStartedAt >= deadline, 'cancellation must start at or after the original deadline');
    assert.ok(cancelElapsedMs !== undefined && cancelElapsedMs >= taskDurationMs - 10, 'monotonic elapsed time must reach the configured duration');
  }
  assert.equal(remoteRunningAfterCancel, false, 'fresh SDK connection must observe a stopped command');
  assert.equal(store.getAttempt(attempt.attemptId).status, 'TIMED_OUT');
  assert.equal(store.getRun(runId).status, 'CANCELLED');
  assert.equal(store.getSandbox(runId), undefined, 'released sandbox must no longer be registered');
  assert.ok(executionRef);
  let deleted = false;
  try {
    const client = await Sandbox.connect({ sandboxId: executionRef.sandboxId, connectionConfig: connection });
    try { await client.getInfo(); } finally { await client.close(); }
  } catch (error) {
    if (error instanceof SandboxApiException && error.statusCode === 404) deleted = true;
    else throw error;
  }
  assert.equal(deleted, true, 'fresh SDK lookup must confirm sandbox deletion with 404');
  checks.push({ name: 'deadline-remote-stop-and-cleanup', passed: true, detail: {
    runId, attemptId: attempt.attemptId, executionId: attempt.executionId, sandboxId: executionRef.sandboxId,
    clockMode, deadline, runningObservedAt, cancelStartedAt, cancelElapsedMs, taskDurationMs,
    ...(wallClock ? {} : { clockOffsetMs: offset }), remoteRunningAfterCancel,
    attemptStatus: store.getAttempt(attempt.attemptId).status, runStatus: store.getRun(runId).status,
    sandboxLookup: '404 after deletion',
  } });
} catch (error) {
  failed = true;
  const message = error instanceof Error ? error.message : 'unknown error';
  checks.push({ name: 'deadline-remote-stop-and-cleanup', passed: false,
    detail: { message: message.replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500) } });
} finally {
  abort.abort();
  if (execution) await execution;
  const remaining = store.getSandbox(runId);
  if (remaining) {
    try { await sandbox.destroy(remaining); store.releaseSandbox(remaining); checks.push({ name: 'cleanup', passed: true, detail: { sandboxId: remaining.sandboxId } }); }
    catch { failed = true; checks.push({ name: 'cleanup', passed: false, detail: { sandboxId: remaining.sandboxId } }); }
  }
  store.close();
  const report = { checkedAt: new Date().toISOString(), realServiceInvoked: true, clockMode,
    budget: 'FakeBudget; no provider or model calls', checks };
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (failed) process.exitCode = 1;
}
