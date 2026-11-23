import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { runDemo } from '../../eval/demo.js';
import { analyzeInput, expectedChart, expectedReport } from '../../eval/artifact-validation.js';
import { FakeSandbox } from '../support/fakes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
class Provider extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.tools?.length) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'demo-controlled' as never, name: 'runtime_python', arguments: '{"code":"# controlled demo"}' } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else { yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
}
describe('one-task demonstration delivery', () => {
  it('exports only accepted files and explicit accounting proof; preserves an existing directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'demo-delivery-')); roots.push(root);
    const stats = analyzeInput(readFileSync('examples/charging-analysis/normal.csv'));
    const sandbox = new FakeSandbox();
    sandbox.enqueue({ collect: { outputs: Object.entries({ 'statistics.json': JSON.stringify(stats), 'report.md': expectedReport(stats), 'chart.svg': expectedChart(stats) })
      .map(([path, content]) => ({ path, content: Buffer.from(content) })) } });
    const options = { directory: join(root, 'demo'), configPath: 'config/eval-finalize.json',
      env: { DEEPSEEK_API_KEY: 'test', OPEN_SANDBOX_API_KEY: 'test' }, provider: new Provider(), sandbox };
    const proof = await runDemo(options);
    expect(proof).toMatchObject({ passed: true, status: 'SUCCEEDED', mode: { injectedProvider: true, injectedSandbox: true },
      budget: { usedTokens: 30, reservedTokens: 0, unknownCalls: 0 } });
    expect(JSON.parse(readFileSync(join(options.directory, 'delivery/statistics.json'), 'utf8'))).toEqual(stats);
    expect(readFileSync(join(options.directory, 'delivery/report.md'), 'utf8')).toBe(expectedReport(stats));
    expect(readFileSync(join(options.directory, 'delivery/chart.svg'), 'utf8')).toBe(expectedChart(stats));
    expect(readFileSync(join(options.directory, 'demo.json'), 'utf8')).not.toContain('API_KEY');
    await expect(runDemo(options)).rejects.toThrow('exists');
  }, 30000);
});
