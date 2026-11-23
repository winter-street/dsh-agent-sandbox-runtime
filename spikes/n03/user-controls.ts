import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { SandboxApiException, SandboxManager } from '@alibaba-group/opensandbox';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createRuntimeServer } from '../../src/api/server.js';
import { startApplication, type ApplicationConfig } from '../../src/app/index.js';

const sandboxKey = process.env.OPEN_SANDBOX_API_KEY;
assert(sandboxKey, 'Set OPEN_SANDBOX_API_KEY for the local service');
const browserModule = process.env.RUNTIME_PLAYWRIGHT_MODULE;
const executablePath = process.env.RUNTIME_BROWSER_EXECUTABLE;
assert(browserModule && executablePath, 'Set RUNTIME_PLAYWRIGHT_MODULE and RUNTIME_BROWSER_EXECUTABLE');
const { chromium } = await import(pathToFileURL(resolve(browserModule)).href);
const id = randomUUID();
const runId = 'n03-user-controls-' + id;
const output = resolve('.runtime', runId);
const token = randomUUID();
const task = 'N03 user controls: checkpoint the input before preparing a second artifact.';
const contents = Buffer.from('id\n42\n');
const sandboxConfig = (JSON.parse(await readFile('config/eval-hard.json', 'utf8')) as ApplicationConfig).sandbox;
const config: ApplicationConfig = {
  schemaVersion: 1, runtimeConfigPath: resolve('config/runtime-hard.json'), dataDir: output,
  model: { provider: 'controlled', name: 'n03-control-fixture', apiKeyEnv: 'N03_CONTROLLED_KEY' },
  budget: { maxTokens: 50000, finalizeTokens: 0 }, sandbox: sandboxConfig,
};
await mkdir(output);
const configPath = join(output, 'application.json');
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

