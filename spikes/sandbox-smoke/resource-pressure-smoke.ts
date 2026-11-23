import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import type { ExecutionPolicy, ExecutionRef, SandboxRef } from '../../src/contracts/sandbox.js';
import { normalizeResourceSample, type ResourceSample } from '../../src/resources/index.js';
import { ResourcePolicy, ResourcePolicyController } from '../../src/resources/policy.js';
import type { ResourcePolicyConfig, ResourcePolicyDecision, ResourcePolicyState } from '../../src/resources/policy.js';

type Signal = 'cpu' | 'memory' | 'logs';
type Observation = {
  phase: 'pressure' | 'release' | 'gap';
  origin: 'real-sdk' | 'real-collector' | 'injected-telemetry-gap';
  sample: ResourceSample;
  decision: ResourcePolicyDecision;
};
type Check = { name: string; passed: boolean; detail?: unknown };

const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
if (!apiKey || !domain || !image) {
  throw new Error('Set OPEN_SANDBOX_API_KEY, OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE before running the resource pressure probe.');
}
const startedAt = Date.now();
const runId = `resource-pressure-${randomUUID()}`;
const reportPath = resolve(process.env.RESOURCE_PRESSURE_SMOKE_OUTPUT ?? `.runtime/sandbox-smoke/${runId}.json`);
const deployment = { evidenceRef: 'docs/evidence/P0-04-isolation.md#L47', cpuCores: 1, memoryMiB: 512 };
const executionPolicy: ExecutionPolicy = {
  image, cpu: deployment.cpuCores, memoryMiB: deployment.memoryMiB,
  ttlSeconds: 180, commandTimeoutMs: 30_000, maxLogBytes: 4_096, maxOutputBytes: 1_024,
  maxOutputFiles: 1, network: { defaultAction: 'deny', allowHosts: [] },
};
const pressureSeconds = 12;
const releaseSeconds = 9;
const memoryMiB = 320;
const sampleIntervalMs = 700;
const pressureSampleLimit = 12;
const releaseSampleLimit = 28;
const logWrites = 16;
const bytesPerWrite = 512;
const logLimit = 2 * executionPolicy.maxLogBytes;
const policyFor = (signal: Signal): ResourcePolicyConfig => ({
  mode: 'enforce', signals: [signal], limits: signal === 'logs' ? { logBytes: logLimit } : {},
  maxConcurrency: 2, reducedConcurrency: 1, highRatio: signal === 'memory' ? 0.55 : 0.70,
  recoverRatio: 0.20, consecutiveHigh: signal === 'logs' ? 1 : 2, consecutiveLow: 2, maxSampleAgeMs: 5_000,
});
const policyConfigurations = { cpu: policyFor('cpu'), memory: policyFor('memory'), logs: policyFor('logs') };
const observations: Record<Signal, Observation[]> = { cpu: [], memory: [], logs: [] };
const checks: Check[] = [];
const check = (name: string, passed: boolean, detail?: unknown) => checks.push({ name, passed, detail });
const safeError = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error').replaceAll(apiKey, '[redacted]').slice(0, 500);

const adapter = new OpenSandboxAdapter({
  connection: { domain, apiKey, requestTimeoutSeconds: 8, disableMetrics: true },
  resourceSampling: { deployment, timeoutMs: 2_500, maxAgeMs: 5_000 },
  cancelTimeoutMs: 8_000,
  pollIntervalMs: 150,
});

const cpuWork = `import time
end = time.monotonic() + ${pressureSeconds}
x = 1
while time.monotonic() < end:
    for _ in range(4096):
        x = (x * 1664525 + 1013904223) & 0xffffffff
# A small amount of work gives the SDK a nonzero reading after full load.
end = time.monotonic() + ${releaseSeconds}
while time.monotonic() < end:
    tick = time.monotonic()
    while time.monotonic() - tick < 0.005:
        x = (x * 1664525 + 1013904223) & 0xffffffff
    time.sleep(max(0, 0.1 - (time.monotonic() - tick)))
print('cpu-pressure-complete')
`;
const memoryWork = `import time
pages = bytearray(${memoryMiB} * 1024 * 1024)
for offset in range(0, len(pages), 4096):
    pages[offset] = 1
time.sleep(${pressureSeconds})
del pages
time.sleep(${releaseSeconds})
print('memory-pressure-complete')
`;
const logWork = `import sys, time
for _ in range(${logWrites}):
    sys.stdout.buffer.write(b'o' * ${bytesPerWrite})
    sys.stderr.buffer.write(b'e' * ${bytesPerWrite})
    sys.stdout.flush()
    sys.stderr.flush()
    time.sleep(0.15)
`;

