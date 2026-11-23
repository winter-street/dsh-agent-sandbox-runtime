import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import type { ExecutionPolicy, ExecutionRef, SandboxRef } from '../../src/contracts/sandbox.js';

type Check = { name: string; passed: boolean; detail?: unknown };
const checks: Check[] = [];
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const reportPath = process.env.ADAPTER_SMOKE_OUTPUT ?? '../../.runtime/sandbox-smoke/adapter-smoke.json';
if (!domain || !image) {
  console.error('BLOCKED: set OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE. No sandbox was created.');
  process.exit(2);
}

const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500);
};
const connection = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true };
const policy: ExecutionPolicy = {
  image,
  cpu: 1,
  memoryMiB: 512,
  ttlSeconds: 300,
  commandTimeoutMs: 120_000,
  maxLogBytes: 8_192,
  maxOutputBytes: 1_048_576,
  maxOutputFiles: 8,
  network: { defaultAction: 'deny', allowHosts: [] },
};
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitForTerminal(adapter: OpenSandboxAdapter, ref: ExecutionRef, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await adapter.inspect(ref);
    if (status.state !== 'RUNNING') return status;
    await delay(200);
  }
  throw new Error(`Execution ${ref.executionId} did not reach a terminal state within ${timeoutMs}ms`);
}

const adapter = new OpenSandboxAdapter({ connection, cancelTimeoutMs: 10_000, pollIntervalMs: 100 });
let sandbox: SandboxRef | undefined;
let processFailed = false;
try {
  sandbox = await adapter.create('adapter-smoke-run', policy);
  checks.push({ name: 'adapter-create', passed: true, detail: { sandboxId: sandbox.sandboxId } });

  const successful = await adapter.execute({
    sandbox,
    runId: sandbox.runId,
    stepId: 'success-step',
    attemptId: 'success-attempt',
    code: [
      'import os, pathlib',
      'seed = (pathlib.Path(os.environ["AGENT_INPUT_DIR"]) / "seed.txt").read_text()',
      '(pathlib.Path(os.environ["AGENT_OUTPUT_DIR"]) / "result.txt").write_text("accepted:" + seed)',
      'print(f"adapter-smoke-ok uid={os.getuid()} gid={os.getgid()}")',
    ].join('\n'),
    inputs: [{ path: 'seed.txt', content: Buffer.from('seed-7', 'utf8') }],
    policy,
  });
  checks.push({ name: 'adapter-dispatch', passed: true, detail: { executionId: successful.executionId } });

  // A fresh adapter instance forces the production connect/reconnect path.
  const resumedAdapter = new OpenSandboxAdapter({ connection, cancelTimeoutMs: 10_000, pollIntervalMs: 100,
    // The profile is an operator assertion tied to the pinned deployment probe.
    // Unknown CPU/memory readings remain unknown if the service cannot prove scope.
    resourceSampling: { deployment: { evidenceRef: 'docs/evidence/P0-04-isolation.md#L47', cpuCores: 1, memoryMiB: 512 } },
  });
  const successStatus = await waitForTerminal(resumedAdapter, successful);
  assert.equal(successStatus.state, 'SUCCEEDED');
  checks.push({ name: 'adapter-reconnect-inspect', passed: true, detail: successStatus });
  const collected = await resumedAdapter.collect(successful, policy);
  assert.equal(collected.exitCode, 0);
  assert.match(collected.stdout, /adapter-smoke-ok uid=65534 gid=65534/);
  assert.equal(collected.outputs.length, 1);
  assert.equal(collected.outputs[0]?.path, 'result.txt');
  assert.equal(Buffer.from(collected.outputs[0]!.content).toString('utf8'), 'accepted:seed-7');
  checks.push({ name: 'adapter-collect', passed: true, detail: {
    executionId: successful.executionId,
    exitCode: collected.exitCode,
    stdout: collected.stdout,
    outputPaths: collected.outputs.map((output) => output.path),
    outputBytes: collected.resources?.outputBytes,
    resources: collected.resources ? {
      cpuUtilization: collected.resources.cpuUtilization,
      memoryUsed: collected.resources.memoryUsed,
      memoryCapacity: collected.resources.memoryCapacity,
      wallTime: collected.resources.wallTime,
      cpuTime: collected.resources.cpuTime,
      peakMemory: collected.resources.peakMemory,
    } : null,
  } });

  const failed = await resumedAdapter.execute({
    sandbox,
    runId: sandbox.runId,
    stepId: 'failure-step',
    attemptId: 'failure-attempt',
    code: 'import sys\nprint("expected-failure")\nsys.exit(7)\n',
    inputs: [],
    policy,
  });
  const failureStatus = await waitForTerminal(resumedAdapter, failed);
  assert.equal(failureStatus.state, 'FAILED');
  assert.equal(failureStatus.exitCode, 7);
  const failedResult = await resumedAdapter.collect(failed, policy);
  assert.equal(failedResult.exitCode, 7);
  assert.match(failedResult.stdout, /expected-failure/);
  checks.push({ name: 'adapter-error-exit-and-collect', passed: true, detail: {
    executionId: failed.executionId,
    status: failureStatus,
    stdout: failedResult.stdout,
  } });

  const cancellable = await resumedAdapter.execute({
    sandbox,
    runId: sandbox.runId,
    stepId: 'cancel-step',
    attemptId: 'cancel-attempt',
    code: 'import time\nprint("waiting", flush=True)\ntime.sleep(60)\n',
    inputs: [],
    policy,
  });
  let running = false;
  const runningDeadline = Date.now() + 10_000;
  while (Date.now() < runningDeadline) {
    const status = await resumedAdapter.inspect(cancellable);
    if (status.state === 'RUNNING') { running = true; break; }
    if (status.state !== 'UNKNOWN') break;
    await delay(100);
  }
  assert(running, 'long-running adapter command must be observed running before cancellation');
  const cancellation = await resumedAdapter.cancel(cancellable);
  assert.equal(cancellation.confirmed, true, cancellation.reason);
  assert.deepEqual(await resumedAdapter.inspect(cancellable), { state: 'CANCELLED' });
  checks.push({ name: 'adapter-cancel-confirmed', passed: true, detail: { executionId: cancellable.executionId } });

  // Keep this adapter as the destroy owner so its lifecycle state is observed.
  await resumedAdapter.destroy(sandbox);
  await resumedAdapter.destroy(sandbox);
  sandbox = undefined;
  checks.push({ name: 'adapter-destroy-confirmed', passed: true, detail: { repeatedDestroy: 'idempotent' } });
} catch (error) {
  processFailed = true;
  checks.push({ name: 'adapter-smoke-error', passed: false, detail: { type: error instanceof Error ? error.name : 'UnknownError', message: safeError(error) } });
} finally {
  if (sandbox) {
    try {
      await adapter.destroy(sandbox);
      checks.push({ name: 'adapter-cleanup-after-error', passed: true });
    } catch (error) {
      processFailed = true;
      checks.push({ name: 'adapter-cleanup-after-error', passed: false, detail: safeError(error) });
    }
  }
  const report = { checkedAt: new Date().toISOString(), sdk: '1.2.1', adapter: 'repository OpenSandboxAdapter', realServiceInvoked: true, checks };
  const absoluteReportPath = resolve(reportPath);
  await mkdir(resolve(absoluteReportPath, '..'), { recursive: true });
  await writeFile(absoluteReportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (processFailed || checks.some((check) => !check.passed)) process.exitCode = 1;
}
