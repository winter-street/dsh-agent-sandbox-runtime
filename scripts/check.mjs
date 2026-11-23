import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const steps = [
  ['typecheck', process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit']],
  ['unit and integration tests', process.execPath, [join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run']],
  ['build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']],
  ['client assets', process.execPath, ['scripts/copy-client.mjs']],
  ['frozen fixture verification', process.env.RUNTIME_PYTHON ?? 'python', ['examples/charging-analysis/verify.py', '--self-test']],
];
for (const [name, command, args] of steps) {
  process.stdout.write(`\n[check] ${name}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) {
    process.stderr.write(`[check] FAILED ${name}: ${result.error?.message ?? result.status}\n`);
    process.exit(result.status || 1);
  }
}
process.stdout.write('\n[check] PASS all local checks; no live provider or sandbox verification implied.\n');
