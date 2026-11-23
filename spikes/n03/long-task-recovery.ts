import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recoverWriterLock } from '../../.sources/budget/scripts/recover-writer-lock.mjs';
import { openBrowser } from './browser.mjs';
import { domain, env, maxCalls, model, pluginUrl, safeError, worker, type WorkerMessage } from './worker.js';

async function preflight() {
  env('DEEPSEEK_API_KEY'); env('OPEN_SANDBOX_API_KEY');
  await import(pluginUrl.href);
  const response = await fetch(domain + '/health', { signal: AbortSignal.timeout(5000) });
  assert(response.ok, 'OpenSandbox health failed: ' + response.status);
  await import(pathToFileURL(env('RUNTIME_PLAYWRIGHT_MODULE')).href);
}
function launch(directory: string, runId: string, deadline: number, port: number, token: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', directory, runId, String(deadline), String(port)],
    { env: { ...process.env, N03_HTTP_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const messages: WorkerMessage[] = []; let diagnostics = '';
  child.on('message', message => messages.push(message as WorkerMessage));
  child.stderr?.on('data', value => { diagnostics = (diagnostics + safeError(value.toString())).slice(-2048); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('exit', (code, signal) => done({ code, signal })); child.once('error', reject);
  });
  const close = new Promise<void>(done => child.once('close', () => done()));
  void exit.catch(() => {});
  const wait = async <T extends WorkerMessage['phase']>(phase: T) => {
    for (;;) {
      const failure = messages.find(message => message.phase === 'failed');
      if (failure?.phase === 'failed') throw Object.assign(new Error(failure.error), { snapshot: failure.snapshot });
      const message = messages.find(message => message.phase === phase);
      if (message) return message as Extract<WorkerMessage, { phase: T }>;
      const stopped = await Promise.race([exit, new Promise<null>(done => setTimeout(() => done(null), 100))]);
      if (stopped) {
        await close;
        await new Promise<void>(done => setImmediate(done));
        const failure = messages.find(message => message.phase === 'failed');
        if (failure?.phase === 'failed') {
          throw Object.assign(new Error('Worker failed before ' + phase + ': ' + failure.error
            + (diagnostics ? '\nWorker stderr:\n' + diagnostics : '')), { snapshot: failure.snapshot });
        }
        const lateMessage = messages.find(message => message.phase === phase);
        if (lateMessage) return lateMessage as Extract<WorkerMessage, { phase: T }>;
        throw new Error('Worker exited before ' + phase + ': ' + JSON.stringify(stopped)
          + (diagnostics ? '\nWorker stderr:\n' + diagnostics : ''));
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + phase);
    }
  };
  return { child, exit, wait, async stop() {
    if (child.connected) child.disconnect();
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try { return await exit; } finally { clearTimeout(timer); }
  } };
}
interface Frame { eventSeq: number; runId: string; type: string }
async function replay(url: string, id: string, token: string, cursor: number, target: number): Promise<Frame[]> {
  assert(target > cursor, 'SSE comparison needs nonempty replay');
  const frames: Frame[] = [];
  let nextCursor = cursor;
  // The server deliberately ends an SSE observer after accepted backpressure.
  // Resume from the last fully parsed event instead of treating that bounded
  // connection close as a lost event stream.
  for (let reconnects = 0; nextCursor < target; reconnects++) {
    assert(reconnects < 32, 'SSE replay exceeded reconnect bound');
    const response = await fetch(url + '/runs/' + id + '/events', {
      headers: { Authorization: 'Bearer ' + token, 'Last-Event-ID': String(nextCursor) },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    let buffer = ''; let progressed = false;
    try {
      for (;;) {
        const fragment = await reader.read();
        if (fragment.done) break;
        buffer += decoder.decode(fragment.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, end).split('\n'); buffer = buffer.slice(end + 2);
          const data = lines.find(line => line.startsWith('data: ')); if (!data) continue;
          const event = JSON.parse(data.slice(6)) as Frame;
          assert.equal(event.runId, id); assert.equal(event.eventSeq, nextCursor + 1);
          assert(lines.includes('id: ' + event.eventSeq)); frames.push(event);
          nextCursor = event.eventSeq; progressed = true;
          if (nextCursor === target) return frames;
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
    assert(progressed, 'SSE closed before making replay progress');
  }
  return frames;
}

async function run(directory: string, timeout: number) {
  mkdirSync(directory);
  const id = 'n03-' + randomUUID(); const token = randomUUID(); const deadline = Date.now() + timeout;
  let active: ReturnType<typeof launch> | undefined;
  let ui: Awaited<ReturnType<typeof openBrowser>> | undefined;
  const report: Record<string, unknown> = { schemaVersion: 1, checkedAt: new Date().toISOString(), runId: id, model, maxCalls, passed: false };
  try {
    await preflight();
    ui = await openBrowser(directory, token, env('RUNTIME_PLAYWRIGHT_MODULE'), env('RUNTIME_BROWSER_EXECUTABLE'));
    active = launch(directory, id, deadline, 0, token);
    const { url } = await active.wait('ready');
    await ui.start(url, id);
    active.child.send('run');
    await ui.reload();
    const { snapshot: before } = await active.wait('committed');
    report.before = before;
    assert(before.context?.coverages.length, 'No settled compaction before process termination');
    assert.equal(before.attemptIds.length, 1); assert(before.attemptIds[0]?.executionId);
    assert.equal(before.budget.unknownCalls, 0);
    const initial = await replay(url, id, token, 0, before.cursor);
    await ui.offline(true);
    assert(active.child.kill('SIGKILL'));
    const termination = await active.exit; assert.equal(termination.signal, 'SIGKILL'); report.termination = termination;
    report.budgetLockRecovery = recoverWriterLock(join(directory, 'budget'), before.pid);
    active = launch(directory, id, deadline, Number(new URL(url).port), token);
    assert.equal((await active.wait('ready')).url, url);
    active.child.send('run');
    const { snapshot: after } = await active.wait('finished'); report.after = after;
    await ui.offline(false);
    const suffix = await replay(url, id, token, before.cursor, after.cursor);
    const full = await replay(url, id, token, 0, after.cursor);
    assert.deepEqual(full, [...initial, ...suffix]);
    assert.equal(full.filter(event => event.type === 'workflow.role_completed').length, 3);
    assert.equal(suffix.filter(event => event.type === 'workflow.role_completed').length, 1);
    assert.notEqual(after.pid, before.pid);
    assert.deepEqual(after.attemptIds, before.attemptIds); assert.deepEqual(after.artifacts, before.artifacts);
    assert.equal(after.scopeKey, before.scopeKey); assert.equal(after.deadline, before.deadline); assert.equal(after.inputHash, before.inputHash);
    assert.deepEqual(after.roleRecords.slice(0, 2), before.roleRecords.slice(0, 2));
    assert.equal(after.roleRecords[2]?.status, 'done'); assert.equal(before.roleRecords[2]?.status, undefined);
    assert.deepEqual(after.receipts.slice(0, before.receipts.length), before.receipts);
    assert(after.context && after.context.version > before.context.version);
    assert.deepEqual(after.context.coverages.slice(0, before.context.coverages.length), before.context.coverages);
    assert(after.context.entries.some(e => e.id === 'runtime-task' && e.sourceRefs.includes('input:' + after.inputHash)));
    assert(after.context.entries.some(e => e.id === 'task-boundary' && e.required));
    assert(after.context.entries.some(e => e.id === 'validated-sandbox-output' && e.sourceRefs.length === 3));
    assert.equal(after.providerDispatches, 3 + after.context.coverages.length);
    assert.equal(after.providerDispatches, after.receipts.length);
    assert(after.providerDispatches > before.providerDispatches && after.providerDispatches <= maxCalls);
    assert.equal(after.budget.reservedTokens, 0); assert.equal(after.budget.unknownCalls, 0);
    assert(after.budget.meteringComplete && after.budget.usedTokens > before.budget.usedTokens);
    assert.equal(after.status, 'SUCCEEDED'); assert(after.validation.passed && after.sandboxReleased);
    report.sse = { initial: initial.length, resumed: suffix.length, full: full.length, cursor: after.cursor };
    report.browser = await ui.finish(after.artifacts);
    report.passed = true;
  } catch (error) {
    report.error = safeError(error);
    if (error && typeof error === 'object' && 'snapshot' in error) report.failureSnapshot = error.snapshot;
    process.exitCode = 2;
  } finally {
    await ui?.close().catch(() => {});
    await active?.stop().catch(() => {});
    const path = join(directory, 'n03-report.json');
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, runId: id, path, error: report.error }));
  }
}

try {
  const [mode, directory, a, b, c] = process.argv.slice(2);
  if (mode === '--check-only') {
    await preflight(); const ui = await openBrowser('.', 'unused', env('RUNTIME_PLAYWRIGHT_MODULE'), env('RUNTIME_BROWSER_EXECUTABLE')); await ui.close();
    console.log('N03 preflight passed without model or sandbox execution calls.');
  } else if (mode === '--worker' && directory && a && b && c && process.send) await worker(directory, a, Number(b), Number(c));
  else if (mode === '--run' && directory && Number.isSafeInteger(Number(a)) && Number(a) >= 30_000 && Number(a) <= 900_000) await run(directory, Number(a));
  else throw new Error('Usage: --check-only or --run <new directory> <timeout: 30000..900000 ms>');
} catch (error) {
  if (process.send) { process.send({ phase: 'failed', error: safeError(error) } satisfies WorkerMessage); process.disconnect(); }
  else console.error(safeError(error));
  process.exitCode = 1;
}
