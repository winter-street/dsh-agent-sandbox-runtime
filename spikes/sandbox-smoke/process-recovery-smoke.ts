import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import { loadConfig } from '../../src/config.js';
import { RuntimeService } from '../../src/core/service.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeBudget } from '../../tests/support/fakes.js';

const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
if (!domain || !image) throw new Error('OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE are required');
const worker = process.argv.includes('--worker');
const crashWindow = process.env.RUNTIME_PROCESS_CRASH_WINDOW ?? 'after-publish';
if (!['after-publish', 'after-destroy'].includes(crashWindow)) throw new Error('Unsupported process recovery crash window');
const root = process.env.RUNTIME_PROCESS_RECOVERY_ROOT ?? await mkdtemp(join(tmpdir(), 'runtime-process-recovery-'));
const config = loadConfig('/workspace/config/example.json');
config.sandbox.image = image; config.sandbox.ttlSeconds = 300; config.sandbox.commandTimeoutMs = 120000;
const budget = new FakeBudget({ scopeKey: 'process-smoke-scope', limitTokens: 10000, sessionIds: ['process-smoke-root'] });
const adapter = () => new OpenSandboxAdapter({ connection: { domain, ...(apiKey ? { apiKey } : {}),
  requestTimeoutSeconds: 60, disableMetrics: true } });
const artifacts = new ArtifactStore(join(root, 'artifacts'));
const input = { runId: 'process-recovery-run', stepId: 'process-recovery-step', inputs: [], code: [
  'import os, pathlib',
  'pathlib.Path(os.environ["AGENT_OUTPUT_DIR"]).joinpath("result.json").write_text(\'{"proof":"process-kill-recovery"}\')',
  'print("process-kill-recovery")',
].join('\n') };
const validate = async () => {
  const files = await artifacts.list();
  const output = files.published.flatMap(p => p.artifacts).find(a => a.path === 'result.json');
  const passed = !!output && Buffer.from(await artifacts.read(output)).toString() === '{"proof":"process-kill-recovery"}';
  return { passed, evidence: { expected: 'fixed literal output checked independently from task status' } };
};

