import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ExecutionRequest } from '../../src/contracts/sandbox.js';
import { FakeSandbox } from './fakes.js';

/** Runs trusted regression programs locally. This is a test seam, not an isolation boundary. */
export class LocalPythonSandbox extends FakeSandbox {
  constructor(private readonly directory: string) { super(); }
  override async execute(request: ExecutionRequest) {
    const root = resolve(this.directory, request.attemptId);
    const inputDir = join(root, 'inputs'); const outputDir = join(root, 'outputs');
    mkdirSync(inputDir, { recursive: true }); mkdirSync(outputDir, { recursive: true });
    for (const input of request.inputs) {
      const target = resolve(inputDir, input.path);
      if (!target.startsWith(inputDir + sep)) throw new Error('Test input escaped its directory');
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, input.content);
    }
    const program = join(root, 'main.py'); writeFileSync(program, request.code);
    const result = spawnSync(process.env.RUNTIME_PYTHON ?? 'python', [program], {
      cwd: outputDir, timeout: 5000, maxBuffer: 65536, encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        PYTHONIOENCODING: 'utf-8', AGENT_INPUT_DIR: inputDir, AGENT_OUTPUT_DIR: outputDir },
    });
    if (result.error || result.status === null) throw result.error ?? new Error('Local Python regression did not exit');
    const outputs: Array<{ path: string; content: Uint8Array }> = [];
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) visit(join(directory, entry.name), `${path}/`);
        else if (entry.isFile()) outputs.push({ path, content: readFileSync(join(directory, entry.name)) });
      }
    };
    visit(outputDir);
    this.enqueue({ states: [result.status === 0 ? { state: 'SUCCEEDED', exitCode: 0 } : { state: 'FAILED', exitCode: result.status }],
      collect: { stdout: result.stdout, stderr: result.stderr, outputs } });
    return super.execute(request);
  }
}
