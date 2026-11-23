import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { startApplication } from '../src/app/index.js';
import { DeepSeekAdapter } from '../src/models/deepseek.js';
import { FakeSandbox } from '../tests/support/fakes.js';

const endpoint = 'https://api.deepseek.com/chat/completions';
const model = 'deepseek-flash';
const maxOutputTokens = 256;
const cases = ['authentication-rejection', 'client-interruption'] as const;
type Case = typeof cases[number];

async function observe(directory: string, kind: Case, credential: string) {
  let requests = 0;
  let status: number | null = null;
  let sawSse = false;
  let interrupted = false;
  let abortedTransport = false;
  const abort = new AbortController();
  const sandbox = new FakeSandbox();
  const runId = `external-${kind}`;
  class ObservedAdapter extends DeepSeekAdapter {
    override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
      const { tools: _tools, ...request } = options;
      for await (const chunk of super.stream({ ...request, signal })) {
        yield chunk;
        if (kind === 'client-interruption' && chunk.type === 'text-delta' && chunk.text.length > 0) {
          interrupted = true;
          abort.abort(new Error('N01 client stopped consuming the external stream'));
          signal.throwIfAborted();
        }
      }
    }
  }
  const provider = new ObservedAdapter({ apiKey: credential, endpoint, thinking: 'disabled', maxCalls: 1, requestTimeoutMs: 25_000,
    fetch: async (url, options) => {
      if (url !== endpoint || requests !== 0 || options?.method !== 'POST') throw new Error('Probe transport limit');
      const body = JSON.parse(String(options.body)) as { model?: string; max_tokens?: number };
      if (body.model !== model || body.max_tokens !== maxOutputTokens) throw new Error('Probe model or token cap changed');
      requests++;
      options.signal?.addEventListener('abort', () => { if (abort.signal.aborted) abortedTransport = true; }, { once: true });
      const response = await fetch(url, { ...options, redirect: 'error' });
      status = response.status;
      sawSse = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
      if (!response.ok) await response.body?.cancel();
      return response;
    },
  });
  const open = () => startApplication({ configPath: join(dirname(directory), 'probe-config.json'), dataDirectory: directory,
    env: { PROBE_PROVIDER_KEY: 'provided-by-adapter', PROBE_SANDBOX_KEY: 'unused' }, listen: false, installSignalHandlers: false,
    provider, sandbox, validate: async () => ({ passed: false, evidence: { reason: 'no task delivery expected in this probe' } }),
  });
  let host: Awaited<ReturnType<typeof open>> | undefined;
  try {
    host = await open();
    await host.submit({ runId, task: 'Reply with a list of the integers 1 through 100 as plain text. Do not invoke tools.', inputs: [] });
    const run = await host.wait(runId, { timeoutMs: 30_000 });
    const snapshot = await host.budget.reader.snapshot(run.budgetScopeKey);
    const readReceipts = async (current: NonNullable<typeof host>) => (await current.budget.reader.eventsAfter(0)).filter(item => item.scopeKey === run.budgetScopeKey);
    const readImportedIds = (current: NonNullable<typeof host>) => current.store.eventsAfter(runId).filter(item => item.type === 'budget.receipt')
      .map(item => (item.payload as { receiptEventId: string }).receiptEventId);
    const receipts = await readReceipts(host);
    const callEvents = receipts.filter(item => ['reserve', 'dispatch', 'unknown', 'settle', 'release'].includes(item.type));
    const reservationId = callEvents[0]?.payload.reservationId;
    const events = host.store.eventsAfter(runId);
    const modelEvents = events.filter(item => item.type === 'model.response');
    const facts = modelEvents[0]?.payload as { textChars: number; finishReason: string | null; usageReported: boolean } | undefined;
    const importedIds = readImportedIds(host);
    await host.close(); host = undefined;
    host = await open();
    const reopened = await host.reconcile(runId);
    const persisted = reopened.status === 'PAUSED_ACCOUNTING' && reopened.deadline === run.deadline && reopened.budgetScopeKey === run.budgetScopeKey
      && isDeepStrictEqual(await host.budget.reader.snapshot(run.budgetScopeKey), snapshot)
      && isDeepStrictEqual(await readReceipts(host), receipts) && isDeepStrictEqual(readImportedIds(host), importedIds);
    const expectedTransport = kind === 'authentication-rejection' ? status === 401 && !interrupted
      : status === 200 && sawSse && interrupted && abortedTransport && (facts?.textChars ?? 0) > 0;
    const checks = {
      expectedTransport, oneRequest: requests === 1 && modelEvents.length === 1 && !events.some(item => item.type === 'model.admission-rejected'),
      noSandbox: sandbox.calls.length === 0,
      unknownPreserved: run.status === 'PAUSED_ACCOUNTING' && snapshot.unknownCalls === 1 && snapshot.reservedTokens > 0
        && snapshot.usedTokens === 0 && !snapshot.meteringComplete && facts?.usageReported === false,
      originalReceipts: typeof reservationId === 'string' && isDeepStrictEqual(callEvents.map(item => item.type), ['reserve', 'dispatch', 'unknown'])
        && callEvents.every(item => item.payload.reservationId === reservationId)
        && isDeepStrictEqual(importedIds, receipts.map(item => item.eventId)),
      persisted,
    };
    return { kind, passed: Object.values(checks).every(Boolean), status, requests, sawSse, interrupted, abortedTransport,
      facts: facts ? { textChars: facts.textChars, finishReason: facts.finishReason, usageReported: facts.usageReported } : null,
      runStatus: run.status, reservedTokens: snapshot.reservedTokens, settledTokens: snapshot.usedTokens, unknownCalls: snapshot.unknownCalls,
      receiptTypes: callEvents.map(item => item.type), checks };
  } catch {
    return { kind, passed: false, status, requests, sawSse, interrupted, abortedTransport, error: 'Probe could not finish local evidence collection' };
  } finally { await host?.close(); }
}

export async function runExternalTransportFaults(outputDirectory: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    || (existsSync('.env.local') ? parseEnv(readFileSync('.env.local', 'utf8')).DEEPSEEK_API_KEY?.trim() : undefined);
  if (!apiKey) throw new Error('Set DEEPSEEK_API_KEY in the process or .env.local before running the external transport probe');
  const output = resolve(outputDirectory);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  writeFileSync(join(output, 'probe-config.json'), JSON.stringify({ schemaVersion: 1, runtimeConfigPath: resolve('config/runtime-hard.json'),
    dataDir: output, model: { provider: 'deepseek', name: model, apiKeyEnv: 'PROBE_PROVIDER_KEY', thinking: 'disabled', maxOutputTokens },
    budget: { maxTokens: 8_000, finalizeTokens: 0 }, sandbox: { domain: 'http://127.0.0.1:1', apiKeyEnv: 'PROBE_SANDBOX_KEY' },
  }, null, 2) + '\n', { flag: 'wx' });
  const results = [];
  for (const kind of cases) {
    const result = await observe(join(output, kind), kind, kind === 'authentication-rejection' ? 'n01-intentionally-invalid' : apiKey);
    writeFileSync(join(output, `${kind}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    results.push(result);
  }
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), mode: 'external-transport', endpoint, model, maxOutputTokens,
    requestLimit: 2, authenticatedRequestLimit: 1, passed: results.filter(item => item.passed).length, results,
    limitations: ['Authentication rejection is intentional, not an outage.', 'Client interruption does not prove server-side cancellation.',
      'No invoice or delayed usage reconciliation. No OpenSandbox calls. Not part of formal evaluation.'] };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}