if (worker) {
  const store = new RuntimeStore(join(root, 'database'));
  const service = new RuntimeService(store, artifacts, adapter(), budget, config, {
    pollIntervalMs: 150,
    fault: async point => {
      if (point === crashWindow) {
        process.send?.({ window: crashWindow, runId: input.runId });
        await delay(300000); // Parent sends SIGKILL before this fault hook returns.
      }
    },
  });
  await service.createRun({ runId: input.runId, rootSessionId: 'process-smoke-root', budgetScopeKey: 'process-smoke-scope',
    task: 'Verify OS process termination and remote result recovery', deadline: Date.now() + 240000,
    policyVersion: 'process-smoke-v1', inputHash: 'e'.repeat(64) });
  await service.executeCode(input);
  throw new Error('Parent failed to terminate the worker at its requested crash window');
} else {
  const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
  let store: RuntimeStore | undefined;
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
    execArgv: ['--import', 'tsx'], env: { ...process.env, RUNTIME_PROCESS_RECOVERY_ROOT: root },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let childDiagnostic = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { childDiagnostic = (childDiagnostic + chunk).slice(-4000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal })); child.once('error', reject);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>(resolveReady => child.on('message', message => {
        if (message && typeof message === 'object' && 'window' in message && message.window === crashWindow) resolveReady();
      })),
      exited.then(exit => { throw new Error(`Worker exited before reaching the requested crash window (${exit.code}/${exit.signal}): ${childDiagnostic.replaceAll(apiKey ?? '\0', '[redacted]').slice(-1200)}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Worker crash-window wait timed out')), 90000); }),
    ]);
    if (timer) clearTimeout(timer);
    assert.ok(child.kill('SIGKILL'), 'OS must accept worker termination');
    const exit = await exited;
    assert.equal(exit.signal, 'SIGKILL');
    const deadOwner = JSON.parse(await readFile(join(root, 'database/writer.lock'), 'utf8')) as { pid: number };
    assert.equal(deadOwner.pid, child.pid);
    checks.push({ name: 'actual-worker-sigkill', passed: true, detail: { pid: child.pid, ...exit, crashWindow } });

    store = new RuntimeStore(join(root, 'database'));
    assert.equal(store.listArtifacts(input.runId).length, crashWindow === 'after-publish' ? 0 : 1);
    assert.equal((await artifacts.list()).published.length, 1);
    const original = store.listAttempts(input.runId)[0]!;
    const originalRun = store.getRun(input.runId);
    assert.equal(original.status, crashWindow === 'after-publish' ? 'RUNNING' : 'SUCCEEDED'); assert.ok(original.executionId);
    assert.ok(original.sandboxId, 'original sandbox identity must be retained in the attempt');
    const confirmDeleted = async () => {
      try {
        const client = await Sandbox.connect({ sandboxId: original.sandboxId!,
          connectionConfig: { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true } });
        try { await client.getInfo(); } finally { await client.close(); }
      } catch (error) {
        if (error instanceof SandboxApiException && error.statusCode === 404) return;
        throw error;
      }
      throw new Error('Fresh SDK lookup must confirm sandbox deletion with 404');
    };
    if (crashWindow === 'after-destroy') {
      const ref = store.getSandbox(input.runId);
      const cleanup = store.getComponentState(input.runId, 'runtime', 'sandbox-cleanup') as
        { pending?: boolean; commandStopped?: boolean; sandboxId?: string; attemptId?: string } | undefined;
      assert.equal(ref?.sandboxId, original.sandboxId, 'crashed worker must leave the local sandbox reference');
      assert.equal(cleanup?.pending, true, 'cleanup must remain pending before recovery');
      assert.equal(cleanup?.commandStopped, true);
      assert.equal(cleanup?.sandboxId, original.sandboxId);
      assert.equal(cleanup?.attemptId, original.attemptId);
      await confirmDeleted();
      checks.push({ name: 'destroyed-sandbox-with-pending-local-cleanup', passed: true,
        detail: { sandboxId: original.sandboxId, sandboxLookup: '404 before recovery', pending: true } });
    }
    const service = new RuntimeService(store, artifacts, adapter(), budget, config, { pollIntervalMs: 150, validate });
    await service.recover(input.runId);
    assert.equal(store.getSandbox(input.runId), undefined, 'recovery must release the sandbox reference');
    await confirmDeleted();
    checks.push({ name: 'recovery-confirms-sandbox-cleanup', passed: true,
      detail: { sandboxId: original.sandboxId, sandboxLookup: '404 after deletion' } });
    const replay = await service.executeCode(input);
    assert.equal(replay.attemptId, original.attemptId);
    assert.equal(store.listAttempts(input.runId).length, 1);
    assert.equal(store.listAttempts(input.runId)[0]?.executionId, original.executionId);
    assert.equal(store.eventsAfter(input.runId).filter(e => e.type === 'tool.finished').length, 1);
    const final = await service.finalize(input.runId, true);
    assert.equal(final.run.status, 'SUCCEEDED');
    assert.equal(final.run.deadline, originalRun.deadline);
    checks.push({ name: 'new-process-lock-and-remote-result-recovery', passed: true, detail: {
      attemptId: original.attemptId, executionId: original.executionId, sandboxId: original.sandboxId,
      attemptCount: 1, artifactSha256: replay.artifacts[0]?.sha256, finalStatus: final.run.status,
      originalDeadlineRetained: final.run.deadline === originalRun.deadline,
    } });
  } catch (error) {
    checks.push({ name: 'process-recovery-smoke', passed: false,
      detail: { message: (error instanceof Error ? error.message : 'unknown').replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 1600) } });
    process.exitCode = 1;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.catch(() => {}); }
    if (!store) { try { store = new RuntimeStore(join(root, 'database')); } catch { /* no durable run may exist */ } }
    if (store) {
      for (const run of store.listRuns()) {
        const ref = store.getSandbox(run.runId);
        if (!ref) continue;
        try { await adapter().destroy(ref); store.releaseSandbox(ref); }
        catch { checks.push({ name: 'sandbox-cleanup', passed: false, detail: { sandboxId: ref.sandboxId } }); process.exitCode = 1; }
      }
      store.close();
    }
    const report = { checkedAt: new Date().toISOString(), sdk: '1.2.1', realServiceInvoked: true,
      processTermination: 'SIGKILL of separate Node worker in Docker client container',
      budget: 'FakeBudget only; no model calls or real-plugin ledger recovery', checks };
    const target = resolve(process.env.RUNTIME_PROCESS_SMOKE_OUTPUT ?? '/reports/process-recovery-smoke.json');
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
}
