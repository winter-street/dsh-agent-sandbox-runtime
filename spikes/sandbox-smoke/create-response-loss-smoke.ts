import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { SandboxApiException, SandboxManager } from '@alibaba-group/opensandbox';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import { loadConfig } from '../../src/config.js';
import { RuntimeService } from '../../src/core/service.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeBudget } from '../../tests/support/fakes.js';

const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
if (!domain || !image) throw new Error('OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE are required');
const upstream = new URL(domain);
if (upstream.protocol !== 'http:') throw new Error('This local fault proxy requires an HTTP upstream');
const root = await mkdtemp(join(tmpdir(), 'runtime-create-fault-'));
const runId = `create-response-loss-${randomUUID()}`;
const config = loadConfig('/workspace/config/example.json');
config.sandbox.image = image;
config.sandbox.ttlSeconds = 300;
config.sandbox.commandTimeoutMs = 120000;
const artifacts = new ArtifactStore(join(root, 'artifacts'));
const budget = new FakeBudget({ scopeKey: 'create-fault-scope', limitTokens: 10000, sessionIds: ['create-fault-root'] });
const connection = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 30, disableMetrics: true };
const manager = SandboxManager.create({ connectionConfig: connection });
const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
const capturedIds = new Set<string>();
let createRequests = 0;
let upstreamStatus = 0;
let store: RuntimeStore | undefined;

const proxy = createServer((incoming, outgoing) => {
  const intercept = incoming.method === 'POST' && /^\/v1\/sandboxes(?:\?.*)?$/.test(incoming.url ?? '');
  if (intercept) createRequests++;
  const forwarded = request(new URL(incoming.url ?? '/', upstream), {
    method: incoming.method, headers: { ...incoming.headers, host: upstream.host },
  }, response => {
    if (intercept) {
      upstreamStatus = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown };
          if (upstreamStatus >= 200 && upstreamStatus < 300 && typeof body.id === 'string') capturedIds.add(body.id);
        } catch { /* The report will record failure to capture a successful response. */ }
        outgoing.destroy();
      });
      return;
    }
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  forwarded.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
  incoming.pipe(forwarded);
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const address = proxy.address();
if (!address || typeof address === 'string') throw new Error('Could not start fault proxy');
const makeService = (runtimeStore: RuntimeStore) => new RuntimeService(runtimeStore, artifacts,
  new OpenSandboxAdapter({ connection: { ...connection, domain: `http://127.0.0.1:${address.port}` },
    cancelTimeoutMs: 10000, pollIntervalMs: 150 }), budget, config, { pollIntervalMs: 150 });
const input = { runId, stepId: 'never-dispatched', inputs: [], code: 'print("must-not-run")' };
const isUnknown = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EXECUTION_UNKNOWN';
async function assertBlocked(service: RuntimeService, runtimeStore: RuntimeStore, suffix: string) {
  await service.recover(runId);
  assert.equal(runtimeStore.getRun(runId).status, 'RECOVERY_REQUIRED');
  await assert.rejects(service.resumeRun(runId, `resume-${suffix}`, runtimeStore.getRun(runId).revision), isUnknown);
  await assert.rejects(service.finalize(runId, false), isUnknown);
  await assert.rejects(service.executeCode(input));
  assert.equal((await service.cancelRun(runId, `cancel-${suffix}`, { reason: 'probe' })).status, 'RECOVERY_REQUIRED');
  assert.equal(createRequests, 1);
  const attempts = runtimeStore.listAttempts(runId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, 'UNKNOWN');
  assert.equal(attempts[0]?.errorCode, 'SANDBOX_CREATE_UNKNOWN');
  assert.equal(attempts[0]?.sandboxId, null);
  assert.equal(attempts[0]?.executionId, null);
}
try {
  store = new RuntimeStore(join(root, 'db'));
  let service = makeService(store);
  await service.createRun({ runId, rootSessionId: 'create-fault-root', budgetScopeKey: 'create-fault-scope',
    task: 'Verify a lost sandbox creation response', deadline: Date.now() + 240000,
    policyVersion: 'create-fault-v1', inputHash: 'c'.repeat(64) });
  await assert.rejects(service.executeCode(input));
  assert.equal(createRequests, 1);
  assert.ok(upstreamStatus >= 200 && upstreamStatus < 300, `upstream returned ${upstreamStatus}`);
  assert.equal(capturedIds.size, 1, 'capture one ID from the successful upstream response');
  const sandboxId = [...capturedIds][0]!;
  const remote = await manager.getSandboxInfo(sandboxId);
  assert.equal(remote.metadata?.project, 'agent-runtime');
  assert.equal(remote.metadata?.runId, runId);
  assert.equal(store.getSandbox(runId), undefined);
  const attemptId = store.listAttempts(runId)[0]?.attemptId;
  await assertBlocked(service, store, 'first');
  store.close();
  store = new RuntimeStore(join(root, 'db'));
  service = makeService(store);
  await assertBlocked(service, store, 'reopened');
  assert.equal(store.listAttempts(runId)[0]?.attemptId, attemptId);
  await manager.killSandbox(sandboxId);
  await assert.rejects(manager.getSandboxInfo(sandboxId), (error: unknown) => error instanceof SandboxApiException && error.statusCode === 404);
  await assertBlocked(service, store, 'after-cleanup');
  checks.push({ name: 'successful-create-response-lost', passed: true, detail: {
    runId, attemptId, sandboxId, upstreamStatus, createRequests, remoteMetadataVerified: true,
    runStatus: store.getRun(runId).status, attemptStatus: store.listAttempts(runId)[0]?.status,
    lookupAfterCleanup: 404, blockedAfterSqliteReopenAndCleanup: true,
  } });
} catch (error) {
  checks.push({ name: 'create-response-loss-smoke', passed: false,
    detail: { message: (error instanceof Error ? error.stack ?? error.message : String(error)).replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 2000) } });
  process.exitCode = 1;
} finally {
  for (const id of capturedIds) {
    try { await manager.killSandbox(id); }
    catch (error) { if (!(error instanceof SandboxApiException && error.statusCode === 404)) {
      checks.push({ name: 'cleanup-captured-sandbox', passed: false, detail: { sandboxId: id } }); process.exitCode = 1;
    } }
    try { await manager.getSandboxInfo(id); checks.push({ name: 'cleanup-confirmation', passed: false, detail: { sandboxId: id } }); process.exitCode = 1; }
    catch (error) { if (!(error instanceof SandboxApiException && error.statusCode === 404)) {
      checks.push({ name: 'cleanup-confirmation', passed: false, detail: { sandboxId: id } }); process.exitCode = 1;
    } }
  }
  store?.close();
  await manager.close();
  await new Promise<void>(resolveClose => proxy.close(() => resolveClose()));
  const report = { checkedAt: new Date().toISOString(), sdk: '1.2.1', realServiceInvoked: true,
    injection: 'local HTTP proxy drops a successful create response after recording its sandbox ID',
    budget: 'FakeBudget only; no model calls or real-plugin ledger recovery', checks,
    limitations: ['The proxy injection is a controlled client-side fault, not a naturally observed service failure.',
      'This observation does not establish server-side idempotency or a creation-termination receipt.',
      'Deleting the captured sandbox does not prove there cannot be a late creation or authorize clearing the unknown state.'] };
  const target = resolve(process.env.RUNTIME_SERVICE_SMOKE_OUTPUT ?? '/reports/create-response-loss-smoke.json');
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
