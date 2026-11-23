import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Sandbox, ConnectionConfig, SandboxApiException } from '@alibaba-group/opensandbox';

const key = process.env.OPEN_SANDBOX_API_KEY;
const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const peer = process.env.ISOLATION_PEER_IP;
assert(key && domain && image && peer, 'Set required environment before creating sandboxes');
const connectionConfig = new ConnectionConfig({ domain, apiKey: key, disableMetrics: true, requestTimeoutSeconds: 60 });
const directory = '/reports';
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), sdk: '1.2.1', realServiceInvoked: true,
  controlledPeer: { ip: peer, port: 8765, samePeerForAllowAndDeny: true },
  requested: { cpu: '0.5', memory: '192Mi', workUid: 65534 }, checks: [], cleanup: [] };
const cleanup = report.cleanup as unknown[];
const live: Sandbox[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const safe = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error').replaceAll(key, '[redacted]').slice(0, 300);
try {
  const source = await readFile('/probe/probe.py', 'utf8');
  for (const mode of ['allow', 'deny'] as const) {
    const sandbox = await Sandbox.create({ connectionConfig, image, timeoutSeconds: 240, readyTimeoutSeconds: 45,
      resource: { cpu: '0.5', memory: '192Mi' }, networkPolicy: { defaultAction: mode, egress: [] },
      metadata: { project: 'agent-runtime', purpose: 'p0-04-isolation', mode } });
    live.push(sandbox);
    await sandbox.files.createDirectories([{ path: '/tmp/runtime-isolation', mode: 777 }]);
    await sandbox.files.writeFiles([{ path: '/tmp/runtime-isolation/probe.py', data: source, mode: 644 }]);
    if (mode === 'deny') {
      await writeFile(`${directory}/inventory-request.json`, JSON.stringify({ sandboxId: sandbox.id }));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try { await readFile(`${directory}/inventory-done.json`); break; } catch { await delay(200); }
      }
      assert(Date.now() < deadline, 'Host inventory handshake timed out');
    }
    const result = await sandbox.commands.run(['python3', '/tmp/runtime-isolation/probe.py', peer, mode],
      { uid: 65534, gid: 65534, timeoutSeconds: 45 });
    assert.equal(result.exitCode, 0, `Probe ${mode} failed`);
    const observed = JSON.parse(await sandbox.files.readFile('/tmp/runtime-isolation/result.json'));
    report[mode] = { sandboxId: sandbox.id, executionId: result.id, ...observed };
  }
  const allow = report.allow as any; const deny = report.deny as any;
  const inventory = JSON.parse((await readFile(`${directory}/inventory.json`, 'utf8')).replace(/^\uFEFF/, ''));
  const mounts = Array.isArray(inventory.mounts) ? inventory.mounts : [inventory.mounts];
  report.inventory = inventory;
  const checks = [
    { name: 'positive-control-domain', passed: allow.network.domainResolved && allow.network.domainConnected },
    { name: 'positive-control-direct-ip', passed: allow.network.directIpConnected },
    { name: 'deny-domain', passed: allow.network.domainResolved && !deny.network.domainResolved && !deny.network.domainConnected },
    { name: 'deny-direct-ip', passed: allow.network.directIpConnected && !deny.network.directIpConnected },
    { name: 'nonroot-file-permissions', passed: deny.filesystem.uid === 65534 && deny.filesystem.gid === 65534
      && deny.filesystem.etcWriteDenied && !deny.filesystem.rootHomeReadable && !deny.filesystem.dockerSocketPresent
      && !deny.filesystem.cgroupLimitWritable && deny.filesystem.workWritePassed },
    { name: 'no-sensitive-host-mounts', passed: !inventory.hostConfig.privileged
      && mounts.every((mount: { Type: string; Destination: string; Name?: string }) => mount.Type === 'volume'
        && mount.Destination === '/opt/opensandbox' && mount.Name === `opensandbox-runtime-${deny.sandboxId}`) },
    { name: 'cpu-hard-limit', passed: deny.resources.cpuMax === '50000 100000'
      && deny.resources.cpuPressure?.throttledPeriodsDelta > 0
      && deny.resources.cpuPressure.usageSeconds / deny.resources.cpuPressure.elapsedSeconds < .85 },
    { name: 'memory-hard-limit', passed: deny.resources.memoryMax === String(192 * 1024 * 1024)
      && deny.resources.memoryPressure?.oomKillDelta > 0 && deny.resources.memoryPressure.childExitCode === -9 },
  ];
  report.checks = checks;
  if (checks.some(check => !check.passed)) process.exitCode = 1;
} catch (error) {
  report.error = safe(error); process.exitCode = 1;
} finally {
  for (const sandbox of live) {
    let confirmed = false;
    try {
      await sandbox.kill();
      for (let attempt = 0; attempt < 30; attempt++) {
        try { await sandbox.getInfo(); } catch (error) {
          if (error instanceof SandboxApiException && error.statusCode === 404) { confirmed = true; break; }
          throw error;
        }
        await delay(200);
      }
    } catch (error) { cleanup.push({ sandboxId: sandbox.id, error: safe(error) }); }
    cleanup.push({ sandboxId: sandbox.id, lifecycle404: confirmed });
    if (!confirmed) process.exitCode = 1;
    await sandbox.close();
  }
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/isolation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, error: report.error, cleanup }, null, 2));
}
