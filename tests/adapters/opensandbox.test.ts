import { describe, expect, it, vi } from 'vitest';
import { SandboxApiException } from '@alibaba-group/opensandbox';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import type { SandboxClient, SandboxFactory } from '../../src/adapters/opensandbox/index.js';
import type { ExecutionPolicy, ExecutionRef, ExecutionRequest } from '../../src/contracts/sandbox.js';

const policy: ExecutionPolicy = {
  image: 'python@sha256:test-only', cpu: 1, memoryMiB: 512, ttlSeconds: 300,
  commandTimeoutMs: 5000, maxLogBytes: 1024, maxOutputBytes: 4096, maxOutputFiles: 4,
  network: { defaultAction: 'deny', allowHosts: [] },
};
const ref: ExecutionRef = { sandboxId: 'sandbox-1', runId: 'run-1', attemptId: 'attempt-1', executionId: 'execution-1', workDir: '/tmp/agent-runtime/run-1/attempt-1' };
const request: ExecutionRequest = { sandbox: { sandboxId: 'sandbox-1', runId: 'run-1' }, runId: 'run-1', stepId: 'step-1', attemptId: 'attempt-1', code: 'print(42)', inputs: [{ path: 'input.csv', content: Buffer.from('a\n1') }], policy };

function setup() {
  const client: SandboxClient = {
    id: 'sandbox-1',
    files: { createDirectories: vi.fn().mockResolvedValue(undefined), writeFiles: vi.fn().mockResolvedValue(undefined) },
    commands: {
      run: vi.fn().mockResolvedValue({ id: 'execution-1', logs: { stdout: [], stderr: [] }, result: [] }),
      getCommandStatus: vi.fn().mockResolvedValue({ id: 'execution-1', running: false, exitCode: 0 }),
      interrupt: vi.fn().mockResolvedValue(undefined),
    },
    kill: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getInfo: vi.fn().mockRejectedValue(new SandboxApiException({ statusCode: 404 })),
  };
  const factory: SandboxFactory = { create: vi.fn().mockResolvedValue(client), connect: vi.fn().mockResolvedValue(client) };
  const adapter = new OpenSandboxAdapter({ connection: { domain: 'http://127.0.0.1:8080' }, factory, cancelTimeoutMs: 10, pollIntervalMs: 1 });
  return { adapter, client, factory };
}

function collection(client: SandboxClient, overrides: Record<string, unknown> = {}) {
  vi.mocked(client.commands.run).mockResolvedValue({
    id: 'collect-1', exitCode: 0, result: [], logs: { stderr: [], stdout: [{ timestamp: 1, text: JSON.stringify({
      outputs: [{ path: 'stats.json', base64: Buffer.from('{"sum":10}').toString('base64') }],
      stdoutBase64: Buffer.from('done\n').toString('base64'), stderrBase64: '', logsTruncated: false,
      ...overrides,
    }) }] },
  });
}

