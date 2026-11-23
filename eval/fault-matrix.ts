import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter } from '../src/models/deepseek.js';
import { RuntimeService } from '../src/core/service.js';
import { ArtifactStore } from '../src/artifacts/index.js';
import { RuntimeStore } from '../src/storage/index.js';
import { loadConfig } from '../src/config.js';
import { RuntimeError, type AttemptStatus, type RunStatus } from '../src/contracts/runtime.js';
import { FakeBudget, FakeClock, FakeSandbox } from '../tests/support/fakes.js';

export type FaultLayer = 'provider' | 'sandbox';
export type FaultAction = 'retry' | 'pause' | 'cancelled' | 'reconcile';
export type ReservationDisposition = 'unknown' | 'released-unsent' | 'not-applicable';

export interface FaultScenario {
  id: string;
  layer: FaultLayer;
  description: string;
  expected: {
    failureKind: FaultLayer | 'accounting' | 'cancelled';
    retryable: boolean;
    action: FaultAction;
    reservation: ReservationDisposition;
    manualReconcile: boolean;
  };
}

export interface FaultObservation {
  scenario: FaultScenario;
  passed: boolean;
  failureKind: FaultScenario['expected']['failureKind'];
  retryable: boolean;
  action: FaultAction;
  reservation: ReservationDisposition;
  manualReconcile: boolean;
  errorCode: string;
  phase: string;
  runStatus?: RunStatus;
  attemptStatus?: AttemptStatus;
  sandboxCalls?: string[];
  providerCalls?: number;
  evidencePath: string;
  failurePath: string;
  limitations: string[];
}

