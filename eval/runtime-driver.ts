import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ArtifactStore } from '../src/artifacts/index.js';
import type { BudgetBridge } from '../src/adapters/budget/index.js';
import type { BudgetEventReceipt } from '../src/contracts/budget.js';
import type { ArtifactRecord, RunRecord, RuntimeEvent } from '../src/contracts/runtime.js';
import { IdSchema } from '../src/contracts/runtime.js';
import type { SandboxInput } from '../src/contracts/sandbox.js';
import { runtimeCodeHash } from '../src/core/checkpoint.js';
import { loadConfig, type RuntimeConfig } from '../src/config.js';
import type { RuntimeStore } from '../src/storage/index.js';
import { ContextCheckpointStore } from '../src/context/checkpoint.js';
import { ARTIFACT_FORMAT_INSTRUCTIONS, validateArtifacts } from './artifact-validation.js';
import { RunResultSchema, VARIANTS, type RunResult } from './report.js';
import { DriverManifestSchema, type DriverManifest, type EvaluationDriver, type EvaluationRequest } from './runner.js';

type Variant = RunResult['variant'];
type Call = RunResult['calls'][number];
type AppConfig = { runtimeConfigPath: string; dataDir: string; model: { provider: string; name: string; apiKeyEnv: string }; budget: { maxTokens: number; finalizeTokens: number }; sandbox: { domain: string; apiKeyEnv: string }; server?: { tokenEnv: string } };
interface HostSnapshot extends RunRecord { artifacts: ArtifactRecord[]; host: { active: boolean; recoveryRequired: boolean; error?: { code: string; message: string; phase?: string; retryable?: boolean; causeRef?: string } } }
export interface EvaluationRuntimeHost {
  mode: { provider: string; sandbox: string; injectedProvider: boolean; injectedSandbox: boolean; finalization: 'budgeted' | 'disabled' };
  store: RuntimeStore; budget: BudgetBridge; artifacts: ArtifactStore;
  submit(input: { runId: string; task: string; inputs: SandboxInput[] }): Promise<unknown>;
  wait(runId: string, options?: { timeoutMs?: number }): Promise<HostSnapshot>;
  get(runId: string): Promise<HostSnapshot>;
  reconcile(runId: string): Promise<HostSnapshot>;
  close(): Promise<unknown>;
  preflight?(): Promise<{ checkedAt: number; sandboxId?: string }>;
}
type StartHost = (options: { configPath: string; env: NodeJS.ProcessEnv; listen: false; installSignalHandlers: false;
  dataDirectory?: string;
  validate: (run: RunRecord, records: ArtifactRecord[], read: (artifact: ArtifactRecord) => Promise<Uint8Array>) => Promise<{ passed: boolean; evidence: unknown }> }) => Promise<EvaluationRuntimeHost>;
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Parse the original plugin receipts, never estimates or reconstructed balance deltas. */
export function collectLedgerCalls(receipts: readonly BudgetEventReceipt[], scopeKey: string, categories = new Map<string, Call['category']>()): Call[] {
  const calls = new Map<string, Call>(); const reservations = new Map<string, { callId: string; released: boolean; dispatched: boolean; settled: boolean; unknown: boolean }>();
  const ids = new Set<string>(); let cursor = 0;
  for (const receipt of receipts) {
    if (!Number.isSafeInteger(receipt.cursor) || receipt.cursor <= cursor || ids.has(receipt.eventId)) throw new Error('Original ledger receipt ordering/identity mismatch');
    cursor = receipt.cursor; ids.add(receipt.eventId);
    if (receipt.scopeKey !== scopeKey) continue;
    const p = receipt.payload; const reservationId = typeof p.reservationId === 'string' ? p.reservationId : undefined;
    if (receipt.type === 'reserve') {
      const r = p.request as Record<string, unknown> | undefined;
      if (!r || typeof r.modelCallId !== 'string' || !r.modelCallId || !reservationId || r.scopeKey !== scopeKey || reservations.has(reservationId) || calls.has(r.modelCallId)) throw new Error('Original ledger reservation identity mismatch');
      const category = r.purpose === 'finalize' ? 'finalize' : categories.get(r.modelCallId) ?? categories.get(reservationId) ?? 'work';
      calls.set(r.modelCallId, { callId: r.modelCallId, category, usage: null }); reservations.set(reservationId, { callId: r.modelCallId, released: false, dispatched: false, settled: false, unknown: false });
    } else if (['dispatch', 'settle', 'unknown', 'release-unsent'].includes(receipt.type)) {
      const reservation = reservationId && reservations.get(reservationId);
      if (!reservation) throw new Error('Original ledger contains an orphan reservation receipt');
      const call = calls.get(reservation.callId)!;
      if (receipt.type === 'dispatch') {
        if (reservation.dispatched || reservation.released || reservation.settled) throw new Error('Invalid or repeated original dispatch');
        reservation.dispatched = true;
      }
      else if (receipt.type === 'settle') {
        if (!reservation.dispatched || reservation.released || reservation.settled) throw new Error('Invalid or repeated original settlement');
        call.usage = RunResultSchema.shape.calls.element.shape.usage.unwrap().parse(p.usage);
        reservation.settled = true;
      } else if (receipt.type === 'unknown') {
        if (!reservation.dispatched || reservation.settled || reservation.released || reservation.unknown) throw new Error('Invalid UNKNOWN transition');
        reservation.unknown = true; call.usage = null;
      }
      else { if (reservation.dispatched || call.usage !== null) throw new Error('Dispatched call cannot be released unsent'); reservation.released = true; }
    } else if (['start', 'sample', 'unmetered'].includes(receipt.type)) {
      if (typeof p.callId !== 'string' || !p.callId) throw new Error('Legacy ledger call has no identity');
      const category = p.purpose === 'compaction' ? 'summary' : categories.get(p.callId) ?? 'work';
      const call = calls.get(p.callId) ?? { callId: p.callId, category, usage: null };
      if (p.purpose === 'compaction' || categories.has(p.callId)) call.category = category;
      call.usage = receipt.type === 'sample' ? RunResultSchema.shape.calls.element.shape.usage.unwrap().parse(p.usage) : receipt.type === 'unmetered' ? null : call.usage;
      calls.set(call.callId, call);
    }
  }
  const released = new Set([...reservations.values()].filter(r => r.released).map(r => r.callId));
  return [...calls.values()].filter(call => !released.has(call.callId));
}
function categoriesFor(store: RuntimeStore, runId: string, trace: RuntimeEvent[]): Map<string, Call['category']> {
  const result = new Map<string, Call['category']>(); const seen = new Map<string, number>();
  for (const event of trace) if (event.type === 'workflow.role_completed') {
    const p = event.payload as { role?: string; modelCallId?: string };
    if (p.modelCallId && p.role) { const prior = seen.get(p.role) ?? 0; result.set(p.modelCallId, prior > 0 ? 'retry' : p.role === 'reviewer' ? 'review' : 'work'); seen.set(p.role, prior + 1); }
  }
  const checkpoint = new ContextCheckpointStore(store, runId).load();
  for (const coverage of checkpoint?.coverages ?? []) result.set(coverage.receipt.reservationId, 'summary');
  return result;
}
function latestExecutionArtifacts(app: EvaluationRuntimeHost, runId: string, records: ArtifactRecord[]): ArtifactRecord[] {
  const trace = app.store.eventsAfter(runId);
  const manifest = trace.findLast(event => event.type === 'delivery.manifest');
  if (manifest) {
    const ids = (manifest.payload as { artifactIds?: unknown }).artifactIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Delivery manifest is malformed');
    const selected = records.filter(record => ids.includes(record.artifactId));
    if (selected.length !== ids.length) throw new Error('Delivery manifest references missing artifacts');
    return selected;
  }
  // A later exploratory failure must not hide a previously committed delivery.
  for (const finished of trace.filter(event => event.type === 'tool.finished').reverse()) {
    const attemptId = (finished.payload as { attemptId?: string }).attemptId;
    if (!attemptId) continue;
    const attempt = app.store.getAttempt(attemptId);
    if (attempt.runId !== runId || !['SUCCEEDED', 'FAILED'].includes(attempt.status)) continue;
    const selected = records.filter(record => record.runId === runId && record.attemptId === attemptId);
    if (selected.length) return selected;
  }
  return [];
}

