/** Browser fixture: real API/database/artifact service, controlled budget and sandbox. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { createRuntimeServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { FakeBudget, FakeSandbox } from '../support/fakes.js';
const root = mkdtempSync(join(tmpdir(), 'runtime-browser-'));
const store = new RuntimeStore(join(root, 'db'));
const sandbox = new FakeSandbox(); const budget = new FakeBudget({ scopeKey: 'browser-scope', sessionIds: ['browser-session'] });
const allocation = budget.reserve({ sessionId: 'browser-session', scopeKey: 'browser-scope', modelCallId: 'fixture-usage', provider: 'controlled', model: 'controlled', purpose: 'work', estimatedTokens: 7000 });
if (!allocation.allowed) throw new Error('Fixture allocation failed');
budget.markDispatched(allocation.reservation.reservationId); budget.settle(allocation.reservation.reservationId, { inputTokens: 6000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
const service = new RuntimeService(store, new ArtifactStore(join(root, 'artifacts')), sandbox, budget, loadConfig('config/example.json'), {
  validate: async (_run, artifacts) => ({ passed: artifacts.length > 0, evidence: { kind: 'browser-fixture', actualModel: false, actualSandbox: false } }),
});
const token = randomBytes(32).toString('hex'); let sequence = 0;
const server = createRuntimeServer(service, { token, client: true, eventPollMs: 30, createTask: async task => {
  const runId = `browser-run-${++sequence}`;
  await service.createRun({ runId, rootSessionId: 'browser-session', budgetScopeKey: 'browser-scope', task, deadline: Date.now() + 600000,
    policyVersion: 'budget-policy-v1', inputHash: createHash('sha256').update(task).digest('hex') });
  sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { stdout: 'CSV fixture verified', outputs: [{ path: 'ranking.csv', content: Buffer.from('charger_id,alert_count\nC7,3\nC2,1\n') }] } });
  await service.executeCode({ runId, stepId: `export-${sequence}`, code: '# controlled browser fixture; never executes on host', inputs: [] });
  if (task.includes('审批')) await service.requestApproval({ runId, approvalId: `approval-${sequence}`, toolCallId: `approval-call-${sequence}`, args: { action: 'publish' }, reason: '发布产物需要用户批准', ttlMs: 300000 });
  else { store.transitionRun(runId, 'PAUSED_BUDGET', undefined, 'Browser fixture paused at a safe boundary'); store.saveCheckpoint(runId); }
  return service.getRun(runId);
} });
server.listen(0, '127.0.0.1', () => {
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No browser fixture port');
  process.send?.({ ready: true, url: `http://127.0.0.1:${address.port}`, token, root });
});
process.on('message', async (raw: { id: number; command: string; runId: string; complete?: boolean }) => {
  try {
    if (raw.command === 'event') store.appendEvent(raw.runId, 'browser.disconnected-update', { message: '离线期间持久化的新事件' });
    else if (raw.command === 'finalize') await service.finalize(raw.runId, raw.complete ?? false);
    else if (raw.command === 'consume') await service.consumeApproval(raw.runId, service.approvals.list(raw.runId)[0]!.approvalId, { action: 'publish' });
    process.send?.({ id: raw.id, ok: true });
  } catch (error) { process.send?.({ id: raw.id, error: error instanceof Error ? error.message : String(error) }); }
});
process.once('disconnect', () => { server.closeAllConnections(); server.close(() => { store.close(); process.exit(); }); });
