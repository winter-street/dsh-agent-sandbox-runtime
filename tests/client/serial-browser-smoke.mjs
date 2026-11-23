import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recoverWriterLock } from '../../.sources/budget/scripts/recover-writer-lock.mjs';

const modulePath = process.env.RUNTIME_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright-core');
const output = resolve(process.env.RUNTIME_BROWSER_EVIDENCE_DIR || join('.runtime', `n04-serial-browser-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
await mkdir(output, { recursive: true });
const token = randomBytes(32).toString('hex');
let backend, browser, ready, commandSeq = 0;
const diagnostics = [], errors = [], evidence = {}, checks = [], processes = [];
const record = async (name, runId) => {
  const id = ++commandSeq;
  const result = await new Promise((accept, reject) => {
    const timer = setTimeout(() => { backend.off('message', listener); reject(new Error('Evidence read timed out')); }, 10000);
    const listener = result => { if (result.id !== id) return; clearTimeout(timer); backend.off('message', listener); result.error ? reject(new Error(result.error)) : accept(result); };
    backend.on('message', listener); backend.send({ id, command: 'evidence', runId });
  });
  delete result.id; evidence[name] = result; return result;
};
const start = async port => {
  backend = spawn(process.execPath, ['--import', 'tsx', 'tests/client/serial-browser-server.ts', output, String(port)], {
    cwd: resolve('.'), env: { ...process.env, RUNTIME_SERIAL_BROWSER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  backend.stderr.on('data', data => diagnostics.push(data.toString()));
  backend.stdout.on('data', data => diagnostics.push(data.toString()));
  const info = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`Backend startup timed out: ${diagnostics.join('')}`)), 20000);
    backend.on('message', message => { if (message.ready) { clearTimeout(timer); accept(message); } });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited ${code}: ${diagnostics.join('')}`)); });
  });
  processes.push(info.pid); return info;
};
const stop = async force => {
  const child = backend; if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Backend did not exit within shutdown bound')); }, 15000);
    child.once('exit', () => { clearTimeout(timer); accept(); });
    if (force) child.kill('SIGKILL'); else if (child.connected) child.disconnect(); else child.kill();
  });
};
const assertAccounting = (result, calls, executions) => {
  assert.equal(result.audit.filter(entry => entry.kind === 'provider').length, calls);
  assert.equal(result.audit.filter(entry => entry.kind === 'sandbox' && entry.method === 'execute').length, executions);
  assert.equal(result.ledger.filter(entry => entry.type === 'reserve').length, calls);
  assert.equal(result.ledger.filter(entry => entry.type === 'settle').length, calls);
  assert.equal(result.budget.usedTokens, calls * 30); assert.equal(result.budget.reservedTokens, 0); assert.equal(result.budget.unknownCalls, 0);
  assert.equal(result.counts.mcp, 1);
};
try {
  ready = await start(0);
  browser = await chromium.launch({ headless: true, ...(process.env.RUNTIME_BROWSER_EXECUTABLE ? { executablePath: process.env.RUNTIME_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const waitText = async (id, text) => {
    await page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), { id, text }, { timeout: 15000 });
    if (id === 'status') {
      const task = await page.locator('#task-title').textContent();
      const summary = await page.locator('#runs button').filter({ hasText: task.slice(0, 40) }).textContent();
      assert.equal(summary.startsWith(text), true, `Task list must agree with detail: ${summary}`);
    }
  };
  const login = async () => { await page.locator('#token').fill(token); await page.locator('#login-form button').click(); await page.locator('#workspace').waitFor({ state: 'visible' }); };
  const create = async task => {
    await page.locator('#task').fill(task); await page.locator('#create-form button').click(); await waitText('task-title', task); await waitText('status', '等待确认');
    return page.locator('#run-id').textContent();
  };
  const shot = name => page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  const approve = () => page.locator('#approvals button').filter({ hasText: '批准一次' }).click();
  const cancel = async runId => {
    // SSE may publish CANCELLED before the HTTP command finishes sandbox cleanup.
    const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === `/runs/${runId}/cancel`);
    await page.locator('#cancel').click();
    assert.equal((await response).status(), 200);
    await waitText('status', '已取消');
  };
  await page.goto(ready.url); await login();
  const first = await create('N04 browser: approve and verify result.json');
  assertAccounting(await record('beforeApproval', first), 2, 0); await shot('approval-pending');
  await approve(); await waitText('status', '已完成并验证');
  const normal = await record('approved', first); assertAccounting(normal, 3, 1); assert.equal(normal.counts.consumed, 1);
  assert.equal(await page.locator('#approvals button').count(), 0);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#artifacts button').first().click(); const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'result.json'); assert.equal(await readFile(await download.path(), 'utf8'), '{"verified":true}');
  const approval = normal.approvals[0];
  const duplicate = await context.request.post(`${ready.url}/runs/${first}/approvals/${approval.approvalId}`, { headers: { Authorization: `Bearer ${token}` }, data: { decisionId: approval.decisionId, approved: true } });
  assert.equal(duplicate.status(), 200);
  const conflict = await context.request.post(`${ready.url}/runs/${first}/approvals/${approval.approvalId}`, { headers: { Authorization: `Bearer ${token}` }, data: { decisionId: approval.decisionId, approved: false } });
  assert.equal(conflict.status(), 409); assertAccounting(await record('duplicateApproval', first), 3, 1);
  await shot('approval-succeeded'); checks.push('browser approval automatically completes with exact artifact', 'idempotent approval and conflicting duplicate');

  const rejected = await create('N04 browser: reject then cancel');
  await page.locator('#approvals button').filter({ hasText: '拒绝' }).click(); await waitText('approvals', 'rejected');
  const rejectedResult = await record('rejected', rejected); assertAccounting(rejectedResult, 2, 0); assert.equal(rejectedResult.approvals[0].status, 'rejected');
  await shot('approval-rejected'); await cancel(rejected);
  assertAccounting(await record('rejectedCancelled', rejected), 2, 0); checks.push('browser rejection prevents execution and allows cancellation');

  const restarted = await create('N04 browser: restart while approval is pending');
  const before = await record('beforeProcessKill', restarted); assertAccounting(before, 2, 0);
  const killedPid = ready.pid; await stop(true);
  evidence.budgetLockRecovery = recoverWriterLock(join(output, 'application', 'budget'), killedPid);
  ready = await start(ready.port);
  const after = await record('afterProcessRestart', restarted); assertAccounting(after, 2, 0);
  assert.equal(after.run.status, 'PAUSED_APPROVAL'); assert.equal(after.run.budgetScopeKey, before.run.budgetScopeKey);
  assert.equal(after.run.deadline, before.run.deadline); assert.deepEqual(after.approvals, before.approvals); assert.deepEqual(after.ledger, before.ledger);
  await page.reload(); await login(); await page.locator('#runs button').filter({ hasText: 'restart while approval' }).click();
  await waitText('run-id', restarted); await waitText('status', '等待确认'); await approve(); await waitText('status', '已完成并验证');
  const resumed = await record('restartedSucceeded', restarted); assertAccounting(resumed, 3, 1); assert.equal(resumed.counts.consumed, 1);
  await shot('process-restart-succeeded'); checks.push('forced backend process termination and pending approval recovery without role or MCP replay');

  const cancelled = await create('N04 browser: cancel-running approved sandbox'); await approve(); await waitText('status', '执行中');
  await page.waitForFunction(() => document.getElementById('steps')?.textContent.includes('RUNNING'), undefined, { timeout: 10000 });
  await cancel(cancelled);
  const cancelledResult = await record('runningCancelled', cancelled); assertAccounting(cancelledResult, 2, 1);
  assert.equal(cancelledResult.audit.some(entry => entry.method === 'cancel' && entry.confirmed === true), true);
  assert.equal(cancelledResult.audit.some(entry => entry.method === 'destroy'), true); assert.equal(cancelledResult.run.artifacts.length, 0);
  await shot('running-cancelled'); checks.push('browser cancellation confirms sandbox stop and skips Reviewer');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await create('N04 browser: mobile approval'); await shot('mobile-pending');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#approvals button').filter({ hasText: '拒绝' }).click(); await waitText('approvals', 'rejected');
  await cancel(mobile); assertAccounting(await record('mobileCancelled', mobile), 2, 0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(await page.locator('#error').isVisible(), false); assert.deepEqual(errors, []); checks.push('mobile approval controls and no horizontal overflow', 'in-memory authentication and zero page errors');
  const result = { passed: true, checkedAt: new Date().toISOString(), browser: await browser.version(),
    productionApplicationHost: true, actualHarness: true, originalBudgetPlugin: true, actualMcpSubprocess: true, actualHttpSse: true, actualSqlite: true,
    actualExternalModel: false, actualSandbox: false, usage: 'synthetic; 20 input + 10 output per role',
    backendProcessTermination: 'SIGKILL/forced process termination while awaiting approval; explicit checked dead-writer lock recovery before restart', backendPids: processes,
    viewports: [{ width: 1440, height: 1100 }, { width: 390, height: 844 }], screenshots: 6, checks, evidence };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, output, checks, backendPids: processes, pageErrors: errors.length }));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ checkedAt: new Date().toISOString(), message: String(error), diagnostics, evidence, checks }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close(); await stop(false);
}