/** Preserve sandbox classification when the host only persisted the attempt error code. */
export function inferInfrastructureFailure(trace: readonly RuntimeEvent[], hostError?: HostSnapshot['host']['error']): NonNullable<RunResult['failureEvidence']> | undefined {
  const sandboxEvent = trace.findLast(event => event.type === 'sandbox.failure');
  const sandboxPayload = sandboxEvent?.payload as { code?: string; phase?: string; retryable?: boolean; message?: string; observedAt?: number; causeRef?: string } | undefined;
  if (sandboxPayload?.code && sandboxPayload.phase && sandboxPayload.message) {
    return { code: sandboxPayload.code, phase: sandboxPayload.phase, retryable: sandboxPayload.retryable ?? true, message: sandboxPayload.message,
      observedAt: sandboxPayload.observedAt ?? Date.now(), ...(sandboxPayload.causeRef ? { causeRef: sandboxPayload.causeRef } : {}) };
  }
  const failedAttempt = trace.findLast(event => event.type === 'attempt.failed' && typeof (event.payload as { errorCode?: unknown }).errorCode === 'string'
    && /SANDBOX_(?:CREATE_FAILED|UNAVAILABLE)|DOCKER::/i.test((event.payload as { errorCode: string }).errorCode));
  if (failedAttempt) {
    const code = (failedAttempt.payload as { errorCode: string }).errorCode;
    return { code, phase: 'sandbox.create', retryable: false, message: 'Sandbox creation failed; inspect trace.json for the remote error.', observedAt: failedAttempt.timestamp };
  }
  if (hostError && (/^sandbox(?:\.|$)/i.test(hostError.phase ?? '') || /SANDBOX|DOCKER::|sidecar/i.test(`${hostError.code} ${hostError.message}`))) {
    return { code: hostError.code, phase: hostError.phase ?? 'host', retryable: hostError.retryable ?? true, message: hostError.message,
      observedAt: Date.now(), ...(hostError.causeRef ? { causeRef: hostError.causeRef } : {}) };
  }
  return undefined;
}

