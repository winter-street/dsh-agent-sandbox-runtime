import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
import type { ExecutionRef } from '../../src/contracts/sandbox.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import { loadConfig } from '../../src/config.js';
import { FakeBudget } from '../../tests/support/fakes.js';

const { OPEN_SANDBOX_DOMAIN: domain, OPEN_SANDBOX_IMAGE: image, OPEN_SANDBOX_API_KEY: apiKey } = process.env;
if (!domain || !image) throw new Error('Sandbox domain and image are required');
const connection = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true };
const root = `/tmp/runtime-timeout-tree-${randomUUID()}`;
await mkdir(root, { recursive: true });
const store = new RuntimeStore(`${root}/db`);
const artifacts = new ArtifactStore(`${root}/artifacts`);
const budget = new FakeBudget({ scopeKey: 'tree-scope', sessionIds: ['tree-session'], limitTokens: 10000 });
const config = loadConfig('/workspace/config/example.json');
config.sandbox.image = image;
config.sandbox.ttlSeconds = 300;
config.sandbox.commandTimeoutMs = 15000;
type Identity = { pid: number; start: string };
let observed: Record<string, { pid: number; start: string }> = {};
const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
const sleep = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
const hostSnapshot = async (processes: Record<string, { pid: number; start: string }>) => {
  const states: Record<string, { sameProcess: boolean; state?: string }> = {};
  for (const [name, process] of Object.entries(processes)) {
    try {
      const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const state = fields[0];
      assert.ok(state, 'Host process state is missing');
      states[name] = { sameProcess: fields[19] === process.start, state };
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      states[name] = { sameProcess: false };
    }
  }
  return states;
};
let remoteRunningAfterCancel: boolean | undefined;
class ObservedAdapter extends OpenSandboxAdapter {
  override async cancel(ref: ExecutionRef) {
    const sandboxRef = store.getSandbox('timeout-tree')!;
    const attempt = store.listAttempts('timeout-tree')[0]!;
    const client = await Sandbox.connect({ sandboxId: sandboxRef.sandboxId, connectionConfig: connection });
    try {
      const identities: Record<string, Identity> = {};
      for (const name of ['child', 'grandchild']) {
        identities[name] = JSON.parse(await client.files.readFile(`${attempt.workDir}/outputs/${name}.json`)) as Identity;
      }
      for (const pid of await readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')]);
          const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
          const namespacePids = status.match(/^NSpid:\s+([\d\s]+)$/m)?.[1]?.trim().split(/\s+/).map(Number);
          for (const [name, identity] of Object.entries(identities)) {
            if (namespacePids && namespacePids.length > 1 && namespacePids.at(-1) === identity.pid && fields[19] === identity.start) {
              assert.ok(!observed[name], `ambiguous host process for ${name}`);
              observed[name] = { pid: Number(pid), start: identity.start };
            }
          }
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      assert.equal(Object.keys(observed).length, 2, 'both detached descendants must be observable');
      const before = await hostSnapshot(observed);
      assert.ok(Object.values(before).every(item => item.sameProcess && item.state !== 'Z'), 'descendants must be alive before cleanup');
      checks.push({ name: 'detached-descendants-alive-before-timeout-cancel', passed: true, detail: { identities, hostProcesses: observed, before } });
    } finally { await client.close(); }
    const result = await super.cancel(ref);
    if (result.confirmed) {
      const client = await Sandbox.connect({ sandboxId: ref.sandboxId, connectionConfig: connection });
      try { remoteRunningAfterCancel = (await client.commands.getCommandStatus(ref.executionId)).running; }
      finally { await client.close(); }
    }
    return result;
  }
}
const adapter = new ObservedAdapter({ connection, pollIntervalMs: 150 });
const service = new RuntimeService(store, artifacts, adapter, budget, config, { pollIntervalMs: 150 });
let failed = false;
try {
  await service.createRun({ runId: 'timeout-tree', rootSessionId: 'tree-session', budgetScopeKey: 'tree-scope', task: 'Verify descendant cleanup',
    deadline: Date.now() + 300000, policyVersion: 'sandbox-smoke-v1', inputHash: 'd'.repeat(64) });
  const result = await service.executeCode({ runId: 'timeout-tree', stepId: 'first', inputs: [], code: `import json, os, pathlib, time
out = pathlib.Path(os.environ['AGENT_OUTPUT_DIR'])
def record(name):
    stat = pathlib.Path('/proc/%d/stat' % os.getpid()).read_text().rsplit(')', 1)[1].split()
    (out / (name + '.json')).write_text(json.dumps({'pid': os.getpid(), 'start': stat[19]}))
child = os.fork()
if child == 0:
    os.setsid()
    fd = os.open('/dev/null', os.O_RDWR)
    for target in (0, 1, 2): os.dup2(fd, target)
    if fd > 2: os.close(fd)
    record('child')
    grandchild = os.fork()
    if grandchild == 0: record('grandchild')
    time.sleep(120)
else:
    while not (out / 'grandchild.json').exists(): time.sleep(0.05)
    time.sleep(120)
` }).then(value => ({ value }), error => ({ error }));
  assert.ok('error' in result, `expected timeout, received ` + JSON.stringify({ result, attempts: store.listAttempts('timeout-tree') }));
  assert.equal((result.error as { code?: string }).code, 'EXECUTION_TIMEOUT');
  assert.equal(remoteRunningAfterCancel, false);
  assert.equal(store.listAttempts('timeout-tree')[0]!.status, 'TIMED_OUT');
  assert.equal(store.getRun('timeout-tree').status, 'RUNNING');
  assert.equal(store.getSandbox('timeout-tree'), undefined);
  let after = await hostSnapshot(observed);
  const until = Date.now() + 10000;
  while (Date.now() < until && Object.values(after).some(item => item.sameProcess && item.state !== 'Z')) {
    await sleep(100); after = await hostSnapshot(observed);
  }
  assert.ok(Object.values(after).every(item => !item.sameProcess || item.state === 'Z'), 'descendants must stop after cleanup');
  const firstSandbox = store.listAttempts('timeout-tree')[0]!.sandboxId;
  assert.ok(firstSandbox);
  let deleted = false;
  try {
    const client = await Sandbox.connect({ sandboxId: firstSandbox, connectionConfig: connection });
    try { await client.getInfo(); } finally { await client.close(); }
  } catch (error) {
    if (error instanceof SandboxApiException && error.statusCode === 404) deleted = true;
    else throw error;
  }
  assert.equal(deleted, true, 'independent sandbox lookup must confirm deletion');
  const next = await service.executeCode({ runId: 'timeout-tree', stepId: 'second', inputs: [], code:
    `import os, pathlib\n(pathlib.Path(os.environ['AGENT_OUTPUT_DIR']) / 'next.txt').write_text('ok')` });
  assert.equal(next.exitCode, 0);
  assert.notEqual(store.getAttempt(next.attemptId).sandboxId, firstSandbox);
  checks.push({ name: 'command-timeout-cleans-detached-descendants-before-next-step', passed: true,
    detail: { after, firstSandbox, nextSandbox: store.getAttempt(next.attemptId).sandboxId,
      remoteRunningAfterCancel, firstAttemptStatus: store.listAttempts('timeout-tree')[0]!.status, sandboxLookup: '404' } });
} catch (error) {
  failed = true;
  checks.push({ name: 'runtime-tree-error', passed: false, detail: { message: (error instanceof Error ? error.message : 'Unknown error').replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500) } });
} finally {
  const ref = store.getSandbox('timeout-tree');
  if (ref) {
    try { await adapter.destroy(ref); } catch { failed = true; }
  }
  store.close();
  const report = { checkedAt: new Date().toISOString(), realServiceInvoked: true, provider: 'none', budget: 'FakeBudget', checks };
  const reportPath = `/reports/runtime-timeout-tree-${randomUUID()}.json`;
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (failed) process.exitCode = 1;
}
