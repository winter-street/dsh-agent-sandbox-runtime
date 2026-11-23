import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';

function command(file, args) {
  const result = spawnSync(file, args, { timeout: 15000, windowsHide: true });
  const raw = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  const decode = (value) => value.includes(0) ? value.toString('utf16le') : value.toString('utf8');
  return {
    available: result.error?.code !== 'ENOENT',
    exitCode: result.status,
    errorCode: result.error?.code ?? null,
    output: (decode(raw) + decode(stderr)).trim().slice(0, 2000),
  };
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (reachable) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const docker = command('docker', ['info', '--format', '{{.ServerVersion}}']);
const podman = command('podman', ['info', '--format', '{{.Version.Version}}']);
const wsl = process.platform === 'win32'
  ? command('wsl.exe', ['-d', 'Ubuntu', '--', 'sh', '-lc', 'command -v docker; command -v podman; uname -s'])
  : null;
const report = {
  checkedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  configuredRemote: Boolean(process.env.OPEN_SANDBOX_DOMAIN),
  configuredApiKey: Boolean(process.env.OPEN_SANDBOX_API_KEY),
  localDefaultPortReachable: await probeTcp('127.0.0.1', 8080),
  docker,
  podman,
  wsl,
  registeredUbuntuDiskPresent: process.platform === 'win32' ? existsSync('D:\\WSL\\Ubuntu\\ext4.vhdx') : null,
  scope: 'Environment availability only; no sandbox or isolation validation has passed.',
};
console.log(JSON.stringify(report, null, 2));
if (!report.configuredRemote && !report.localDefaultPortReachable && docker.exitCode !== 0 && podman.exitCode !== 0) {
  process.exitCode = 2;
}
