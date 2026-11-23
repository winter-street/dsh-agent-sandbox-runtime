import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntimeServer } from '../api/server.js';
import { startApplication } from './index.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = argument('--config') ?? process.env.ASR_APPLICATION_CONFIG;
if (!configPath || !existsSync(configPath)) throw new Error('Set --config or ASR_APPLICATION_CONFIG to an application JSON file');
const applicationConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { server?: { tokenEnv?: string; port?: number }; validatorModule?: string };
type Validator = (run: import('../contracts/runtime.js').RunRecord, records: import('../contracts/runtime.js').ArtifactRecord[], read: (artifact: import('../contracts/runtime.js').ArtifactRecord) => Promise<Uint8Array>) => Promise<{ passed: boolean; evidence: unknown }>;
let validator: Validator | undefined;
if (applicationConfig.validatorModule) {
  const validatorPath = resolve(dirname(configPath), applicationConfig.validatorModule);
  const loaded = await import(pathToFileURL(validatorPath).href) as { default?: unknown; validate?: unknown };
  const candidate = loaded.default ?? loaded.validate;
  if (typeof candidate !== 'function') throw new Error(`Validator module ${validatorPath} must export a function or validate()`);
  validator = candidate as Validator;
}
const host = await startApplication({ configPath, env: process.env, listen: false, installSignalHandlers: false,
  validate: async (run, records, read) => validator
    ? validator(run, records, read)
    : { passed: false, evidence: { validator: 'configure validatorModule for task-specific acceptance' } } });
const tokenEnv = applicationConfig.server?.tokenEnv ?? process.env.ASR_RUNTIME_API_TOKEN_ENV ?? 'ASR_RUNTIME_API_TOKEN';
const token = process.env[tokenEnv];
if (!token || token.length < 24) { await host.close(); throw new Error(`Set ${tokenEnv} to a bearer token of at least 24 characters`); }
const port = Number(argument('--port') ?? process.env.ASR_RUNTIME_PORT ?? applicationConfig.server?.port ?? 8787);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { await host.close(); throw new Error('Port must be an integer between 1 and 65535'); }
const server = createRuntimeServer(host.service, { token, client: true, eventPollMs: 250, createTask: async task => {
  const runId = `api-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  await host.submit({ runId, task, inputs: [] });
  return host.get(runId);
}, control: { pause: host.pause, resume: host.resume, cancel: host.cancel, decideApproval: host.decideApproval } });
await new Promise<void>((resolve, reject) => server.listen(port, '127.0.0.1', () => resolve()));
console.log(`Agent runtime listening on http://127.0.0.1:${port}`);
const shutdown = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await host.close(); };
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
