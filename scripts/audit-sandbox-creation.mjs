import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Local records cannot establish whether remote resources exist.
export function auditSandboxCreation(path) {
  const db = new DatabaseSync(resolve(path), { readOnly: true });
  try {
    db.exec('BEGIN');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error(`Unsupported runtime database version: ${version}`);
    const rows = db.prepare(`SELECT a.id AS attempt_id, a.run_id, a.data AS attempt_data,
      r.data AS run_data, c.data AS identity_data, s.sandbox_id, s.active
      FROM attempts a LEFT JOIN runs r ON r.id = a.run_id
      LEFT JOIN component_state c ON c.run_id = a.run_id AND c.namespace = 'runtime' AND c.key = 'identity'
      LEFT JOIN sandboxes s ON s.run_id = a.run_id ORDER BY a.rowid`).all();
    const findings = [];
    for (const row of rows) {
      const attempt = JSON.parse(row.attempt_data);
      const run = JSON.parse(row.run_data);
      if (!attempt || typeof attempt !== 'object' || attempt.attemptId !== row.attempt_id || attempt.runId !== row.run_id
        || !run || typeof run !== 'object' || run.runId !== row.run_id || typeof run.status !== 'string'
        || typeof attempt.status !== 'string' || !('errorCode' in attempt) || !('sandboxId' in attempt)) {
        throw new Error(`Malformed runtime record: ${row.attempt_id}`);
      }
      const creationFailure = attempt.status === 'FAILED' && attempt.errorCode === 'SANDBOX_CREATE_FAILED';
      const provenUnsent = attempt.sandboxCreateEvidence === 'adapter-confirmed-unsent-v1'
        && attempt.sandboxId === null && attempt.executionId === null && attempt.workDir === null;
      const legacyFailure = creationFailure && !provenUnsent;
      const unknownCreate = attempt.status === 'UNKNOWN' && attempt.errorCode === 'SANDBOX_CREATE_UNKNOWN';
      const interruptedCreate = attempt.status === 'CREATED' && attempt.sandboxId === null;
      if (!legacyFailure && !unknownCreate && !interruptedCreate) continue;
      const identity = row.identity_data === null ? null : JSON.parse(row.identity_data);
      findings.push({
        runId: row.run_id, runStatus: run.status, attemptId: row.attempt_id,
        attemptStatus: attempt.status, errorCode: attempt.errorCode,
        attemptSandboxId: attempt.sandboxId, localSandboxId: row.sandbox_id ?? null,
        localSandboxActive: row.active === null ? null : row.active === 1,
        runtimeCodeHash: typeof identity?.codeHash === 'string' ? identity.codeHash : null,
        reason: legacyFailure ? 'creation-failure-without-durable-unsent-proof'
          : unknownCreate ? 'creation-result-unknown' : 'creation-may-have-been-interrupted',
      });
    }
    db.exec('COMMIT');
    return { database: resolve(path), schemaVersion: version, attemptsScanned: rows.length, findings,
      limitation: 'Local records only. Findings do not establish remote ownership or absence; no cleanup, retry, or unblock was performed.' };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/audit-sandbox-creation.mjs <runtime.sqlite>');
    console.log(JSON.stringify(auditSandboxCreation(process.argv[2]), null, 2));
  } catch (error) {
    console.error(`Audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
