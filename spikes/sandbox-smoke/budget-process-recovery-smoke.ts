import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { connectBudgetService } from '../../src/adapters/budget/index.ts';
import { BudgetReceiptSynchronizer } from '../../src/adapters/budget/receipts.ts';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.ts';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { loadConfig } from '../../src/config.ts';
import { RuntimeService } from '../../src/core/service.ts';
import { RuntimeStore } from '../../src/storage/index.ts';

const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
if (!domain || !image || !apiKey) throw new Error('OPEN_SANDBOX_DOMAIN, OPEN_SANDBOX_IMAGE and OPEN_SANDBOX_API_KEY are required');

const worker = process.argv.includes('--worker');
const crashPoint = process.env.RUNTIME_BUDGET_RECOVERY_CRASH_POINT ?? 'after-publish';
const root = process.env.RUNTIME_BUDGET_RECOVERY_ROOT ?? await mkdtemp(join(tmpdir(), 'runtime-budget-recovery-'));
const budgetDirectory = join(root, 'budget');
const databaseDirectory = join(root, 'database');
const artifactDirectory = join(root, 'artifacts');
const runId = 'budget-process-recovery-run';
const rootSessionId = 'budget-process-recovery-root';
const reservationModelCallId = 'budget-process-recovery-call';
const config = loadConfig('/workspace/config/example.json');
Object.assign(config.sandbox, { image, ttlSeconds: 300, commandTimeoutMs: 120_000, maxOutputBytes: 1_048_576, maxOutputFiles: 8, maxLogBytes: 8_192 });

const input = {
  runId,
  stepId: 'budget-process-recovery-step',
  inputs: [],
  code: [
    'import os, pathlib',
    'pathlib.Path(os.environ["AGENT_OUTPUT_DIR"]).joinpath("result.json").write_text(\'{"proof":"budget-process-recovery"}\')',
    'print("budget-process-recovery")',
  ].join('\n'),
};

const adapter = () => new OpenSandboxAdapter({
  connection: { domain, apiKey, requestTimeoutSeconds: 60, disableMetrics: true },
  pollIntervalMs: 150,
  cancelTimeoutMs: 10_000,
});

async function loadBudget(ctx: Context, storageDir: string) {
  const module = await import('/workspace/.sources/budget/lib/index.js') as { name: string; inject: string[]; apply: (context: Context, options: unknown) => void };
  await ctx.plugin({ name: module.name, inject: module.inject, apply: module.apply }, {
    maxTokens: 10_000,
    reservationMode: true,
    pressurePrompt: false,
    storageDir,
    maxConcurrentCalls: 1,
  }).await();
  return connectBudgetService(ctx);
}

async function loadContext(): Promise<{ ctx: Context; budget: ReturnType<typeof connectBudgetService>; rootAgent: Awaited<ReturnType<Context['agents']['create']>> }> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(SessionProjection).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  const budget = await loadBudget(ctx, budgetDirectory);
  const rootAgent = await ctx.agents.create({ sessionId: SessionId(rootSessionId), agentOptions: { provider: 'unused', model: 'unused' } });
  return { ctx, budget, rootAgent };
}

async function runWorker(): Promise<void> {
  const { ctx, budget, rootAgent } = await loadContext();
  const artifacts = new ArtifactStore(artifactDirectory);
  const store = new RuntimeStore(databaseDirectory);
  const service = new RuntimeService(store, artifacts, adapter(), budget.port, config, {
    pollIntervalMs: 150,
    fault: async point => {
      if (point === crashPoint) {
        process.send?.({ event: 'crash-window', runId, crashPoint });
        await delay(300_000);
      }
    },
  });
  try {
    const scopeKey = await budget.port.scopeForSession(rootSessionId);
    await service.createRun({ runId, rootSessionId, budgetScopeKey: scopeKey, task: 'Recover a remote sandbox result after worker termination',
      deadline: Date.now() + 240_000, policyVersion: 'budget-process-recovery-v1', inputHash: 'b'.repeat(64) });
    const reservation = await budget.port.reserve({ scopeKey, modelCallId: reservationModelCallId, sessionId: rootSessionId,
      provider: 'controlled-recovery', model: 'controlled-recovery', purpose: 'work', estimatedTokens: 100 });
    assert.equal(reservation.allowed, true);
    if (!reservation.allowed) throw new Error(`Unexpected budget reservation denial: ${reservation.reason}`);
    await budget.port.markDispatched(reservation.reservation.reservationId);
    process.send?.({ event: 'budget-dispatched', reservationId: reservation.reservation.reservationId, scopeKey });

    await service.executeCode(input);
    throw new Error('Parent did not terminate the worker at the requested crash window');
  } finally {
    try { await rootAgent.dispose(); } catch { /* worker is intentionally terminated in the smoke */ }
    try { await ctx.fiber.dispose(); } catch { /* worker is intentionally terminated in the smoke */ }
    store.close();
  }
}

