/** Production serial host with controlled provider/sandbox; no external credentials or execution. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { startApplication, type ApplicationConfig } from '../../src/app/index.js';
import { createRuntimeServer } from '../../src/api/server.js';
import type { ExecutionRef, ExecutionRequest, ExecutionPolicy, SandboxRef } from '../../src/contracts/sandbox.js';
import { FakeSandbox } from '../support/fakes.js';

const root = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 0);
const token = process.env.RUNTIME_SERIAL_BROWSER_TOKEN;
if (!process.argv[2] || !token || token.length < 24) throw new Error('Fixture requires a directory and local bearer token');
mkdirSync(root, { recursive: true });
const auditPath = join(root, 'audit.jsonl');
function audit(value: Record<string, unknown>): void { appendFileSync(auditPath, JSON.stringify({ timestamp: Date.now(), ...value }) + '\n'); }
function auditEntries(): Record<string, unknown>[] {
  return existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
}
class ControlledRoles extends LlmAdapter {
  override async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    const sessionId = String(request.sessionId);
    const role = sessionId.endsWith('-planner') ? 'planner' : sessionId.endsWith('-executor') ? 'executor' : 'reviewer';
    audit({ kind: 'provider', sessionId, role, usage: { inputTokens: 20, outputTokens: 10 }, syntheticUsage: true });
    const cancel = JSON.stringify(request.messages).includes('cancel-running');
    const code = `# ${cancel ? 'cancel-running' : 'complete'}\nimport json, os\nfrom pathlib import Path\nPath(os.environ['AGENT_OUTPUT_DIR'], 'result.json').write_text(json.dumps({'verified': True}))`;
    const text = JSON.stringify(role === 'planner' ? { steps: ['write result.json'], checks: ['verified is true'] }
      : role === 'executor' ? { code } : { passed: true, findings: [] });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
class ControlledSandbox extends FakeSandbox {
  override async create(runId: string, policy: ExecutionPolicy): Promise<SandboxRef> {
    const ref = await super.create(runId, policy); audit({ kind: 'sandbox', method: 'create', ...ref }); return ref;
  }
  override async execute(request: ExecutionRequest): Promise<ExecutionRef> {
    this.enqueue(request.code.includes('cancel-running') ? { states: [{ state: 'RUNNING' }] }
      : { states: [{ state: 'SUCCEEDED', exitCode: 0 }], collect: { outputs: [{ path: 'result.json', content: Buffer.from('{"verified":true}') }] } });
    const ref = await super.execute(request); audit({ kind: 'sandbox', method: 'execute', ...ref }); return ref;
  }
  override async cancel(ref: ExecutionRef) {
    const result = await super.cancel(ref); audit({ kind: 'sandbox', method: 'cancel', ...ref, confirmed: result.confirmed }); return result;
  }
  override async destroy(ref: SandboxRef): Promise<void> { await super.destroy(ref); audit({ kind: 'sandbox', method: 'destroy', ...ref }); }
}
const configPath = join(root, 'application.json');
if (!existsSync(configPath)) {
  const config: ApplicationConfig = { schemaVersion: 1, runtimeConfigPath: resolve('config/example.json'), dataDir: join(root, 'application'),
    model: { provider: 'controlled', name: 'controlled-browser', apiKeyEnv: 'CONTROLLED_KEY', maxOutputTokens: 2048 },
    budget: { maxTokens: 50000, finalizeTokens: 0 }, sandbox: { domain: 'http://127.0.0.1:8090', apiKeyEnv: 'CONTROLLED_SANDBOX_KEY' },
    workflow: { mode: 'serial', maxRepairs: 1, approval: { reason: 'Review generated Python', ttlMs: 300000 },
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      context: { modelWindowTokens: 32768, safetyReserveTokens: 256 }, reference: { key: 'ranking' } } };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}
const host = await startApplication({ configPath, env: { CONTROLLED_KEY: 'controlled-local-only', CONTROLLED_SANDBOX_KEY: 'controlled-local-only' },
  listen: false, installSignalHandlers: false, provider: new ControlledRoles(), sandbox: new ControlledSandbox(),
  validate: async (_run, artifacts, read) => {
    const result = artifacts.find(artifact => artifact.path === 'result.json');
    return { passed: !!result && Buffer.from(await read(result)).toString() === '{"verified":true}', evidence: { controlled: true } };
  } });
const server = createRuntimeServer(host.service, { token, client: true, eventPollMs: 30, createTask: async task => {
  const runId = `serial-browser-${randomUUID()}`; await host.submit({ runId, task, inputs: [] }); return host.get(runId);
}, control: { pause: host.pause, resume: host.resume, cancel: host.cancel, decideApproval: host.decideApproval } });
await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture failed to bind loopback');
process.send?.({ ready: true, url: `http://127.0.0.1:${address.port}`, port: address.port, pid: process.pid });
process.on('message', async (message: { id: number; command: string; runId: string }) => {
  try {
    if (message.command !== 'evidence') throw new Error('Unsupported read-only fixture command');
    const run = await host.get(message.runId);
    const ledger = (await host.budget.reader.eventsAfter(0)).filter(entry => entry.scopeKey === run.budgetScopeKey);
    const events = host.store.eventsAfter(run.runId);
    process.send?.({ id: message.id, run, budget: await host.budget.reader.snapshot(run.budgetScopeKey), ledger,
      approvals: host.service.approvals.list(run.runId),
      counts: { mcp: events.filter(event => event.type === 'tool.completed' && (event.payload as { toolName?: unknown }).toolName === 'mcp.lookup_rule').length, consumed: events.filter(event => event.type === 'approval.consumed').length },
      audit: auditEntries().filter(entry => entry.runId === run.runId || typeof entry.sessionId === 'string' && entry.sessionId.startsWith(run.rootSessionId + '-')) });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
let closing = false;
async function close(): Promise<void> {
  if (closing) return; closing = true; server.closeAllConnections();
  await new Promise<void>(accept => server.close(() => accept())); await host.close(); process.exit(0);
}
process.once('disconnect', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
