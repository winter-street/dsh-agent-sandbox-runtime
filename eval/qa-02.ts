import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ArtifactStore } from '../src/artifacts/index.js';
import { RuntimeService, type RuntimeServiceOptions } from '../src/core/service.js';
import { loadConfig } from '../src/config.js';
import { RuntimeError } from '../src/contracts/runtime.js';
import { RuntimeStore } from '../src/storage/index.js';
import { FakeBudget, FakeClock, FakeSandbox } from '../tests/support/fakes.js';

export interface Qa02ScenarioResult {
  id: string;
  description: string;
  execution: 'controlled-fake';
  modelCalled: false;
  realProvider: false;
  realSandbox: false;
  budget: 'FakeBudget';
  sandbox: 'FakeSandbox';
  passed: boolean;
  status: { run: string; attempt: string | null; errorCode: string | null };
  remoteStateConfirmed: boolean;
  cleanup: { destroyCalls: number; activeSandboxes: number; released: boolean };
  sandboxCalls: string[];
  errors: { code: string; message: string; phase?: string }[];
  limitations: string[];
}

export interface Qa02Report {
  schemaVersion: 1;
  mode: 'controlled';
  generatedAt: string;
  scenarios: number;
  passed: number;
  failed: number;
  results: Qa02ScenarioResult[];
  realEvidence: string[];
  limitations: string[];
}

interface Fixture {
  root: string;
  runId: string;
  stepId: string;
  clock: FakeClock;
  store: RuntimeStore;
  artifacts: ArtifactStore;
  sandbox: FakeSandbox;
  budget: FakeBudget;
  service: RuntimeService;
  input: { runId: string; stepId: string; code: string; inputs: never[] };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const errorInfo = (error: unknown): { code: string; message: string; phase?: string } => {
  if (error instanceof RuntimeError) return { code: error.code, message: error.message, ...(error.details.phase ? { phase: error.details.phase } : {}) };
  if (error instanceof Error) return { code: error.name || 'ERROR', message: error.message };
  return { code: 'ERROR', message: String(error) };
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function baseLimitations(): string[] {
  return [
    '受控 FakeSandbox/FakeBudget；没有调用 DeepSeek、原预算插件或外部 OpenSandbox。',
    'SQLite、RuntimeService、ArtifactStore 和状态转换使用真实实现；替身只覆盖外部 provider/sandbox/ledger 边界。',
  ];
}

async function createFixture(directory: string, id: string, options: { maxFiles?: number; maxBytes?: number; budgetLimit?: number; service?: RuntimeServiceOptions } = {}): Promise<Fixture> {
  const root = join(resolve(directory), id);
  mkdirSync(root, { recursive: true });
  const clock = new FakeClock(1_000);
  const runId = `${id}-run`;
  const stepId = `${id}-step`;
  const sessionId = `${id}-session`;
  const scopeKey = `${id}-scope`;
  const store = new RuntimeStore(join(root, 'database'), clock.now);
  const artifacts = new ArtifactStore(join(root, 'artifacts'), {
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const sandbox = new FakeSandbox({ clock });
  const budget = new FakeBudget({ scopeKey, sessionIds: [sessionId], limitTokens: options.budgetLimit ?? 10_000, clock });
  const config = loadConfig(resolve('config/example.json'));
  config.sandbox.commandTimeoutMs = 250;
  const service = new RuntimeService(store, artifacts, sandbox, budget, config, {
    now: clock.now,
    wait: clock.sleep,
    pollIntervalMs: 100,
    validate: async () => ({ passed: true, evidence: { validator: 'qa-02-controlled' } }),
    ...(options.service ?? {}),
  });
  await service.createRun({ runId, rootSessionId: sessionId, budgetScopeKey: scopeKey, task: `QA-02 ${id}`,
    deadline: clock.now() + 60_000, policyVersion: 'budget-policy-v1', inputHash: sha256(id) });
  return { root, runId, stepId, clock, store, artifacts, sandbox, budget, service,
    input: { runId, stepId, code: 'print(42)', inputs: [] } };
}

async function withFixture<T>(directory: string, id: string, options: Parameters<typeof createFixture>[2], run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const fixture = await createFixture(directory, id, options);
  try { return await run(fixture); } finally { fixture.store.close(); }
}

function status(fixture: Fixture): Qa02ScenarioResult['status'] {
  const run = fixture.store.getRun(fixture.runId);
  const attempt = fixture.store.listAttempts(fixture.runId)[0];
  return { run: run.status, attempt: attempt?.status ?? null, errorCode: attempt?.errorCode ?? null };
}

function cleanup(fixture: Fixture): Qa02ScenarioResult['cleanup'] {
  const destroyCalls = fixture.sandbox.calls.filter(call => call.method === 'destroy').length;
  const activeSandboxes = fixture.sandbox.sandboxRefs.length;
  return { destroyCalls, activeSandboxes, released: activeSandboxes === 0 };
}

function result(fixture: Fixture, id: string, description: string, passed: boolean, remoteStateConfirmed: boolean, errors: unknown[]): Qa02ScenarioResult {
  return { id, description, execution: 'controlled-fake', modelCalled: false, realProvider: false, realSandbox: false,
    budget: 'FakeBudget', sandbox: 'FakeSandbox', passed, status: status(fixture), remoteStateConfirmed,
    cleanup: cleanup(fixture), sandboxCalls: fixture.sandbox.calls.map(call => call.method), errors: errors.map(errorInfo), limitations: baseLimitations() };
}

async function normal(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'normal-execution', {}, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      stdout: '42', outputs: [{ path: 'result.txt', content: Buffer.from('42') }],
    } });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); await fixture.service.finalize(fixture.runId, true); }
    catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'normal-execution', '正常执行、独立校验和完整交付', state.run === 'SUCCEEDED' && state.attempt === 'SUCCEEDED' && cleanup(fixture).released, true, errors);
  });
}

