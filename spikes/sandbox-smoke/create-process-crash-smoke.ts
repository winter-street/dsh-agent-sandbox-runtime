import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxApiException, SandboxManager } from '@alibaba-group/opensandbox';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { loadConfig } from '../../src/config.js';
import { RuntimeService } from '../../src/core/service.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeBudget } from '../../tests/support/fakes.js';

const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
if (!domain || !image) throw new Error('OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE are required');
const worker = process.argv.includes('--worker');
const root = process.env.RUNTIME_CREATE_CRASH_ROOT ?? await mkdtemp(join(tmpdir(), 'runtime-create-crash-'));
const runId = process.env.RUNTIME_CREATE_CRASH_RUN_ID ?? `create-crash-${randomUUID()}`;
const config = loadConfig('/workspace/config/example.json');
config.sandbox.image = image;
config.sandbox.ttlSeconds = 300;
config.sandbox.commandTimeoutMs = 120000;
const budget = new FakeBudget({ scopeKey: 'create-crash-scope', limitTokens: 10000, sessionIds: ['create-crash-root'] });
const artifacts = new ArtifactStore(join(root, 'artifacts'));
const connection = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true };
const makeService = (store: RuntimeStore, serviceDomain: string) => new RuntimeService(store, artifacts,
  new OpenSandboxAdapter({ connection: { ...connection, domain: serviceDomain }, cancelTimeoutMs: 10000, pollIntervalMs: 150 }),
  budget, config, { pollIntervalMs: 150 });
const input = { runId, stepId: 'never-dispatched', inputs: [], code: 'print("must-not-run")' };
const isUnknown = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EXECUTION_UNKNOWN';

