import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConnectionConfig, Sandbox, SandboxApiException, SandboxException } from '@alibaba-group/opensandbox';

type Evidence = { name: string; passed: boolean; detail: unknown };
const checks: Evidence[] = [];
const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
if (!domain || !image) {
  console.error('BLOCKED: set OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE to an existing service and fixed Python image. No sandbox was created.');
  process.exit(2);
}
const parsed = new URL(domain.includes('://') ? domain : `http://${domain}`);
if (parsed.username || parsed.password || parsed.search || parsed.hash) {
  throw new Error('Endpoint must not contain credentials, query parameters, or a fragment.');
}
const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const safeErrorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return 'Unknown error';
  return error.message.replaceAll(apiKey ?? '\u0000', '[redacted]').slice(0, 500);
};
const connectionConfig = new ConnectionConfig({
  domain,
  ...(apiKey ? { apiKey } : {}),
  requestTimeoutSeconds: 120,
  useServerProxy: process.env.OPEN_SANDBOX_USE_SERVER_PROXY === '1',
  disableMetrics: true,
});
const outputDirectory = resolve(process.env.SANDBOX_SMOKE_OUTPUT ?? '../../.runtime/sandbox-smoke');
let sandbox: Sandbox | undefined;
let killConfirmed = false;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function pollFinished(id: string, seconds = 15) {
  assert(sandbox);
  const expires = Date.now() + seconds * 1000;
  while (Date.now() < expires) {
    const status = await sandbox.commands.getCommandStatus(id);
    if (status.running === false) return status;
    await delay(250);
  }
  throw new Error(`Command ${id} termination could not be confirmed within ${seconds}s`);
}

try {
  sandbox = await Sandbox.create({
    connectionConfig,
    image,
    timeoutSeconds: 300,
    readyTimeoutSeconds: 45,
    resource: { cpu: '1', memory: '512Mi' },
    networkPolicy: { defaultAction: 'deny', egress: [] },
    metadata: { project: 'agent-runtime', purpose: 'p0-04-smoke' },
  });
  checks.push({ name: 'create', passed: true, detail: { sandboxId: sandbox.id, image } });
  await sandbox.files.createDirectories([{ path: '/tmp/runtime-smoke', mode: 755 }]);
  const source = [
    'import json, pathlib',
    'p = pathlib.Path("/tmp/runtime-smoke")',
    'data = json.loads((p / "input.json").read_text())',
    '(p / "result.json").write_text(json.dumps({"sum": sum(data["values"])}))',
    'print("runtime-smoke-ok")',
  ].join('\n');
  await sandbox.files.writeFiles([
    { path: '/tmp/runtime-smoke/input.json', data: '{"values":[2,3,5]}', mode: 644 },
    { path: '/tmp/runtime-smoke/main.py', data: source, mode: 644 },
    { path: '/tmp/runtime-smoke/long.py', data: 'import time\ntime.sleep(120)\n', mode: 644 },
  ]);
  const result = await sandbox.commands.run(['python3', '/tmp/runtime-smoke/main.py'], { timeoutSeconds: 10 });
  assert.equal(result.exitCode, 0, 'normal command must report successful exit');
  const raw = await sandbox.files.readFile('/tmp/runtime-smoke/result.json');
  assert.deepEqual(JSON.parse(raw), { sum: 10 });
  checks.push({ name: 'upload-execute-download', passed: true, detail: { executionId: result.id, sha256: createHash('sha256').update(raw).digest('hex'), exitCode: result.exitCode } });

  const background = await sandbox.commands.run(['python3', '/tmp/runtime-smoke/long.py'], { background: true, timeoutSeconds: 30 });
  assert(background.id, 'background execution must have a stable ID');
  const before = await sandbox.commands.getCommandStatus(background.id);
  assert.equal(before.running, true);
  await sandbox.commands.interrupt(background.id);
  const after = await pollFinished(background.id);
  checks.push({ name: 'cancel-confirmed', passed: true, detail: { executionId: background.id, status: after } });

  const timeout = await sandbox.commands.run(['python3', '/tmp/runtime-smoke/long.py'], { background: true, timeoutSeconds: 1 });
  assert(timeout.id);
  const timeoutStatus = await pollFinished(timeout.id);
  assert.notEqual(timeoutStatus.exitCode, 0, 'timed out command must not succeed');
  checks.push({ name: 'timeout-confirmed', passed: true, detail: { executionId: timeout.id, status: timeoutStatus } });

  // Never report policy enforcement from request configuration alone.
  checks.push({ name: 'isolation', passed: false, detail: 'Network/filesystem/resource enforcement requires deployment-specific tests; not established by this smoke.' });
} catch (error) {
  checks.push({ name: 'smoke-error', passed: false, detail: error instanceof SandboxException ? { type: error.name, code: error.error.code, requestId: error.requestId, message: safeErrorMessage(error) } : { type: error instanceof Error ? error.name : 'UnknownError', message: safeErrorMessage(error), cause: error instanceof Error && error.cause instanceof Error ? safeErrorMessage(error.cause) : undefined } });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await sandbox.kill();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          await sandbox.getInfo();
        } catch (error) {
          if (error instanceof SandboxApiException && error.statusCode === 404) {
            killConfirmed = true;
            break;
          }
          throw error;
        }
        await delay(250);
      }
      assert(killConfirmed, 'delete acknowledged but disappearance not confirmed');
      checks.push({ name: 'kill-confirmed', passed: true, detail: { sandboxId: sandbox.id, confirmation: 'lifecycle GET returns 404' } });
    } catch {
      checks.push({ name: 'kill', passed: false, detail: { sandboxId: sandbox.id, action: 'Inspect and clean up this sandbox; TTL 300 seconds was requested.' } });
      process.exitCode = 1;
    }
    await sandbox.close();
  }
  await mkdir(outputDirectory, { recursive: true });
  const evidence = { checkedAt: new Date().toISOString(), sdk: '1.2.1', realServiceInvoked: true, checks, killConfirmed };
  await writeFile(resolve(outputDirectory, 'smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