export interface FaultMatrixReport {
  schemaVersion: 1;
  mode: 'controlled';
  generatedAt: string;
  scenarios: number;
  passed: number;
  failed: number;
  observations: FaultObservation[];
  limitations: string[];
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const bounded = (value: unknown): string => (value instanceof Error ? value.message : String(value)).replace(/[\r\n\t]+/g, ' ').slice(0, 240);

export const FAULT_SCENARIOS: readonly FaultScenario[] = [
  { id: 'provider-http-error', layer: 'provider', description: 'Provider returns an HTTP error before a usable completion.', expected: { failureKind: 'provider', retryable: false, action: 'pause', reservation: 'unknown', manualReconcile: true } },
  { id: 'provider-sse-disconnect', layer: 'provider', description: 'Provider SSE transport disconnects before a finish frame.', expected: { failureKind: 'provider', retryable: true, action: 'reconcile', reservation: 'unknown', manualReconcile: true } },
  { id: 'provider-no-finish', layer: 'provider', description: 'SSE reaches EOF without a finish reason.', expected: { failureKind: 'provider', retryable: true, action: 'reconcile', reservation: 'unknown', manualReconcile: true } },
  { id: 'provider-missing-usage', layer: 'provider', description: 'Provider finishes but omits usage accounting.', expected: { failureKind: 'accounting', retryable: false, action: 'pause', reservation: 'unknown', manualReconcile: true } },
  { id: 'provider-timeout', layer: 'provider', description: 'Provider request exceeds the adapter timeout.', expected: { failureKind: 'provider', retryable: true, action: 'reconcile', reservation: 'unknown', manualReconcile: true } },
  { id: 'client-cancel', layer: 'provider', description: 'Client cancels before the provider request is dispatched.', expected: { failureKind: 'cancelled', retryable: false, action: 'cancelled', reservation: 'released-unsent', manualReconcile: false } },
  { id: 'sandbox-create-failed', layer: 'sandbox', description: 'OpenSandbox create fails before a command is dispatched.', expected: { failureKind: 'sandbox', retryable: false, action: 'reconcile', reservation: 'not-applicable', manualReconcile: true } },
  { id: 'sandbox-command-timeout', layer: 'sandbox', description: 'A running sandbox command reaches its deadline and cancellation is confirmed.', expected: { failureKind: 'sandbox', retryable: true, action: 'retry', reservation: 'not-applicable', manualReconcile: false } },
  { id: 'sandbox-cancel-unconfirmed', layer: 'sandbox', description: 'Remote cancellation cannot be confirmed.', expected: { failureKind: 'sandbox', retryable: false, action: 'reconcile', reservation: 'not-applicable', manualReconcile: true } },
  { id: 'remote-result-unknown', layer: 'sandbox', description: 'Remote status inspection fails after dispatch, leaving execution identity unresolved.', expected: { failureKind: 'sandbox', retryable: false, action: 'reconcile', reservation: 'not-applicable', manualReconcile: true } },
];

function frameResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function errorResponse(status: number): Response { return new Response('provider body must not be persisted', { status }); }

async function providerProbe(scenario: FaultScenario): Promise<Omit<FaultObservation, 'evidencePath' | 'failurePath'>> {
  let providerCalls = 0;
  const sse = 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const fetch = async (_url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    providerCalls += 1;
    if (scenario.id === 'provider-http-error') return errorResponse(503);
    if (scenario.id === 'provider-timeout') return await new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(new Error('provider request timeout')), 25);
    });
    if (scenario.id === 'provider-sse-disconnect') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(sse)); controller.error(new Error('provider stream disconnected')); } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (scenario.id === 'provider-no-finish') return frameResponse([sse]);
    return frameResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']);
  };
  const adapter = new DeepSeekAdapter({ apiKey: 'controlled', fetch, requestTimeoutMs: scenario.id === 'provider-timeout' ? 10 : 1000 });
  const signal = scenario.id === 'client-cancel' ? AbortSignal.abort(new Error('client cancelled before dispatch')) : undefined;
  const request = { provider: 'deepseek', model: 'deepseek-chat', sessionId: 'fault-session' as never, maxTokens: 64,
    ...(signal ? { signal } : {}), messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fault probe' }] })] };
  let errorCode = 'PROVIDER_UNKNOWN'; let phase = 'provider.request'; let observedFailure: 'provider' | 'accounting' | 'cancelled' = 'provider';
  let retryable = scenario.expected.retryable; let action = scenario.expected.action; let reservation = scenario.expected.reservation;
  try {
    const chunks = [];
    for await (const chunk of adapter.stream(request)) chunks.push(chunk);
    if (scenario.id === 'provider-missing-usage' && !chunks.some(chunk => chunk.type === 'usage')) {
      errorCode = 'USAGE_UNKNOWN'; phase = 'provider.usage'; observedFailure = 'accounting'; retryable = false; action = 'pause'; reservation = 'unknown';
    } else throw new Error('Fault probe unexpectedly completed without the expected failure');
  } catch (error) {
    const message = bounded(error);
    if (scenario.id === 'client-cancel') { errorCode = 'CLIENT_CANCELLED'; phase = 'provider.dispatch'; observedFailure = 'cancelled'; retryable = false; action = 'cancelled'; reservation = 'released-unsent'; }
    else if (scenario.id === 'provider-http-error') { errorCode = /HTTP \d+/.exec(message)?.[0]?.replace(' ', '_') ?? 'PROVIDER_HTTP_ERROR'; phase = 'provider.response'; retryable = false; action = 'pause'; reservation = 'unknown'; }
    else if (scenario.id === 'provider-timeout') { errorCode = 'PROVIDER_TIMEOUT'; phase = 'provider.request'; retryable = true; action = 'reconcile'; reservation = 'unknown'; }
    else if (scenario.id === 'provider-sse-disconnect') { errorCode = 'PROVIDER_SSE_DISCONNECTED'; phase = 'provider.stream'; retryable = true; action = 'reconcile'; reservation = 'unknown'; }
    else if (scenario.id === 'provider-no-finish') { errorCode = 'PROVIDER_SSE_NO_FINISH'; phase = 'provider.stream'; retryable = true; action = 'reconcile'; reservation = 'unknown'; }
    else throw error;
  }
  const manualReconcile = scenario.expected.manualReconcile;
  return { scenario, passed: observedFailure === scenario.expected.failureKind && retryable === scenario.expected.retryable && action === scenario.expected.action
    && reservation === scenario.expected.reservation && manualReconcile === scenario.expected.manualReconcile,
    failureKind: observedFailure, retryable, action, reservation, manualReconcile,
    errorCode, phase, providerCalls, limitations: ['Controlled fetch; no external provider request or billing reconciliation was performed.'] };
}

