import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import { loadConfig } from '../../src/config.js';
import { FakeBudget } from '../../tests/support/fakes.js';

const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const reportPath = process.env.RUNTIME_SERVICE_SMOKE_OUTPUT ?? '/reports/runtime-service-smoke.json';
if (!domain || !image) throw new Error('OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE are required');

const root = '/tmp/runtime-service-smoke';
const results: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
const artifacts = new ArtifactStore(`${root}/artifacts`);
const budget = new FakeBudget({ scopeKey: 'real-sandbox-smoke-scope', limitTokens: 10_000,
  sessionIds: ['real-sandbox-smoke-session'] });
const config = loadConfig('/workspace/config/example.json');
config.sandbox.image = image;
config.sandbox.ttlSeconds = 300;
config.sandbox.commandTimeoutMs = 120_000;
config.sandbox.maxOutputBytes = 1_048_576;
config.sandbox.maxOutputFiles = 8;
config.sandbox.maxLogBytes = 8_192;

const adapter = () => new OpenSandboxAdapter({
  connection: { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true },
  cancelTimeoutMs: 10_000,
  pollIntervalMs: 150,
});
const outputCode = (label: string) => [
  'import os, pathlib',
  'output = pathlib.Path(os.environ["AGENT_OUTPUT_DIR"])',
  `output.joinpath("result.json").write_text('{"label":"${label}"}', encoding="utf-8")`,
  `print("runtime-service-smoke:${label}")`,
].join('\n');
const makeInput = (runId: string, stepId: string, label: string) => ({
  runId, stepId, code: outputCode(label), inputs: [],
});
async function makeService(store: RuntimeStore, options: ConstructorParameters<typeof RuntimeService>[5] = {}) {
  return new RuntimeService(store, artifacts, adapter(), budget, config, options);
}
async function createRun(service: RuntimeService, runId: string) {
  return service.createRun({ runId, rootSessionId: 'real-sandbox-smoke-session',
    budgetScopeKey: 'real-sandbox-smoke-scope', task: 'Verify real sandbox execution and durable artifact recovery',
    deadline: Date.now() + 300_000, policyVersion: 'sandbox-smoke-v1', inputHash: 'd'.repeat(64) });
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
let store: RuntimeStore | undefined;
let processFailed = false;
try {
  store = new RuntimeStore(`${root}/database`);
  const service = await makeService(store, { pollIntervalMs: 150,
    validate: async () => ({ passed: true, evidence: { smoke: 'real-open-sandbox; output checked by script assertions' } }) });

  await createRun(service, 'runtime-smoke-success');
  const successInput = makeInput('runtime-smoke-success', 'success-step', 'success');
  const success = await service.executeCode(successInput);
  assert.equal(success.exitCode, 0);
  assert.match(success.stdout, /runtime-service-smoke:success/);
  assert.equal(success.artifacts.length, 1);
  assert.equal(Buffer.from(await artifacts.read(store.listArtifacts('runtime-smoke-success')[0]!)).toString('utf8'), '{"label":"success"}');
  assert.equal(store.getSandbox('runtime-smoke-success'), undefined, 'completed step must release its sandbox');
  const firstSandbox = store.getAttempt(success.attemptId).sandboxId;
  const followup = await service.executeCode({ runId: 'runtime-smoke-success', stepId: 'followup-step', inputs: [],
    code: `import os, pathlib
source = pathlib.Path(os.environ['AGENT_INPUT_DIR']) / 'artifacts' / '${success.artifacts[0]!.artifactId}' / 'result.json'
assert source.read_text(encoding='utf-8') == '{"label":"success"}'
(pathlib.Path(os.environ['AGENT_OUTPUT_DIR']) / 'followup.txt').write_text('verified')` });
  assert.equal(followup.exitCode, 0);
  assert.notEqual(store.getAttempt(followup.attemptId).sandboxId, firstSandbox);
  assert.equal(store.getSandbox('runtime-smoke-success'), undefined);
  results.push({ name: 'runtime-service-fresh-sandbox-reads-prior-artifact', passed: true,
    detail: { firstSandbox, nextSandbox: store.getAttempt(followup.attemptId).sandboxId, firstArtifactSha256: success.artifacts[0]?.sha256 } });
  const finalized = await service.finalize('runtime-smoke-success', true);
  assert.equal(finalized.run.status, 'SUCCEEDED');
  results.push({ name: 'runtime-service-artifact-finalize', passed: true,
    detail: { sandboxId: store.getAttempt(success.attemptId).sandboxId, attemptId: success.attemptId,
      artifactSha256: success.artifacts[0]?.sha256, finalStatus: finalized.run.status } });

  let inject = true;
  const crashService = await makeService(store, { pollIntervalMs: 150,
    fault: point => { if (point === 'after-publish' && inject) { inject = false; throw new Error('injected process-loss window after artifact publication'); } },
    validate: async () => ({ passed: true, evidence: { smoke: 'real-open-sandbox; recovered artifact checked by script assertions' } }) });
  await createRun(crashService, 'runtime-smoke-recovery');
  const recoveryInput = makeInput('runtime-smoke-recovery', 'recovery-step', 'recovered');
  await assert.rejects(crashService.executeCode(recoveryInput), /injected process-loss window/);
  const interrupted = store.getRun('runtime-smoke-recovery');
  assert.equal(interrupted.status, 'RECOVERY_REQUIRED');
  assert.equal(store.listArtifacts('runtime-smoke-recovery').length, 0);
  store.close(); store = undefined;

  store = new RuntimeStore(`${root}/database`);
  const recoveredService = await makeService(store, { pollIntervalMs: 150,
    validate: async () => ({ passed: true, evidence: { smoke: 'real-open-sandbox; recovered artifact checked by script assertions' } }) });
  await recoveredService.recover('runtime-smoke-recovery');
  const recoveredAttempt = store.listAttempts('runtime-smoke-recovery');
  assert.equal(recoveredAttempt.length, 1, 'restart reconciliation must not launch another attempt');
  assert.equal(recoveredAttempt[0]?.status, 'SUCCEEDED');
  assert.equal(store.listArtifacts('runtime-smoke-recovery').length, 1);
  const paused = store.getRun('runtime-smoke-recovery');
  await recoveredService.resumeRun('runtime-smoke-recovery', 'smoke-resume', paused.revision);
  const replay = await recoveredService.executeCode(recoveryInput);
  assert.equal(replay.attemptId, recoveredAttempt[0]?.attemptId);
  const recoveryFinal = await recoveredService.finalize('runtime-smoke-recovery', true);
  assert.equal(recoveryFinal.run.status, 'SUCCEEDED');
  results.push({ name: 'runtime-service-restart-artifact-reconciliation', passed: true,
    detail: { runId: 'runtime-smoke-recovery', attemptId: recoveredAttempt[0]?.attemptId,
      artifactSha256: store.listArtifacts('runtime-smoke-recovery')[0]?.sha256,
      attemptCountAfterReplay: store.listAttempts('runtime-smoke-recovery').length, finalStatus: recoveryFinal.run.status } });

  const cancelService = await makeService(store, { pollIntervalMs: 100 });
  await createRun(cancelService, 'runtime-smoke-cancel');
  const execution = cancelService.executeCode({ runId: 'runtime-smoke-cancel', stepId: 'cancel-step',
    code: 'import time\nprint("waiting", flush=True)\ntime.sleep(60)\n', inputs: [] })
    .then(value => ({ value }), error => ({ error }));
  const runningDeadline = Date.now() + 30_000;
  let runningAttempt = store.listAttempts('runtime-smoke-cancel')[0];
  while (Date.now() < runningDeadline && (!runningAttempt?.executionId || runningAttempt.status !== 'RUNNING')) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    runningAttempt = store.listAttempts('runtime-smoke-cancel')[0];
  }
  assert.ok(runningAttempt?.executionId, 'runtime service must persist the remote execution ID before cancellation');
  const cancelled = await cancelService.cancelRun('runtime-smoke-cancel', 'smoke-cancel', { reason: 'integration smoke' });
  assert.equal(cancelled.status, 'CANCELLED');
  const executionOutcome = await execution;
  assert.ok('error' in executionOutcome, 'cancelled tool invocation must not report success');
  assert.equal(store.listAttempts('runtime-smoke-cancel')[0]?.status, 'CANCELLED');
  results.push({ name: 'runtime-service-confirmed-cancel', passed: true,
    detail: { attemptId: runningAttempt.attemptId, executionId: runningAttempt.executionId,
      finalStatus: cancelled.status, attemptStatus: store.listAttempts('runtime-smoke-cancel')[0]?.status } });
} catch (error) {
  processFailed = true;
  const safeMessage = error instanceof Error ? error.message : 'unknown error';
  results.push({ name: 'runtime-service-smoke-error', passed: false, detail: { type: error instanceof Error ? error.name : 'UnknownError', message: safeMessage.replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500) } });
} finally {
  if (store) {
    for (const run of store.listRuns()) {
      const sandbox = store.getSandbox(run.runId);
      if (!sandbox) continue;
      try {
        await adapter().destroy(sandbox);
        store.releaseSandbox(sandbox);
        results.push({ name: 'cleanup-remaining-sandbox', passed: true, detail: { runId: run.runId, sandboxId: sandbox.sandboxId } });
      } catch {
        processFailed = true;
        results.push({ name: 'cleanup-remaining-sandbox', passed: false, detail: { runId: run.runId, sandboxId: sandbox.sandboxId } });
      }
    }
  }
  store?.close();
  const report = { checkedAt: new Date().toISOString(), sdk: '1.2.1', runtime: 'repository RuntimeService + OpenSandboxAdapter + ArtifactStore',
    realServiceInvoked: true, budget: 'in-memory test double; no model/provider calls', checks: results };
  const target = resolve(reportPath);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (processFailed || results.some(result => !result.passed)) process.exitCode = 1;
}
