import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { startApplication } from '../../src/app/index.js';
import { validateArtifacts } from '../../eval/artifact-validation.js';
import { LocalPythonSandbox } from '../support/local-python.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Synthetic missing-column input: no held-out answer or task identifier is used.
const input = Buffer.from('alert_id,device_id\nsynthetic-a,synthetic-device\n');
function program(conditional: boolean) {
  return `import csv,json,os
from pathlib import Path
rows=csv.DictReader(open(Path(os.environ['AGENT_INPUT_DIR'])/'input.csv',encoding='utf-8'))
required={'alert_id','device_id','occurred_at','severity','review_state'}
stats={'error':'MISSING_COLUMN'} if not required.issubset(rows.fieldnames or []) else {}
out=Path(os.environ['AGENT_OUTPUT_DIR'])
(out/'statistics.json').write_text(json.dumps(stats),encoding='utf-8')
names=['statistics.json']${conditional ? " if 'error' in stats else ['statistics.json','report.md','chart.svg']" : "+['report.md','chart.svg']"}
for name in names:
    assert (out/name).is_file(), name
`;
}
class ScriptedProvider extends LlmAdapter {
  calls = 0; feedback: any[] = [];
  constructor(private readonly repair: boolean, private readonly scenario: 'assertion' | 'wrong-artifact' | 'fresh-output' = 'assertion') { super(); }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const call = ++this.calls;
    const results = options.messages.filter(message => message.role === 'tool');
    this.feedback.push(...results.flatMap(result => result.content.filter(c => c.type === 'text').map(c => { try { return JSON.parse(c.text); } catch { return null; } })));
    if (call > (this.repair ? this.scenario === 'fresh-output' ? 3 : 2 : 1)) { yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'stop' } }; return; }
    const previous = this.feedback.findLast(value => value?.diagnostics);
    const prior = this.feedback.findLast(value => value?.diagnostics?.priorArtifacts?.length)?.diagnostics.priorArtifacts[0]?.inputPath;
    const readPrior = prior ? `import json,os\nfrom pathlib import Path\nassert isinstance(json.loads((Path(os.environ['AGENT_INPUT_DIR'])/${JSON.stringify(prior)}).read_text(encoding='utf-8')),dict)\n` : '';
    const args = call === 1 ? { code: this.scenario === 'wrong-artifact' ? program(false).replace('MISSING_COLUMN', 'WRONG_ERROR') : program(false) }
      : { code: call === 2 && this.scenario === 'fresh-output' ? "import os\nfrom pathlib import Path\n(Path(os.environ['AGENT_OUTPUT_DIR'])/'statistics.json').read_text()" : readPrior + program(true),
        repairOf: previous?.diagnostics?.repairableStepIds ?? [] };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `synthetic-repair-${call}` as never, name: 'runtime_python', arguments: JSON.stringify(args) } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
