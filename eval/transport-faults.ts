import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { startApplication } from '../src/app/index.js';
import { BudgetReceiptSynchronizer } from '../src/adapters/budget/receipts.js';
import { DeepSeekAdapter } from '../src/models/deepseek.js';
import { FakeSandbox } from '../tests/support/fakes.js';

const scenarios = ['http-error', 'sse-disconnect', 'sse-no-finish', 'sse-no-usage', 'request-timeout', 'host-cancel'] as const;
type Scenario = typeof scenarios[number];
const fixtureUsage = { inputTokens: 11, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };
const runId = 'transport-fault';

async function runScenario(scenario: Scenario, directory: string) {
  let networkRequests = 0;
  let responseClosedEarly = false;
  let markFirstDelta: () => void = () => {};
  const firstDelta = new Promise<void>(resolve => { markFirstDelta = resolve; });
  const hostCancel = scenario === 'host-cancel';
  const expectedStatus = hostCancel ? 'CANCELLED' : 'PAUSED_ACCOUNTING';
  const cancelReason = 'Cancelled by the local transport probe';
  let breakStream: (() => void) | undefined;
  const server = createServer((request, response) => {
    networkRequests++;
    request.resume();
    request.once('end', () => {
      response.once('close', () => { if (!response.writableFinished) responseClosedEarly = true; });
      if (scenario === 'request-timeout') return;
      if (scenario === 'http-error') { response.writeHead(503).end('controlled fault response body'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const reason = scenario === 'sse-no-usage' ? '"stop"' : 'null';
      const frame = `data: {"choices":[{"delta":{"content":"controlled output"},"finish_reason":${reason}}]}\n\n`;
      if (scenario === 'sse-disconnect') {
        breakStream = () => response.destroy();
        response.write(frame);
      } else if (hostCancel) response.write(frame);
      else response.end(frame + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ready);
  });
  class ObservedAdapter extends DeepSeekAdapter {
    override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      for await (const chunk of super.stream(options)) {
        if (chunk.type === 'text-delta' && breakStream) {
          breakStream();
          breakStream = undefined;
        }
        if (chunk.type === 'text-delta' && chunk.text.length > 0) markFirstDelta();
        yield chunk;
      }
    }
  }
  const sandbox = new FakeSandbox();
  const open = () => startApplication({ configPath: resolve('config/eval-hard.json'), dataDirectory: directory,
    env: { DEEPSEEK_API_KEY: 'local-fixture', OPEN_SANDBOX_API_KEY: 'local-fixture' }, listen: false, installSignalHandlers: false, sandbox,
    provider: new ObservedAdapter({ endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/chat/completions`,
      apiKey: 'local-fixture', thinking: 'disabled', requestTimeoutMs: scenario === 'request-timeout' ? 750 : hostCancel ? 15_000 : 3000, maxCalls: 2 }),
    validate: async () => ({ passed: false, evidence: { reason: 'no delivery expected during this fault' } }),
  });
  let host: Awaited<ReturnType<typeof open>> | undefined;
  try {
    host = await open();
    await host.submit({ runId, task: 'Local budget fault probe.', inputs: [] });
    if (hostCancel) {
      const gotDelta = await Promise.race([firstDelta.then(() => true), delay(3_000, false, { ref: false })]);
      assert.equal(gotDelta, true, 'model produced a delta before cancellation');
      assert.equal((await host.cancel(runId, 'cancel-model-stream', cancelReason)).status, 'CANCELLED');
    }
    const paused = await host.wait(runId, { timeoutMs: 7000 });
    assert.equal(paused.status, expectedStatus);
    assert.equal(paused.host.active, false, 'the host has stopped processing the turn');
    assert.equal(networkRequests, 1, 'no automatic provider retry');
    if (scenario === 'request-timeout' || scenario === 'sse-disconnect' || hostCancel) {
      for (let i = 0; i < 20 && !responseClosedEarly; i++) await delay(25);
      assert.equal(responseClosedEarly, true, 'fault closes an unfinished response');
    }
    assert.equal(sandbox.calls.length, 0);
    const scope = paused.budgetScopeKey;
    const snapshot = await host.budget.reader.snapshot(scope);
    assert.equal(snapshot.unknownCalls, 1);
    assert.equal(snapshot.usedTokens, 0);
    assert.equal(snapshot.meteringComplete, false);
    assert.ok(snapshot.reservedTokens > 0);
    const receipts = await host.budget.reader.eventsAfter(0);
    const callReceipts = receipts.filter(item => ['reserve', 'dispatch', 'unknown', 'settle', 'release'].includes(item.type));
    assert.deepEqual(callReceipts.map(item => item.type), ['reserve', 'dispatch', 'unknown']);
    const reservationId = callReceipts[0]!.payload.reservationId;
    assert.equal(typeof reservationId, 'string');
    assert.ok(callReceipts.every(item => item.scopeKey === scope && item.payload.reservationId === reservationId));
    const eventsBefore = host.store.eventsAfter(runId);
    const responses = eventsBefore.filter(event => event.type === 'model.response');
    assert.equal(responses.length, 1);
    assert.ok(!eventsBefore.some(event => event.type === 'model.admission-rejected'), 'the host does not attempt a follow-up request');
    const response = responses[0];
    assert.ok(response);
    const facts = response.payload as { finishReason: string | null; usageReported: boolean; textChars: number };
    if (hostCancel) assert.ok(facts.finishReason === null || facts.finishReason === 'error');
    else assert.equal(facts.finishReason, scenario === 'sse-no-usage' ? 'stop' : 'error');
    assert.equal(facts.usageReported, false);
    if (scenario === 'sse-disconnect' || hostCancel) assert.ok(facts.textChars > 0, 'the host observed the SSE delta before interruption');
    const importedIds = (events: typeof eventsBefore) => events.filter(event => event.type === 'budget.receipt')
      .map(event => (event.payload as { receiptEventId: string }).receiptEventId);
    assert.deepEqual(importedIds(eventsBefore), receipts.map(item => item.eventId));

    await host.close();
    host = await open();
    const reopened = await host.reconcile(runId);
    assert.equal(reopened.status, expectedStatus);
    assert.equal(reopened.budgetScopeKey, scope);
    assert.equal(reopened.deadline, paused.deadline);
    assert.deepEqual(await host.budget.reader.snapshot(scope), snapshot);
    assert.deepEqual(host.store.eventsAfter(runId).find(event => event.type === 'model.response'), response);
    assert.deepEqual(importedIds(host.store.eventsAfter(runId)), importedIds(eventsBefore));
    if (hostCancel) {
      assert.equal((await host.cancel(runId, 'cancel-model-stream', cancelReason)).status, 'CANCELLED');
      await assert.rejects(host.service.resumeRun(runId, 'before-reconciliation', reopened.revision), { code: 'CONFLICT' });
    } else await assert.rejects(host.service.resumeRun(runId, 'before-reconciliation', reopened.revision), { code: 'USAGE_UNKNOWN' });

    // Trusted synthetic late usage for the original reservation.
    const budget = host.budget;
    const originalId = String(reservationId);
    await budget.port.settle(originalId, fixtureUsage);
    await budget.port.settle(originalId, fixtureUsage);
    await assert.rejects(async () => budget.port.settle(originalId, { ...fixtureUsage, outputTokens: 5 }));
    const sync = new BudgetReceiptSynchronizer(host.store, budget.reader, join(directory, 'budget'));
    const imported = await sync.sync(runId);
    assert.equal(imported.imported, 1);
    assert.equal((await sync.sync(runId)).imported, 0);
    const settled = await budget.reader.snapshot(scope);
    assert.equal(settled.usedTokens, 15);
    assert.equal(settled.unknownCalls, 0);
    assert.equal(settled.reservedTokens, 0);
    assert.equal(settled.meteringComplete, true);
    if (hostCancel) {
      const cancelled = await host.reconcile(runId);
      assert.equal(cancelled.status, 'CANCELLED');
      assert.equal(cancelled.host.active, false);
      await assert.rejects(host.service.resumeRun(runId, 'after-reconciliation', cancelled.revision), { code: 'CONFLICT' });
    } else assert.equal((await host.service.resumeRun(runId, 'after-reconciliation', reopened.revision)).status, 'RUNNING');
    assert.equal(networkRequests, 1);
    return { scenario, passed: true as const, networkRequests, responseClosedEarly, reservationId: originalId, scope,
      pausedStatus: paused.status, unknownReservedTokens: snapshot.reservedTokens, settledTokens: settled.usedTokens, receiptCursor: imported.cursor,
      observed: { finishReason: facts.finishReason, usageReported: facts.usageReported, textChars: facts.textChars } };
  } finally {
    try { await host?.close(); }
    finally {
      await new Promise<void>((done, fail) => {
        server.close(error => error ? fail(error) : done());
        server.closeAllConnections();
      });
    }
  }
}

export async function runTransportFaults(outputDirectory: string) {
  const output = resolve(outputDirectory);
  mkdirSync(resolve(output, '..'), { recursive: true });
  mkdirSync(output);
  const results: Array<Awaited<ReturnType<typeof runScenario>> | { scenario: Scenario; passed: false; error: string }> = [];
  for (const scenario of scenarios) {
    try { results.push(await runScenario(scenario, join(output, scenario))); }
    catch (error) {
      // Assertion summaries contain only synthetic data. No upstream bodies or stack traces.
      results.push({ scenario, passed: false, error: error instanceof assert.AssertionError ? error.message.slice(0, 300) : 'Probe could not complete; inspect the local scenario state' });
    }
  }
  const report = { schemaVersion: 1, mode: 'loopback-http', checkedAt: new Date().toISOString(),
    passed: results.filter(result => result.passed).length, results,
    limitations: ['Actual HTTP/SSE transport to a local fixture.', 'Actual Harness and patched original budget plugin; no external DeepSeek billing or OpenSandbox calls.', 'Late usage is a trusted synthetic input.'] };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}
