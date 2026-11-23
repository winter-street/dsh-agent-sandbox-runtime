import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../../src/storage/index.js';
import { RuntimeService } from '../../src/core/service.js';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { loadConfig } from '../../src/config.js';
import { FakeBudget, FakeClock, FakeSandbox } from './fakes.js';

export async function runtimeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-integration-'));
  const clock = new FakeClock(1000); const store = new RuntimeStore(join(directory, 'db'), clock.now);
  const sandbox = new FakeSandbox({ clock });
  const budget = new FakeBudget({ scopeKey: 'scope', sessionIds: ['root', 'planner', 'executor', 'reviewer'], limitTokens: 100000, clock });
  const service = new RuntimeService(store, new ArtifactStore(join(directory, 'artifacts')), sandbox, budget, loadConfig('config/example.json'), {
    now: clock.now, wait: clock.sleep, validate: async (_run, artifacts) => ({ passed: artifacts.some(a => a.path === 'result.json'), evidence: 'test fixture independent expected artifact' }),
  });
  await service.createRun({ runId: 'run', rootSessionId: 'root', budgetScopeKey: 'scope', task: 'produce result.json', inputHash: 'a'.repeat(64), policyVersion: 'budget-policy-v1', deadline: 100000 });
  return { directory, clock, store, sandbox, budget, service, dispose: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