export interface RuntimeDriverOptions {
  configs: Record<Variant, string>;
  /** Worker-local durable placement; semantic configuration/credit stays unchanged. */
  applicationDirectory?: string;
  directory?: string; env?: NodeJS.ProcessEnv; mode?: 'real' | 'simulation';
  /** Controlled tests must explicitly select simulation; a real CLI driver never injects an adapter. */
  start?: StartHost;
  execution?: DriverManifest['execution'];
}
/** Configuration is fully preflighted before the runner can persist a dispatch intent. */
export function createRuntimeEvaluationDriver(options: RuntimeDriverOptions): EvaluationDriver {
  const env = options.env ?? process.env; const mode = options.mode ?? 'real';
  if (mode === 'real' && options.start) throw new Error('Real evaluation cannot use an injected host factory');
  if (mode === 'real' && options.execution) throw new Error('Real evaluation execution identity cannot be overridden');
  const configs = {} as Record<Variant, { path: string; raw: string; app: AppConfig; runtime: RuntimeConfig; runtimeBytes: string }>;
  for (const variant of VARIANTS) {
    const path = resolve(options.configs[variant]); const raw = readFileSync(path, 'utf8'); const app = JSON.parse(raw) as AppConfig;
    if (!app.model || !app.budget || !app.sandbox || !app.runtimeConfigPath || !Number.isSafeInteger(app.budget.maxTokens) || app.budget.maxTokens <= 0) throw new Error(`Evaluation preflight: invalid ${variant} application configuration`);
    const runtimePath = resolve(dirname(path), app.runtimeConfigPath); const runtimeBytes = readFileSync(runtimePath, 'utf8'); const runtime = loadConfig(runtimePath);
    if (app.model.provider !== 'deepseek' || !app.model.name || !app.sandbox.domain) throw new Error('Evaluation preflight: DeepSeek and OpenSandbox configuration required');
    if (mode === 'real') {
      for (const key of [app.model.apiKeyEnv, app.sandbox.apiKeyEnv]) if (!key || !env[key]?.trim()) throw new Error(`Evaluation preflight: missing required credential environment variable ${key || '(unconfigured)'}`);
      if (!existsSync(resolve('.sources/budget/lib/index.js'))) throw new Error('Evaluation preflight: original patched budget plugin has not been built');
    }
    configs[variant] = { path, raw, app, runtime, runtimeBytes };
  }
  const hard = configs['hard-only']; const tiered = configs.tiered; const finalize = configs['tiered-finalize'];
  if (hard.runtime.policy.mode !== 'observe' || hard.app.budget.finalizeTokens !== 0 || hard.runtime.policy.finalizeShare !== 0
    || tiered.runtime.policy.mode !== 'enforce' || tiered.app.budget.finalizeTokens !== 0 || tiered.runtime.policy.finalizeShare !== 0
    || finalize.runtime.policy.mode !== 'enforce' || finalize.app.budget.finalizeTokens <= 0 || finalize.runtime.policy.finalizeShare <= 0) throw new Error('Evaluation preflight: variants must implement hard-only / tiered without reserve / tiered with finalize reserve');
  if (new Set(VARIANTS.map(v => configs[v].app.budget.maxTokens)).size !== 1 || new Set(VARIANTS.map(v => canonical(configs[v].app.model))).size !== 1) throw new Error('Evaluation preflight: comparison requires identical model configuration and total token budget');
  if (new Set(VARIANTS.map(v => canonical({ sandbox: configs[v].app.sandbox, resources: configs[v].runtime.sandbox,
    thresholds: Object.fromEntries(Object.entries(configs[v].runtime.policy).filter(([k]) => !['mode', 'finalizeShare'].includes(k))) }))).size !== 1) throw new Error('Evaluation preflight: variants must share sandbox resources and policy thresholds');
  if (Math.abs(finalize.app.budget.finalizeTokens / finalize.app.budget.maxTokens - finalize.runtime.policy.finalizeShare) > 1e-12) throw new Error('Evaluation preflight: finalization allocation must agree with its policy reserve ratio');
  if (new Set(VARIANTS.map(v => resolve(dirname(configs[v].path), configs[v].app.dataDir))).size !== 3) throw new Error('Evaluation preflight: variants require separate durable application directories');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
  };
  const dependencyVersion = (name: string) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name] ?? 'unknown';
  const validatorHash = digest(readFileSync(fileURLToPath(new URL('./artifact-validation.ts', import.meta.url))));
  const driverHash = digest(readFileSync(fileURLToPath(import.meta.url)));
  const execution = options.execution ?? { provider: 'deepseek', model: hard.app.model.name, modelVersion: `${hard.app.model.name} (provider alias; server revision not exposed)`,
    harnessVersion: dependencyVersion('@deepseek-ai/dsh-llm'), sandboxVersion: `OpenSandbox SDK ${dependencyVersion('@alibaba-group/opensandbox')}`, codeRevision: digest(canonical({ runtime: runtimeCodeHash(), driverHash, validatorHash })) };
  const variantManifest = Object.fromEntries(VARIANTS.map(v => [v, { configSha256: digest(canonical({ application: JSON.parse(configs[v].raw), runtime: configs[v].runtime, outputContract: ARTIFACT_FORMAT_INSTRUCTIONS, validatorHash })), budgetLimitTokens: configs[v].app.budget.maxTokens }]));
  const manifest = DriverManifestSchema.parse({ schemaVersion: 1, mode, execution, variants: variantManifest });
  if (new Set(Object.values(manifest.variants).map(v => v.configSha256)).size !== 3) throw new Error('Evaluation preflight: variant configuration fingerprints must differ');
  const directory = resolve(options.directory ?? env.ASR_EVAL_EVIDENCE_DIR ?? '.runtime/evaluation-evidence');
  if (mode === 'real' && !existsSync(resolve('src/app/index.ts'))) throw new Error('Evaluation preflight: application host entrypoint is unavailable');
  const snapshots = new Map<string, { result: RunResult; requestHash: string }>();
  const start: StartHost = options.start ?? (async args => {
    const modulePath = pathToFileURL(resolve('src/app/index.ts')).href;
    const appModule = await import(modulePath) as { startApplication: StartHost };
    return appModule.startApplication(args);
  });
  const requestHash = (r: EvaluationRequest) => digest(canonical({ ...r, input: { ...r.input, content: digest(r.input.content) } }));
  async function inspect(request: EvaluationRequest, reconcile: boolean, signal?: AbortSignal): Promise<{ runId: string }> {
    signal?.throwIfAborted();
    IdSchema.parse(request.runId);
    if (digest(request.input.content) !== request.input.sha256) throw new Error('Evaluation input content fingerprint mismatch');
    const config = configs[request.variant];
    if (readFileSync(config.path, 'utf8') !== config.raw || readFileSync(resolve(dirname(config.path), config.app.runtimeConfigPath), 'utf8') !== config.runtimeBytes) throw new Error('Evaluation configuration changed after preflight');
    const runDirectory = join(directory, request.runId); const intentPath = join(runDirectory, 'intent.json');
    const intent = canonical({ version: 1, requestHash: requestHash(request), manifest, variant: request.variant });
    if (reconcile) { if (readFileSync(intentPath, 'utf8') !== intent) throw new Error('Existing evaluation intent does not match this exact request and manifest'); }
    else { mkdirSync(runDirectory, { recursive: true }); writeFileSync(intentPath, intent, { flag: 'wx', mode: 0o600 }); }
    let app: EvaluationRuntimeHost | undefined;
    app = await start({ configPath: config.path, env, listen: false, installSignalHandlers: false,
      ...(options.applicationDirectory ? { dataDirectory: resolve(options.applicationDirectory, request.variant) } : {}),
      validate: async (run, records, read) => {
        if (!app) throw new Error('Application artifact reader is not ready');
        const selected = latestExecutionArtifacts(app, run.runId, records);
        const evidence = await validateArtifacts(request.input.content, selected, { read });
        return { passed: evidence.passed, evidence: { ...evidence, attemptId: selected[0]?.attemptId ?? null } };
      },
    });
    try {
      if (mode === 'real' && (app.mode.injectedProvider || app.mode.injectedSandbox || app.mode.provider !== 'deepseek' || app.mode.sandbox !== 'opensandbox')) throw new Error('Real evaluation requires actual DeepSeek provider and OpenSandbox adapter');
      if (app.mode.finalization !== (request.variant === 'tiered-finalize' ? 'budgeted' : 'disabled')) throw new Error('Application finalization capability does not match the experiment variant');
      // Querying old work is deliberately a separate branch; it never invokes submit/continue/wait.
      let snapshot: HostSnapshot;
      if (reconcile) { await app.get(request.runId); snapshot = await app.reconcile(request.runId); }
      else { await app.submit({ runId: request.runId, task: request.prompt + ARTIFACT_FORMAT_INSTRUCTIONS, inputs: [{ path: 'input.csv', content: Uint8Array.from(request.input.content) }] }); snapshot = await app.wait(request.runId, { timeoutMs: 900_000 }); }
      signal?.throwIfAborted();
      if (snapshot.runId !== request.runId || snapshot.host.active || snapshot.status === 'RUNNING' || snapshot.status === 'CANCELLING') throw new Error('Evaluation run remains active/uncertain; preserve the pending slot for reconciliation');
      const trace = app.store.eventsAfter(request.runId); const ledger = (await app.budget.reader.eventsAfter(0)).filter(r => r.scopeKey === snapshot.budgetScopeKey);
      const selected = latestExecutionArtifacts(app, request.runId, snapshot.artifacts);
      const evidence = { ...await validateArtifacts(request.input.content, selected, app.artifacts), attemptId: selected[0]?.attemptId ?? null };
      const calls = collectLedgerCalls(ledger, snapshot.budgetScopeKey, categoriesFor(app.store, request.runId, trace));
      const accounting = await app.budget.reader.snapshot(snapshot.budgetScopeKey);
      if (accounting.limitTokens !== manifest.variants[request.variant].budgetLimitTokens) throw new Error('Original root ledger budget does not match the variant manifest');
      if (calls.length && accounting.meteringComplete && accounting.unknownCalls === 0 && calls.some(c => c.usage === null)) throw new Error('Ledger snapshot and call receipts disagree about accounting completeness');
      const knownTokens = calls.reduce((total, call) => total + (call.usage ? Object.values(call.usage).reduce((a, b) => a + b, 0) : 0), 0);
      if (!Number.isSafeInteger(knownTokens) || knownTokens !== accounting.usedTokens) throw new Error('Original ledger total does not match independently enumerated model calls');
      const write = (name: string, value: unknown) => { const path = join(runDirectory, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); return path; };
      const tracePath = write('trace.json', trace); const ledgerPath = write('ledger.json', { scopeKey: snapshot.budgetScopeKey, snapshot: accounting, receipts: ledger }); const validationPath = write('validation.json', evidence);
      const artifactPaths: string[] = [];
      for (const record of snapshot.artifacts) { const bytes = await app.artifacts.read(record); const path = join(runDirectory, `${record.artifactId}.artifact`); writeFileSync(path, bytes, { mode: 0o600 }); artifactPaths.push(path); }
      write('artifacts.json', snapshot.artifacts);
      const outcome: RunResult['outcome'] = snapshot.status === 'SUCCEEDED' ? 'complete' : snapshot.status === 'COMPLETED_PARTIAL' ? 'partial' : snapshot.status === 'FAILED' ? 'failed' : snapshot.status === 'CANCELLED' ? 'cancelled' : 'paused';
      const denied = trace.filter(e => e.type === 'policy.decision' && (e.payload as { allowed?: boolean }).allowed === false);
      const infrastructureFailure = inferInfrastructureFailure(trace, snapshot.host.error);
      const lastModelResponse = trace.findLast(event => event.type === 'model.response')?.payload as { finishReason?: string } | undefined;
      // Internal conflicts and local admission are not provider failures. Only
      // explicit model failures or provider-boundary finish facts support that attribution.
      const providerFailure = ['MODEL_OUTPUT_TRUNCATED', 'MODEL_REQUEST_FAILED'].includes(snapshot.host.error?.code ?? '')
        || ['max-tokens', 'error'].includes(lastModelResponse?.finishReason ?? '');
      const validationFailure = snapshot.host.error?.code === 'VALIDATION_FAILED' || !evidence.passed;
      const localBudgetFailure = snapshot.status === 'PAUSED_BUDGET' || snapshot.host.error?.code === 'BUDGET_UNAVAILABLE';
      const internalFailure = snapshot.host.error && snapshot.host.error.code !== 'VALIDATION_FAILED';
      const failureKind: RunResult['failureKind'] = outcome === 'complete' ? null : accounting.unknownCalls > 0 ? 'accounting' : infrastructureFailure ? 'sandbox' : localBudgetFailure ? 'budget' : snapshot.status === 'PAUSED_APPROVAL' ? 'permission' : outcome === 'cancelled' ? 'cancelled' : providerFailure ? 'provider' : internalFailure ? 'other' : validationFailure ? 'validation' : 'other';
      const result = RunResultSchema.parse({ schemaVersion: 1, suiteSha256: request.suiteSha256, taskId: request.taskId, variant: request.variant, repetition: request.repetition, mode, runId: request.runId,
        execution: { ...manifest.execution, configSha256: manifest.variants[request.variant].configSha256 }, outcome, candidateStatistics: evidence.candidateStatistics, checks: evidence.checks, calls,
        budgetLimitTokens: manifest.variants[request.variant].budgetLimitTokens, durationMs: Math.max(0, snapshot.updatedAt - snapshot.createdAt),
        interruptions: trace.filter(e => e.type === 'run.cancelling' && !(e.payload as { outcome?: string }).outcome?.includes('deadline')).length,
        denials: denied.length, reviewedDenials: 0, falseDenials: 0, failureKind,
        ...(infrastructureFailure ? { failureEvidence: infrastructureFailure } : {}), evidence: { trace: tracePath, ledger: ledgerPath, validation: validationPath, artifacts: artifactPaths } });
      if (failureKind) write('failure.json', { schemaVersion: 1, runId: request.runId, failureKind,
        ...(infrastructureFailure ? { evidence: infrastructureFailure } : {}),
        hostErrorCode: snapshot.host.error?.code ?? null, lastModelFinishReason: lastModelResponse?.finishReason ?? null,
        validationPassed: evidence.passed,
        incompleteRequiredSteps: app.store.listSteps(request.runId).filter(step => step.required && step.status !== 'SUCCEEDED').map(step => ({ stepId: step.stepId, kind: step.kind, status: step.status })),
        references: { trace: tracePath, ledger: ledgerPath, validation: validationPath } });
      write('result.json', result); snapshots.set(request.runId, { result, requestHash: requestHash(request) });
      return { runId: request.runId };
    } finally { await app.close(); }
  }
  const preflight = async (signal?: AbortSignal) => {
    if (mode !== 'real') return { mode, checked: false };
    const checked: Array<{ variant: Variant; checkedAt: number; sandboxId?: string }> = [];
    for (const variant of VARIANTS) {
      signal?.throwIfAborted();
      const config = configs[variant];
      const host = await start({ configPath: config.path, env, listen: false, installSignalHandlers: false,
        ...(options.applicationDirectory ? { dataDirectory: resolve(options.applicationDirectory, variant) } : {}),
        validate: async () => ({ passed: false, evidence: { phase: 'preflight' } }) });
      try {
        if (!host.preflight) throw new Error('Application host does not expose sandbox preflight');
        checked.push({ variant, ...(await host.preflight()) });
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Evaluation preflight failed for ${variant} at ${config.app.sandbox.domain}: ${message}`, { cause: error });
      }
      finally { await host.close(); }
    }
    return { mode, checked };
  };
  return { manifest, preflight, execute: (request, signal) => inspect(request, false, signal), reconcile: (request, signal) => inspect(request, true, signal),
    async validate(request, executionResult) {
      if (!executionResult || typeof executionResult !== 'object' || (executionResult as { runId?: string }).runId !== request.runId) throw new Error('Untrusted evaluation execution handle');
      const saved = snapshots.get(request.runId);
      if (!saved || saved.requestHash !== requestHash(request)) throw new Error('No independently collected result for this exact request');
      return structuredClone(saved.result);
    } };
}

let configured: EvaluationDriver | undefined;
export function runtimeDriverConfigs(env = process.env): Record<Variant, string> {
  const names = { 'hard-only': 'ASR_EVAL_CONFIG_HARD_ONLY', tiered: 'ASR_EVAL_CONFIG_TIERED', 'tiered-finalize': 'ASR_EVAL_CONFIG_FINALIZE' } as const;
  return Object.fromEntries(VARIANTS.map(v => { const path = env[names[v]];
    if (!path) throw new Error(`Evaluation preflight: configure ${names[v]} before using the real runtime driver`); return [v, path]; })) as Record<Variant, string>;
}
function configuredDriver() {
  if (!configured) {
    configured = createRuntimeEvaluationDriver({ configs: runtimeDriverConfigs() });
  }
  return configured;
}
/** CLI default is always real and performs no work at module import time. */
export default {
  get manifest() { return configuredDriver().manifest; },
  preflight: async signal => (await configuredDriver().preflight?.(signal)) ?? { mode: 'real', checked: false },
  execute: (r, signal) => configuredDriver().execute(r, signal),
  reconcile: (r, signal) => configuredDriver().reconcile!(r, signal),
  validate: (r, execution) => configuredDriver().validate(r, execution),
} satisfies EvaluationDriver;