describe('OpenSandbox SDK adapter contract (mock client; no real service)', () => {
  it('preflight writes inside the runner output directory and completes the full lifecycle', async () => {
    const { adapter, client } = setup();
    collection(client, { outputs: [{ path: 'preflight.txt', base64: Buffer.from('ok').toString('base64') }] });
    await expect(adapter.preflight!(policy)).resolves.toMatchObject({ sandboxId: 'sandbox-1' });
    expect(client.files.writeFiles).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining('/main.py'), data: expect.stringContaining("Path('preflight.txt')") }),
    ]));
    expect(client.kill).toHaveBeenCalledOnce();
  });

  it('maps execution limits and deny-default egress without host mounts', async () => {
    const { adapter, factory } = setup();
    await expect(adapter.create('run-1', policy)).resolves.toEqual({ sandboxId: 'sandbox-1', runId: 'run-1' });
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({
      image: policy.image, timeoutSeconds: 300, resource: { cpu: '1', memory: '512Mi' },
      networkPolicy: { defaultAction: 'deny', egress: [] }, metadata: { project: 'agent-runtime', runId: 'run-1' },
    }));
    expect(vi.mocked(factory.create).mock.calls[0]?.[0]).not.toHaveProperty('volumes');
  });

  it('encodes long branch identities as deterministic legal metadata and retains the full execution identity', async () => {
    const { adapter, factory } = setup();
    const runId = `branch-${'a'.repeat(64)}`;
    expect(runId).toHaveLength(71);
    const sandbox = await adapter.create(runId, policy);
    expect(sandbox).toEqual({ sandboxId: 'sandbox-1', runId });
    const label = vi.mocked(factory.create).mock.calls[0]?.[0].metadata?.runId;
    expect(label).toHaveLength(63);
    expect(label).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,61}[A-Za-z0-9]$/);
    await adapter.create(runId, policy);
    expect(vi.mocked(factory.create).mock.calls[1]?.[0].metadata?.runId).toBe(label);
    await adapter.create(`branch-${'a'.repeat(63)}b`, policy);
    expect(vi.mocked(factory.create).mock.calls[2]?.[0].metadata?.runId).not.toBe(label);
    const execution = await adapter.execute({ ...request, sandbox, runId });
    expect(execution.runId).toBe(runId);
    expect(execution.workDir).toBe(`/tmp/agent-runtime/${runId}/${request.attemptId}`);
  });
  it('accepts fractional CPU quotas used by the deployment isolation profile', async () => {
    const { adapter, factory } = setup();
    await adapter.create('run-1', { ...policy, cpu: 0.5 });
    expect(factory.create).toHaveBeenCalledWith(expect.objectContaining({ resource: { cpu: '0.5', memory: '512Mi' } }));
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid CPU quota %s', async (cpu) => {
    const { adapter } = setup();
    await expect(adapter.create('run-1', { ...policy, cpu })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('uploads code as files and invokes a fixed argv runner with a non-root identity', async () => {
    const { adapter, client } = setup();
    const result = await adapter.execute({ ...request, code: 'print("$(touch host)")' });
    expect(result).toEqual(ref);
    expect(client.commands.run).toHaveBeenCalledWith(
      ['python3', `${ref.workDir}/runner.py`, ref.workDir, '1024'],
      { background: true, workingDirectory: ref.workDir, timeoutSeconds: 5, uid: 65534, gid: 65534 },
      undefined, expect.any(AbortSignal),
    );
    expect(client.files.createDirectories).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ owner: 'nobody', group: 'nogroup', mode: 700 }),
    ]));
    expect(client.files.writeFiles).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ path: `${ref.workDir}/main.py`, data: 'print("$(touch host)")' })]));
  });

  it.each(['../private', '/etc/passwd', 'a\\b', 'nested/../escape', 'C:secret', 'a//b'])('rejects unsafe input path %s before remote execution', async (path) => {
    const { adapter, client } = setup();
    await expect(adapter.execute({ ...request, inputs: [{ path, content: Buffer.from('x') }] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(client.commands.run).not.toHaveBeenCalled();
  });

  it('rejects duplicate paths and mismatched run ownership', async () => {
    const { adapter } = setup();
    await expect(adapter.execute({ ...request, inputs: [...request.inputs, ...request.inputs] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(adapter.execute({ ...request, runId: 'other-run' })).rejects.toMatchObject({ code: 'RUN_MISMATCH' });
  });

  it('fences further starts after a lost dispatch acknowledgement', async () => {
    const { adapter, client } = setup();
    vi.mocked(client.commands.run).mockRejectedValueOnce(new Error('connection lost'));
    await expect(adapter.execute(request)).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    await expect(adapter.execute({ ...request, attemptId: 'attempt-2' })).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(client.commands.run).toHaveBeenCalledTimes(1);
  });

  it('does not overlap a running or unresolved command', async () => {
    const { adapter, client } = setup();
    await adapter.execute(request);
    vi.mocked(client.commands.getCommandStatus).mockResolvedValue({ running: true });
    await expect(adapter.execute({ ...request, attemptId: 'attempt-2' })).rejects.toMatchObject({ code: 'EXECUTION_BUSY' });
    expect(client.commands.run).toHaveBeenCalledTimes(1);
  });

  it('reconnects with the persisted sandbox ID and maps incomplete remote status to unknown', async () => {
    const { adapter, client, factory } = setup();
    vi.mocked(client.commands.getCommandStatus).mockResolvedValue({ running: false });
    await expect(adapter.inspect(ref)).resolves.toMatchObject({ state: 'UNKNOWN' });
    expect(factory.connect).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: ref.sandboxId }));
    vi.mocked(client.commands.getCommandStatus).mockRejectedValue(new Error('offline'));
    await expect(adapter.inspect(ref)).resolves.toMatchObject({ state: 'UNKNOWN' });
  });

  it('maps real nonzero exit codes without pretending the command succeeded', async () => {
    const { adapter, client } = setup();
    vi.mocked(client.commands.getCommandStatus).mockResolvedValue({ running: false, exitCode: 23, error: 'failed' });
    await expect(adapter.inspect(ref)).resolves.toEqual({ state: 'FAILED', exitCode: 23, error: 'failed' });
  });

  it('requires remote stopped status before confirming cancellation', async () => {
    const { adapter, client } = setup();
    vi.mocked(client.commands.getCommandStatus).mockResolvedValueOnce({ running: true }).mockResolvedValueOnce({ running: true }).mockResolvedValue({ running: false, exitCode: -1 });
    await expect(adapter.cancel(ref)).resolves.toEqual({ confirmed: true });
    expect(client.commands.interrupt).toHaveBeenCalledWith(ref.executionId);
    await expect(adapter.inspect(ref)).resolves.toEqual({ state: 'CANCELLED' });
  });

  it('does not confirm a cancellation that was merely requested', async () => {
    const { adapter, client } = setup();
    vi.mocked(client.commands.getCommandStatus).mockResolvedValue({ running: true });
    await expect(adapter.cancel(ref)).resolves.toMatchObject({ confirmed: false });
    await expect(adapter.inspect(ref)).resolves.toEqual({ state: 'RUNNING' });
  });

  it('collects verified terminal output with separate logs', async () => {
    const { adapter, client } = setup();
    collection(client);
    const result = await adapter.collect(ref, policy);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done\n');
    expect(result.stderr).toBe('');
    expect(result.outputs[0]?.content.toString()).toBe('{"sum":10}');
    expect(result.logsTruncated).toBe(false);
    expect(result.resources?.outputBytes).toMatchObject({ status: 'known', value: Buffer.byteLength('{"sum":10}') });
    expect(result.resources?.cpuTime).toMatchObject({ status: 'unknown', reason: 'not-supported' });
    const argv = vi.mocked(client.commands.run).mock.calls[0]?.[0];
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toContain('-c');
  });

  it('normalizes explicit SDK resource sampling only with a matching deployment profile', async () => {
    const { client, factory } = setup();
    client.metrics = { getMetrics: vi.fn().mockImplementation(async () => ({ cpuCount: 1, cpuUsedPercentage: 25,
      memoryTotalMiB: 512, memoryUsedMiB: 128, timestamp: Date.now() })) };
    vi.mocked(client.commands.getCommandStatus).mockResolvedValue({ running: false, exitCode: 0, startedAt: new Date(1000), finishedAt: new Date(1234) });
    const adapter = new OpenSandboxAdapter({ connection: { domain: 'http://127.0.0.1:8080' }, factory,
      resourceSampling: { deployment: { evidenceRef: 'test-fixture-only', cpuCores: 1, memoryMiB: 512 } } });
    const result = await adapter.sampleResources(ref, policy);
    expect(result.cpuUtilization).toMatchObject({ status: 'known', value: 0.25 });
    expect(result.memoryUsed).toMatchObject({ status: 'known', value: 128 * 1048576 });
    expect(result.wallTime).toMatchObject({ status: 'known', value: 234 });
    expect((await adapter.sampleResources(ref, { ...policy, memoryMiB: 1024 })).memoryUsed).toMatchObject({ status: 'unknown', reason: 'scope-unverified' });
  });

  it('marks unsupported and failed metrics as unknown while preserving confirmed wall time', async () => {
    const { client, factory } = setup();
    const adapter = new OpenSandboxAdapter({ connection: { domain: 'http://127.0.0.1:8080' }, factory });
    vi.mocked(client.commands.getCommandStatus).mockResolvedValue({ running: false, startedAt: new Date(1000), finishedAt: new Date(2000) });
    const missing = await adapter.sampleResources(ref, policy);
    expect(missing.memoryUsed).toMatchObject({ status: 'unknown', reason: 'not-supported' });
    expect(missing.wallTime).toMatchObject({ status: 'known', value: 1000 });
    client.metrics = { getMetrics: vi.fn().mockRejectedValue(new Error('offline')) };
    expect((await adapter.sampleResources(ref, policy)).cpuUtilization).toMatchObject({ status: 'unknown', reason: 'request-failed' });
  });

  it('bounds a stalled metrics request without starting repeated network calls', async () => {
    const { client, factory } = setup(); let resolveMetrics!: (value: never) => void;
    client.metrics = { getMetrics: vi.fn().mockImplementation(() => new Promise(resolve => { resolveMetrics = resolve; })) };
    const adapter = new OpenSandboxAdapter({ connection: { domain: 'http://127.0.0.1:8080' }, factory, resourceSampling: { timeoutMs: 5 } });
    expect((await adapter.sampleResources(ref, policy)).memoryUsed).toMatchObject({ status: 'unknown', reason: 'request-failed' });
    await adapter.sampleResources(ref, policy);
    expect(client.metrics.getMetrics).toHaveBeenCalledTimes(1);
    resolveMetrics(undefined as never);
  });

  it('rejects collection before execution outcome is established', async () => {
    const { adapter, client } = setup();
    vi.mocked(client.commands.getCommandStatus).mockResolvedValue({ running: true });
    await expect(adapter.collect(ref, policy)).rejects.toMatchObject({ code: 'EXECUTION_NOT_COLLECTABLE' });
    expect(client.commands.run).not.toHaveBeenCalled();
  });

  it('rejects forged directory, oversized, duplicate, and invalid manifest values', async () => {
    const { adapter, client } = setup();
    await expect(adapter.collect({ ...ref, workDir: '/etc' }, policy)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    collection(client, { outputs: [{ path: 'a', base64: Buffer.alloc(4097).toString('base64') }] });
    await expect(adapter.collect(ref, policy)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    collection(client, { outputs: [{ path: 'a', base64: '' }, { path: 'a', base64: '' }] });
    await expect(adapter.collect(ref, policy)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    collection(client, { outputs: [{ path: 'a', base64: 'not-base64' }] });
    await expect(adapter.collect(ref, policy)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('rejects unsafe output paths and collector failure', async () => {
    const { adapter, client } = setup();
    collection(client, { outputs: [{ path: '../escape', base64: '' }] });
    await expect(adapter.collect(ref, policy)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    vi.mocked(client.commands.run).mockResolvedValue({ exitCode: 1, result: [], logs: { stdout: [], stderr: [] } });
    await expect(adapter.collect(ref, policy)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('confirms deletion with lifecycle lookup and makes repeated cleanup idempotent', async () => {
    const { adapter, client } = setup();
    await adapter.destroy(ref);
    await adapter.destroy(ref);
    expect(client.kill).toHaveBeenCalledTimes(1);
    expect(client.getInfo).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('does not report confirmed cleanup on transport errors', async () => {
    const { adapter, client } = setup();
    vi.mocked(client.getInfo).mockRejectedValue(new Error('offline'));
    await expect(adapter.destroy(ref)).rejects.toThrow('offline');
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
