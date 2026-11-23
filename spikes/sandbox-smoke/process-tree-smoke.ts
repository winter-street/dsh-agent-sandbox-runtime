import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox } from '@alibaba-group/opensandbox';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import type { ExecutionPolicy, SandboxRef } from '../../src/contracts/sandbox.js';

const { OPEN_SANDBOX_DOMAIN: domain, OPEN_SANDBOX_IMAGE: image, OPEN_SANDBOX_API_KEY: apiKey, PROCESS_TREE_OUTPUT: reportPath } = process.env;
if (!domain || !image || !reportPath) throw new Error('Sandbox domain, image and report path are required');
const connection = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 60, disableMetrics: true };
const policy: ExecutionPolicy = { image, cpu: 1, memoryMiB: 512, ttlSeconds: 180, commandTimeoutMs: 90_000,
  maxLogBytes: 8192, maxOutputBytes: 1_048_576, maxOutputFiles: 8, network: { defaultAction: 'deny', allowHosts: [] } };
const adapter = new OpenSandboxAdapter({ connection, cancelTimeoutMs: 10_000, pollIntervalMs: 100 });
const detached = process.env.PROCESS_TREE_DETACHED === '1';
const verifyDestroy = process.env.PROCESS_TREE_VERIFY_DESTROY === '1';
const normalExit = process.env.PROCESS_TREE_NORMAL_EXIT === '1';
if (verifyDestroy && !detached) throw new Error('Destroy verification requires detached descendants');
const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let sandbox: SandboxRef | undefined;
let failed = false;
let realServiceInvoked = false;
try {
  realServiceInvoked = true;
  sandbox = await adapter.create(`tree-${randomUUID()}`, policy);
  const ref = await adapter.execute({ sandbox, runId: sandbox.runId, stepId: 'tree', attemptId: 'tree', inputs: [], policy,
    code: `import json, os, pathlib, time
out = pathlib.Path(os.environ['AGENT_OUTPUT_DIR'])
def record(name):
    stat = pathlib.Path('/proc/%d/stat' % os.getpid()).read_text().rsplit(')', 1)[1].split()
    (out / (name + '.json')).write_text(json.dumps({'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgrp(), 'start': stat[19]}))
record('parent')
child = os.fork()
if child == 0:
    if ${detached ? 'True' : 'False'}:
        os.setsid()
    if ${normalExit ? 'True' : 'False'}:
        fd = os.open('/dev/null', os.O_RDWR)
        for target in (0, 1, 2): os.dup2(fd, target)
        if fd > 2: os.close(fd)
    record('child')
    grandchild = os.fork()
    if grandchild == 0:
        record('grandchild')
    time.sleep(75)
else:
    if ${normalExit ? 'True' : 'False'}:
        while not (out / 'release-parent').exists(): time.sleep(0.05)
    else:
        time.sleep(75)
` });
  const client = await Sandbox.connect({ sandboxId: sandbox.sandboxId, connectionConfig: connection });
  try {
    type Identity = { pid: number; ppid: number; pgid: number; start: string };
    const identities: Record<string, Identity> = {};
    for (const name of ['parent', 'child', 'grandchild']) {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        try { identities[name] = JSON.parse(await client.files.readFile(`${ref.workDir}/outputs/${name}.json`)) as Identity; break; }
        catch { await sleep(100); }
      }
      assert.ok(identities[name], `${name} process did not become ready`);
    }
    assert.equal(identities.child!.ppid, identities.parent!.pid);
    assert.equal(identities.grandchild!.ppid, identities.child!.pid);
    assert.equal(identities.child!.pgid, identities.grandchild!.pgid);
    if (detached) assert.notEqual(identities.parent!.pgid, identities.child!.pgid);
    else assert.equal(identities.parent!.pgid, identities.child!.pgid);
    async function snapshot() {
      const path = `/tmp/process-tree-snapshot-${randomUUID()}.json`;
      const code = `import json, pathlib\nids = json.loads(${JSON.stringify(JSON.stringify(identities))})\nr = {}\nfor name, ident in ids.items():\n p = pathlib.Path('/proc/%d/stat' % ident['pid'])\n try:\n  s = p.read_text().rsplit(')', 1)[1].split()\n  r[name] = {'exists': True, 'state': s[0], 'start': s[19], 'sameProcess': s[19] == ident['start']}\n except FileNotFoundError:\n  r[name] = {'exists': False, 'sameProcess': False}\npathlib.Path(${JSON.stringify(path)}).write_text(json.dumps(r))`;
      const result = await client.commands.run(['python3', '-c', code], { timeoutSeconds: 10 });
      assert.equal(result.exitCode, 0, 'independent process observer must succeed');
      return JSON.parse(await client.files.readFile(path)) as Record<string, { exists: boolean; sameProcess: boolean; state?: string }>;
    }
    async function hostIdentities() {
      const matches: Record<string, number[]> = Object.fromEntries(Object.keys(identities).map(name => [name, []]));
      for (const pid of await readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')]);
          const start = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
          const namespacePids = status.match(/^NSpid:\s+([\d\s]+)$/m)?.[1]?.trim().split(/\s+/).map(Number);
          if (!namespacePids || namespacePids.length < 2) continue;
          for (const [name, identity] of Object.entries(identities)) {
            if (namespacePids.at(-1) === identity.pid && start === identity.start) matches[name]!.push(Number(pid));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      return Object.fromEntries(Object.entries(matches).map(([name, pids]) => {
        assert.equal(pids.length, 1, `Expected exactly one host PID for ${name}`);
        return [name, pids[0]!];
      }));
    }
    async function hostSnapshot(hostPids: Record<string, number>) {
      const result: Record<string, { sameProcess: boolean; state?: string }> = {};
      for (const [name, pid] of Object.entries(hostPids)) {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
          result[name] = { sameProcess: fields[19] === identities[name]!.start, state: fields[0] };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          result[name] = { sameProcess: false };
        }
      }
      return result;
    }
    const hostPids = verifyDestroy ? await hostIdentities() : undefined;
    const before = await snapshot();
    for (const name of Object.keys(identities)) {
      assert.equal(before[name]?.sameProcess, true, `${name} identity must be independently observed`);
      assert.notEqual(before[name]?.state, 'Z', `${name} must be alive before cancellation`);
    }
    assert.equal((await client.commands.getCommandStatus(ref.executionId)).running, true);
    let cancellation: { confirmed: boolean } | undefined;
    let completion: Awaited<ReturnType<typeof adapter.inspect>> | undefined;
    if (normalExit) {
      const release = await client.commands.run(['touch', `${ref.workDir}/outputs/release-parent`], { timeoutSeconds: 10 });
      assert.equal(release.exitCode, 0);
      const until = Date.now() + 15_000;
      while ((await client.commands.getCommandStatus(ref.executionId)).running && Date.now() < until) await sleep(100);
      completion = await adapter.inspect(ref);
      assert.equal(completion.state, 'SUCCEEDED', 'Parent command must exit successfully');
    } else {
      cancellation = await adapter.cancel(ref);
    }
    const after = await snapshot();
    const allStopped = Object.values(after).every(item => !item.sameProcess || item.state === 'Z');
    if (verifyDestroy) {
      if (!normalExit) assert.equal(cancellation?.confirmed, true, 'Adapter cancellation must be confirmed');
      assert.ok(['child', 'grandchild'].every(name => after[name]?.sameProcess && after[name]?.state !== 'Z'),
        'Detached descendants must still be alive before destruction');
      const hostBefore = await hostSnapshot(hostPids!);
      assert.ok(['child', 'grandchild'].every(name => hostBefore[name]?.sameProcess && hostBefore[name]?.state !== 'Z'));
      await adapter.destroy(sandbox);
      const sandboxId = sandbox.sandboxId;
      sandbox = undefined;
      const until = Date.now() + 10_000;
      let hostAfter = await hostSnapshot(hostPids!);
      while (Date.now() < until && Object.values(hostAfter).some(item => item.sameProcess && item.state !== 'Z')) {
        await sleep(100);
        hostAfter = await hostSnapshot(hostPids!);
      }
      const passed = Object.values(hostAfter).every(item => !item.sameProcess || item.state === 'Z');
      checks.push({ name: normalExit ? 'normal-exit-destroy-stops-detached-descendants' : 'destroy-stops-detached-descendants', passed,
        detail: { sandboxId, executionId: ref.executionId, identities, hostPids, before, completion, cancellation, after, hostBefore, hostAfter,
          observation: 'Host PID namespace /proc and process start-time identity; zombie is no longer executing' } });
      if (!passed) failed = true;
    } else {
      checks.push({ name: 'cancel-process-tree', passed: !!cancellation?.confirmed && allStopped,
        detail: { executionId: ref.executionId, sandboxId: sandbox.sandboxId, detached, identities, before, cancellation, after,
          observation: 'Linux /proc PID and start-time identity; zombie is no longer executing' } });
      if (!checks.at(-1)!.passed) failed = true;
    }
  } finally { await client.close(); }
} catch (error) {
  failed = true;
  checks.push({ name: 'probe-error', passed: false, detail: { message: (error instanceof Error ? error.message : 'Unknown error').replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500) } });
} finally {
  if (sandbox) {
    try { await adapter.destroy(sandbox); checks.push({ name: 'sandbox-destroy', passed: true, detail: { sandboxId: sandbox.sandboxId } }); }
    catch { failed = true; checks.push({ name: 'sandbox-destroy', passed: false, detail: { sandboxId: sandbox.sandboxId } }); }
  }
  const report = { checkedAt: new Date().toISOString(), realServiceInvoked, provider: 'none', checks };
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  if (failed) process.exitCode = 1;
}
