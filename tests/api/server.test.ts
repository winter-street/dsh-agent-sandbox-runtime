import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeServerOptions } from '../../src/api/server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { createRuntimeServer } from '../../src/api/server.js';
import { MAX_EVENT_FRAME_BYTES } from '../../src/api/events.js';
import { loadConfig } from '../../src/config.js';
import { FakeBudget, FakeClock, FakeSandbox } from '../support/fakes.js';

const token = 'local-test-token-only-32-characters';
const cleanup: Array<{ server: Server; store: RuntimeStore; root: string }> = [];
async function readFrames(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<string> {
  let text = ''; const decoder = new TextDecoder();
  while (text.split('\n\n').slice(0, -1).filter(frame => frame.split('\n').some(line => line.startsWith('data: '))).length < count) {
    const chunk = await reader.read(); if (chunk.done) throw new Error('Replay ended before the expected complete frame');
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}
async function setup(serverOptions: Partial<RuntimeServerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-api-')); const clock = new FakeClock(1000);
  const store = new RuntimeStore(join(root, 'db'), clock.now);
  const service = new RuntimeService(store, new ArtifactStore(join(root, 'artifacts')), new FakeSandbox(),
    new FakeBudget({ scopeKey: 'scope-1', sessionIds: ['session-1'] }), loadConfig('config/example.json'), { now: clock.now });
  const server = createRuntimeServer(service, { token, eventPollMs: 10, ...serverOptions });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push({ server, store, root });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const input = { runId: 'run-1', rootSessionId: 'session-1', budgetScopeKey: 'scope-1', task: 'analyze', deadline: 100000, policyVersion: 'budget-policy-v1', inputHash: 'a'.repeat(64) };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return { url, headers, input, store, service, server };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { server, store, root } of cleanup.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local HTTP API and durable SSE', () => {
  it('requires auth, rejects foreign origins, validates bodies and command idempotency', async () => {
    const t = await setup();
    expect((await fetch(`${t.url}/runs`)).status).toBe(401);
    expect((await fetch(`${t.url}/runs`, { headers: { ...t.headers, Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await fetch(`${t.url}/runs`, { method: 'POST', headers: t.headers, body: '{}' })).status).toBe(400);
    expect((await fetch(`${t.url}/runs`, { method: 'POST', headers: t.headers, body: JSON.stringify(t.input) })).status).toBe(201);
    const snapshot = await fetch(`${t.url}/runs/run-1`, { headers: t.headers });
    expect(snapshot.status).toBe(200); expect(await snapshot.json()).toMatchObject({ status: 'RUNNING', budgetScopeKey: 'scope-1' });
    const cancel = { commandId: 'cancel-1', reason: 'user' };
    const send = (value: unknown) => fetch(`${t.url}/runs/run-1/cancel`, { method: 'POST', headers: t.headers, body: JSON.stringify(value) });
    const first = await send(cancel); expect(first.status).toBe(200); const firstBody = await first.json();
    expect(await (await send(cancel)).json()).toEqual(firstBody);
    expect((await send({ ...cancel, reason: 'changed' })).status).toBe(409);
    expect((await fetch(`${t.url}/runs/run-1/artifacts/not-committed`, { headers: t.headers })).status).toBe(404);
  });
  it('replays after the exact durable cursor and disconnect does not cancel', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.eventsAfter('run-1').at(-1)!.eventSeq;
    t.store.appendEvent('run-1', 'test.changed', { value: 2 });
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, { headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('test.changed')) {
      const read = await reader.read(); if (read.done) break; text += new TextDecoder().decode(read.value);
    }
    expect(text).toContain(`id: ${cursor + 1}`); expect(text).not.toContain('event: run.created');
    controller.abort();
    expect(t.store.getRun('run-1').status).toBe('RUNNING');
    expect((await fetch(`${t.url}/runs/run-1/events`, { headers: { ...t.headers, 'Last-Event-ID': '9999' } })).status).toBe(409);
    expect((await fetch(`${t.url}/runs/run-1/events?token=secret`, { headers: t.headers })).status).toBe(400);
  });
  it('joins a snapshot cursor to paged replay without gaps or duplicates', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const snapshot = await (await fetch(`${t.url}/runs/run-1`, { headers: t.headers })).json() as { lastEventSeq: number };
    // These events land after the snapshot and before the observer attaches.
    for (let i = 0; i < 145; i++) t.store.appendEvent('run-1', 'test.page', { index: i });
    const reads = vi.spyOn(t.store, 'eventsAfter');
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(snapshot.lastEventSeq) },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    });
    const reader = response.body!.getReader(); const text = await readFrames(reader, 145);
    const sequences = [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    expect(sequences).toEqual(Array.from({ length: 145 }, (_, i) => snapshot.lastEventSeq + i + 1));
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(reads.mock.calls.every(call => call[2] === 64)).toBe(true);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    const afterClose = reads.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(reads.mock.calls.length).toBe(afterClose);
    expect(t.store.getRun('run-1').status).toBe('RUNNING');
  });
  it('bounds oversized replay frames, preserves IDs, and continues after the omitted payload', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    t.store.appendEvent('run-1', 'tool.output', { stdout: 'x'.repeat(256 * 1024) });
    t.store.appendEvent('run-1', 'test.after-large-output', { value: 1 });
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const text = await readFrames(response.body!.getReader(), 2);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '));
    expect(frames).toHaveLength(2);
    expect(frames.every(frame => Buffer.byteLength(`${frame}\n\n`) <= MAX_EVENT_FRAME_BYTES)).toBe(true);
    expect(frames[0]).toContain(`id: ${cursor + 1}\n`);
    expect(frames[0]).toContain('EVENT_FRAME_TOO_LARGE');
    expect(frames[1]).toContain(`id: ${cursor + 2}\n`);
    expect(frames[1]).toContain('test.after-large-output');
    const omitted = JSON.parse(frames[0]!.split('\ndata: ')[1]!) as { payload: unknown };
    expect(omitted.payload).toEqual({ omitted: true, reason: 'EVENT_FRAME_TOO_LARGE' });
    controller.abort();
  });
  it('projects tool completion payloads without exposing large output or unrelated fields', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    t.store.appendEvent('run-1', 'tool.finished', {
      attemptId: 'attempt-1', stepId: 'step-1', executionId: 'exec-1', exitCode: 0,
      stdout: 'x'.repeat(32), stderr: 'y'.repeat(7), artifacts: ['artifact-1'], secret: 'must-not-leak',
    });
    t.store.appendEvent('run-1', 'tool.completed', {
      callId: 'call-1', toolName: 'python', location: 'sandbox', ok: false,
      error: { code: 'TIMEOUT', retryable: true, message: 'must-not-leak' }, secret: 'must-not-leak',
    });
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const text = await readFrames(response.body!.getReader(), 2);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '));
    const finished = JSON.parse(frames[0]!.split('\ndata: ')[1]!) as { payload: Record<string, unknown> };
    const completed = JSON.parse(frames[1]!.split('\ndata: ')[1]!) as { payload: Record<string, unknown> };
    expect(finished.payload).toEqual({ attemptId: 'attempt-1', stepId: 'step-1', executionId: 'exec-1', exitCode: 0,
      artifacts: ['artifact-1'], stdoutBytes: 32, stderrBytes: 7 });
    expect(completed.payload).toEqual({ callId: 'call-1', toolName: 'python', location: 'sandbox', ok: false,
      error: { code: 'TIMEOUT', retryable: true } });
    expect(text).not.toContain('must-not-leak');
    controller.abort();
  });
  it('does not forward nested or wrongly typed tool completion fields over SSE', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const secret = 'nested-secret-must-not-cross-sse';
    const finished = { attemptId: 'attempt-1', exitCode: { secret }, artifacts: [{ path: secret }], stdout: secret };
    const completed = { callId: 'call-1', toolName: { secret }, location: { secret }, ok: false,
      error: { code: { secret }, retryable: { secret }, message: secret } };
    t.store.appendEvent('run-1', 'tool.finished', finished);
    t.store.appendEvent('run-1', 'tool.completed', completed);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const text = await readFrames(response.body!.getReader(), 2);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '));
    expect(JSON.parse(frames[0]!.split('\ndata: ')[1]!).payload).toEqual({
      attemptId: 'attempt-1', stdoutBytes: Buffer.byteLength(secret), stderrBytes: 0,
    });
    expect(JSON.parse(frames[1]!.split('\ndata: ')[1]!).payload).toEqual({ callId: 'call-1', ok: false, error: {} });
    expect(text).not.toContain(secret);
    const events = t.store.eventsAfter('run-1', cursor);
    expect(events[0]!.payload).toEqual(finished);
    expect(events[1]!.payload).toEqual(completed);
    controller.abort();
  });
  it('summarizes entity evidence in SSE while retaining durable evidence', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const secret = 'private-evidence-locator';
    const payload = { entityId: 'entity-1', inputVersion: 'v1', generation: 1,
      evidence: [{ kind: 'input', id: 'input-1', version: 'v1', locator: secret, contentHash: 'a'.repeat(64) }] };
    t.store.appendEvent('run-1', 'entity.upserted', payload);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const text = await readFrames(response.body!.getReader(), 1);
    const projected = JSON.parse(text.split('\ndata: ')[1]!.split('\n\n')[0]!).payload;
    expect(projected).toMatchObject({ entityId: 'entity-1', inputVersion: 'v1', generation: 1,
      evidence: { present: true, bytes: Buffer.byteLength(JSON.stringify(payload.evidence)) } });
    expect(projected.evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(text).not.toContain(secret);
    expect(t.store.eventsAfter('run-1', cursor)[0]!.payload).toEqual(payload);
    controller.abort();
  });
  it('projects policy, approval, validation and graph events through explicit allowlists', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const secret = 'producer-secret-must-not-cross-sse';
    const hash = 'a'.repeat(64);
    const events: Array<[string, Record<string, unknown>]> = [
      ['validation.completed', { stepId: 'review-1', passed: true, evidence: { version: 1, bindingHash: hash, validatorVersion: 'v1', data: secret } }],
      ['approval.requested', { approvalId: 'approval-1', toolCallId: 'call-1', argumentsHash: hash, reason: secret, status: 'pending', createdAt: 1, expiresAt: 2 }],
      ['approval.approved', { approvalId: 'approval-1', toolCallId: 'call-1', argumentsHash: hash, reason: secret, status: 'approved', decisionId: 'decision-1', decidedAt: 2 }],
      ['approval.consumed', { approvalId: 'approval-1', toolCallId: 'call-1', argumentsHash: hash, reason: secret, status: 'consumed', consumedAt: 3 }],
      ['policy.decision', { phase: 'dispatch', allowed: false, disposition: 'deny', stage: 'focus', mode: 'enforce', limits: { maxModelConcurrency: 1, allowOptionalWork: false }, proposedLimits: { maxModelConcurrency: 1, allowNewAgents: false }, pressure: { used: 10, reserved: 2, total: 12 }, requiresReestimate: true, reasons: [{ code: 'BUDGET_PRESSURE', hard: false, detail: secret }] }],
      ['tool.claimed', { runId: 'run-1', callId: 'call-1', toolName: 'python', location: 'sandbox', argsHash: secret, inputHash: secret, requestHash: secret, extra: secret }],
      ['retry.dispatch_intent', { key: secret, version: 2, attempts: 1, nextAt: 0, phase: 'pending', lastFailure: 'unknown', extra: secret }],
      ['retry.classified', { key: secret, version: 2, attempts: 1, nextAt: 123, phase: 'failed', lastFailure: 'transient-unsent', retryable: true, extra: secret }],
      ['policy.changed', { schemaVersion: 1, policyVersion: 'v1', rulesFingerprint: hash, stage: 'focus', finalized: false,
        notifiedStages: ['notice', 'focus'], lastTransitionStep: 2, evaluationCount: 4, lastOperatorReason: secret, extra: secret }],
      ['run.completed_partial', { from: 'RUNNING', revision: 4, outcome: secret, extra: secret }],
      ['policy.triggered', { key: 'policy:key:focus', stage: 'focus', pressure: 0.9, mode: 'enforce', message: secret }],
      ['tool.policy-admission', { callId: 'call-2', toolName: 'python', allowed: false, reason: 'NO_PROGRESS', message: secret }],
      ['tool.policy-notice', { key: 'tool:key', message: secret }],
      ['tool.policy-outcome', { callId: 'call-2', ok: false, progressVersion: 'v2', errorSignature: secret }],
      ['resource.policy_decision', { stateKey: 'branches', telemetry: 'known', maxNewConcurrency: 1, proposedConcurrency: 1, affects: 'new-dispatch-only', reasons: [secret, 'RESOURCE_HIGH_CPU'] }],
      ['graph.snapshot', { graphId: 'graph-1', revision: 4, detail: { complete: true, artifacts: [{ artifactId: 'artifact-1', path: secret }] } }],
      ['graph.reconciliation_claimed', { graphId: 'graph-1', revision: 5, detail: { evidence: secret } }],
      ['graph.reconciled', { graphId: 'graph-1', revision: 6, detail: { evidence: secret } }],
      ['repair.validated', { attemptId: 'attempt-1', replacementId: 'step-2', evidence: { version: 1, data: secret } }],
      ['tool.validation', { attemptId: 'attempt-1', stepId: 'step-2', execution: 'SUCCEEDED', passed: true, repairedStepIds: ['step-1'], arbitrary: secret }],
    ];
    for (const [type, payload] of events) t.store.appendEvent('run-1', type, payload);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const text = await readFrames(response.body!.getReader(), events.length);
    expect(text).not.toContain(secret);
    const payloads = text.split('\n\n').filter(frame => frame.includes('\ndata: ')).map(frame => JSON.parse(frame.split('\ndata: ')[1]!) as { type: string; payload: Record<string, unknown> });
    expect(payloads.find(event => event.type === 'validation.completed')?.payload).toMatchObject({ stepId: 'review-1', passed: true,
      evidence: { version: 1, validatorVersion: 'v1', bindingHash: hash, present: true } });
    expect(payloads.find(event => event.type === 'approval.requested')?.payload).toMatchObject({ approvalId: 'approval-1', status: 'pending', reasonPresent: true });
    expect(payloads.find(event => event.type === 'policy.decision')?.payload).toMatchObject({ stage: 'focus', allowed: false,
      reasons: [{ code: 'BUDGET_PRESSURE', hard: false }] });
    expect(payloads.find(event => event.type === 'policy.changed')?.payload).toMatchObject({ stage: 'focus', finalized: false,
      notifiedStages: ['notice', 'focus'], reasonPresent: true, reasonBytes: Buffer.byteLength(secret) });
    expect(payloads.find(event => event.type === 'run.completed_partial')?.payload).toEqual({ from: 'RUNNING', revision: 4,
      outcomePresent: true, outcomeBytes: Buffer.byteLength(secret) });
    expect(payloads.find(event => event.type === 'tool.claimed')?.payload).toEqual({ callId: 'call-1', toolName: 'python', location: 'sandbox' });
    expect(t.store.eventsAfter('run-1', cursor).find(event => event.type === 'tool.claimed')?.payload).toMatchObject({ argsHash: secret, inputHash: secret, requestHash: secret });
    expect(payloads.find(event => event.type === 'retry.dispatch_intent')?.payload).toMatchObject({
      key: { present: true }, version: 2, attempts: 1, nextAt: 0, phase: 'pending', lastFailure: 'unknown' });
    expect(payloads.find(event => event.type === 'retry.classified')?.payload).toMatchObject({
      key: { present: true }, version: 2, attempts: 1, nextAt: 123, phase: 'failed', lastFailure: 'transient-unsent', retryable: true });
    expect(t.store.eventsAfter('run-1', cursor).find(event => event.type === 'retry.classified')?.payload).toMatchObject({ key: secret });
    expect(t.store.eventsAfter('run-1', cursor).find(event => event.type === 'policy.changed')?.payload).toMatchObject({ lastOperatorReason: secret });
    expect(t.store.eventsAfter('run-1', cursor).find(event => event.type === 'run.completed_partial')?.payload).toMatchObject({ outcome: secret });
    expect(payloads.find(event => event.type === 'tool.policy-admission')?.payload).toEqual({ callId: 'call-2', toolName: 'python', allowed: false, reason: 'NO_PROGRESS' });
    expect(payloads.find(event => event.type === 'graph.snapshot')?.payload).toEqual({ graphId: 'graph-1', revision: 4, complete: true, artifactIds: ['artifact-1'] });
    controller.abort();
  });
  it('projects pause reasons and sandbox failure details while preserving durable events', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const secret = 'sensitive diagnostic and user reason';
    const failure = { code: 'DOCKER::SANDBOX_START_FAILED', phase: 'sandbox.create', retryable: true,
      observedAt: 1000, message: secret, causeRef: secret };
    const events: Array<[string, Record<string, unknown>]> = [
      ['run.pause_requested', { reason: secret }],
      ['step.optional', { stepId: 'step-1', reason: secret }],
      ['sandbox.failure', failure],
      ['attempt.unknown', { attemptId: 'attempt-1', stepId: 'step-1', sandboxId: 'box-1', executionId: 'exec-1',
        errorCode: 'SANDBOX_CREATE_UNKNOWN', workDir: secret, failure }],
    ];
    for (const [type, payload] of events) t.store.appendEvent('run-1', type, payload);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const text = await readFrames(response.body!.getReader(), events.length);
    const received = text.split('\n\n').filter(frame => frame.includes('\ndata: '))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]!) as { type: string; payload: Record<string, unknown> });
    const projectedFailure = { code: failure.code, phase: failure.phase, retryable: true, observedAt: 1000,
      messagePresent: true, messageBytes: Buffer.byteLength(secret), causeRefPresent: true };
    expect(received.map(event => event.payload)).toEqual([
      { reasonPresent: true, reasonBytes: Buffer.byteLength(secret) },
      { stepId: 'step-1', reasonPresent: true, reasonBytes: Buffer.byteLength(secret) },
      projectedFailure,
      { attemptId: 'attempt-1', stepId: 'step-1', sandboxId: 'box-1', executionId: 'exec-1',
        errorCode: 'SANDBOX_CREATE_UNKNOWN', failure: projectedFailure },
    ]);
    expect(text).not.toContain(secret);
    expect(t.store.eventsAfter('run-1', cursor).map(event => event.payload)).toEqual(events.map(([, payload]) => payload));
    controller.abort();
  });
  it('summarizes retry execution bindings on the event stream', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const payload = { stepId: 'step-1', dispatchNo: 1, attemptNo: 2,
      binding: { rootSessionId: 'private-session', input: { token: 'sensitive-retry-binding' } } };
    t.store.appendEvent('run-1', 'retry.execution_intent', payload);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader(); const text = await readFrames(reader, 1);
    const event = JSON.parse(text.split('\ndata: ')[1]!.split('\n\n')[0]!);
    expect(event.payload).toMatchObject({ stepId: 'step-1', dispatchNo: 1, attemptNo: 2,
      binding: { present: true, bytes: Buffer.byteLength(JSON.stringify(payload.binding)), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(text).not.toContain('private-session');
    expect(text).not.toContain('sensitive-retry-binding');
    expect(t.store.eventsAfter('run-1', cursor)[0]!.payload).toEqual(payload);
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('projects budget receipts while retaining trace correlation and keeping ledger paths private', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const payloads = [
      { ledgerId: 'C:/private-ledger/budget', budgetScopeKey: 'private-scope', ledgerSeq: 3,
        receiptEventId: 'receipt-1', reservationId: 'reservation-1', modelCallId: 'model-1', eventType: 'reserve',
        extra: { token: 'private-receipt-data' } },
      { ledgerId: '/private-ledger', budgetScopeKey: 'private-scope', ledgerSeq: 0,
        receiptEventId: 'invalid receipt', reservationId: {}, modelCallId: null, eventType: 'private-receipt-data' },
    ];
    payloads.forEach(payload => t.store.appendEvent('run-1', 'budget.receipt', payload));
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader(); const text = await readFrames(reader, payloads.length);
    const events = text.split('\n\n').filter(frame => frame.includes('\ndata: '))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(events.map(event => event.payload)).toEqual([
      { ledgerSeq: 3, receiptEventId: 'receipt-1', reservationId: 'reservation-1', modelCallId: 'model-1', eventType: 'reserve' }, {},
    ]);
    expect(text).not.toContain('private-ledger');
    expect(text).not.toContain('private-scope');
    expect(text).not.toContain('private-receipt-data');
    expect(t.store.eventsAfter('run-1', cursor).map(event => event.payload)).toEqual(payloads);
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('projects executor links without exposing extra payload fields', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const payload = { callId: 'role-1', modelCallId: 'model-1', receiptId: 'receipt-1', stepId: 'step-1',
      privateData: { token: 'sensitive-link-data' } };
    t.store.appendEvent('run-1', 'workflow.executor_step_linked', payload);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader(); const text = await readFrames(reader, 1);
    const event = JSON.parse(text.split('\ndata: ')[1]!.split('\n\n')[0]!);
    expect(event.payload).toEqual({ callId: 'role-1', modelCallId: 'model-1', receiptId: 'receipt-1', stepId: 'step-1' });
    expect(text).not.toContain('sensitive-link-data');
    expect(t.store.eventsAfter('run-1', cursor)[0]!.payload).toEqual(payload);
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('projects context checkpoint metadata without exposing content fingerprints', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const types = ['context.initialized', 'context.replaced', 'context.summary-state', 'context.summarized'];
    const payloads = types.map((type, index) => ({
      version: index + 1, attemptsTotal: index, entriesFingerprint: 'sensitive-context-fingerprint', extra: 'sensitive-checkpoint-data',
    }));
    types.forEach((type, index) => t.store.appendEvent('run-1', type, payloads[index]!));
    const malformed = { version: -1, attemptsTotal: 1.5, entriesFingerprint: 'sensitive-context-fingerprint' };
    t.store.appendEvent('run-1', 'context.replaced', malformed);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const text = await readFrames(reader, types.length + 1);
    const events = text.split('\n\n').filter(frame => frame.includes('\ndata: '))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(events.map(event => event.payload)).toEqual([
      ...payloads.map(({ version, attemptsTotal }) => ({ version, attemptsTotal })), {},
    ]);
    expect(text).not.toContain('sensitive-context-fingerprint');
    expect(text).not.toContain('sensitive-checkpoint-data');
    expect(t.store.eventsAfter('run-1', cursor).map(event => event.payload)).toEqual([...payloads, malformed]);
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('projects final report lifecycle without exposing the request fingerprint', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const events: Array<[string, Record<string, unknown>]> = [
      ['finalization.report_intent', { requestHash: 'sensitive-request-fingerprint', estimatedTokens: 123, extra: 'sensitive-report-data' }],
      ['finalization.report_outcome', { reason: 'generated', enhanced: true, complete: false, extra: 'sensitive-report-data' }],
      ['finalization.report_intent', { estimatedTokens: -1 }],
      ['finalization.report_outcome', { reason: 'sensitive-report-data', enhanced: 'true', complete: 1 }],
    ];
    events.forEach(([type, payload]) => t.store.appendEvent('run-1', type, payload));
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const text = await readFrames(reader, events.length);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(frames.map(event => event.payload)).toEqual([
      { estimatedTokens: 123 }, { reason: 'generated', enhanced: true, complete: false }, {}, {},
    ]);
    expect(text).not.toContain('sensitive-request-fingerprint');
    expect(text).not.toContain('sensitive-report-data');
    expect(t.store.eventsAfter('run-1', cursor).map(event => event.payload)).toEqual(events.map(([, payload]) => payload));
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('projects retry classifications and committed attempts with their correlation fields', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const events: Array<[string, Record<string, unknown>]> = [
      ['retry.execution_classified', { stepId: 'step-1', dispatchNo: 1, attemptNo: 1, attemptId: null, failure: 'unknown', retryable: false, extra: 'sensitive-retry-data' }],
      ['retry.execution_classified', { stepId: 'step-1', dispatchNo: 2, attemptNo: 2, attemptId: 'attempt-2', failure: 'transient-unsent', retryable: true, extra: 'sensitive-retry-data' }],
      ['retry.execution_committed', { stepId: 'step-1', dispatchNo: 3, attemptNo: 3, attemptId: 'attempt-3', extra: 'sensitive-retry-data' }],
      ['retry.execution_classified', { stepId: { secret: 'sensitive-retry-data' }, dispatchNo: -1, attemptNo: 1.5, failure: 'sensitive-retry-data', retryable: 'true' }],
    ];
    events.forEach(([type, payload]) => t.store.appendEvent('run-1', type, payload));
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const text = await readFrames(reader, events.length);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(frames.map(event => event.payload)).toEqual([
      { stepId: 'step-1', dispatchNo: 1, attemptNo: 1, attemptId: null, failure: 'unknown', retryable: false },
      { stepId: 'step-1', dispatchNo: 2, attemptNo: 2, attemptId: 'attempt-2', failure: 'transient-unsent', retryable: true },
      { stepId: 'step-1', dispatchNo: 3, attemptNo: 3, attemptId: 'attempt-3' }, {},
    ]);
    expect(text).not.toContain('sensitive-retry-data');
    expect(t.store.eventsAfter('run-1', cursor).map(event => event.payload)).toEqual(events.map(([, payload]) => payload));
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('projects role and branch events without exposing the budget scope or extra payload', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const events: Array<[string, Record<string, unknown>]> = [
      ['workflow.role_dispatch_intent', { role: 'executor', callId: 'call-1', sessionId: 'session-1', budgetScopeKey: 'private-scope', extra: 'private-extra' }],
      ['workflow.role_not_dispatched', { role: 'planner', callId: 'call-2', sessionId: 'session-2', extra: 'private-extra' }],
      ['workflow.role_completed', { role: 'reviewer', callId: 'call-3', modelCallId: 'model-3', receiptId: 'receipt-3', extra: 'private-extra' }],
      ['branch.child_intent', { branchId: 'branch-1', childRunId: 'child-1', dispatchId: 'dispatch-1', budgetScopeKey: 'private-scope', extra: 'private-extra' }],
      ['workflow.role_completed', { role: 'private-extra', callId: { value: 'private-extra' }, receiptId: 'bad id' }],
      ['branch.child_intent', { branchId: 'bad id', childRunId: null, dispatchId: { value: 'private-extra' } }],
    ];
    events.forEach(([type, payload]) => t.store.appendEvent('run-1', type, payload));
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const text = await readFrames(reader, events.length);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(frames.map(event => event.payload)).toEqual([
      { role: 'executor', callId: 'call-1', sessionId: 'session-1' },
      { role: 'planner', callId: 'call-2', sessionId: 'session-2' },
      { role: 'reviewer', callId: 'call-3', modelCallId: 'model-3', receiptId: 'receipt-3' },
      { branchId: 'branch-1', childRunId: 'child-1', dispatchId: 'dispatch-1' }, {}, {},
    ]);
    expect(text).not.toContain('private-scope');
    expect(text).not.toContain('private-extra');
    expect(t.store.eventsAfter('run-1', cursor).map(event => event.payload)).toEqual(events.map(([, payload]) => payload));
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('projects session bindings while preserving durable payloads', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const payloads = [
      { sessionId: 'session-1', purpose: 'work', intent: 'summary', extra: 'private-session-data' },
      { sessionId: { value: 'private-session-data' }, purpose: 'private-session-data', intent: 'private-session-data' },
      { sessionId: 'session-2', purpose: 'finalize', intent: 'final-report' },
    ];
    payloads.forEach(payload => t.store.appendEvent('run-1', 'session.bound', payload));
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const text = await readFrames(reader, payloads.length);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '))
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(frames.map(event => event.payload)).toEqual([
      { sessionId: 'session-1', purpose: 'work', intent: 'summary' }, {},
      { sessionId: 'session-2', purpose: 'finalize', intent: 'final-report' },
    ]);
    expect(text).not.toContain('private-session-data');
    expect(t.store.eventsAfter('run-1', cursor).map(event => event.payload)).toEqual(payloads);
    controller.abort(); await reader.cancel().catch(() => {});
  });

  it('keeps arbitrary tool data intact and prevents event-name field injection', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const payload = { stdout: 'line 1\n\nid: 999\ndata: forged\n令牌 token is a user data label', token: 'domain-data', nested: { authorization: 'a document heading' } };
    t.store.appendEvent('run-1', 'unsafe\nid: 999\ndata: injected', payload);
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader(); const text = await readFrames(reader, 1);
    expect(text).toContain('event: message\n'); expect(text).not.toContain('\nid: 999\n');
    const event = JSON.parse(text.split('\ndata: ')[1]!.split('\n\n')[0]!);
    expect(event.payload).toEqual(payload); expect(event.type).toBe('unsafe\nid: 999\ndata: injected');
    expect(text).not.toContain(token);
    controller.abort(); await reader.cancel().catch(() => {});
    for (const value of ['-1', '1.5', '9007199254740992', 'NaN']) {
      expect((await fetch(`${t.url}/runs/run-1/events`, { headers: { ...t.headers, 'Last-Event-ID': value } })).status).toBe(400);
    }
  });
  it('keeps the poller alive when a later oversized event is bounded', async () => {
    const t = await setup(); await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const intervals = vi.spyOn(globalThis, 'setInterval'); const clears = vi.spyOn(globalThis, 'clearInterval');
    const reads = vi.spyOn(t.store, 'eventsAfter');
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const index = intervals.mock.calls.findIndex(call => call[1] === 10);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = intervals.mock.results[index]!.value;
    t.store.appendEvent('run-1', 'tool.output', { stdout: 'y'.repeat(256 * 1024) });
    t.store.appendEvent('run-1', 'test.after-large-output', { value: 1 });
    const text = await readFrames(response.body!.getReader(), 2);
    expect(text).toContain(`id: ${cursor + 1}\n`);
    expect(text).toContain('test.after-large-output');
    expect(clears).not.toHaveBeenCalledWith(timer);
    const afterEnd = reads.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(reads.mock.calls.length).toBeGreaterThan(afterEnd);
    expect(t.store.getRun('run-1').status).toBe('RUNNING');
    controller.abort();
  });
  it('applies a per-connection byte window without skipping or rereading events', async () => {
    const t = await setup({ eventPollMs: 1, eventRateLimitBytesPerWindow: 128 * 1024, eventRateLimitWindowMs: 100 });
    await t.service.createRun(t.input);
    const cursor = t.store.latestEventSeq('run-1');
    const total = 700;
    for (let i = 0; i < total; i += 1) t.store.appendEvent('run-1', `rate-limit-${i}`, { blob: 'x'.repeat(16) });
    const readTimes: number[] = [];
    const originalEventsAfter = t.store.eventsAfter.bind(t.store);
    const reads = vi.spyOn(t.store, 'eventsAfter').mockImplementation((...args) => {
      readTimes.push(Date.now());
      return originalEventsAfter(...args);
    });
    const controller = new AbortController();
    const response = await fetch(`${t.url}/runs/run-1/events`, {
      headers: { ...t.headers, 'Last-Event-ID': String(cursor) }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const text = await readFrames(reader, total);
    const frames = text.split('\n\n').filter(frame => frame.includes('\ndata: '));
    expect(frames).toHaveLength(total);
    expect(frames.map(frame => Number(frame.match(/^id: (\d+)$/m)?.[1]))).toEqual(
      Array.from({ length: total }, (_, index) => cursor + index + 1),
    );
    expect(reads.mock.calls.every(call => call[2] === 64)).toBe(true);
    expect(readTimes.some((time, index) => index > 0 && time - readTimes[index - 1]! >= 50)).toBe(true);
    controller.abort();
  });
});
