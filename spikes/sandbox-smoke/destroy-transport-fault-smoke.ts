import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
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
const root = await mkdtemp(join(tmpdir(), 'runtime-destroy-fault-'));
const config = loadConfig('/workspace/config/example.json');
config.sandbox.image = image;
config.sandbox.ttlSeconds = 300;
config.sandbox.commandTimeoutMs = 120000;
const artifacts = new ArtifactStore(join(root, 'artifacts'));
const budget = new FakeBudget({ scopeKey: 'destroy-fault-scope', limitTokens: 10000, sessionIds: ['destroy-fault-root'] });
const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
let store: RuntimeStore | undefined;
let fault: 'reject-delete' | 'drop-delete-response' | undefined;
let intercepted = 0;
let upstreamDeletes: number[] = [];

const proxy = createServer((incoming, outgoing) => {
  const intercept = incoming.method === 'DELETE' && /^\/v1\/sandboxes\/[^/?]+(?:\?.*)?$/.test(incoming.url ?? '');
  if (intercept && fault === 'reject-delete') {
    intercepted++;
    outgoing.writeHead(503, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ code: 'INJECTED_UNAVAILABLE', message: 'Injected lifecycle proxy failure' }));
    return;
  }
  const headers = { ...incoming.headers, host: upstream.host };
  const forwarded = request(new URL(incoming.url ?? '/', upstream), { method: incoming.method, headers }, response => {
    if (intercept && fault === 'drop-delete-response') {
      intercepted++;
      upstreamDeletes.push(response.statusCode ?? 0);
      response.resume();
      response.once('end', () => outgoing.destroy());
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
const proxyDomain = `http://127.0.0.1:${address.port}`;
const makeAdapter = (endpoint: string) => new OpenSandboxAdapter({ connection: {
  domain: endpoint, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 15, disableMetrics: true,
}, cancelTimeoutMs: 10000, pollIntervalMs: 150 });
const validate = async () => ({ passed: true, evidence: { smoke: 'literal artifact verified independently' } });
const sandboxExists = async (sandboxId: string) => {
  try {
    const client = await Sandbox.connect({ sandboxId, connectionConfig: { domain,
      ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 15, disableMetrics: true } });
    try { await client.getInfo(); return true; } finally { await client.close(); }
  } catch (error) {
    if (error instanceof SandboxApiException && error.statusCode === 404) return false;
    throw error;
  }
};
try {
  for (const mode of ['reject-delete', 'drop-delete-response'] as const) {
    const runId = `destroy-${mode}`;
    const input = { runId, stepId: 'write-output', inputs: [], code: [
      'import os, pathlib',
      'pathlib.Path(os.environ["AGENT_OUTPUT_DIR"]).joinpath("result.txt").write_text("destroy-fault-proof")',
    ].join('\n') };
    store = new RuntimeStore(join(root, mode));
    const service = new RuntimeService(store, artifacts, makeAdapter(proxyDomain), budget, config, { pollIntervalMs: 150, validate });
    await service.createRun({ runId, rootSessionId: 'destroy-fault-root', budgetScopeKey: 'destroy-fault-scope',
      task: 'Check recovery from a sandbox deletion transport fault', deadline: Date.now() + 240000,
      policyVersion: 'destroy-fault-v1', inputHash: 'd'.repeat(64) });
    fault = mode;
    intercepted = 0;
    upstreamDeletes = [];
    await assert.rejects(service.executeCode(input), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'CANCEL_UNCONFIRMED');
    assert.ok(intercepted > 0, 'proxy must intercept the lifecycle DELETE');
    if (mode === 'drop-delete-response') assert.ok(upstreamDeletes.some(status => status >= 200 && status < 300), 'upstream must accept DELETE');
    const ref = store.getSandbox(runId);
    assert.ok(ref, 'unconfirmed cleanup must retain sandbox reference');
    assert.equal(await sandboxExists(ref.sandboxId), mode === 'reject-delete');
    assert.equal(store.getRun(runId).status, 'RECOVERY_REQUIRED');
    const pending = store.getComponentState(runId, 'runtime', 'sandbox-cleanup') as
      { pending?: boolean; sandboxId?: string } | undefined;
    assert.equal(pending?.pending, true);
    assert.equal(pending?.sandboxId, ref.sandboxId);
    await assert.rejects(service.resumeRun(runId, 'resume-before-cleanup', store.getRun(runId).revision),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EXECUTION_UNKNOWN');
    const attempt = store.listAttempts(runId)[0];
    assert.ok(attempt?.executionId);
    assert.equal(attempt.status, 'SUCCEEDED');
    const saved = store.listArtifacts(runId);
    assert.equal(saved.length, 1);
    assert.equal(Buffer.from(await artifacts.read(saved[0]!)).toString(), 'destroy-fault-proof');
    await assert.rejects(service.executeCode(input), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'EXECUTION_UNKNOWN');
    const before = { sandboxId: ref.sandboxId, attemptId: attempt.attemptId, executionId: attempt.executionId,
      intercepted, upstreamDeletes, sandboxPresent: mode === 'reject-delete' };
    fault = undefined;
    store.close();
    store = new RuntimeStore(join(root, mode));
    const recovered: RuntimeService = new RuntimeService(store, artifacts, makeAdapter(domain), budget, config, { pollIntervalMs: 150, validate });
    await recovered.recover(runId);
    assert.equal(store.getSandbox(runId), undefined);
    assert.equal(await sandboxExists(ref.sandboxId), false);
    assert.equal(store.listAttempts(runId).length, 1);
    assert.equal(store.eventsAfter(runId).filter(event => event.type === 'tool.finished').length, 1);
    await recovered.resumeRun(runId, 'resume-after-cleanup', store.getRun(runId).revision);
    const replay: Awaited<ReturnType<RuntimeService["executeCode"]>> = await recovered.executeCode(input);
    assert.equal(replay.attemptId, attempt.attemptId);
    assert.equal(store.listAttempts(runId)[0]?.executionId, attempt.executionId);
    const final: Awaited<ReturnType<RuntimeService["finalize"]>> = await recovered.finalize(runId, true);
    assert.equal(final.run.status, 'SUCCEEDED');
    checks.push({ name: mode, passed: true, detail: { ...before, finalStatus: final.run.status,
      attempts: store.listAttempts(runId).length, sandboxLookupAfterRecovery: '404' } });
    store.close();
    store = undefined;
  }
} catch (error) {
  checks.push({ name: 'destroy-fault-smoke', passed: false,
    detail: { message: (error instanceof Error ? error.message : 'unknown').replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 1600) } });
  process.exitCode = 1;
} finally {
  fault = undefined;
  if (store) {
    for (const run of store.listRuns()) {
      const ref = store.getSandbox(run.runId);
      if (!ref) continue;
      try { await makeAdapter(domain).destroy(ref); }
      catch { checks.push({ name: 'cleanup-remaining-sandbox', passed: false, detail: { sandboxId: ref.sandboxId } }); process.exitCode = 1; }
    }
    store.close();
  }
  await new Promise<void>(resolveClose => proxy.close(() => resolveClose()));
  const report = { checkedAt: new Date().toISOString(), sdk: '1.2.1', realServiceInvoked: true,
    injection: 'local HTTP proxy rejects DELETE before upstream or drops the successful upstream DELETE response',
    budget: 'FakeBudget only; no model calls or real-plugin ledger recovery', checks };
  const target = resolve(process.env.RUNTIME_SERVICE_SMOKE_OUTPUT ?? '/reports/destroy-transport-fault-smoke.json');
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
