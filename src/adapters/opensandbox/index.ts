import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Sandbox, SandboxApiException } from '@alibaba-group/opensandbox';
import type { ConnectionConfigOptions, SandboxCreateOptions, SandboxConnectOptions } from '@alibaba-group/opensandbox';
import type {
  CancelResult, CollectedExecution, ExecutionPolicy, ExecutionRef, ExecutionRequest,
  ExecutionStatus, SandboxPort, SandboxRef,
} from '../../contracts/sandbox.js';
import { COLLECTOR_SCRIPT, RUNNER_SCRIPT } from './scripts.js';
import { normalizeResourceSample } from '../../resources/index.js';
import type { MetricsDeploymentProfile, ResourceSample } from '../../resources/index.js';

export interface SandboxClient {
  id: string;
  files: Pick<Sandbox['files'], 'createDirectories' | 'writeFiles'>;
  commands: Pick<Sandbox['commands'], 'run' | 'getCommandStatus' | 'interrupt'>;
  metrics?: Pick<Sandbox['metrics'], 'getMetrics'>;
  kill(): Promise<void>;
  close(): Promise<void>;
  getInfo(): ReturnType<Sandbox['getInfo']>;
}

export interface SandboxFactory {
  create(options: SandboxCreateOptions): Promise<SandboxClient>;
  connect(options: SandboxConnectOptions): Promise<SandboxClient>;
}

export interface OpenSandboxOptions {
  connection: ConnectionConfigOptions & { domain: string };
  cancelTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Injection seam for SDK contract tests; production defaults to the published SDK. */
  factory?: SandboxFactory;
  /** Opt in after checking the actual deployment; no profile means unknown metric scope. */
  resourceSampling?: { deployment?: MetricsDeploymentProfile; timeoutMs?: number; maxAgeMs?: number };
}

export class SandboxAdapterError extends Error {
  override readonly name = 'SandboxAdapterError';
  constructor(readonly code: string, message: string) { super(message); }
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new SandboxAdapterError('INVALID_ARGUMENT', `${label} must be a bounded identifier`);
  }
  return value;
}

function relativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || posix.isAbsolute(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..') || value.includes(':')) {
    throw new SandboxAdapterError('INVALID_ARGUMENT', 'File path must be a normalized relative path');
  }
  return value;
}

function decodeBase64(value: string, limit: number): Buffer {
  if (value.length > 4 * Math.ceil(limit / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SandboxAdapterError('ARTIFACT_INVALID', 'Invalid or oversized base64 data');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > limit || decoded.toString('base64') !== value) throw new SandboxAdapterError('ARTIFACT_INVALID', 'Invalid or oversized base64 data');
  return decoded;
}

function policyChecked(policy: ExecutionPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (typeof value === 'number') {
      // CPU quotas are expressed in fractional cores (for example 0.5),
      // while memory, timeout and output limits are integral quantities.
      const valid = name === 'cpu'
        ? Number.isFinite(value) && value > 0
        : Number.isSafeInteger(value) && value > 0;
      if (!valid) {
        throw new SandboxAdapterError('INVALID_ARGUMENT', name === 'cpu'
          ? `${name} must be a positive finite number`
          : `${name} must be a positive safe integer`);
      }
    }
  }
  if (!policy.image.trim() || policy.network.defaultAction !== 'deny') {
    throw new SandboxAdapterError('INVALID_ARGUMENT', 'An image and deny-default network policy are required');
  }
  if (policy.network.allowHosts.some((host) => !host || /[\s\/:@]/.test(host))) {
    throw new SandboxAdapterError('INVALID_ARGUMENT', 'Network allowHosts must be host names, not URLs');
  }
}

/** A real SDK adapter. Untrusted code is never executed on the application host. */
export class OpenSandboxAdapter implements SandboxPort {
  private readonly clients = new Map<string, Promise<SandboxClient>>();
  private readonly active = new Map<string, ExecutionRef>();
  private readonly starting = new Set<string>();
  private readonly uncertain = new Set<string>();
  private readonly destroyed = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly factory: SandboxFactory;
  private readonly cancelTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly resourceRequests = new Map<string, Promise<{ metrics?: unknown; commandStatus?: unknown; metricsFailure?: 'not-supported' | 'request-failed' }>>();