function tracker(signal: Signal) {
  const policy = policyConfigurations[signal];
  let pending: ResourceSample | undefined;
  let state: ResourcePolicyState | undefined;
  const scope = `${runId}:${signal}`;
  const makeController = () => new ResourcePolicyController({
    policy: new ResourcePolicy(policy),
    sample: async () => {
      if (!pending) throw new Error('No resource observation supplied');
      return pending;
    },
    loadState: () => state,
    saveDecision: (_scope, decision) => { state = decision.state; },
  });
  let controller = makeController();
  return {
    async evaluate(sample: ResourceSample, phase: Observation['phase'], origin: Observation['origin']) {
      pending = sample;
      try {
        const decision = await controller.evaluate(scope);
        observations[signal].push({ phase, origin, sample, decision });
        return decision;
      } finally { pending = undefined; }
    },
    restoreSerializedState() {
      if (!state) throw new Error('No prior resource policy state to restore');
      state = JSON.parse(JSON.stringify(state)) as ResourcePolicyState;
      controller = makeController();
    },
  };
}

async function execute(sandbox: SandboxRef, step: string, code: string): Promise<ExecutionRef> {
  return adapter.execute({ sandbox, runId, stepId: step, attemptId: step, code, inputs: [], policy: executionPolicy });
}