async function scriptError(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'script-error', {}, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'FAILED', exitCode: 7 }], collect: {
      stderr: 'expected failure', outputs: [{ path: 'failure.txt', content: Buffer.from('failure') }],
    } });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); await fixture.service.finalize(fixture.runId, false); }
    catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'script-error', '脚本非零退出被记录为 SCRIPT_FAILED 并交付部分结果', state.run === 'COMPLETED_PARTIAL' && state.attempt === 'FAILED' && state.errorCode === 'SCRIPT_FAILED' && cleanup(fixture).released, true, errors);
  });
}

async function timeout(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'command-timeout', {}, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: true });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); }
    catch (error) { errors.push(error); }
    try { await fixture.service.finalize(fixture.runId, false); } catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'command-timeout', '命令超时后确认远端取消并回收沙箱', state.attempt === 'TIMED_OUT' && state.errorCode === 'EXECUTION_TIMEOUT' && cleanup(fixture).released, true, errors);
  });
}

async function clientCancel(directory: string): Promise<Qa02ScenarioResult> {
  const controller = new AbortController();
  let waits = 0;
  return withFixture(directory, 'client-cancel', { service: {
    wait: async ms => { waits += 1; await Promise.resolve(); if (waits === 1) controller.abort(); },
  } }, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'RUNNING' }, { state: 'RUNNING' }], cancelConfirmed: true });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input, controller.signal); } catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'client-cancel', '客户端取消后确认远端停止并进入 CANCELLED', state.run === 'CANCELLED' && state.attempt === 'CANCELLED' && cleanup(fixture).released, true, errors);
  });
}

async function cancelUnconfirmed(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'cancel-unconfirmed', {}, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'RUNNING' }], cancelConfirmed: false });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); } catch (error) { errors.push(error); }
    const ref = fixture.sandbox.executionRefs[0];
    if (ref) fixture.sandbox.setCancelConfirmed(ref.executionId, true);
    try { await fixture.service.cancelRun(fixture.runId, 'qa02-confirm-cancel', { reason: 'operator-confirmation' }); } catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'cancel-unconfirmed', '首次取消无法确认时保留恢复状态，二次确认后回收', state.run === 'CANCELLED' && state.attempt === 'CANCELLED' && errors.some(error => errorInfo(error).code === 'CANCEL_UNCONFIRMED') && cleanup(fixture).released, true, errors);
  });
}

async function artifactLimit(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'artifact-limit', { maxFiles: 1 }, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'a.txt', content: Buffer.from('a') }, { path: 'b.txt', content: Buffer.from('b') }],
    } });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); } catch (error) { errors.push(error); }
    try { await fixture.service.cancelRun(fixture.runId, 'qa02-limit-cleanup', { reason: 'artifact-limit' }); } catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'artifact-limit', '产物数量限制阻止发布并保留可审计失败', state.run === 'CANCELLED' && state.attempt === 'CANCELLED' && errors.some(error => errorInfo(error).code === 'ARTIFACT_INVALID') && cleanup(fixture).released, true, errors);
  });
}

async function artifactBytes(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'artifact-bytes', { maxBytes: 1 }, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.txt', content: Buffer.from('too-large') }],
    } });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); } catch (error) { errors.push(error); }
    try { await fixture.service.cancelRun(fixture.runId, 'qa02-bytes-cleanup', { reason: 'artifact-bytes' }); } catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'artifact-bytes', '产物总字节限制阻止发布并保留可审计失败', state.run === 'CANCELLED' && state.attempt === 'CANCELLED' && errors.some(error => errorInfo(error).code === 'ARTIFACT_INVALID') && cleanup(fixture).released, true, errors);
  });
}

async function artifactPath(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'artifact-path', {}, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: '../escape.txt', content: Buffer.from('unsafe') }],
    } });
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); } catch (error) { errors.push(error); }
    try { await fixture.service.cancelRun(fixture.runId, 'qa02-path-cleanup', { reason: 'artifact-path' }); } catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'artifact-path', '产物路径校验拒绝路径穿越', state.run === 'CANCELLED' && state.attempt === 'CANCELLED' && errors.some(error => errorInfo(error).code === 'ARTIFACT_INVALID') && cleanup(fixture).released, true, errors);
  });
}

