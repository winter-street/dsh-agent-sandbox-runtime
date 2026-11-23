import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'creation-audit-'));
  directories.push(directory);
  const path = join(directory, 'runtime.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=2;
    CREATE TABLE runs (id TEXT, data TEXT);
    CREATE TABLE attempts (id TEXT, run_id TEXT, data TEXT);
    CREATE TABLE component_state (run_id TEXT, namespace TEXT, key TEXT, data TEXT);
    CREATE TABLE sandboxes (run_id TEXT, sandbox_id TEXT, active INTEGER);`);
  db.prepare('INSERT INTO runs VALUES (?,?)').run('run', JSON.stringify({ runId: 'run', status: 'COMPLETED_PARTIAL' }));
  const add = (id: string, status: string, errorCode: string | null, sandboxId: string | null = null, sandboxCreateEvidence?: string) =>
    db.prepare('INSERT INTO attempts VALUES (?,?,?)').run(id, 'run', JSON.stringify({ attemptId: id, runId: 'run', status, errorCode,
      sandboxId, executionId: null, workDir: null, sandboxCreateEvidence }));
  return { path, db, add };
}
function audit(path: string) {
  return spawnSync(process.execPath, [resolve('scripts/audit-sandbox-creation.mjs'), path], { encoding: 'utf8' });
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('sandbox creation audit', () => {
  it('flags legacy failures, unknown and interrupted creation regardless of run status', () => {
    const { path, db, add } = fixture();
    add('old', 'FAILED', 'SANDBOX_CREATE_FAILED');
    add('unknown', 'UNKNOWN', 'SANDBOX_CREATE_UNKNOWN');
    add('interrupted', 'CREATED', null);
    add('success', 'SUCCEEDED', null, 'remote');
    add('proven-unsent', 'FAILED', 'SANDBOX_CREATE_FAILED', null, 'adapter-confirmed-unsent-v1');
    add('contradictory', 'FAILED', 'SANDBOX_CREATE_FAILED', 'remote', 'adapter-confirmed-unsent-v1');
    db.prepare('INSERT INTO sandboxes VALUES (?,?,?)').run('run', 'local', 0);
    db.close();
    const result = audit(path);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.attemptsScanned).toBe(6);
    expect(report.findings.map((item: { attemptId: string; reason: string }) => [item.attemptId, item.reason])).toEqual([
      ['old', 'creation-failure-without-durable-unsent-proof'], ['unknown', 'creation-result-unknown'],
      ['interrupted', 'creation-may-have-been-interrupted'], ['contradictory', 'creation-failure-without-durable-unsent-proof'],
    ]);
    expect(report.findings[0]).toMatchObject({ runStatus: 'COMPLETED_PARTIAL', localSandboxId: 'local', localSandboxActive: false, runtimeCodeHash: null });
    expect(report.limitation).toContain('no cleanup, retry, or unblock');
  });

  it('fails closed for malformed or orphaned records and missing databases', () => {
    const { path, db } = fixture();
    db.prepare('INSERT INTO attempts VALUES (?,?,?)').run('orphan', 'missing', '{}');
    db.close();
    expect(audit(path).status).not.toBe(0);
    expect(audit(join(path, 'missing')).status).not.toBe(0);
  });
});
