import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Reuse an installed browser runtime; the repository does not require Playwright.
const modulePath = process.env.RUNTIME_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright-core');
const output = resolve(process.env.RUNTIME_BROWSER_EVIDENCE_DIR || 'test-results/browser-smoke');
await mkdir(output, { recursive: true });
const backend = spawn(process.execPath, ['--import', 'tsx', 'tests/client/browser-server.ts'], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
let ready, browser; const diagnostics = []; const errors = []; let commandSeq = 0;
backend.stderr.on('data', value => diagnostics.push(value.toString()));
const command = (command, runId, extra = {}) => new Promise((accept, reject) => {
  const id = ++commandSeq; const timer = setTimeout(() => { backend.off('message', listener); reject(new Error(`Fixture command timed out: ${command}`)); }, 10000);
  const listener = result => { if (result.id !== id) return; clearTimeout(timer); backend.off('message', listener); result.error ? reject(new Error(result.error)) : accept(result); };
  backend.on('message', listener); backend.send({ id, command, runId, ...extra });
});
try {
  ready = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${diagnostics.join('')}`)), 15000);
    backend.on('message', value => { if (value.ready) { clearTimeout(timer); accept(value); } });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${diagnostics.join('')}`)); });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.RUNTIME_BROWSER_EXECUTABLE ? { executablePath: process.env.RUNTIME_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const waitText = (id, text) => page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), { id, text }, { timeout: 10000 });
  const login = async () => { await page.locator('#token').fill(ready.token); await page.locator('#login-form button').click(); await page.locator('#workspace').waitFor({ state: 'visible' }); };
  const create = async text => { await page.locator('#task').fill(text); await page.locator('#create-form button').click(); await waitText('task-title', text); await page.locator('#detail').waitFor({ state: 'visible' }); return page.locator('#run-id').textContent(); };
  const shot = name => page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  await page.goto(ready.url); await login();
  const first = await create('浏览器验收：按告警数降序输出 CSV'); await waitText('status', '预算暂停');
  await waitText('policy-reasons', 'BUDGET_PRESSURE'); await waitText('policy-mode', '观察模式');
  await waitText('policy-reasons', '预算使用达到策略阈值');
  assert.doesNotMatch(await page.locator('#policy-reasons').textContent(), /undefined/);
  assert.equal(await page.locator('#used').textContent(), '7,000');
  await shot('P3-03-paused');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#artifacts button').first().click(); const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'ranking.csv'); assert.equal(await readFile(await download.path(), 'utf8'), 'charger_id,alert_count\nC7,3\nC2,1\n');
  await page.locator('#resume').click(); await waitText('status', '执行中');
  await context.setOffline(true); await command('event', first); await context.setOffline(false); await waitText('events', 'browser.disconnected-update');
  const snapshot = await page.evaluate(async ({ token, first }) => (await fetch(`/runs/${first}`, { headers: { Authorization: `Bearer ${token}` } })).json(), { token: ready.token, first });
  assert.equal(snapshot.status, 'RUNNING'); assert.equal(snapshot.budget.usedTokens, 7000);
  await page.reload(); await page.locator('#login').waitFor({ state: 'visible' }); await login(); await waitText('run-id', first); await waitText('status', '执行中');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const second = await create('部分交付验收'); await page.locator('#resume').click(); await waitText('status', '执行中');
  await command('finalize', second, { complete: false }); await waitText('status', '部分交付'); await shot('P3-03-partial');
  const third = await create('完整交付验收'); await page.locator('#resume').click(); await waitText('status', '执行中');
  await command('finalize', third, { complete: true }); await waitText('status', '已完成并验证');
  await page.locator('#refresh').click(); await waitText('runs', '已完成并验证');
  assert.equal(await page.locator('#error').isVisible(), false); await shot('P3-03-succeeded');
  await page.locator('#runs button').filter({ hasText: '浏览器验收' }).click(); await waitText('run-id', first);
  await page.locator('#cancel').click(); await waitText('status', '已取消'); await shot('P3-03-cancelled');
  const fourth = await create('审批验收'); await waitText('status', '等待确认');
  await page.locator('#approvals button').filter({ hasText: '批准一次' }).click(); await waitText('approvals', 'approved');
  await command('consume', fourth); await waitText('status', '执行中');
  // A delayed old snapshot must not replace the newly selected task.
  let release; const gate = new Promise(accept => { release = accept; }); let intercepted;
  const seen = new Promise(accept => { intercepted = accept; });
  await page.route(`**/runs/${first}`, async route => { intercepted(); await gate; await route.continue(); });
  await page.locator('#runs button').filter({ hasText: '浏览器验收' }).click(); await seen;
  await page.locator('#runs button').filter({ hasText: '完整交付验收' }).click(); await waitText('run-id', third);
  release(); await page.waitForTimeout(200); assert.equal(await page.locator('#run-id').textContent(), third); await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 390, height: 844 }); await shot('P3-03-mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const result = { date: new Date().toISOString(), browser: await browser.version(), actualHttp: true, actualSqlite: true, actualArtifactDownload: true,
    actualModel: false, actualSandbox: false, processRestart: false, checks: ['create', 'view', 'budget and policy reasons', 'download exact CSV', 'resume', 'offline SSE replay', 'reload and reauthenticate', 'partial', 'succeeded', 'refresh list and selection', 'cancel', 'approval', 'stale selection response', 'mobile overflow'], screenshots: 5 };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally {
  await browser?.close(); if (backend.connected) backend.disconnect();
  await new Promise(accept => { if (backend.exitCode !== null) accept(); else { const timer = setTimeout(() => { backend.kill(); accept(); }, 5000); backend.once('exit', () => { clearTimeout(timer); accept(); }); } });
  if (ready?.root && dirname(ready.root) === tmpdir() && basename(ready.root).startsWith('runtime-browser-')) await rm(ready.root, { recursive: true, force: true });
}
