import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Sandbox } from '@alibaba-group/opensandbox';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import type { ExecutionRef, SandboxRef } from '../../src/contracts/sandbox.js';
import { loadConfig } from '../../src/config.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { FakeBudget } from '../../tests/support/fakes.js';

const { OPEN_SANDBOX_DOMAIN: domain, OPEN_SANDBOX_IMAGE: image, OPEN_SANDBOX_API_KEY: apiKey } = process.env;
if (!domain || !image) throw new Error('Sandbox domain and image are required');
const connection = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true };
const policy = loadConfig('/workspace/config/example.json').sandbox;
policy.image = image;
policy.ttlSeconds = 300;
policy.commandTimeoutMs = 5000;
const adapter = new OpenSandboxAdapter({ connection, pollIntervalMs: 100 });
const runId = `timeout-order-${randomUUID()}`;
let sandbox: SandboxRef | undefined;
let execution: ExecutionRef | undefined;
let failed = false;
const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
try {
  sandbox = await adapter.create(runId, policy);
  execution = await adapter.execute({ sandbox, runId, stepId: 'sleep', attemptId: randomUUID(), inputs: [], policy,
    code: 'import time\ntime.sleep(60)\n' });
  const client = await Sandbox.connect({ sandboxId: sandbox.sandboxId, connectionConfig: connection });
  try {
    const before = await client.commands.getCommandStatus(execution.executionId);
    assert.equal(before.running, true, 'the command must start before observation');
    await new Promise<void>(resolve => setTimeout(resolve, 8000));
    const after = await client.commands.getCommandStatus(execution.executionId);
    const mapped = await adapter.inspect(execution);
    const collected = mapped.state === 'FAILED' || mapped.state === 'SUCCEEDED' ? await adapter.collect(execution, policy) : undefined;
    checks.push({ name: 'remote-timeout-status-after-delayed-poll', passed: true, detail: {
      timeoutMs: policy.commandTimeoutMs, waitMs: 8000, before: { running: before.running },
      after: { running: after.running, exitCode: after.exitCode, error: after.error }, mapped,
      ...(collected ? { collected: { exitCode: collected.exitCode, stdout: collected.stdout, stderr: collected.stderr } } : {}),
    } });
  } finally { await client.close(); }
  const root = `/tmp/runtime-timeout-order-${randomUUID()}`;
  await mkdir(root, { recursive: true });
  const store = new RuntimeStore(`${root}/db`);
  const config = loadConfig('/workspace/config/example.json');
  config.sandbox = policy;
  const budget = new FakeBudget({ scopeKey: 'timeout-order-scope', sessionIds: ['timeout-order-session'] });
  const service = new RuntimeService(store, new ArtifactStore(`${root}/artifacts`), adapter, budget, config, {
    fault: async point => {
      if (point === 'after-execute') await new Promise<void>(resolve => setTimeout(resolve, 8000));
    },
  });
  const serviceRunId = `timeout-service-${randomUUID()}`;
  try {
    await service.createRun({ runId: serviceRunId, rootSessionId: 'timeout-order-session', budgetScopeKey: 'timeout-order-scope',
      task: 'Observe delayed timeout polling', deadline: Date.now() + 300_000, policyVersion: 'timeout-order-v1', inputHash: 'a'.repeat(64) });
    const outcome = await service.executeCode({ runId: serviceRunId, stepId: 'sleep', inputs: [], code: 'import time\ntime.sleep(60)\n' })
      .then(value => ({ value }), error => ({ error }));
    assert.ok('error' in outcome, 'a dispatch delay beyond the timeout must not return a completed result');
    assert.equal((outcome.error as { code?: string }).code, 'EXECUTION_TIMEOUT');
    const attempt = store.listAttempts(serviceRunId)[0];
    assert.ok(attempt);
    assert.equal(attempt.status, 'TIMED_OUT');
    assert.equal(store.getRun(serviceRunId).status, 'RUNNING');
    assert.equal(store.getSandbox(serviceRunId), undefined);
    checks.push({ name: 'runtime-delayed-after-dispatch', passed: true, detail: {
      injectedDelayMs: 8000, errorCode: 'EXECUTION_TIMEOUT', attemptStatus: attempt.status, runStatus: store.getRun(serviceRunId).status,
    } });
  } finally {
    const serviceSandbox = store.getSandbox(serviceRunId);
    if (serviceSandbox) await adapter.destroy(serviceSandbox);
    store.close();
  }
} catch (error) {
  failed = true;
  checks.push({ name: 'timeout-order-error', passed: false, detail: { message: (error instanceof Error ? error.message : 'Unknown error').replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500) } });
} finally {
  if (sandbox) {
    try { await adapter.destroy(sandbox); } catch { failed = true; checks.push({ name: 'cleanup', passed: false }); }
  }
  const report = { checkedAt: new Date().toISOString(), realServiceInvoked: true, provider: 'none', checks };
  const reportPath = `/reports/runtime-timeout-order-${randomUUID()}.json`;
  await mkdir('/reports', { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (failed) process.exitCode = 1;
}
