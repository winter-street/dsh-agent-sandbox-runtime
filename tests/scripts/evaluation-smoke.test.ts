import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function run(scenario: string, calibration = true) {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-smoke-offline-')); roots.push(root);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve('tests/support/evaluation-smoke.ps1'), '-RepoRoot', process.cwd(), '-CheckRoot', root, '-Scenario', scenario,
    ...(calibration ? ['-Calibration'] : [])], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (result.error) throw result.error;
  const logPath = join(root, 'commands.jsonl');
  const commands: Array<{ args: Array<string | number> }> = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
  return { root, status: result.status, output: result.stdout + result.stderr,
    runs: commands.filter(command => command.args[1] === 'run'), commands };
}

describe.skipIf(process.platform !== 'win32')('PowerShell evaluation smoke (intercepted pnpm; no network or model)', () => {
  it('bounds calibration to five tasks across three variants, writes verified per-slot results and dispatches once', () => {
    const result = run('success');
    expect(result.status, result.output).toBe(0);
    expect(result.runs).toHaveLength(1);
    const summary = JSON.parse(readFileSync(join(result.root, 'out/smoke-summary.json'), 'utf8').replace(/^\uFEFF/, ''));
    expect(summary).toMatchObject({ Passed: true, Split: 'calibration', RecordedSlots: 15, ExpectedSlots: 15 });
    expect(summary.Results).toHaveLength(15);
    for (const variant of ['hard-only', 'tiered', 'tiered-finalize']) {
      expect(summary.Results.filter((entry: { Variant: string }) => entry.Variant === variant)).toHaveLength(5);
    }
  });
  it('preserves the default single-slot behavior', () => {
    const result = run('success', false);
    expect(result.status, result.output).toBe(0);
    expect(result.runs).toHaveLength(1);
    expect(result.output).toMatch(/"TaskId":\s*"e01"/);
    expect(result.output).toMatch(/"Passed":\s*true/);
    expect(existsSync(join(result.root, 'out/smoke-summary.json'))).toBe(false);
  });
  it('returns failure for an independently failed calibration slot', () => {
    const result = run('validation');
    expect(result.status, result.output).toBe(1);
    expect(result.runs).toHaveLength(1);
    const summary = JSON.parse(readFileSync(join(result.root, 'out/smoke-summary.json'), 'utf8').replace(/^\uFEFF/, ''));
    expect(summary.Passed).toBe(false);
    expect(summary.Results.filter((entry: { Passed: boolean }) => !entry.Passed)).toHaveLength(1);
  });
  it('rejects duplicate or missing strategy/task coverage despite fifteen records', () => {
    const result = run('coverage');
    expect(result.status).toBe(1);
    expect(result.runs).toHaveLength(1);
    expect(result.output).toContain('do not match the requested');
    expect(existsSync(join(result.root, 'out/smoke-summary.json'))).toBe(false);
  });
  it('preserves the infrastructure stop code without retry or reconciliation', () => {
    const result = run('infrastructure');
    expect(result.status, result.output).toBe(2);
    expect(result.runs).toHaveLength(1);
    expect(result.commands.map(command => command.args[1])).toEqual(['verify-fixtures', 'run']);
  });
  it('refuses an existing output directory before invoking any package command', () => {
    const result = run('existing');
    expect(result.status).toBe(1);
    expect(result.commands).toHaveLength(0);
    expect(result.output).toContain('already exists');
  });
  it('checks the fifteen-slot plan without creating an output directory or dispatching work', () => {
    const result = run('check-only');
    expect(result.status, result.output).toBe(0);
    expect(result.runs).toHaveLength(0);
    expect(result.output).toContain('15 calibration slot(s)');
    expect(result.output).not.toContain('offline-placeholder');
    expect(existsSync(join(result.root, 'out'))).toBe(false);
  });
});
