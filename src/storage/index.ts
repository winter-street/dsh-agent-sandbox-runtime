import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SandboxRef } from '../contracts/sandbox.js';
import {
  assertAttemptTransition, assertRunTransition, IdSchema, RunInputSchema, RuntimeError, CheckpointSchema, RuntimeIdentitySchema,
  type RunInput, type RunRecord, type RunStatus, type StepRecord, type AttemptRecord,
  type AttemptStatus, type ArtifactRecord, type RuntimeEvent, type CheckpointRecord,
} from '../contracts/runtime.js';

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
type AttemptPatch = Partial<Pick<AttemptRecord, 'sandboxId' | 'executionId' | 'workDir' | 'errorCode' | 'failure' | 'sandboxCreateEvidence'>>;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}

/** One writer process. The budget ledger remains owned by its separate plugin. */
export class RuntimeStore {
  private readonly db: DatabaseSync;
  private readonly lockPath: string;
  private readonly lockToken = randomUUID();
  private lockFd: number;
  private closed = false;
  private transactionDepth = 0;
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {
    directory = resolve(directory);
    mkdirSync(directory, { recursive: true });
    this.lockPath = join(directory, 'writer.lock');
    try { this.lockFd = openSync(this.lockPath, 'wx'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const recoveryPath = this.lockPath + '.recovering';
      let guard: number;
      try { guard = openSync(recoveryPath, 'wx'); }
      catch { throw new RuntimeError('WRITER_BUSY', 'Writer lock recovery already in progress'); }
      try {
        // Re-read under the recovery guard so two recoverers cannot unlink a new lock.
        let owner: { pid?: number };
        try { owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: number }; }
        catch { throw new RuntimeError('WRITER_BUSY', 'Writer lock is unreadable; inspect before recovering it'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || alive(owner.pid!)) throw new RuntimeError('WRITER_BUSY', 'Runtime already has an active writer');
        unlinkSync(this.lockPath);
        this.lockFd = openSync(this.lockPath, 'wx');
      } finally { closeSync(guard); unlinkSync(recoveryPath); }
    }
    writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, token: this.lockToken }), 'utf8');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(join(directory, 'runtime.sqlite'));
      this.db = database;
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 2) throw new RuntimeError('VERSION_MISMATCH', 'Database schema is newer than this runtime');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL REFERENCES steps(id), attempt_no INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(step_id, attempt_no));
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(run_id, seq));
        CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT NOT NULL REFERENCES attempts(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), revision INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS policy_state (run_id TEXT PRIMARY KEY REFERENCES runs(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS commands (run_id TEXT NOT NULL REFERENCES runs(id), command_id TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(run_id,command_id));
        CREATE TABLE IF NOT EXISTS budget_receipts (event_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, ledger_seq INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sandboxes (run_id TEXT PRIMARY KEY REFERENCES runs(id), sandbox_id TEXT NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS component_state (run_id TEXT NOT NULL REFERENCES runs(id), namespace TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,namespace,key));
        PRAGMA user_version=2; COMMIT;`);
    } catch (error) { database?.close(); this.releaseLock(); throw error; }
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++;
    try {
      this.db.exec(depth ? `SAVEPOINT nested_${depth}` : 'BEGIN IMMEDIATE');
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('SQLite transactions require synchronous callbacks');
        this.db.exec(depth ? `RELEASE nested_${depth}` : 'COMMIT'); return result;
      } catch (error) {
        this.db.exec(depth ? `ROLLBACK TO nested_${depth}; RELEASE nested_${depth}` : 'ROLLBACK'); throw error;
      }
    } finally { this.transactionDepth--; }
  }
  getComponentState<T>(runId: string, namespace: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM component_state WHERE run_id=? AND namespace=? AND key=?').get(runId, namespace, key);
    return row ? parse<T>(row.data) : undefined;
  }
  setComponentState(runId: string, namespace: string, key: string, data: unknown): void {
    this.db.prepare('INSERT INTO component_state VALUES(?,?,?,?) ON CONFLICT(run_id,namespace,key) DO UPDATE SET data=excluded.data').run(runId, namespace, key, JSON.stringify(data));
  }
  deleteComponentState(runId: string, namespace: string, key: string): boolean {
    const result = this.db.prepare('DELETE FROM component_state WHERE run_id=? AND namespace=? AND key=?').run(runId, namespace, key);
    return result.changes > 0;
  }
  listComponentState<T>(runId: string, namespace: string): T[] {
    return this.db.prepare('SELECT data FROM component_state WHERE run_id=? AND namespace=? ORDER BY rowid').all(runId, namespace).map(r => parse<T>(r.data));
  }
  private releaseLock(): void {
    closeSync(this.lockFd);
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string };
      if (lock.token === this.lockToken) unlinkSync(this.lockPath);
    } catch { /* Do not remove another process's lock. */ }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); this.releaseLock(); } }
  createRun(input: RunInput): RunRecord {
    input = RunInputSchema.parse(input);
    if (input.deadline <= this.now()) throw new RuntimeError('INVALID_INPUT', 'Deadline already elapsed');
    const record: RunRecord = { ...input, status: 'CREATED', revision: 0, createdAt: this.now(), updatedAt: this.now(), outcome: null };
    return this.transaction(() => {
      if (this.findRun(input.runId)) throw new RuntimeError('CONFLICT', 'Run already exists');
      this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(input.runId, JSON.stringify(record), 0);
      this.appendEvent(input.runId, 'run.created', {});
      return record;
    });
  }
  findRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(runId);
    return row ? parse<RunRecord>(row.data) : undefined;
  }
  getRun(runId: string): RunRecord {
    const run = this.findRun(runId);
    if (!run) throw new RuntimeError('NOT_FOUND', `Run ${runId} not found`);
    return run;
  }
  listRuns(): RunRecord[] { return this.db.prepare('SELECT data FROM runs ORDER BY rowid').all().map(r => parse<RunRecord>(r.data)); }
  getSandbox(runId: string): SandboxRef | undefined {
    const row = this.db.prepare('SELECT sandbox_id FROM sandboxes WHERE run_id=? AND active=1').get(runId);
    return row ? { runId, sandboxId: String(row.sandbox_id) } : undefined;
  }
  saveSandbox(ref: SandboxRef): void {
    this.transaction(() => {
      const old = this.getSandbox(ref.runId);
      if (old && old.sandboxId !== ref.sandboxId) throw new RuntimeError('CONFLICT', 'Run already owns an active sandbox');
      this.db.prepare('INSERT INTO sandboxes VALUES(?,?,1) ON CONFLICT(run_id) DO UPDATE SET sandbox_id=excluded.sandbox_id,active=1').run(ref.runId, ref.sandboxId);
      this.appendEvent(ref.runId, 'sandbox.attached', { sandboxId: ref.sandboxId });
    });
  }
  releaseSandbox(ref: SandboxRef): void {
    this.db.prepare('UPDATE sandboxes SET active=0 WHERE run_id=? AND sandbox_id=?').run(ref.runId, ref.sandboxId);
  }
  transitionRun(runId: string, next: RunStatus, expectedRevision?: number, outcome: string | null = null): RunRecord {
    return this.transaction(() => this.updateRunInside(runId, next, expectedRevision, outcome));
  }
  /**
   * Operator governance switch: bound or release a run's task deadline without
   * touching its status. Only the deadline view of the run changes, so every
   * existing deadline check keeps working from one durable source.
   */
  setRunDeadline(runId: string, deadline: number): RunRecord {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new RuntimeError('INVALID_INPUT', 'Governance deadline must be a positive safe integer');
      const updated: RunRecord = { ...run, deadline, revision: run.revision + 1, updatedAt: this.now() };
      this.db.prepare('UPDATE runs SET data=?,revision=? WHERE id=?').run(JSON.stringify(updated), updated.revision, runId);
      this.appendEvent(runId, 'run.governance', { deadline, previousDeadline: run.deadline });
      return updated;
    });
  }
  private updateRunInside(runId: string, next: RunStatus, expectedRevision?: number, outcome: string | null = null): RunRecord {
    const run = this.getRun(runId);
    if (expectedRevision !== undefined && run.revision !== expectedRevision) throw new RuntimeError('CONFLICT', 'Run revision changed');
    assertRunTransition(run.status, next);
    if (next === 'SUCCEEDED') {
      const steps = this.listSteps(runId);
      if (!steps.length || steps.some(s => s.required && s.status !== 'SUCCEEDED')) throw new RuntimeError('CONFLICT', 'Required validation is incomplete');
    }
    const updated: RunRecord = { ...run, status: next, revision: run.revision + 1, updatedAt: this.now(), outcome };
    this.db.prepare('UPDATE runs SET data=?,revision=? WHERE id=?').run(JSON.stringify(updated), updated.revision, runId);
    this.appendEvent(runId, `run.${next.toLowerCase()}`, { from: run.status, revision: updated.revision, outcome });
    return updated;
  }
  addStep(step: StepRecord): void {
    IdSchema.parse(step.stepId);
    this.transaction(() => {
      this.getRun(step.runId);
      const old = this.getStep(step.stepId);
      if (old) {
        if (old.runId !== step.runId || old.inputHash !== step.inputHash || old.kind !== step.kind) throw new RuntimeError('CONFLICT', 'Step identity changed');
        return;
      }
      for (const dep of step.dependencies) {
        if (this.getStep(dep)?.runId !== step.runId) throw new RuntimeError('INVALID_INPUT', 'Step dependency missing or belongs to another run');
      }
      this.db.prepare('INSERT INTO steps VALUES(?,?,?)').run(step.stepId, step.runId, JSON.stringify(step));
      this.appendEvent(step.runId, 'step.created', { stepId: step.stepId });
    });
  }
  getStep(stepId: string): StepRecord | undefined {
    const row = this.db.prepare('SELECT data FROM steps WHERE id=?').get(stepId);
    return row ? parse<StepRecord>(row.data) : undefined;
  }
  listSteps(runId: string): StepRecord[] { return this.db.prepare('SELECT data FROM steps WHERE run_id=? ORDER BY rowid').all(runId).map(r => parse<StepRecord>(r.data)); }
  supersedeFailedStep(stepId: string, replacementId: string): void {
    this.transaction(() => {
      const old = this.getStep(stepId); const replacement = this.getStep(replacementId);
      if (!old || !replacement || old.runId !== replacement.runId || old.kind !== replacement.kind || old.status !== 'FAILED' || replacement.status !== 'SUCCEEDED') throw new RuntimeError('CONFLICT', 'Repair must reference a verified replacement for a failed step');
      this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify({ ...old, required: false }), stepId);
      this.appendEvent(old.runId, 'step.superseded', { stepId, replacementId });
    });
  }
  recordValidation(stepId: string, passed: boolean, evidence: unknown): void {
    this.transaction(() => {
      const step = this.getStep(stepId);
      if (!step || step.kind !== 'review') throw new RuntimeError('CONFLICT', 'Validation requires a registered review step');
      if (step.status === 'SUCCEEDED') throw new RuntimeError('CONFLICT', 'Validation is already committed');
      this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify({ ...step, status: passed ? 'SUCCEEDED' : 'FAILED' }), stepId);
      this.appendEvent(step.runId, 'validation.completed', { stepId, passed, evidence });
    });
  }
  /** Infrastructure failures are exploratory until an independent validator proves delivery. */
  markStepOptional(stepId: string, reason: string): void {
    this.transaction(() => {
      const step = this.getStep(stepId);
      if (!step) throw new RuntimeError('NOT_FOUND', `Step ${stepId} not found`);
      if (!step.required) return;
      this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify({ ...step, required: false }), stepId);
      this.appendEvent(step.runId, 'step.optional', { stepId, reason: reason.slice(0, 256) });
    });
  }
  createAttempt(runId: string, stepId: string, codeHash: string): AttemptRecord {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const step = this.getStep(stepId);
      if (run.status !== 'RUNNING' || !step || step.runId !== runId || step.status === 'SUCCEEDED') throw new RuntimeError('CONFLICT', 'Step cannot start');
      if (this.listAttempts(runId).some(a => ['CREATED', 'DISPATCHING', 'RUNNING', 'UNKNOWN'].includes(a.status))) throw new RuntimeError('CONFLICT', 'Run already has an active or unresolved attempt');
      if (step.dependencies.some(id => this.getStep(id)?.status !== 'SUCCEEDED')) throw new RuntimeError('CONFLICT', 'Step dependencies incomplete');
      const previous = this.listAttempts(runId).filter(a => a.stepId === stepId);
      const record: AttemptRecord = {
        attemptId: randomUUID(), stepId, runId, attemptNo: previous.length + 1, dispatchIntentId: randomUUID(),
        sandboxId: null, executionId: null, workDir: null, codeHash, status: 'CREATED', errorCode: null,
        startedAt: this.now(), finishedAt: null,
      };
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?)').run(record.attemptId, runId, stepId, record.attemptNo, JSON.stringify(record));
      this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify({ ...step, status: 'RUNNING' }), stepId);
      this.appendEvent(runId, 'attempt.created', { attemptId: record.attemptId, stepId });
      return record;
    });
  }
  getAttempt(id: string): AttemptRecord {
    const row = this.db.prepare('SELECT data FROM attempts WHERE id=?').get(id);
    if (!row) throw new RuntimeError('NOT_FOUND', 'Attempt not found');
    return parse<AttemptRecord>(row.data);
  }
  listAttempts(runId: string): AttemptRecord[] { return this.db.prepare('SELECT data FROM attempts WHERE run_id=? ORDER BY rowid').all(runId).map(r => parse<AttemptRecord>(r.data)); }
  transitionAttempt(id: string, status: AttemptStatus, patch: AttemptPatch = {}): AttemptRecord {
    return this.transaction(() => this.updateAttemptInside(id, status, patch));
  }
  private updateAttemptInside(id: string, status: AttemptStatus, patch: AttemptPatch): AttemptRecord {
    const attempt = this.getAttempt(id);
    assertAttemptTransition(attempt.status, status);
    const finished = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(status);
    const updated: AttemptRecord = { ...attempt, ...patch, status, finishedAt: finished ? this.now() : null };
    this.db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify(updated), id);
    if (finished) {
      const step = this.getStep(attempt.stepId)!;
      this.db.prepare('UPDATE steps SET data=? WHERE id=?').run(JSON.stringify({ ...step, status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED' }), step.stepId);
    }
    this.appendEvent(attempt.runId, `attempt.${status.toLowerCase()}`, { attemptId: id, stepId: attempt.stepId, ...patch });
    return updated;
  }
  commitResult(id: string, artifacts: ArtifactRecord[], result: { stdout: string; stderr: string; exitCode: number }): void {
    this.transaction(() => {
      const attempt = this.getAttempt(id);
      if (attempt.status === 'SUCCEEDED') return;
      for (const artifact of artifacts) {
        if (artifact.runId !== attempt.runId || artifact.attemptId !== id) throw new RuntimeError('ARTIFACT_INVALID', 'Artifact owner does not match attempt');
        this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?)').run(artifact.artifactId, artifact.runId, id, JSON.stringify(artifact));
      }
      this.updateAttemptInside(id, result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED', result.exitCode === 0 ? {} : { errorCode: 'SCRIPT_FAILED' });
      this.appendEvent(attempt.runId, 'tool.finished', { attemptId: id, ...result, artifacts: artifacts.map(a => a.artifactId) });
    });
  }
  listArtifacts(runId: string): ArtifactRecord[] { return this.db.prepare('SELECT data FROM artifacts WHERE run_id=? ORDER BY rowid').all(runId).map(r => parse<ArtifactRecord>(r.data)); }
  appendEvent(runId: string, type: string, payload: unknown, eventId: string = randomUUID()): RuntimeEvent {
    const old = this.db.prepare('SELECT data FROM events WHERE id=?').get(eventId);
    if (old) {
      const event = parse<RuntimeEvent>(old.data);
      if (event.runId !== runId || event.type !== type || JSON.stringify(event.payload) !== JSON.stringify(payload)) throw new RuntimeError('CONFLICT', 'Event identity reused with different data');
      return event;
    }
    const last = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE run_id=?').get(runId) as { seq: number };
    const event: RuntimeEvent = { schemaVersion: 1, eventId, runId, eventSeq: last.seq + 1, type, timestamp: this.now(), payload };
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(eventId, runId, event.eventSeq, JSON.stringify(event));
    return event;
  }
  latestEventSeq(runId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE run_id=?').get(runId) as { seq: number };
    return row.seq;
  }
  eventsAfter(runId: string, after = 0, limit?: number): RuntimeEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new RuntimeError('INVALID_INPUT', 'Event cursor must be a nonnegative safe integer');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) {
      throw new RuntimeError('INVALID_INPUT', 'Event page size must be an integer from 1 to 1000');
    }
    const rows = limit === undefined
      ? this.db.prepare('SELECT data FROM events WHERE run_id=? AND seq>? ORDER BY seq').all(runId, after)
      : this.db.prepare('SELECT data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit);
    return rows.map(r => parse<RuntimeEvent>(r.data));
  }
  getPolicyState<T = unknown>(runId: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM policy_state WHERE run_id=?').get(runId);
    return row ? parse<T>(row.data) : undefined;
  }
  savePolicyState(runId: string, state: unknown): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO policy_state VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data').run(runId, JSON.stringify(state));
      this.appendEvent(runId, 'policy.changed', state);
    });
  }
  saveCheckpoint(runId: string): CheckpointRecord {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const checkpoint: CheckpointRecord = {
        schemaVersion: 2, checkpointId: randomUUID(), runId, revision: run.revision,
        inputHash: run.inputHash, policyVersion: run.policyVersion, budgetScopeKey: run.budgetScopeKey,
        runtimeIdentity: this.getComponentState(runId, 'runtime', 'identity') === undefined
          ? null : RuntimeIdentitySchema.parse(this.getComponentState(runId, 'runtime', 'identity')),
        lastEventSeq: this.latestEventSeq(runId),
        steps: this.listSteps(runId).map(({ stepId, inputHash }) => ({ stepId, inputHash })),
        attempts: this.listAttempts(runId).map(({ attemptId, stepId, codeHash }) => ({ attemptId, stepId, codeHash })),
        artifacts: this.listArtifacts(runId), policyState: this.getPolicyState(runId) ?? null,
      };
      CheckpointSchema.parse(checkpoint);
      this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(checkpoint.checkpointId, runId, run.revision, JSON.stringify(checkpoint));
      this.appendEvent(runId, 'checkpoint.saved', { checkpointId: checkpoint.checkpointId });
      return checkpoint;
    });
  }
  latestCheckpoint(runId: string): CheckpointRecord | undefined {
    const row = this.db.prepare('SELECT data FROM checkpoints WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId);
    if (!row) return undefined;
    try { return CheckpointSchema.parse(parse<unknown>(row.data)); }
    catch { throw new RuntimeError('VERSION_MISMATCH', 'Checkpoint is corrupt or uses an unsupported schema; explicit migration is required'); }
  }
  commandResult<T>(runId: string, commandId: string, kind: string, payloadHash: string): T | undefined {
    const row = this.db.prepare('SELECT * FROM commands WHERE run_id=? AND command_id=?').get(runId, commandId);
    if (!row) return undefined;
    if (row.kind !== kind || row.payload_hash !== payloadHash) throw new RuntimeError('CONFLICT', 'Command ID reused with different payload');
    return row.result === 'null' ? undefined : parse<T>(row.result);
  }
  beginCommand(runId: string, commandId: string, kind: string, payloadHash: string): void {
    this.transaction(() => {
      this.commandResult(runId, commandId, kind, payloadHash);
      this.db.prepare('INSERT OR IGNORE INTO commands VALUES(?,?,?,?,?)').run(runId, commandId, kind, payloadHash, 'null');
    });
  }
  recordCommand(runId: string, commandId: string, kind: string, payloadHash: string, result: unknown): void {
    this.commandResult(runId, commandId, kind, payloadHash);
    this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?) ON CONFLICT(run_id,command_id) DO UPDATE SET result=excluded.result').run(runId, commandId, kind, payloadHash, JSON.stringify(result));
  }
  completeCommandTransition(runId: string, commandId: string, kind: string, payloadHash: string, status: RunStatus, expectedRevision?: number): RunRecord {
    return this.transaction(() => {
      const previous = this.commandResult<RunRecord>(runId, commandId, kind, payloadHash);
      if (previous) return previous;
      const current = this.getRun(runId);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new RuntimeError('CONFLICT', 'Run revision changed');
      const result = current.status === status ? current : this.updateRunInside(runId, status, expectedRevision);
      this.recordCommand(runId, commandId, kind, payloadHash, result);
      return result;
    });
  }
}
