import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { startApplication } from '../../src/app/index.js';
import { analyzeInput, expectedChart, expectedReport } from '../../eval/artifact-validation.js';
import { createRuntimeEvaluationDriver } from '../../eval/runtime-driver.js';
import { mergeShardedEvaluation, runShardedEvaluation } from '../../eval/sharded.js';
import { auditEvaluation } from '../../eval/audit.js';
import { loadSuite } from '../../eval/report.js';
import { FakeSandbox } from '../support/fakes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('shards composed with actual Harness host, original ledger, SQLite and artifact store', () => {
  it('isolates worker storage, validates all calibration slots and reopens without another call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sharded-host-')); roots.push(root);
    const configs = {} as Record<'hard-only' | 'tiered' | 'tiered-finalize', string>;
    for (const [variant, name] of [['hard-only', 'eval-hard.json'], ['tiered', 'eval-tiered.json'], ['tiered-finalize', 'eval-finalize.json']] as const) configs[variant] = resolve('config', name);
    const started: string[] = []; const dispatched: string[] = [];
    class Provider extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        dispatched.push(String(options.sessionId)); await delay(5);
        if (options.tools?.length) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'controlled-tool' as never, name: 'runtime_python', arguments: '{"code":"# controlled sandbox output"}' } };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else { yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
      }
    }
    const drivers = [0, 1].map(index => createRuntimeEvaluationDriver({ mode: 'simulation', configs, directory: join(root, `worker-${index}`, 'evidence'),
      applicationDirectory: join(root, `worker-${index}`, 'application'), env: { DEEPSEEK_API_KEY: 'controlled', OPEN_SANDBOX_API_KEY: 'controlled' },
      start: async options => {
        started.push(options.dataDirectory!);
        const sandbox = new FakeSandbox();
        const host = await startApplication({ ...options, provider: new Provider(), sandbox });
        const submit = host.submit.bind(host);
        host.submit = async request => {
          const input = request.inputs.find(item => item.path === 'input.csv')!.content;
          const stats = analyzeInput(input);
          const outputs = 'error' in stats ? { 'statistics.json': JSON.stringify(stats) }
            : { 'statistics.json': JSON.stringify(stats), 'report.md': expectedReport(stats), 'chart.svg': expectedChart(stats) };
          sandbox.enqueue({ collect: { outputs: Object.entries(outputs).map(([path, content]) => ({ path, content: Buffer.from(content!) })) } });
          return submit(request);
        };
        return host;
      },
    })) as Parameters<typeof runShardedEvaluation>[0]['drivers'];
    const options = { directory: root, suite: loadSuite(), drivers, split: 'calibration' as const, repetitions: 1, maxRunsPerWorker: 15 };
    const progress = await runShardedEvaluation(options);
    expect(progress.peakActiveRuns).toBe(2); expect(new Set(started).size).toBe(6);
    expect(started.every(path => /worker-[01][\\/]application[\\/]/.test(path))).toBe(true);
    const calls = dispatched.length;
    expect(calls).toBe(20); // 15 task calls plus five trusted finalize reports.
    await runShardedEvaluation(options); expect(dispatched).toHaveLength(calls);
    const output = join(root, 'merged');
    expect(mergeShardedEvaluation({ ...options, output, mode: 'simulation' }).acceptance.passedRuns).toBe(15);
    expect(await auditEvaluation({ ...options, records: join(output, 'records.jsonl'), mode: 'simulation' }))
      .toMatchObject({ recorded: 15, validationPassed: 15, complete: 15, artifactCount: 33, tokenTotal: 300, unknownCalls: 0 });
    const records = readFileSync(join(output, 'records.jsonl'), 'utf8');
    expect(records).not.toContain('controlled sandbox output');
    writeFileSync(join(root, 'controlled-proof.json'), JSON.stringify({ calls, progress }));
  }, 30000);
});