async function setup(repair: boolean, scenario: 'assertion' | 'wrong-artifact' | 'fresh-output' = 'assertion', variant = 'hard-only') {
  const root = mkdtempSync(join(tmpdir(), 'runtime-script-repair-')); roots.push(root);
  const path = join(root, 'application.json');
  const runtime = JSON.parse(readFileSync('config/example.json', 'utf8'));
  runtime.policy = { ...runtime.policy, mode: variant === 'hard-only' ? 'observe' : 'enforce', finalizeShare: variant === 'tiered-finalize' ? 0.1 : 0 };
  const runtimePath = join(root, 'runtime.json'); writeFileSync(runtimePath, JSON.stringify(runtime));
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, runtimeConfigPath: runtimePath, dataDir: join(root, 'host'),
    model: { provider: 'controlled', name: 'controlled', apiKeyEnv: 'CONTROLLED_KEY' }, budget: { maxTokens: 50000, finalizeTokens: variant === 'tiered-finalize' ? 5000 : 0 },
    sandbox: { domain: 'http://127.0.0.1:8090', apiKeyEnv: 'SANDBOX_KEY' } }));
  const provider = new ScriptedProvider(repair, scenario); const sandbox = new LocalPythonSandbox(join(root, 'python'));
  const host = await startApplication({ configPath: path, env: { CONTROLLED_KEY: 'test', SANDBOX_KEY: 'test' }, listen: false, installSignalHandlers: false, provider, sandbox,
    validate: async (_run, records, read) => { const evidence = await validateArtifacts(input, records, { read }); return { passed: evidence.passed, evidence }; } });
  return { host, provider, sandbox };
}
describe('real local Python failure and explicit delivery repair (no external services)', () => {
  it('reproduces a correct error JSON followed by an actual nonzero report assertion without claiming success', async () => {
    const { host } = await setup(false);
    try {
      await host.submit({ runId: 'synthetic-assertion-failure', task: 'Invalid input requires only error statistics.json.', inputs: [{ path: 'input.csv', content: input }] });
      const snapshot = await host.wait('synthetic-assertion-failure', { timeoutMs: 30000 });
      expect(snapshot.status).toBe('COMPLETED_PARTIAL');
      const events = host.store.eventsAfter(snapshot.runId);
      expect(events.find(event => event.type === 'tool.finished')?.payload).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('AssertionError: report.md') });
      const stats = snapshot.artifacts.find(a => a.path === 'statistics.json')!;
      expect(JSON.parse(Buffer.from(await host.artifacts.read(stats)).toString())).toEqual({ error: 'MISSING_COLUMN' });
      expect(events.some(event => event.type === 'delivery.accepted')).toBe(false);
      expect(host.store.listSteps(snapshot.runId).filter(step => step.required && step.status === 'FAILED')).toHaveLength(1);
    } finally { await host.close(); }
  }, 40000);
  it.each(['hard-only', 'tiered', 'tiered-finalize'].flatMap(variant => (['assertion', 'wrong-artifact'] as const).map(scenario => ({ variant, scenario }))))('diagnoses $scenario under $variant and completes only after an explicit successful independently verified replacement', async ({ variant, scenario }) => {
    const { host, provider, sandbox } = await setup(true, scenario, variant);
    try {
      await host.submit({ runId: 'synthetic-explicit-repair', task: 'Invalid input requires only error statistics.json. Repair an identified failed step explicitly.', inputs: [{ path: 'input.csv', content: input }] });
      const snapshot = await host.wait('synthetic-explicit-repair', { timeoutMs: 30000 });
      expect(snapshot.status).toBe('SUCCEEDED');
      expect(provider.calls).toBe(variant === 'tiered-finalize' ? 3 : 2);
      const feedback = provider.feedback.find(value => value?.diagnostics);
      expect(feedback).toMatchObject({ exitCode: 1, diagnostics: { validation: scenario === 'assertion' ? 'passed' : 'failed', execution: 'failed', repairableStepIds: [expect.any(String)],
        priorArtifacts: [{ inputPath: expect.stringMatching(/^artifacts\/[^/]+\/statistics.json$/) }] } });
      const events = host.store.eventsAfter(snapshot.runId);
      expect(events.filter(event => event.type === 'repair.validated')).toHaveLength(1);
      expect(events.filter(event => event.type === 'step.superseded')).toHaveLength(1);
      expect(host.store.listAttempts(snapshot.runId).map(a => a.status)).toEqual(['FAILED', 'SUCCEEDED']);
      expect(sandbox.calls.filter(call => call.method === 'execute')).toHaveLength(2);
      expect(await host.budget.reader.snapshot(snapshot.budgetScopeKey)).toMatchObject({ usedTokens: provider.calls * 15, unknownCalls: 0, reservedTokens: 0 });
    } finally { await host.close(); }
  }, 40000);
  it('diagnoses a real fresh-output FileNotFoundError and repairs the explicit chain using canonical prior artifact inputs', async () => {
    const { host, provider, sandbox } = await setup(true, 'fresh-output');
    try {
      await host.submit({ runId: 'synthetic-directory-repair', task: 'Handle invalid input and repair identified delivery failures.', inputs: [{ path: 'input.csv', content: input }] });
      const snapshot = await host.wait('synthetic-directory-repair', { timeoutMs: 30000 });
      expect(snapshot.status).toBe('SUCCEEDED'); expect(provider.calls).toBe(3);
      const finished = host.store.eventsAfter(snapshot.runId).filter(event => event.type === 'tool.finished');
      expect(finished.map(event => event.payload)).toMatchObject([
        { exitCode: 1, stderr: expect.stringContaining('AssertionError: report.md') },
        { exitCode: 1, stderr: expect.stringContaining('FileNotFoundError') }, { exitCode: 0 },
      ]);
      expect(host.store.eventsAfter(snapshot.runId).filter(event => event.type === 'step.superseded')).toHaveLength(2);
      const requests = sandbox.calls.filter(call => call.method === 'execute');
      expect(requests).toHaveLength(3);
      expect((requests[2]!.args[0] as { inputs: Array<{ path: string }> }).inputs.some(item => item.path.startsWith('artifacts/'))).toBe(true);
      expect(await host.budget.reader.snapshot(snapshot.budgetScopeKey)).toMatchObject({ usedTokens: 45, unknownCalls: 0, reservedTokens: 0 });
    } finally { await host.close(); }
  }, 40000);
});