if (worker) {
  const proxyDomain = process.env.RUNTIME_CREATE_CRASH_PROXY;
  if (!proxyDomain) throw new Error('Worker proxy address is required');
  const store = new RuntimeStore(join(root, 'db'));
  const service = makeService(store, proxyDomain);
  await service.createRun({ runId, rootSessionId: 'create-crash-root', budgetScopeKey: 'create-crash-scope',
    task: 'Verify recovery after a process dies during sandbox creation', deadline: Date.now() + 240000,
    policyVersion: 'create-crash-v1', inputHash: 'd'.repeat(64) });
  await service.executeCode(input);
  throw new Error('Worker unexpectedly completed the create request');
} else {
  const upstream = new URL(domain);
  if (upstream.protocol !== 'http:') throw new Error('This local fault proxy requires an HTTP upstream');
  const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
  const manager = SandboxManager.create({ connectionConfig: connection });
  let capturedId: string | undefined;
  let identityVerified = false;
  let createRequests = 0;
  let upstreamStatus = 0;
  let store: RuntimeStore | undefined;
  let signalCreate: (id: string) => void = () => {};
  const created = new Promise<string>(resolveCreated => { signalCreate = resolveCreated; });
  const proxy = createServer((incoming, outgoing) => {
    const intercept = incoming.method === 'POST' && /^\/v1\/sandboxes(?:\?.*)?$/.test(incoming.url ?? '');
    if (intercept) createRequests++;
    const forwarded = request(new URL(incoming.url ?? '/', upstream), {
      method: incoming.method, headers: { ...incoming.headers, host: upstream.host },
    }, response => {
      if (!intercept) {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
        return;
      }
      upstreamStatus = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown };
          if (upstreamStatus >= 200 && upstreamStatus < 300 && typeof body.id === 'string') {
            capturedId = body.id;
            signalCreate(body.id);
            return; // Hold the response until the worker is killed.
          }
        } catch { /* The timeout reports a missing successful create response. */ }
        outgoing.destroy();
      });
    });
    forwarded.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(forwarded);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Could not start fault proxy');
  const proxyDomain = `http://127.0.0.1:${address.port}`;
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, RUNTIME_CREATE_CRASH_ROOT: root, RUNTIME_CREATE_CRASH_RUN_ID: runId, RUNTIME_CREATE_CRASH_PROXY: proxyDomain },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostic = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-4000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    child.once('error', reject);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sandboxId = await Promise.race([
      created,
      exited.then(exit => { throw new Error(`Worker exited before create response (${exit.code}/${exit.signal}): ${diagnostic}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for successful create response')), 150000); }),
    ]);
    if (timer) clearTimeout(timer);
    const remote = await manager.getSandboxInfo(sandboxId);
    assert.equal(remote.metadata?.project, 'agent-runtime');
    assert.equal(remote.metadata?.runId, runId);
    identityVerified = true;
    assert.ok(child.kill('SIGKILL'), 'OS must accept worker termination');
    assert.equal((await exited).signal, 'SIGKILL');
    store = new RuntimeStore(join(root, 'db'));
    const initial = store.listAttempts(runId);
    assert.equal(initial.length, 1);
    assert.equal(initial[0]?.status, 'CREATED');
    assert.equal(initial[0]?.sandboxId, null);
    assert.equal(initial[0]?.executionId, null);
    assert.equal(store.getSandbox(runId), undefined);
    const service = makeService(store, proxyDomain);
    await service.recover(runId);
    assert.equal(store.getRun(runId).status, 'RECOVERY_REQUIRED');
    const recovered = store.listAttempts(runId);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.attemptId, initial[0]?.attemptId);
    assert.equal(recovered[0]?.status, 'UNKNOWN');
    assert.equal(recovered[0]?.errorCode, 'SANDBOX_CREATE_UNKNOWN');
    await assert.rejects(service.resumeRun(runId, 'resume-after-crash', store.getRun(runId).revision), isUnknown);
    await assert.rejects(service.finalize(runId, false), isUnknown);
    await assert.rejects(service.executeCode(input));
    assert.equal((await service.cancelRun(runId, 'cancel-after-crash', { reason: 'probe' })).status, 'RECOVERY_REQUIRED');
    assert.equal(createRequests, 1);
    assert.equal(store.listAttempts(runId).length, 1);
    assert.equal(store.listAttempts(runId)[0]?.executionId, null);
    checks.push({ name: 'worker-killed-after-successful-create-before-response', passed: true,
      detail: { runId, attemptId: initial[0]?.attemptId, sandboxId, upstreamStatus, createRequests,
        workerSignal: 'SIGKILL', statusBeforeRecovery: initial[0]?.status,
        statusAfterRecovery: recovered[0]?.status, runStatus: store.getRun(runId).status, executionId: null } });
  } catch (error) {
    checks.push({ name: 'create-process-crash-smoke', passed: false,
      detail: { message: (error instanceof Error ? error.stack ?? error.message : String(error)).replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 2000) } });
    process.exitCode = 1;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.catch(() => {}); }
    if (capturedId) {
      try {
        if (!identityVerified) {
          const remote = await manager.getSandboxInfo(capturedId);
          assert.equal(remote.metadata?.project, 'agent-runtime');
          assert.equal(remote.metadata?.runId, runId);
          identityVerified = true;
        }
        await manager.killSandbox(capturedId);
        await assert.rejects(manager.getSandboxInfo(capturedId), (error: unknown) => error instanceof SandboxApiException && error.statusCode === 404);
        if (store) {
          const service = makeService(store, proxyDomain);
          await service.recover(runId);
          assert.equal(store.getRun(runId).status, 'RECOVERY_REQUIRED');
          await assert.rejects(service.executeCode(input));
          assert.equal(createRequests, 1);
        }
        checks.push({ name: 'captured-sandbox-cleanup-confirmed', passed: true, detail: { sandboxId: capturedId, lookup: 404 } });
      } catch (error) {
        checks.push({ name: 'captured-sandbox-cleanup-confirmed', passed: false,
          detail: { sandboxId: capturedId, identityVerified, message: (error instanceof Error ? error.message : String(error)).replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500) } });
        process.exitCode = 1;
      }
    }
    store?.close();
    await manager.close();
    proxy.closeAllConnections();
    await new Promise<void>(resolveClose => proxy.close(() => resolveClose()));
    const report = { checkedAt: new Date().toISOString(), runId, sdk: '1.2.1', realServiceInvoked: true,
      processTermination: 'SIGKILL of separate Node worker in Docker client container after successful create response reached parent proxy',
      budget: 'FakeBudget only; no model calls or real-plugin ledger recovery', checks,
      limitations: ['Controlled proxy holds a successful response; this does not simulate a physical host crash.',
        'A single confirmed deletion does not establish server-side creation idempotency or termination.',
        'If no response ID is captured, an in-flight create may still complete and must be investigated by runId.'] };
    const target = resolve(process.env.RUNTIME_SERVICE_SMOKE_OUTPUT ?? '/reports/create-process-crash-smoke.json');
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