  constructor(private readonly options: OpenSandboxOptions) {
    const url = new URL(options.connection.domain.includes('://') ? options.connection.domain : `http://${options.connection.domain}`);
    if (url.username || url.password || url.search || url.hash) throw new SandboxAdapterError('INVALID_ARGUMENT', 'Service URL cannot contain credentials or query parameters');
    this.factory = options.factory ?? { create: (opts) => Sandbox.create(opts), connect: (opts) => Sandbox.connect(opts) };
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    if (!Number.isFinite(this.cancelTimeoutMs) || this.cancelTimeoutMs <= 0 || !Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new SandboxAdapterError('INVALID_ARGUMENT', 'Polling durations must be positive');
    }
    const sampleTimeout = options.resourceSampling?.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(sampleTimeout) || sampleTimeout < 1 || sampleTimeout > 30_000) throw new SandboxAdapterError('INVALID_ARGUMENT', 'Resource sample timeout must be 1..30000 ms');
  }

  async sampleResources(ref: ExecutionRef, policy: ExecutionPolicy): Promise<ResourceSample> {
    policyChecked(policy);
    let request = this.resourceRequests.get(ref.executionId);
    if (!request) {
      request = (async () => {
        try {
          const client = await this.client(ref);
          const [metrics, status] = await Promise.allSettled([
            client.metrics ? client.metrics.getMetrics() : Promise.reject(new Error('unsupported')),
            client.commands.getCommandStatus(ref.executionId),
          ]);
          return {
            ...(metrics.status === 'fulfilled' ? { metrics: metrics.value } : { metricsFailure: client.metrics ? 'request-failed' as const : 'not-supported' as const }),
            ...(status.status === 'fulfilled' ? { commandStatus: status.value } : {}),
          };
        } catch { return { metricsFailure: 'request-failed' as const }; }
      })();
      this.resourceRequests.set(ref.executionId, request);
      const pending = request;
      void request.finally(() => { if (this.resourceRequests.get(ref.executionId) === pending) this.resourceRequests.delete(ref.executionId); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The SDK metrics method has no abort parameter. Retain one pending request
      // per execution after a local timeout instead of starting unbounded retries.
      const received = await Promise.race([request, new Promise<{ metricsFailure: 'request-failed' }>(resolve => {
        timer = setTimeout(() => resolve({ metricsFailure: 'request-failed' }), this.options.resourceSampling?.timeoutMs ?? 5000);
      })]);
      const configured = this.options.resourceSampling?.deployment;
      const deployment = configured && configured.cpuCores === policy.cpu && configured.memoryMiB === policy.memoryMiB ? configured : undefined;
      return normalizeResourceSample({ execution: ref, observedAt: Date.now(), ...received,
        ...(deployment ? { deployment } : {}), ...(this.options.resourceSampling?.maxAgeMs !== undefined ? { maxAgeMs: this.options.resourceSampling.maxAgeMs } : {}) });
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Full bounded probe used before an evaluation batch; it never reuses a task sandbox. */
  async preflight(policy: ExecutionPolicy): Promise<{ checkedAt: number; sandboxId?: string }> {
    const runId = `preflight-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const attemptId = `preflight-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    let sandbox: SandboxRef | undefined;
    let execution: ExecutionRef | undefined;
    try {
      sandbox = await this.create(runId, policy);
      // The runner already sets cwd to the sandbox output directory; write a file name relative to it.
      execution = await this.execute({ sandbox, runId, stepId: 'preflight-step', attemptId, code: "from pathlib import Path; Path('preflight.txt').write_text('ok')", inputs: [], policy });
      const deadline = Date.now() + Math.min(policy.commandTimeoutMs, 30_000) + 5_000;
      let status: ExecutionStatus = { state: 'RUNNING' };
      while (status.state === 'RUNNING' && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, this.pollIntervalMs));
        status = await this.inspect(execution);
      }
      if (status.state !== 'SUCCEEDED') throw new SandboxAdapterError('SANDBOX_PREFLIGHT_FAILED', `Preflight execution ended in ${status.state}`);
      await this.collect(execution, policy);
      return { checkedAt: Date.now(), sandboxId: sandbox.sandboxId };
    } finally {
      if (sandbox) await this.destroy(sandbox).catch(error => { throw error; });
    }
  }

  async create(runId: string, policy: ExecutionPolicy): Promise<SandboxRef> {
    identifier(runId, 'runId');
    policyChecked(policy);
    // OpenSandbox metadata values are labels bounded to 63 characters.
    // Preserve the full local identity in SandboxRef, execution paths and storage.
    const metadataRunId = runId.length <= 63 && /[A-Za-z0-9]$/.test(runId)
      ? runId : `run-${createHash('sha256').update(runId).digest('hex').slice(0, 59)}`;
    const sandbox = await this.factory.create({
      connectionConfig: { ...this.options.connection, disableMetrics: true },
      image: policy.image,
      timeoutSeconds: policy.ttlSeconds,
      resource: { cpu: String(policy.cpu), memory: `${policy.memoryMiB}Mi` },
      networkPolicy: { defaultAction: 'deny', egress: policy.network.allowHosts.map((target) => ({ target, action: 'allow' })) },
      metadata: { project: 'agent-runtime', runId: metadataRunId },
    });
    this.clients.set(sandbox.id, Promise.resolve(sandbox));
    return { sandboxId: sandbox.id, runId };
  }

  private client(ref: SandboxRef): Promise<SandboxClient> {
    let existing = this.clients.get(ref.sandboxId);
    if (!existing) {
      existing = this.factory.connect({ sandboxId: ref.sandboxId, connectionConfig: { ...this.options.connection, disableMetrics: true } });
      this.clients.set(ref.sandboxId, existing);
      existing.catch(() => { this.clients.delete(ref.sandboxId); });
    }
    return existing;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionRef> {
    policyChecked(request.policy);
    identifier(request.runId, 'runId');
    identifier(request.attemptId, 'attemptId');
    identifier(request.stepId, 'stepId');
    if (request.runId !== request.sandbox.runId) throw new SandboxAdapterError('RUN_MISMATCH', 'Sandbox belongs to another run');
    if (this.uncertain.has(request.sandbox.sandboxId)) throw new SandboxAdapterError('EXECUTION_UNKNOWN', 'A prior dispatch is unresolved; reconcile before starting another command');
    if (this.starting.has(request.sandbox.sandboxId)) throw new SandboxAdapterError('EXECUTION_BUSY', 'A command is being started');
    this.starting.add(request.sandbox.sandboxId);
    const workDir = `/tmp/agent-runtime/${request.runId}/${request.attemptId}`;
    try {
      const previous = this.active.get(request.sandbox.sandboxId);
      if (previous) {
        const status = await this.inspect(previous);
        if (status.state === 'RUNNING' || status.state === 'UNKNOWN') throw new SandboxAdapterError('EXECUTION_BUSY', 'Prior execution has not been confirmed stopped');
      }
      const inputs = request.inputs.map((input) => ({ ...input, path: relativePath(input.path) }));
      if (new Set(inputs.map((input) => input.path)).size !== inputs.length) throw new SandboxAdapterError('INVALID_ARGUMENT', 'Input paths must be unique');
      const client = await this.client(request.sandbox);
      const directories = new Set([workDir, `${workDir}/inputs`, `${workDir}/outputs`]);
      for (const input of inputs) {
        const parts = input.path.split('/');
        parts.pop();
        for (let i = 1; i <= parts.length; i++) directories.add(`${workDir}/inputs/${parts.slice(0, i).join('/')}`);
      }
      // OpenSandbox resolves these fields as account names (numeric UID strings
      // are treated as usernames by the server API). The pinned Debian Python
      // image maps nobody/nogroup to UID/GID 65534, matching command execution.
      await client.files.createDirectories([...directories].map((path) => ({ path, mode: 700, owner: 'nobody', group: 'nogroup' })));
      await client.files.writeFiles([
        { path: `${workDir}/main.py`, data: request.code, mode: 644 },
        { path: `${workDir}/runner.py`, data: RUNNER_SCRIPT, mode: 644 },
        ...inputs.map((input) => ({ path: `${workDir}/inputs/${input.path}`, data: input.content, mode: 644 })),
      ]);
      let result;
      try {
        result = await client.commands.run(['python3', `${workDir}/runner.py`, workDir, String(request.policy.maxLogBytes)], {
          background: true, workingDirectory: workDir, timeoutSeconds: request.policy.commandTimeoutMs / 1000, uid: 65534, gid: 65534,
        }, undefined, AbortSignal.timeout(Math.min(request.policy.commandTimeoutMs + 5000, 30_000)));
        if (!result.id) throw new Error('missing execution ID');
      } catch {
        this.uncertain.add(request.sandbox.sandboxId);
        throw new SandboxAdapterError('EXECUTION_UNKNOWN', 'Start response did not confirm an execution ID; reconcile before retrying');
      }
      const ref: ExecutionRef = { ...request.sandbox, executionId: result.id, attemptId: request.attemptId, workDir };
      this.active.set(ref.sandboxId, ref);
      return ref;
    } finally {
      this.starting.delete(request.sandbox.sandboxId);
    }
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionStatus> {
    try {
      const status = await (await this.client(ref)).commands.getCommandStatus(ref.executionId);
      if (status.running === true) return { state: 'RUNNING' };
      if (status.running !== false) return { state: 'UNKNOWN', reason: 'Remote status does not establish whether execution is running' };
      if (this.cancelled.has(ref.executionId)) return { state: 'CANCELLED' };
      if (status.exitCode === 0) return { state: 'SUCCEEDED', exitCode: 0 };
      if (typeof status.exitCode === 'number' && Number.isInteger(status.exitCode)) {
        return { state: 'FAILED', exitCode: status.exitCode, ...(status.error ? { error: status.error } : {}) };
      }
      return { state: 'UNKNOWN', reason: 'Remote command stopped without a confirmed exit code' };
    } catch {
      return { state: 'UNKNOWN', reason: 'Remote command status is unavailable; execution outcome is not confirmed' };
    }
  }

  async cancel(ref: ExecutionRef): Promise<CancelResult> {
    try {
      const client = await this.client(ref);
      const before = await client.commands.getCommandStatus(ref.executionId);
      if (before.running === false) return { confirmed: true };
      await client.commands.interrupt(ref.executionId);
      const deadline = Date.now() + this.cancelTimeoutMs;
      let polls = 0;
      while (polls < 2 || Date.now() < deadline) {
        polls++;
        const status = await client.commands.getCommandStatus(ref.executionId);
        if (status.running === false) {
          this.cancelled.add(ref.executionId);
          return { confirmed: true };
        }
        await new Promise<void>((done) => setTimeout(done, this.pollIntervalMs));
      }
      return { confirmed: false, reason: 'Cancellation requested but remote termination not confirmed' };
    } catch {
      return { confirmed: false, reason: 'Cancellation or status query failed; remote execution may still be running' };
    }
  }

  async collect(ref: ExecutionRef, policy: ExecutionPolicy): Promise<CollectedExecution> {
    policyChecked(policy);
    const expected = `/tmp/agent-runtime/${identifier(ref.runId, 'runId')}/${identifier(ref.attemptId, 'attemptId')}`;
    if (ref.workDir !== expected) throw new SandboxAdapterError('ARTIFACT_INVALID', 'Execution directory does not match identifiers');
    const status = await this.inspect(ref);
    if (status.state !== 'SUCCEEDED' && status.state !== 'FAILED') throw new SandboxAdapterError('EXECUTION_NOT_COLLECTABLE', `Cannot publish artifacts from ${status.state}`);
    const execution = await (await this.client(ref)).commands.run([
      'python3', '-c', COLLECTOR_SCRIPT, ref.workDir, String(policy.maxOutputFiles), String(policy.maxOutputBytes), String(policy.maxLogBytes),
    ], { timeoutSeconds: Math.min(30, policy.commandTimeoutMs / 1000) }, undefined, AbortSignal.timeout(Math.min(30_000, policy.commandTimeoutMs) + 1000));
    if (execution.exitCode !== 0) throw new SandboxAdapterError('ARTIFACT_INVALID', 'Sandbox collector could not verify output files');
    let data: unknown;
    try { data = JSON.parse(execution.logs.stdout.map((message) => message.text).join('')); }
    catch { throw new SandboxAdapterError('ARTIFACT_INVALID', 'Sandbox collector returned invalid data'); }
    if (!data || typeof data !== 'object') throw new SandboxAdapterError('ARTIFACT_INVALID', 'Collector result is not an object');
    const record = data as Record<string, unknown>;
    if (!Array.isArray(record.outputs) || record.outputs.length > policy.maxOutputFiles || typeof record.stdoutBase64 !== 'string'
      || typeof record.stderrBase64 !== 'string' || typeof record.logsTruncated !== 'boolean') throw new SandboxAdapterError('ARTIFACT_INVALID', 'Malformed collector manifest');
    let total = 0;
    const outputs = record.outputs.map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new SandboxAdapterError('ARTIFACT_INVALID', 'Invalid output entry');
      const item = value as Record<string, unknown>;
      if (typeof item.path !== 'string' || typeof item.base64 !== 'string') throw new SandboxAdapterError('ARTIFACT_INVALID', 'Invalid output entry');
      const content = decodeBase64(item.base64, policy.maxOutputBytes - total);
      total += content.byteLength;
      if (total > policy.maxOutputBytes) throw new SandboxAdapterError('ARTIFACT_INVALID', 'Outputs exceed configured limit');
      return { path: relativePath(item.path), content };
    });
    if (new Set(outputs.map((output) => output.path)).size !== outputs.length) throw new SandboxAdapterError('ARTIFACT_INVALID', 'Duplicate output paths');
    const stdout = decodeBase64(record.stdoutBase64, policy.maxLogBytes);
    const stderr = decodeBase64(record.stderrBase64, policy.maxLogBytes);
    if (stdout.length > policy.maxLogBytes || stderr.length > policy.maxLogBytes) throw new SandboxAdapterError('ARTIFACT_INVALID', 'Logs exceed configured limit');
    const collected = { retainedLogBytes: stdout.length + stderr.length, logsTruncated: record.logsTruncated, outputBytes: total, outputFiles: outputs.length };
    const resources = this.options.resourceSampling ? await this.sampleResources(ref, policy)
      : normalizeResourceSample({ execution: ref, observedAt: Date.now(), metricsFailure: 'not-supported' });
    const outputResources = normalizeResourceSample({ execution: ref, observedAt: resources.observedAt, collected });
    resources.retainedLogBytes = outputResources.retainedLogBytes; resources.outputBytes = outputResources.outputBytes; resources.outputFiles = outputResources.outputFiles;
    return { execution: ref, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: status.exitCode, outputs, logsTruncated: record.logsTruncated, resources };
  }

  async destroy(ref: SandboxRef): Promise<void> {
    if (this.destroyed.has(ref.sandboxId)) return;
    let client: SandboxClient;
    try { client = await this.client(ref); }
    catch (error) {
      if (error instanceof SandboxApiException && error.statusCode === 404) { this.destroyed.add(ref.sandboxId); return; }
      throw error;
    }
    try {
      try { await client.kill(); }
      catch (error) { if (!(error instanceof SandboxApiException && error.statusCode === 404)) throw error; }
      const deadline = Date.now() + this.cancelTimeoutMs;
      while (Date.now() < deadline) {
        try { await client.getInfo(); }
        catch (error) {
          if (error instanceof SandboxApiException && error.statusCode === 404) {
            this.destroyed.add(ref.sandboxId);
            this.active.delete(ref.sandboxId);
            this.uncertain.delete(ref.sandboxId);
            return;
          }
          throw error;
        }
        await new Promise<void>((done) => setTimeout(done, this.pollIntervalMs));
      }
      throw new SandboxAdapterError('CANCEL_UNCONFIRMED', 'Sandbox deletion was requested but not confirmed');
    } finally {
      await client.close();
      this.clients.delete(ref.sandboxId);
    }
  }
}
