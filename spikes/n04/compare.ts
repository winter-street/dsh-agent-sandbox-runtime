import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startApplication, type ApplicationConfig, type EvaluationRuntimeHost } from '../../src/app/index.js';
import { createRuntimeServer } from '../../src/api/server.js';
import { normalizeUsage, type BudgetSnapshot } from '../../src/contracts/budget.js';
import { TERMINAL_RUN_STATES, type ArtifactRecord } from '../../src/contracts/runtime.js';
import { DeepSeekAdapter } from '../../src/models/deepseek.js';
import { input, inputSha256, task, validate, verifyDelivery } from './task.js';
import { waitAfterApproval, waitForControllerIdle } from './wait-approved.js';

const domain = 'http://127.0.0.1:8090';
const model = 'deepseek-flash';
const maxProviderCalls = 6;
type Variant = 'single' | 'serial';
interface Result {
  variant: Variant;
  runId: string;
  passed: boolean;
  finalStatus: string | null;
  elapsedMs: number | null;
  providerCalls: number;
  scopeKey: string | null;
  budget: BudgetSnapshot | null;
  validation: ReturnType<typeof verifyDelivery> | null;
  report: string;
}
function credential(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing environment variable ' + name);
  return value;
}
function safeError(error: unknown): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const name of ['DEEPSEEK_API_KEY', 'OPEN_SANDBOX_API_KEY']) {
    const value = process.env[name]?.trim();
    if (value) text = text.replaceAll(value, '[redacted]');
  }
  return text.slice(0, 2048);
}
function save(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
async function preflight(): Promise<void> {
  credential('DEEPSEEK_API_KEY');
  const key = credential('OPEN_SANDBOX_API_KEY');
  await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href);
  const health = await fetch(domain + '/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200, 'OpenSandbox health check');
  await health.body?.cancel();
  const authenticated = await fetch(domain + '/sandboxes?pageSize=1', {
    headers: { 'OPEN-SANDBOX-API-KEY': key }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(authenticated.status, 200, 'OpenSandbox authenticated read-only check');
  await authenticated.body?.cancel();
}
async function capture(host: EvaluationRuntimeHost, runId: string) {
  const run = await host.get(runId);
  return { run, mode: host.mode, budget: await host.budget.reader.snapshot(run.budgetScopeKey),
    ledger: (await host.budget.reader.eventsAfter(0)).filter(event => event.scopeKey === run.budgetScopeKey),
    roles: host.store.listComponentState(runId, 'role-calls'), approvals: host.service.approvals.list(runId),
    attempts: host.store.listAttempts(runId), steps: host.store.listSteps(runId),
    events: host.store.eventsAfter(runId), sandbox: host.store.getSandbox(runId) ?? null,
    runtimeIdentity: host.store.getComponentState(runId, 'runtime', 'identity') };
}
type Evidence = Awaited<ReturnType<typeof capture>>;
function verifyAccounting(evidence: Evidence): void {
  const reserves = evidence.ledger.filter(event => event.type === 'reserve');
  const settles = evidence.ledger.filter(event => event.type === 'settle');
  assert(reserves.length > 0 && reserves.length <= maxProviderCalls, 'Bounded real provider calls');
  assert.equal(settles.length, reserves.length, 'Every reserved call settles');
  let total = 0;
  for (const reserve of reserves) {
    const related = evidence.ledger.filter(event => event.payload.reservationId === reserve.payload.reservationId);
    assert.deepEqual(related.map(event => event.type), ['reserve', 'dispatch', 'settle']);
    const usage = normalizeUsage(related[2]!.payload.usage as Parameters<typeof normalizeUsage>[0]);
    total += Object.values(usage).reduce((sum, count) => sum + count, 0);
  }
  assert.equal(evidence.budget.usedTokens, total);
  assert.equal(evidence.budget.reservedTokens, 0);
  assert.equal(evidence.budget.unknownCalls, 0);
  assert(evidence.budget.meteringComplete);
}
async function serve(host: EvaluationRuntimeHost, token: string) {
  const server = createRuntimeServer(host.service, { token, control: { decideApproval: host.decideApproval } });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); done(); });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function download(host: EvaluationRuntimeHost, runId: string, url: string, token: string, directory: string) {
  mkdirSync(join(directory, 'downloads'));
  const files = new Map<string, Uint8Array>();
  const artifacts: ArtifactRecord[] = [];
  for (const artifact of host.store.listArtifacts(runId)) {
    assert(['ranking.json', 'report.md'].includes(artifact.path), 'Only contracted files may be downloaded');
    assert(!files.has(artifact.path), 'Artifact paths must be unambiguous');
    const response = await fetch(`${url}/runs/${runId}/artifacts/${artifact.artifactId}`, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, 'Authenticated artifact download');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, artifact.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    writeFileSync(join(directory, 'downloads', artifact.path), bytes, { flag: 'wx' });
    files.set(artifact.path, bytes);
    artifacts.push(artifact);
  }
  return { validation: verifyDelivery(files), artifacts };
}
async function runVariant(parent: string, variant: Variant, timeoutMs: number): Promise<Result> {
  const directory = join(parent, variant);
  mkdirSync(directory);
  const runId = `n04-${variant}-${randomUUID()}`;
  const result: Result = { variant, runId, passed: false, finalStatus: null, elapsedMs: null,
    providerCalls: 0, scopeKey: null, budget: null, validation: null, report: join(directory, 'result.json') };
  const details: Record<string, unknown> = {};
  const runtime = JSON.parse(readFileSync('config/example.json', 'utf8')) as Record<string, unknown>;
  runtime.sandbox = { ...(runtime.sandbox as object), ttlSeconds: Math.ceil(timeoutMs / 1000), commandTimeoutMs: 15000,
    maxOutputFiles: 2, maxOutputBytes: 131072, maxLogBytes: 65536 };
  const config: ApplicationConfig = { schemaVersion: 1, runtimeConfigPath: join(directory, 'runtime.json'),
    dataDir: join(directory, 'application'),
    model: { provider: 'deepseek', name: model, apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', maxOutputTokens: 4096 },
    budget: { maxTokens: 30000, finalizeTokens: 2000 },
    sandbox: { domain, apiKeyEnv: 'OPEN_SANDBOX_API_KEY', useServerProxy: true },
    ...(variant === 'serial' ? { workflow: { mode: 'serial' as const, maxRepairs: 0,
      approval: { reason: 'Bounded P4-07 fixed ranking comparison', ttlMs: 120000 },
      retry: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 500 },
      context: { modelWindowTokens: 32768, safetyReserveTokens: 512 }, reference: { key: 'ranking' as const } } } : {}),
  };
  save(directory, 'runtime.json', runtime);
  save(directory, 'application.json', config);
  let host: EvaluationRuntimeHost | undefined;
  let server: Server | undefined;
  let startedAt: number | undefined;
  try {
    // The actual production adapter is configured explicitly to enforce the same request cap in both modes.
    const provider = new DeepSeekAdapter({ apiKey: credential('DEEPSEEK_API_KEY'), thinking: 'disabled',
      maxCalls: maxProviderCalls, requestTimeoutMs: Math.min(90000, timeoutMs) });
    host = await startApplication({ configPath: join(directory, 'application.json'), listen: false,
      installSignalHandlers: false, validate, provider });
    assert.equal(host.mode.injectedSandbox, false);
    const token = randomBytes(32).toString('hex');
    const api = await serve(host, token);
    server = api.server;
    details.mode = host.mode;
    startedAt = Date.now();
    await host.submit({ runId, task, inputs: [{ path: 'input.csv', content: input }] });
    const initial = host.store.getRun(runId);
    result.scopeKey = initial.budgetScopeKey;
    const deadline = Math.min(initial.deadline, startedAt + timeoutMs);
    let completed = await host.wait(runId, { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (completed.status === 'PAUSED_APPROVAL') {
      assert.equal(variant, 'serial');
      const pending = host.service.approvals.list(runId).filter(approval => approval.status === 'pending');
      assert.equal(pending.length, 1, 'One fixed authenticated approval is allowed');
      const approval = pending[0]!;
      const response = await fetch(`${api.url}/runs/${runId}/approvals/${approval.approvalId}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisionId: 'comparison-approved', approved: true }), signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, 'Fixed-task authenticated approval');
      await response.body?.cancel();
      completed = await waitAfterApproval(host, runId, approval.approvalId, deadline);
    }
    await waitForControllerIdle(host, runId, deadline);
    result.elapsedMs = Date.now() - startedAt;
    const evidence = await capture(host, runId);
    save(directory, 'evidence.json', evidence);
    result.finalStatus = evidence.run.status;
    result.budget = evidence.budget;
    result.providerCalls = evidence.ledger.filter(event => event.type === 'dispatch').length;
    assert.equal(evidence.run.budgetScopeKey, initial.budgetScopeKey);
    assert.equal(evidence.run.deadline, initial.deadline);
    const delivery = await download(host, runId, api.url, token, directory);
    result.validation = delivery.validation;
    details.artifacts = delivery.artifacts;
    save(directory, 'independent-validation.json', delivery.validation);
    verifyAccounting(evidence);
    assert.equal(evidence.run.status, 'SUCCEEDED', 'Task must complete through the application');
    assert(delivery.validation.passed, 'Independent input-derived artifact validation');
    assert.equal(evidence.sandbox, null, 'Local sandbox release');
    const cleanup = [];
    for (const sandboxId of new Set(evidence.attempts.map(attempt => attempt.sandboxId).filter(id => id !== null))) {
      const response = await fetch(`${domain}/sandboxes/${encodeURIComponent(sandboxId)}`, {
        headers: { 'OPEN-SANDBOX-API-KEY': credential('OPEN_SANDBOX_API_KEY') }, signal: AbortSignal.timeout(10000),
      });
      cleanup.push({ sandboxId, status: response.status });
      await response.body?.cancel();
      assert.equal(response.status, 404, 'Authenticated remote sandbox release');
    }
    details.cleanup = cleanup;
    result.passed = true;
  } catch (error) {
    details.error = safeError(error);
    if (startedAt !== undefined && result.elapsedMs === null) result.elapsedMs = Date.now() - startedAt;
    if (host?.store.findRun(runId)) {
      try {
        const evidence = await capture(host, runId);
        save(directory, 'failure-evidence.json', evidence);
        result.finalStatus = evidence.run.status;
        result.scopeKey = evidence.run.budgetScopeKey;
        result.budget = evidence.budget;
        result.providerCalls = evidence.ledger.filter(event => event.type === 'dispatch').length;
      } catch (captureError) { details.captureError = safeError(captureError); }
      try {
        if (!TERMINAL_RUN_STATES.has(host.store.getRun(runId).status)) {
          await host.cancel(runId, 'comparison-bounded-cleanup', 'Bounded comparison stopped and failure evidence retained');
        }
        details.failureCleanup = { run: await host.get(runId), sandbox: host.store.getSandbox(runId) ?? null };
      } catch (cleanupError) { details.cleanupError = safeError(cleanupError); }
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(done => server!.close(() => done()));
    }
    await host?.close();
    save(directory, 'result.json', { ...result, ...details });
    console.log(JSON.stringify(result));
  }
  return result;
}
async function compare(directory: string, timeoutMs: number): Promise<void> {
  await preflight();
  mkdirSync(directory, { recursive: false });
  writeFileSync(join(directory, 'input.csv'), input, { flag: 'wx' });
  save(directory, 'manifest.json', { schemaVersion: 1, createdAt: Date.now(), task, inputSha256, model,
    order: ['single', 'serial'], repetitions: 1,
    bounds: { timeoutMsPerMode: timeoutMs, maxProviderCallsPerMode: maxProviderCalls, maxTokensPerMode: 30000,
      finalizeTokens: 2000, maxOutputTokens: 4096, providerRequestTimeoutMs: Math.min(90000, timeoutMs) },
    timing: 'Milliseconds immediately before submit through application controller idle; bootstrap, downloads and remote cleanup verification excluded in both modes',
    provider: 'Actual production DeepSeekAdapter supplied explicitly to set maxCalls and request timeout; real API SSE and automatic original-plugin usage settlement',
    differences: 'Serial includes MCP prefetch, three roles, one automated authenticated approval and zero repairs; single uses the production root-agent tool loop. The task already supplies the exact same ranking rule.',
    limitations: ['One fixture and one run per mode', 'Fixed single-then-serial order and provider cache can affect measurements',
      'End-to-end production-mode comparison includes workflow, context and approval differences', 'Provider token usage is not a currency price or invoice'] });
  const results = [];
  for (const variant of ['single', 'serial'] as const) results.push(await runVariant(directory, variant, timeoutMs));
  const single = results[0]!;
  const serial = results[1]!;
  const passed = results.every(result => result.passed);
  save(directory, 'comparison.json', { schemaVersion: 1, inputSha256, model, passed, results,
    serialMinusSingle: passed ? { elapsedMs: serial.elapsedMs! - single.elapsedMs!,
      tokens: serial.budget!.usedTokens - single.budget!.usedTokens, providerCalls: serial.providerCalls - single.providerCalls } : null });
  if (!passed) process.exitCode = 2;
  console.log(JSON.stringify({ passed, report: join(directory, 'comparison.json') }));
}
try {
  const [mode, directory, duration] = process.argv.slice(2);
  if (mode === '--check-only') {
    await preflight();
    console.log('P4-07 comparison read-only preflight passed.');
  } else if (mode === '--run' && directory && Number.isSafeInteger(Number(duration)) && Number(duration) >= 120000 && Number(duration) <= 600000) {
    await compare(resolve(directory), Number(duration));
  } else throw new Error('Usage --check-only or --run <new directory> <timeout 120000..600000 ms>');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
