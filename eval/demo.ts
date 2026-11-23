import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApplication, type ApplicationHostOptions } from '../src/app/index.js';
import { runtimeCodeHash } from '../src/core/checkpoint.js';
import { ARTIFACT_FORMAT_INSTRUCTIONS, validateArtifacts } from './artifact-validation.js';
import { collectLedgerCalls } from './runtime-driver.js';

/** Dedicated example, independent of experiment coverage. Fresh directory, one task, no automatic retries. */
export async function runDemo(options: { directory: string; configPath: string; inputPath?: string; env?: NodeJS.ProcessEnv;
  provider?: ApplicationHostOptions['provider']; sandbox?: ApplicationHostOptions['sandbox'] }) {
  const root = resolve(options.directory); if (existsSync(root)) throw new Error('Demo directory exists; preserve it and use a new directory');
  const input = readFileSync(options.inputPath ?? 'examples/charging-analysis/normal.csv');
  mkdirSync(root, { recursive: true });
  const host = await startApplication({ configPath: options.configPath, dataDirectory: join(root, 'application'), listen: false, installSignalHandlers: false,
    ...(options.env ? { env: options.env } : {}), ...(options.provider ? { provider: options.provider } : {}), ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    validate: async (_run, records, read) => { const evidence = await validateArtifacts(input, records, { read }); return { passed: evidence.passed, evidence }; } });
  const runId = `demo-${randomUUID()}`;
  try {
    await host.preflight();
    await host.submit({ runId, task: readFileSync('eval/TASK.md', 'utf8') + ARTIFACT_FORMAT_INSTRUCTIONS, inputs: [{ path: 'input.csv', content: input }] });
    const snapshot = await host.wait(runId, { timeoutMs: 900000 });
    const trace = host.store.eventsAfter(runId);
    const manifest = trace.findLast(event => event.type === 'delivery.manifest')?.payload as { artifactIds?: string[] } | undefined;
    const selected = manifest?.artifactIds ? snapshot.artifacts.filter(a => manifest.artifactIds!.includes(a.artifactId)) : [];
    const validation = await validateArtifacts(input, selected, host.artifacts);
    const budget = await host.budget.reader.snapshot(snapshot.budgetScopeKey);
    const ledger = (await host.budget.reader.eventsAfter(0)).filter(receipt => receipt.scopeKey === snapshot.budgetScopeKey);
    const calls = collectLedgerCalls(ledger, snapshot.budgetScopeKey);
    const published = join(root, 'delivery'); mkdirSync(published);
    for (const artifact of selected) {
      // Public example has exactly these reviewed delivery filenames.
      if (!['statistics.json', 'report.md', 'chart.svg'].includes(artifact.path)) throw new Error('Demo artifact is outside its output contract');
      writeFileSync(join(published, artifact.path), await host.artifacts.read(artifact), { flag: 'wx' });
    }
    const passed = snapshot.status === 'SUCCEEDED' && validation.passed && budget.unknownCalls === 0 && budget.reservedTokens === 0 && budget.meteringComplete;
    const proof = { schemaVersion: 1, runId, passed, status: snapshot.status, mode: host.mode,
      codeRevision: runtimeCodeHash(), durationMs: snapshot.updatedAt - snapshot.createdAt, validation, budget, calls,
      artifacts: selected, deliveryDirectory: published, limitation: 'One example; not full project-gate, long-task recovery, or comparative-effect evidence.' };
    for (const [name, value] of [['demo.json', proof], ['trace.json', trace], ['ledger.json', ledger]] as const) writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    return proof;
  } finally { await host.close(); }
}
