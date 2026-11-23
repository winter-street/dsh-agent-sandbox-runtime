import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { startApplication, type ApplicationConfig, type EvaluationRuntimeHost } from '../../src/app/index.js';
import { createRuntimeServer } from '../../src/api/server.js';
import { normalizeUsage } from '../../src/contracts/budget.js';
import { TERMINAL_RUN_STATES } from '../../src/contracts/runtime.js';
import { input, inputSha256, task, validate, verifyDelivery } from './task.js';
import { waitAfterApproval, waitForControllerIdle } from './wait-approved.js';
import { disconnectedStatusOnce } from './status-fault.js';

const domain = 'http://127.0.0.1:8090';
const model = 'deepseek-flash';
function credential(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing environment variable: ' + name);
  return value;
}
function safeError(error: unknown): string {
  let result = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const name of ['DEEPSEEK_API_KEY', 'OPEN_SANDBOX_API_KEY']) {
    const value = process.env[name]?.trim(); if (value) result = result.replaceAll(value, '[redacted]');
  }
  return result.slice(0, 2048);
}
async function preflight() {
  credential('DEEPSEEK_API_KEY');
  const key = credential('OPEN_SANDBOX_API_KEY');
  await import(pathToFileURL(resolve('.sources/budget/lib/index.js')).href);
  const health = await fetch(domain + '/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200, 'OpenSandbox health check');
  const auth = await fetch(domain + '/sandboxes?pageSize=1', { headers: { 'OPEN-SANDBOX-API-KEY': key }, signal: AbortSignal.timeout(5000) });
  assert.equal(auth.status, 200, 'OpenSandbox authenticated read-only check');
  await auth.body?.cancel();
}
async function capture(host: EvaluationRuntimeHost, runId: string) {
  const run = await host.get(runId);
  return { run, mode: host.mode, budget: await host.budget.reader.snapshot(run.budgetScopeKey),
    ledger: (await host.budget.reader.eventsAfter(0)).filter(event => event.scopeKey === run.budgetScopeKey),
    roles: host.store.listComponentState(runId, 'role-calls'), approvals: host.service.approvals.list(runId),
    attempts: host.store.listAttempts(runId), steps: host.store.listSteps(runId),
    toolCalls: host.store.listComponentState(runId, 'tool-calls'), toolPolicy: host.store.getComponentState(runId, 'tool-policy', 'state'),
    events: host.store.eventsAfter(runId), sandbox: host.store.getSandbox(runId) ?? null,
    runtimeIdentity: host.store.getComponentState(runId, 'runtime', 'identity') };
}
type Evidence = Awaited<ReturnType<typeof capture>>;
function accounting(value: Evidence, calls: number) {
  const reserves = value.ledger.filter(event => event.type === 'reserve');
  const settles = value.ledger.filter(event => event.type === 'settle');
  assert.equal(reserves.length, calls); assert.equal(settles.length, calls);
  assert.equal(new Set(reserves.map(event => event.payload.reservationId)).size, calls);
  let sum = 0;
  for (const reserve of reserves) {
    const related = value.ledger.filter(event => event.payload.reservationId === reserve.payload.reservationId);
    assert.deepEqual(related.map(event => event.type), ['reserve', 'dispatch', 'settle']);
    sum += Object.values(normalizeUsage(related[2]!.payload.usage as Parameters<typeof normalizeUsage>[0])).reduce((a, b) => a + b, 0);
  }
  assert.equal(value.budget.usedTokens, sum); assert.equal(value.budget.reservedTokens, 0);
  assert.equal(value.budget.unknownCalls, 0); assert(value.budget.meteringComplete);
}
async function serve(host: EvaluationRuntimeHost, token: string) {
  const server = createRuntimeServer(host.service, { token, control: { decideApproval: host.decideApproval } });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); done(); }); });
  const address = server.address(); assert(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function closeServer(server: Server | undefined) {
  if (!server) return; server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
}
async function run(directory: string, timeoutMs: number, injectFault = false) {
  mkdirSync(directory, { recursive: false });
  const startedAt = Date.now(); const runId = `n04-real-${randomUUID()}`;
  const runtime = JSON.parse(readFileSync('config/example.json', 'utf8')) as Record<string, unknown>;
  runtime.sandbox = { ...(runtime.sandbox as object), ttlSeconds: Math.ceil(timeoutMs / 1000), commandTimeoutMs: 15000, maxOutputFiles: 2, maxOutputBytes: 131072, maxLogBytes: 65536 };
  const runtimePath = join(directory, 'runtime.json');
  const configPath = join(directory, 'application.json');
  const config: ApplicationConfig = { schemaVersion: 1, runtimeConfigPath: runtimePath, dataDir: join(directory, 'application'),
    model: { provider: 'deepseek', name: model, apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', maxOutputTokens: 4096 },
    budget: { maxTokens: 30000, finalizeTokens: 2000 },
    sandbox: { domain, apiKeyEnv: 'OPEN_SANDBOX_API_KEY', useServerProxy: true },
    workflow: { mode: 'serial', maxRepairs: 0, approval: { reason: 'Fixed N04 ranking acceptance: one immutable Python execution', ttlMs: 120000 },
      retry: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 500 },
      context: { modelWindowTokens: 32768, safetyReserveTokens: 512 }, reference: { key: 'ranking' } } };
  const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  save('runtime.json', runtime); save('application.json', config);
  writeFileSync(join(directory, 'input.csv'), input, { flag: 'wx' });
  save('manifest.json', { schemaVersion: 1, startedAt, runId, task, inputSha256, model,
    bounds: { timeoutMs, maxRoleCalls: 3, maxReportCalls: 1, maxRepairs: 0, summaries: false, maxTokens: 30000, finalizeTokens: 2000, outputCap: 4096, maxSandboxCreationAttempts: 2, commandTimeoutMs: 15000 },
    approval: 'Test-owned authenticated HTTP approval for this fixed authorized task, after normal host close/reopen; no human browser action claimed',
    mode: { productionApplicationHost: true, injectedProvider: false, injectedSandbox: injectFault },
    fault: injectFault ? 'One status query uses a deliberately disconnected local endpoint; the real service itself is not stopped' : null });
  const report: Record<string, unknown> = { schemaVersion: 1, runId, startedAt, passed: false, checks: [],
    limitations: ['One synthetic fixture and one real run; no quality/generalization/acceleration claim',
      'Normal host close/reopen in the same Node process, no forced process termination in this probe',
      injectFault ? 'Test-only connection fault; no outage of the actual service or provider, no usage reconciliation or currency verification' : 'No induced provider/network fault or usage reconciliation, no currency/invoice verification',
      'MCP is a fixed read-only context prefetch, not a free-form model-selected tool loop'] };
  const checks = report.checks as string[]; let host: EvaluationRuntimeHost | undefined; let server: Server | undefined;
  let fault: Awaited<ReturnType<typeof disconnectedStatusOnce>> | undefined;
  const boot = () => startApplication({ configPath, listen: false, installSignalHandlers: false, validate, ...(fault ? { sandbox: fault.sandbox } : {}) });
  try {
    await preflight();
    if (injectFault) fault = await disconnectedStatusOnce(domain, credential('OPEN_SANDBOX_API_KEY'));
    host = await boot();
    assert.equal(host.mode.injectedProvider, false); assert.equal(host.mode.injectedSandbox, injectFault);
    await host.submit({ runId, task, inputs: [{ path: 'input.csv', content: input }] });
    const initial = host.store.getRun(runId);
    console.log(JSON.stringify({ phase: 'roles-before-approval', runId, deadline: initial.deadline }));
    const paused = await host.wait(runId, { timeoutMs: Math.max(1, initial.deadline - Date.now()) });
    const before = await capture(host, runId); save('before-reopen.json', before);
    assert.equal(paused.status, 'PAUSED_APPROVAL'); accounting(before, 2);
    assert.equal(before.attempts.length, 0); assert.equal(before.approvals.length, 1);
    assert.equal(before.events.filter(event => event.type === 'tool.completed' && (event.payload as { toolName?: unknown }).toolName === 'mcp.lookup_rule').length, 1);
    const executor = host.store.getComponentState<{ value: { code: string } }>(runId, 'role-calls', 'executor-0');
    assert(executor?.value.code); writeFileSync(join(directory, 'approved-code.py'), executor.value.code, { flag: 'wx' });
    checks.push('Real Planner/Executor and read-only MCP settle in original scope before any Python execution');
    await host.close(); host = undefined; host = await boot();
    await host.wait(runId, { timeoutMs: 2000 });
    const reopened = await capture(host, runId); save('after-reopen.json', reopened);
    assert.equal(reopened.run.status, 'PAUSED_APPROVAL');
    for (const key of ['ledger', 'roles', 'approvals', 'attempts', 'toolCalls', 'toolPolicy'] as const) assert.deepEqual(reopened[key], before[key]);
    assert.equal(reopened.run.budgetScopeKey, initial.budgetScopeKey); assert.equal(reopened.run.deadline, initial.deadline);
    assert.equal(reopened.run.inputHash, initial.inputHash); checks.push('Normal production-host close/reopen preserves pending approval, scope, deadline, cached roles and MCP without replay');
    const token = randomBytes(32).toString('hex'); const api = await serve(host, token); server = api.server;
    const approval = reopened.approvals[0]!; const decisionId = 'n04-fixed-task-approve';
    const decide = (approved: boolean) => fetch(`${api.url}/runs/${runId}/approvals/${approval.approvalId}`, { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ decisionId, approved }), signal: AbortSignal.timeout(10000) });
    const accepted = await decide(true); assert.equal(accepted.status, 200); await accepted.body?.cancel();
    console.log(JSON.stringify({ phase: 'approved-real-sandbox', runId }));
    let completed = await waitAfterApproval(host, runId, approval.approvalId, initial.deadline);
    if (fault) {
      completed = await waitForControllerIdle(host, runId, initial.deadline);
      const interrupted = await capture(host, runId); save('interrupted-evidence.json', interrupted);
      assert.equal(completed.status, 'RECOVERY_REQUIRED'); assert.equal(completed.host.recoveryRequired, true);
      assert.equal(fault.observations.injected, 1); assert(fault.observations.disconnectedConnections > 0);
      assert.equal(fault.observations.state, 'UNKNOWN');
      assert.equal(interrupted.attempts.length, 1); assert.equal(interrupted.attempts[0]?.status, 'UNKNOWN');
      assert(interrupted.attempts[0]?.executionId); assert.equal(interrupted.approvals[0]?.status, 'consumed');
      accounting(interrupted, 2);
      let recovered = completed;
      do {
        recovered = await host.reconcile(runId);
        if (host.store.listAttempts(runId).some(attempt => attempt.status === 'UNKNOWN')) await delay(250);
      } while (host.store.listAttempts(runId).some(attempt => attempt.status === 'UNKNOWN') && Date.now() < initial.deadline);
      const reconciled = await capture(host, runId); save('reconciled-evidence.json', reconciled);
      assert.equal(reconciled.attempts.length, 1); assert.equal(reconciled.attempts[0]?.status, 'SUCCEEDED');
      assert.equal(reconciled.attempts[0]?.executionId, interrupted.attempts[0]?.executionId);
      assert.deepEqual(reconciled.ledger, interrupted.ledger);
      await host.resume(runId, 'n04-resume-after-status-fault', recovered.revision);
      completed = await host.wait(runId, { timeoutMs: Math.max(1, initial.deadline - Date.now()) });
      report.injectedFault = fault.observations;
      checks.push('One real SDK status request failed against a test-only disconnected endpoint; the original remote execution was reconciled without redispatch');
    }
    const final = await capture(host, runId); save('final-evidence.json', final); report.finalStatus = completed.status;
    assert.equal(completed.status, 'SUCCEEDED'); accounting(final, 4);
    assert.equal(final.run.budgetScopeKey, initial.budgetScopeKey); assert.equal(final.run.deadline, initial.deadline);
    const reserves = final.ledger.filter(event => event.type === 'reserve');
    assert.deepEqual(reserves.map(event => (event.payload.request as { purpose: string }).purpose), ['work', 'work', 'work', 'finalize']);
    const roles = final.events.filter(event => event.type === 'workflow.role_completed').map(event => event.payload as { role: string; modelCallId: string; receiptId: string });
    assert.deepEqual(roles.map(role => role.role), ['planner', 'executor', 'reviewer']);
    for (const role of roles) assert(reserves.some(event => (event.payload.request as { modelCallId: string }).modelCallId === role.modelCallId));
    const files = new Map<string, Uint8Array>(); const downloads = [];
    mkdirSync(join(directory, 'downloads'));
    for (const artifact of completed.artifacts) {
      assert(['ranking.json', 'report.md'].includes(artifact.path));
      const response = await fetch(`${api.url}/runs/${runId}/artifacts/${artifact.artifactId}`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256); assert.equal(bytes.length, artifact.size);
      writeFileSync(join(directory, 'downloads', artifact.path), bytes, { flag: 'wx' }); files.set(artifact.path, bytes); downloads.push(artifact);
    }
    const validation = verifyDelivery(files); save('independent-validation.json', validation); assert(validation.passed);
    const duplicate = await decide(true); assert.equal(duplicate.status, 200); await duplicate.body?.cancel();
    const conflict = await decide(false); assert.equal(conflict.status, 409); await conflict.body?.cancel();
    await delay(250); const replay = await capture(host, runId);
    assert.deepEqual(replay.ledger, final.ledger); assert.deepEqual(replay.attempts, final.attempts);
    assert.equal(final.events.filter(event => event.type === 'approval.consumed').length, 1);
    assert.equal(final.events.filter(event => event.type === 'tool.completed' && (event.payload as { toolName?: unknown }).toolName === 'mcp.lookup_rule').length, 1);
    assert.equal(final.approvals[0]?.status, 'consumed');
    assert.equal(final.attempts.filter(attempt => attempt.executionId).length, 1); assert.equal(final.sandbox, null);
    const sandboxId = final.attempts.find(attempt => attempt.sandboxId)?.sandboxId; assert(sandboxId);
    const remote = await fetch(`${domain}/sandboxes/${encodeURIComponent(sandboxId)}`, { headers: { 'OPEN-SANDBOX-API-KEY': credential('OPEN_SANDBOX_API_KEY') }, signal: AbortSignal.timeout(10000) });
    report.cleanup = { sandboxId, status: remote.status, localReleased: final.sandbox === null }; await remote.body?.cancel(); assert.equal(remote.status, 404);
    checks.push('One authenticated approval and one real Python execution; duplicate idempotent, conflicting decision rejected',
      'Real Reviewer plus optional report each settle once, sharing the original work/finalize allocations',
      'Two exact HTTP artifact downloads match independent semantic validation and committed hashes',
      'Sandbox locally released and authenticated remote GET confirms 404');
    report.budget = final.budget; report.downloads = downloads; report.passed = true;
  } catch (error) {
    report.error = safeError(error); process.exitCode = 2;
    if (host?.store.findRun(runId)) {
      try { save('failure-evidence.json', await capture(host, runId)); } catch (captureError) { report.captureError = safeError(captureError); }
      try {
        if (!TERMINAL_RUN_STATES.has(host.store.getRun(runId).status)) await host.cancel(runId, 'n04-bounded-cleanup', 'Bounded acceptance probe stopped; failure retained');
        report.failureCleanup = { run: await host.get(runId), activeSandbox: host.store.getSandbox(runId) ?? null };
      } catch (cleanupError) { report.cleanupError = safeError(cleanupError); }
    }
  } finally {
    await closeServer(server); await host?.close(); await fault?.close(); report.finishedAt = Date.now(); report.elapsedMs = Date.now() - startedAt;
    save('n04-report.json', report);
    console.log(JSON.stringify({ passed: report.passed, runId, report: join(directory, 'n04-report.json'), status: report.finalStatus, error: report.error, elapsedMs: report.elapsedMs }));
  }
}
try {
  const [mode, directory, duration] = process.argv.slice(2);
  if (mode === '--check-only') { await preflight(); console.log('N04 read-only preflight passed; no inference or sandbox creation.'); }
  else if ((mode === '--run' || mode === '--fault-run') && directory && Number.isSafeInteger(Number(duration)) && Number(duration) >= 120000 && Number(duration) <= 600000) await run(resolve(directory), Number(duration), mode === '--fault-run');
  else throw new Error('Usage: --check-only or --run/--fault-run <new directory> <timeout 120000..600000 ms>');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