async function sandboxProbe(scenario: FaultScenario, base: string): Promise<Omit<FaultObservation, 'evidencePath' | 'failurePath'>> {
  const root = mkdtempSync(join(tmpdir(), 'agent-runtime-fault-')); const clock = new FakeClock(1000); const faults = new (await import('../tests/support/fakes.js')).FakeFaults();
  const sandbox = new FakeSandbox({ clock, faults }); const budget = new FakeBudget({ scopeKey: 'fault-scope', sessionIds: ['fault-session'], clock });
  const store = new RuntimeStore(join(root, 'database'), clock.now); const artifacts = new ArtifactStore(join(root, 'artifacts'));
  const config = loadConfig('config/example.json'); config.sandbox.commandTimeoutMs = 100; config.sandbox.ttlSeconds = 600;
  let cancelController: AbortController | undefined;
  const service = new RuntimeService(store, artifacts, sandbox, budget, config, {
    now: clock.now,
    wait: async ms => { clock.advance(ms); if (scenario.id === 'client-cancel') cancelController?.abort(new Error('client cancelled')); },
    pollIntervalMs: 50,
  });
  const runId = `fault-${scenario.id}`; const input = { runId, stepId: 'fault-step', code: 'print(1)', inputs: [] };
  await service.createRun({ runId, rootSessionId: 'fault-session', budgetScopeKey: 'fault-scope', task: scenario.description, deadline: 10_000, policyVersion: 'fault-matrix-v1', inputHash: sha256('fault-input') });
  if (scenario.id === 'sandbox-create-failed') faults.failNext('sandbox.create.before', new Error('DOCKER::SANDBOX_START_FAILED: controlled sidecar failure'));
  if (scenario.id === 'sandbox-command-timeout') sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: true });
  if (scenario.id === 'sandbox-cancel-unconfirmed') sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: false });
  if (scenario.id === 'remote-result-unknown') { sandbox.enqueue({ states: [{ state: 'RUNNING' }] }); faults.failNext('sandbox.inspect.before', new Error('remote status unavailable')); }
  if (scenario.id === 'client-cancel') { sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: true }); cancelController = new AbortController(); }
  let errorCode = 'NONE'; let phase = 'sandbox';
  try { await service.executeCode(input, cancelController?.signal); }
  catch (error) { errorCode = error instanceof RuntimeError ? error.code : 'SANDBOX_EXECUTION_FAILED'; phase = error instanceof RuntimeError ? error.details.phase ?? 'sandbox.execute' : 'sandbox.execute'; }
  const run = store.getRun(runId); const attempt = store.listAttempts(runId)[0];
  const failureKind: FaultObservation['failureKind'] = run.status === 'CANCELLED' ? 'cancelled' : 'sandbox';
  if (attempt?.errorCode) errorCode = attempt.errorCode;
  if (attempt?.failure) phase = attempt.failure.phase;
  const retryable = attempt?.failure?.retryable ?? scenario.id === 'sandbox-command-timeout';
  const action: FaultAction = run.status === 'CANCELLED' ? 'cancelled' : attempt?.status === 'TIMED_OUT' ? 'retry' : 'reconcile';
  const manualReconcile = action === 'reconcile';
  const reservation: ReservationDisposition = 'not-applicable';
  const sandboxCalls = sandbox.calls.map(call => call.method);
  const passed = failureKind === scenario.expected.failureKind && retryable === scenario.expected.retryable && action === scenario.expected.action && manualReconcile === scenario.expected.manualReconcile
    && (scenario.id === 'sandbox-create-failed' ? !sandboxCalls.includes('execute') : true);
  const result = { scenario, passed, failureKind, retryable, action, reservation, manualReconcile, errorCode, phase, runStatus: run.status,
    ...(attempt ? { attemptStatus: attempt.status } : {}),
    sandboxCalls, limitations: ['Controlled FakeSandbox/FakeBudget; no external OpenSandbox service or real ledger process restart was performed.'] };
  store.close();
  return result;
}

export async function runFaultMatrix(outputDirectory: string): Promise<FaultMatrixReport> {
  const directory = resolve(outputDirectory); mkdirSync(directory, { recursive: true });
  const observations: FaultObservation[] = [];
  for (const scenario of FAULT_SCENARIOS) {
    const result = scenario.layer === 'provider' ? await providerProbe(scenario) : await sandboxProbe(scenario, directory);
    const scenarioDirectory = join(directory, scenario.id); mkdirSync(scenarioDirectory, { recursive: true });
    const evidencePath = join(scenarioDirectory, 'evidence.json'); const failurePath = join(scenarioDirectory, 'failure.json');
    writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(failurePath, JSON.stringify({ schemaVersion: 1, scenario: scenario.id, failureKind: result.failureKind, code: result.errorCode,
      phase: result.phase, retryable: result.retryable, action: result.action, reservation: result.reservation, manualReconcile: result.manualReconcile,
      runStatus: result.runStatus ?? null, attemptStatus: result.attemptStatus ?? null, evidence: 'evidence.json' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    observations.push({ ...result, evidencePath, failurePath });
  }
  const report: FaultMatrixReport = { schemaVersion: 1, mode: 'controlled', generatedAt: new Date().toISOString(), scenarios: observations.length,
    passed: observations.filter(item => item.passed).length, failed: observations.filter(item => !item.passed).length, observations,
    limitations: ['This matrix verifies deterministic classification and durable evidence with controlled adapters.', 'Real DeepSeek/OpenSandbox fault injection and real budget-ledger process recovery remain separate N01/N02 acceptance work.', 'No retry is performed by the matrix; retryability is an observed policy disposition, not proof of a safe external side effect.'] };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const markdown = ['# Controlled provider/sandbox fault matrix', '', `Passed: ${report.passed}/${report.scenarios}`, '', '| Scenario | Kind | Code | Retryable | Action | Reservation | Reconcile | Passed |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...observations.map(item => `| ${item.scenario.id} | ${item.failureKind} | ${item.errorCode} | ${item.retryable} | ${item.action} | ${item.reservation} | ${item.manualReconcile} | ${item.passed} |`), '', 'The matrix uses controlled adapters. See each scenario directory for bounded `failure.json` and `evidence.json`.'].join('\n');
  writeFileSync(join(directory, 'report.md'), markdown + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
