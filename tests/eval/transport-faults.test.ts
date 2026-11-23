import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runTransportFaults } from '../../eval/transport-faults.js';

it('keeps transport failures recoverable in the application and original budget ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transport-faults-'));
  try {
    const report = await runTransportFaults(join(directory, 'probe'));
    expect(report.results.filter(result => !result.passed)).toEqual([]);
    expect(report.results.map(result => result.scenario)).toEqual([
      'http-error', 'sse-disconnect', 'sse-no-finish', 'sse-no-usage', 'request-timeout', 'host-cancel',
    ]);
    expect(report.passed).toBe(6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 50_000);