function reclaimDeadBudgetLock(): { pid: number; reclaimed: boolean } {
  const path = join(budgetDirectory, 'writer.lock');
  const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
  if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) throw new Error('Budget writer lock has no valid owner PID');
  try { process.kill(owner.pid!, 0); throw new Error(`Budget writer PID ${owner.pid} is still alive`); }
  catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code !== 'ESRCH') throw error;
    unlinkSync(path);
  }
  return { pid: owner.pid!, reclaimed: true };
}

async function runParent(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, RUNTIME_BUDGET_RECOVERY_ROOT: root },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostic = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-4000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    child.once('error', reject);
  });
  let reservationId = '';
  let scopeKey = '';
  let ready = false;
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const value = message as { event?: string; reservationId?: string; scopeKey?: string };
    if (value.event === 'budget-dispatched') { reservationId = value.reservationId ?? ''; scopeKey = value.scopeKey ?? ''; }
    if (value.event === 'crash-window' && value.crashPoint === crashPoint) ready = true;
  };
  child.on('message', onMessage);
  try {
    const deadline = Date.now() + 90_000;
    while (!ready && Date.now() < deadline) {
      const exit = await Promise.race([exited, delay(100).then(() => null)]);
      if (exit) throw new Error(`Worker exited before crash window (${exit.code}/${exit.signal}): ${diagnostic}`);
    }
    if (!ready) throw new Error(`Worker did not reach ${crashPoint} crash window`);
    assert.ok(reservationId && scopeKey, 'worker must persist the original budget reservation identity');
    assert.equal(child.kill('SIGKILL'), true);
    const exit = await exited;
    assert.equal(exit.signal, 'SIGKILL');
    checks.push({ name: `actual-worker-sigkill-${crashPoint}`, passed: true, detail: { pid: child.pid, ...exit, reservationId, crashPoint } });

    const budgetLock = reclaimDeadBudgetLock();
    checks.push({ name: 'safe-reclaim-of-dead-budget-writer-lock', passed: budgetLock.reclaimed, detail: budgetLock });

    const { ctx, budget, rootAgent } = await loadContext();
    const artifacts = new ArtifactStore(artifactDirectory);
    const store = new RuntimeStore(databaseDirectory);
    const service = new RuntimeService(store, artifacts, adapter(), budget.port, config, {
      pollIntervalMs: 150,
      validate: async (_run, records, read) => {
        const record = records.find(item => item.path === 'result.json');
        const value = record ? Buffer.from(await read(record)).toString('utf8') : '';
        return { passed: value === '{"proof":"budget-process-recovery"}', evidence: { expected: 'fixed process recovery output', value } };
      },
    });
    try {
      const beforeRecovery = store.getRun(runId);
      const originalAttempt = store.listAttempts(runId)[0]!;
      const originalExecutionId = originalAttempt.executionId;
      const unknown = await budget.reader.snapshot(scopeKey);
      assert.equal(unknown.unknownCalls, 1);
      assert.equal(unknown.reservedTokens, 100);
      if (crashPoint === 'after-publish') {
        assert.equal(store.listArtifacts(runId).length, 0);
        assert.equal((await artifacts.list()).published.length, 1);
        checks.push({ name: 'reopen-preserves-scope-and-marks-dispatched-usage-unknown', passed: true, detail: {
          scopeKey, reservationId, unknownCalls: unknown.unknownCalls, reservedTokens: unknown.reservedTokens,
        } });

        await service.recover(runId);
        const recoveredAttempt = store.listAttempts(runId)[0]!;
        assert.equal(recoveredAttempt.attemptId, originalAttempt.attemptId);
        assert.equal(recoveredAttempt.executionId, originalExecutionId);
        assert.equal(recoveredAttempt.status, 'SUCCEEDED');
        assert.equal(store.listAttempts(runId).length, 1);
        assert.equal(store.listArtifacts(runId).length, 1);
        assert.equal(store.getRun(runId).status, 'PAUSED_ACCOUNTING');
        checks.push({ name: 'reconnects-original-execution-and-commits-without-redispatch', passed: true, detail: {
          attemptId: recoveredAttempt.attemptId, executionId: recoveredAttempt.executionId, artifactSha256: store.listArtifacts(runId)[0]?.sha256,
        } });

        await budget.port.settle(reservationId, { inputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 15 });
        await budget.port.settle(reservationId, { inputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 15 });
        await assert.rejects(async () => budget.port.settle(reservationId, { inputTokens: 26, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 15 }));
        const settled = await budget.reader.snapshot(scopeKey);
        assert.equal(settled.unknownCalls, 0);
        assert.equal(settled.reservedTokens, 0);
        assert.equal(settled.usedTokens, 40);
        checks.push({ name: 'late-usage-settles-once-and-conflicting-duplicate-is-rejected', passed: true, detail: {
          reservationId, usedTokens: settled.usedTokens, unknownCalls: settled.unknownCalls, reservedTokens: settled.reservedTokens,
        } });

        const paused = store.getRun(runId);
        await service.resumeRun(runId, 'budget-recovery-resume', paused.revision);
        const replay = await service.executeCode(input);
        assert.equal(replay.attemptId, originalAttempt.attemptId);
        assert.equal(store.listAttempts(runId).length, 1);
        const final = await service.finalize(runId, true);
        assert.equal(final.run.status, 'SUCCEEDED');
        const sync = new BudgetReceiptSynchronizer(store, budget.reader, join(root, 'receipt-sync'));
        const imported = await sync.sync(runId);
        assert.ok(imported.imported > 0);
        checks.push({ name: 'same-attempt-replay-and-finalization-retain-original-budget-scope', passed: true, detail: {
          attemptId: replay.attemptId, attemptCount: store.listAttempts(runId).length, finalStatus: final.run.status,
          originalDeadlineRetained: final.run.deadline === beforeRecovery.deadline, receiptCursor: imported.cursor,
        } });
      } else {
        assert.equal(store.listArtifacts(runId).length, 0);
        assert.equal(originalAttempt.executionId, null);
        await service.recover(runId);
        const recoveredAttempt = store.listAttempts(runId)[0]!;
        assert.equal(recoveredAttempt.attemptId, originalAttempt.attemptId);
        assert.equal(recoveredAttempt.status, 'UNKNOWN');
        assert.equal(recoveredAttempt.executionId, null);
        assert.equal(store.getRun(runId).status, 'RECOVERY_REQUIRED');
        const sandboxRef = store.getSandbox(runId);
        assert.ok(sandboxRef);
        await adapter().destroy(sandboxRef);
        store.releaseSandbox(sandboxRef);
        await budget.port.settle(reservationId, { inputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 15 });
        const settled = await budget.reader.snapshot(scopeKey);
        assert.equal(settled.unknownCalls, 0);
        assert.equal(settled.reservedTokens, 0);
        assert.equal(settled.usedTokens, 40);
        checks.push({ name: 'early-crash-preserves-unknown-and-never-redispatches', passed: true, detail: {
          crashPoint, attemptId: recoveredAttempt.attemptId, attemptStatus: recoveredAttempt.status,
          runStatus: store.getRun(runId).status, sandboxCleaned: store.getSandbox(runId) === undefined,
          usedTokens: settled.usedTokens, originalDeadlineRetained: store.getRun(runId).deadline === beforeRecovery.deadline,
        } });
      }
    } finally {
      for (const run of store.listRuns()) { const ref = store.getSandbox(run.runId); if (ref) { await adapter().destroy(ref).catch(() => {}); store.releaseSandbox(ref); } }
      store.close();
      try { await rootAgent.dispose(); } catch { /* cleanup */ }
      try { await ctx.fiber.dispose(); } catch { /* cleanup */ }
    }
  } catch (error) {
    checks.push({ name: 'budget-process-recovery', passed: false, detail: { message: error instanceof Error ? error.message : String(error), diagnostic } });
    process.exitCode = 1;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.catch(() => {}); }
    const processTermination = crashPoint === 'after-publish'
      ? 'SIGKILL of separate Node worker after remote artifact publication and before local SQLite result commit'
      : `SIGKILL of separate Node worker at ${crashPoint} before local execution identity commit`;
    const limitations = [
      crashPoint === 'after-publish'
        ? 'The worker is killed after remote artifact publication and before local SQLite result commit.'
        : `The worker is killed at ${crashPoint}; the remote command has no execution identity persisted locally and is conservatively cleaned up.`,
      'The late usage is a trusted reconciliation fixture; it is not provider invoice verification.',
      'This does not claim arbitrary external side effects are exactly once.',
      'A future provider-native crash window remains separate from this sandbox/runtime probe.',
    ];
    const report = { checkedAt: new Date().toISOString(), crashPoint, sdk: 'OpenSandbox SDK 1.2.1', runtime: 'RuntimeService + OpenSandboxAdapter + original patched budget plugin', realServiceInvoked: true,
      processTermination, budget: 'original patched budget plugin; no model/provider calls', checks, limitations };
    const target = resolve(process.env.RUNTIME_BUDGET_RECOVERY_OUTPUT ?? '/reports/budget-process-recovery-smoke.json');
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (checks.some(check => !check.passed)) process.exitCode = 1;
  }
}

if (worker) await runWorker();
else await runParent();