const firstCode = [
  'import os, time', 'from pathlib import Path', 'time.sleep(7)',
  'source = Path(os.environ["AGENT_INPUT_DIR"]) / "input.csv"',
  '(Path(os.environ["AGENT_OUTPUT_DIR"]) / "checkpoint.txt").write_bytes(source.read_bytes())',
].join('\n');
class ScriptedProvider extends LlmAdapter {
  calls = 0;
  constructor(private readonly stage: 1 | 2) { super(); }
  override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    assert.equal(++this.calls, 1, 'Each host may dispatch only one model request');
    const messages = JSON.stringify(request.messages);
    assert(messages.includes(task));
    if (this.stage === 2) assert(messages.includes('Continue from the persisted checkpoint.'));
    const code = this.stage === 1 ? firstCode : 'import time\ntime.sleep(25)';
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ('control-' + this.stage) as never, name: 'runtime_python', arguments: JSON.stringify({ code }) } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
async function openHost(provider: ScriptedProvider, port = 0) {
  const host = await startApplication({ configPath, provider, listen: false, installSignalHandlers: false,
    env: { ...process.env, N03_CONTROLLED_KEY: 'local-fixture' }, validate: async () => ({ passed: false, evidence: { fixture: 'intentionally incomplete' } }) });
  const server = createRuntimeServer(host.service, { token, client: true, eventPollMs: 50,
    createTask: async request => { await host.submit({ runId, task: request, inputs: [{ path: 'input.csv', content: contents }] }); return host.get(runId); },
    control: { pause: host.pause, resume: host.resume, cancel: host.cancel } });
  try { await new Promise<void>((done, reject) => server.once('error', reject).listen(port, '127.0.0.1', done)); }
  catch (error) { await host.close(); throw error; }
  const address = server.address();
  assert(address && typeof address === 'object');
  return { host, port: address.port, async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await host.close(); } };
}
async function waitFor<T>(name: string, observe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 35_000;
  while (Date.now() < until) { const value = await observe(); if (value !== undefined) return value; await sleep(100); }
  throw new Error('Timed out waiting for ' + name);
}
const manager = SandboxManager.create({ connectionConfig: { domain: sandboxConfig.domain, apiKey: sandboxKey } });
const absent = (sandboxId: string) => assert.rejects(manager.getSandboxInfo(sandboxId), error => error instanceof SandboxApiException && error.statusCode === 404);
const first = new ScriptedProvider(1);
const second = new ScriptedProvider(2);
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const browserErrors: string[] = [];
page.on('pageerror', (error: Error) => browserErrors.push(error.message));
const status = (text: string) => page.locator('#status').filter({ hasText: new RegExp('^' + text + '$') }).waitFor({ timeout: 20_000 });
async function login(port: number) {
  await page.goto('http://127.0.0.1:' + port);
  await page.locator('#token').fill(token);
  await page.locator('#login-form button').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
}
let server: Awaited<ReturnType<typeof openHost>> | undefined;
try {
  server = await openHost(first);
  const port = server.port;
  await login(port);
  await page.locator('#task').fill(task);
  await page.locator('#create-form button').click();
  const pauseAttempt = await waitFor('first execution', () => server!.host.store.listRuns().length
    ? server!.host.store.listAttempts(runId).find(attempt => attempt.status === 'RUNNING') : undefined);
  assert(pauseAttempt.sandboxId);
  await page.locator('#pause').click();
  await status('用户已暂停');
  const paused = await server.host.get(runId);
  assert.equal(paused.status, 'PAUSED_USER');
  assert.equal(paused.host.active, false);
  assert.equal(server.host.store.getAttempt(pauseAttempt.attemptId).status, 'SUCCEEDED');
  assert.equal(server.host.store.getSandbox(runId), undefined);
  await absent(pauseAttempt.sandboxId);
  assert.equal(paused.artifacts.length, 1);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#artifacts button').click()]);
  assert.equal(download.suggestedFilename(), 'checkpoint.txt');
  const bytes = await readFile(await download.path());
  assert.deepEqual(bytes, contents);
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(artifactSha256, paused.artifacts[0]?.sha256);
  await page.screenshot({ path: join(output, 'paused.png'), fullPage: true });
  await server.close(); server = undefined;
  server = await openHost(second, port);
  await login(port);
  await status('用户已暂停');
  await page.locator('#resume').click();
  await status('执行中');
  const cancelAttempt = await waitFor('resumed execution', () => server!.host.store.listAttempts(runId).find(attempt => attempt.status === 'RUNNING'));
  assert(cancelAttempt.sandboxId && cancelAttempt.sandboxId !== pauseAttempt.sandboxId);
  await page.locator('#cancel').click();
  await status('已取消');
  await waitFor('confirmed sandbox cleanup', () => server!.host.store.getSandbox(runId) ? undefined : true);
  await absent(cancelAttempt.sandboxId);
  const cancelled = await server.host.get(runId);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(server.host.store.listAttempts(runId).length, 2);
  assert.equal(server.host.store.getAttempt(cancelAttempt.attemptId).status, 'CANCELLED');
  assert.equal(cancelled.deadline, paused.deadline);
  assert.equal(cancelled.rootSessionId, paused.rootSessionId);
  assert.equal(cancelled.budgetScopeKey, paused.budgetScopeKey);
  const budget = await server.host.budget.reader.snapshot(cancelled.budgetScopeKey);
  assert.equal(budget.usedTokens, 30); assert.equal(budget.reservedTokens, 0); assert.equal(budget.unknownCalls, 0);
  assert.equal(first.calls + second.calls, 2);
  assert.deepEqual(browserErrors, []);
  await page.screenshot({ path: join(output, 'cancelled.png'), fullPage: true });
  const lifecycle = server.host.store.eventsAfter(runId).filter(event => ['run.running', 'run.pausing', 'run.paused_user', 'run.cancelling', 'run.cancelled'].includes(event.type)).map(event => event.type);
  assert.deepEqual(lifecycle, ['run.running', 'run.pausing', 'run.paused_user', 'run.running', 'run.cancelling', 'run.cancelled']);
  const report = { passed: true, runId, actualModel: false, actualSandbox: true, browser: await browser.version(), hostReopened: true,
    lifecycle, artifactSha256, pausedSandbox: pauseAttempt.sandboxId, cancelledSandbox: cancelAttempt.sandboxId,
    remoteStatusAfterCleanup: 404, originalDeadline: paused.deadline, originalBudgetScope: paused.budgetScopeKey,
    syntheticUsedTokens: budget.usedTokens, unknownCalls: budget.unknownCalls, reservedTokens: budget.reservedTokens };
  await writeFile(join(output, 'controls-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('N03 user controls passed. Evidence: ' + output);
} finally {
  await browser.close();
  if (server) {
    const active = server.host.store.getSandbox(runId);
    try { if (active) await server.host.cancel(runId, 'probe-cleanup', 'Smoke runner teardown'); }
    finally { await server.close(); }
  }
}