async function finish(ref: ExecutionRef): Promise<void> {
  const deadline = Date.now() + executionPolicy.commandTimeoutMs + 2_000;
  do {
    const status = await adapter.inspect(ref);
    if (status.state === 'SUCCEEDED') return;
    if (status.state !== 'RUNNING') throw new Error(`${ref.attemptId} ended in ${status.state}`);
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${ref.attemptId} exceeded the host wait deadline`);
}

async function proveGap(ref: ExecutionRef, signal: Signal, policyTracker: ReturnType<typeof tracker>): Promise<void> {
  policyTracker.restoreSerializedState();
  // A fresh receipt time is required to exercise unknown data instead of duplicate rejection.
  await delay(5);
  const gap = normalizeResourceSample({ execution: ref, observedAt: Date.now(), metricsFailure: 'request-failed' });
  const decision = await policyTracker.evaluate(gap, 'gap', 'injected-telemetry-gap');
  check(`${signal}-gap-preserves-restored-throttle`, decision.telemetry === 'unknown' && decision.maxNewConcurrency === 1
    && decision.state.lowSamples === 0);
}

function checkRecovery(signal: Signal, origin: Observation['origin']): void {
  const release = observations[signal].filter(item => item.phase === 'release' && item.origin === origin);
  const firstLowHeld = release.some(({ decision }) => decision.state.lowSamples === 1 && decision.maxNewConcurrency === 1);
  const recovered = release.some(({ decision }) => decision.reasons.includes('RESOURCE_CONCURRENCY_RESTORED')
    && decision.state.lowSamples === 2 && decision.maxNewConcurrency === 2);
  check(`${signal}-two-low-samples-restore`, firstLowHeld && recovered, { firstLowHeld, recovered });
}

async function sampleWhileRunning(sandbox: SandboxRef, signal: 'cpu' | 'memory', code: string): Promise<void> {
  const policyTracker = tracker(signal);
  const ref = await execute(sandbox, signal, code);
  let sawFirstHigh = false;
  let throttledWhileRunning = false;
  for (let i = 0; i < pressureSampleLimit; i++) {
    await delay(sampleIntervalMs);
    if ((await adapter.inspect(ref)).state !== 'RUNNING') break;
    const live = await adapter.sampleResources(ref, executionPolicy);
    const decision = await policyTracker.evaluate(live, 'pressure', 'real-sdk');
    sawFirstHigh ||= decision.reasons.includes(`RESOURCE_HIGH_${signal.toUpperCase()}`)
      && decision.state.highSamples === 1 && decision.maxNewConcurrency === 2;
    if (decision.reasons.includes('RESOURCE_CONCURRENCY_REDUCED')) {
      throttledWhileRunning = decision.maxNewConcurrency === 1 && decision.affects === 'new-dispatch-only'
        && (await adapter.inspect(ref)).state === 'RUNNING';
      break;
    }
  }
  check(`${signal}-two-high-live-samples-restrict-future-dispatch`, sawFirstHigh && throttledWhileRunning,
    { sawFirstHigh, throttledWhileRunning });
  if (throttledWhileRunning) await proveGap(ref, signal, policyTracker);
  for (let i = 0; i < releaseSampleLimit; i++) {
    await delay(sampleIntervalMs);
    if ((await adapter.inspect(ref)).state !== 'RUNNING') break;
    const idle = await adapter.sampleResources(ref, executionPolicy);
    // Continue using the same execution while the workload releases pressure.
    const decision = await policyTracker.evaluate(idle, 'release', 'real-sdk');
    if (decision.reasons.includes('RESOURCE_CONCURRENCY_RESTORED')) break;
  }
  checkRecovery(signal, 'real-sdk');
  await finish(ref);
  const workload = await adapter.collect(ref, executionPolicy);
  check(`${signal}-in-flight-workload-completes`, workload.exitCode === 0 && workload.stdout.trim() === `${signal}-pressure-complete`);
}

async function sampleLogs(sandbox: SandboxRef): Promise<void> {
  const policyTracker = tracker('logs');
  const ref = await execute(sandbox, 'logs', logWork);
  await finish(ref);
  const collected = await adapter.collect(ref, executionPolicy);
  if (!collected.resources) throw new Error('Collection did not return log telemetry');
  const retained = collected.resources.retainedLogBytes;
  check('logs-real-per-stream-bounds-and-lower-bound', collected.logsTruncated
    && Buffer.byteLength(collected.stdout) === executionPolicy.maxLogBytes
    && Buffer.byteLength(collected.stderr) === executionPolicy.maxLogBytes
    && retained.status === 'known' && retained.value === logLimit && retained.quality === 'lower-bound'
    && retained.source === 'verified-collector');
  const throttle = await policyTracker.evaluate(collected.resources, 'pressure', 'real-collector');
  const throttled = throttle.maxNewConcurrency === 1 && throttle.reasons.includes('RESOURCE_HIGH_LOGS');
  check('logs-lower-bound-triggers-future-dispatch-limit', throttled);
  if (throttled) await proveGap(ref, 'logs', policyTracker);
  for (let i = 1; i <= 2; i++) {
    const quiet = await execute(sandbox, `logs-quiet-${i}`, 'print("quiet")');
    await finish(quiet);
    const quietCollected = await adapter.collect(quiet, executionPolicy);
    if (!quietCollected.resources) throw new Error('Collection did not return quiet log telemetry');
    await policyTracker.evaluate(quietCollected.resources, 'release', 'real-collector');
  }
  checkRecovery('logs', 'real-collector');
}

let sandbox: SandboxRef | undefined;
try {
  sandbox = await adapter.create(runId, executionPolicy);
  await sampleWhileRunning(sandbox, 'cpu', cpuWork);
  await sampleWhileRunning(sandbox, 'memory', memoryWork);
  await sampleLogs(sandbox);
  const realSamples = Object.values(observations).flat().filter(item => item.origin !== 'injected-telemetry-gap');
  check('unsupported-counters-remain-unknown', realSamples.length > 0 && realSamples.every(({ sample }) =>
    sample.cpuTime.status === 'unknown' && sample.cpuTime.reason === 'not-supported'
    && sample.peakMemory.status === 'unknown' && sample.peakMemory.reason === 'not-supported'));
} catch (error) {
  check('probe-completed', false, safeError(error));
} finally {
  if (sandbox) {
    try {
      await adapter.destroy(sandbox);
      check('sandbox-deletion-confirmed', true);
    } catch (error) {
      check('sandbox-deletion-confirmed', false, safeError(error));
    }
  }
  const report = {
    schemaVersion: 1, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt,
    runId, sandboxId: sandbox?.sandboxId ?? null, realServiceInvoked: true, modelCalls: 0,
    executionPolicy, deployment, pressureSeconds, releaseSeconds, memoryMiB, sampleIntervalMs, pressureSampleLimit, releaseSampleLimit,
    logWorkload: { writesPerStream: logWrites, bytesPerWrite, perStreamLogCapBytes: executionPolicy.maxLogBytes },
    policyConfigurations, checks, observations, passed: checks.every(item => item.passed),
    scope: [
      'CPU and memory decisions use the configured deployment scope and real OpenSandbox SDK samples.',
      'Log decisions use bytes retained by the collector after command completion. Truncation makes this a lower bound.',
      'Injected gaps test missing-data policy with a serialized state round trip in the same client process.',
      'The probe exercises controller decisions and verifies that in-flight workloads finish. Workflow dispatch enforcement is covered by separate scheduler tests.',
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ runId, sandboxId: report.sandboxId, elapsedMs: report.elapsedMs, passed: report.passed, checks, reportPath }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