async function artifactHash(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'artifact-hash', {}, async fixture => {
    fixture.sandbox.enqueue({ states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: {
      outputs: [{ path: 'result.txt', content: Buffer.from('original') }],
    } });
    const errors: unknown[] = [];
    try {
      await fixture.service.executeCode(fixture.input);
      const artifact = fixture.store.listArtifacts(fixture.runId)[0];
      if (!artifact) throw new Error('Expected a committed artifact');
      writeFileSync(join(fixture.artifacts.rootDir, 'runs', fixture.runId, 'attempts', artifact.attemptId, 'files', artifact.path), 'tampered', { encoding: 'utf8' });
      await fixture.artifacts.verify([artifact]);
    } catch (error) { errors.push(error); }
    try { await fixture.service.cancelRun(fixture.runId, 'qa02-hash-cleanup', { reason: 'artifact-hash' }); } catch (error) { errors.push(error); }
    const state = status(fixture);
    return result(fixture, 'artifact-hash', '已提交产物被篡改后 hash 校验失败', state.run === 'CANCELLED' && state.attempt === 'SUCCEEDED' && errors.some(error => errorInfo(error).code === 'ARTIFACT_INVALID') && cleanup(fixture).released, true, errors);
  });
}

async function budgetUnknown(directory: string): Promise<Qa02ScenarioResult> {
  return withFixture(directory, 'budget-unknown', { budgetLimit: 100 }, async fixture => {
    const reservation = fixture.budget.reserve({ scopeKey: `${'budget-unknown'}-scope`, sessionId: 'budget-unknown-session', provider: 'controlled', model: 'controlled', modelCallId: 'qa02-seed-call', purpose: 'work', estimatedTokens: 10 });
    if (!reservation.allowed) throw new Error('Failed to seed the unknown budget reservation');
    fixture.budget.markDispatched(reservation.reservation.reservationId);
    fixture.budget.markUnknown(reservation.reservation.reservationId, 'qa-02-seeded-unknown-usage');
    const errors: unknown[] = [];
    try { await fixture.service.executeCode(fixture.input); } catch (error) { errors.push(error); }
    const state = status(fixture);
    const sandboxStarted = fixture.sandbox.calls.some(call => call.method === 'create' || call.method === 'execute');
    return result(fixture, 'budget-unknown', '原预算用量未知时不启动新的沙箱执行', state.run === 'PAUSED_ACCOUNTING' && state.attempt === null && errors.some(error => errorInfo(error).code === 'USAGE_UNKNOWN') && !sandboxStarted, false, errors);
  });
}

export async function runQa02(outputDirectory: string): Promise<Qa02Report> {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const results = [
    await normal(directory),
    await scriptError(directory),
    await timeout(directory),
    await clientCancel(directory),
    await cancelUnconfirmed(directory),
    await artifactLimit(directory),
    await artifactBytes(directory),
    await artifactPath(directory),
    await artifactHash(directory),
    await budgetUnknown(directory),
  ];
  const report: Qa02Report = {
    schemaVersion: 1,
    mode: 'controlled',
    generatedAt: new Date().toISOString(),
    scenarios: results.length,
    passed: results.filter(item => item.passed).length,
    failed: results.filter(item => !item.passed).length,
    results,
    realEvidence: [
      'docs/evidence/P1-06-harness.md',
      'docs/evidence/P1-07.md',
      'docs/evidence/P1-08.md',
      'docs/evidence/N02-budget-process-recovery.md',
    ],
    limitations: [
      '本 runner 不声明真实 DeepSeek provider 成功、错误、断流、usage 或取消后的计费语义。',
      '本 runner 不声明真实 OpenSandbox 在所有进程树、创建结果未知和资源压力条件下的回收行为。',
      '历史正式评测的 finalEvaluationEligible=false 保持不变。',
    ],
  };
  for (const item of results) writeJson(join(directory, item.id, 'evidence.json'), item);
  writeJson(join(directory, 'report.json'), report);
  const lines = [
    '# QA-02 受控验收证据', '', `通过：${report.passed}/${report.scenarios}`, '',
    '| 场景 | 结果 | Run | Attempt | 错误 | 远端状态确认 | 沙箱回收 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(item => `| ${item.id} | ${item.passed ? 'PASS' : 'FAIL'} | ${item.status.run} | ${item.status.attempt ?? '-'} | ${item.errors.map(error => error.code).join(', ') || '-'} | ${item.remoteStateConfirmed} | ${item.cleanup.released} |`),
    '', '每个场景的脱敏 JSON 见对应目录的 `evidence.json`。所有场景均使用真实 SQLite/RuntimeService/ArtifactStore，但外部 provider、预算账本和沙箱均为明确标注的受控替身。',
  ];
  writeFileSync(join(directory, 'report.md'), `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return report;
}
