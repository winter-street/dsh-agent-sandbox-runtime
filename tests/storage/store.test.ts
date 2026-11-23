import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStore } from '../../src/storage/index.js';

const directories: string[] = [];
const stores: RuntimeStore[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-store-')); directories.push(directory);
  const store = new RuntimeStore(directory, () => 1000); stores.push(store);
  store.createRun({ runId: 'run-1', rootSessionId: 'session-1', budgetScopeKey: 'scope-1', task: 'analyze', deadline: 5000, policyVersion: 'v1', inputHash: 'a'.repeat(64) });
  return { store, directory };
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('durable runtime store', () => {
  it('holds a real writer lock, reopens persisted state and rejects revision conflicts', () => {
    const { store, directory } = setup();
    expect(() => new RuntimeStore(directory)).toThrow('active writer');
    store.transitionRun('run-1', 'RUNNING', 0);
    expect(() => store.transitionRun('run-1', 'PAUSED_BUDGET', 0)).toThrow('revision');
    store.close();
    const reopened = new RuntimeStore(directory); stores.push(reopened);
    expect(reopened.getRun('run-1').status).toBe('RUNNING');
    expect(reopened.eventsAfter('run-1').map(e => e.eventSeq)).toEqual([1, 2]);
  });
  it('rolls back state and its event together if a transaction fails', () => {
    const { store } = setup();
    expect(() => store.transaction(() => { store.appendEvent('run-1', 'probe', {}); throw new Error('crash'); })).toThrow('crash');
    expect(store.eventsAfter('run-1')).toHaveLength(1);
  });
  it('prevents success without required work and refuses blind parallel attempts', () => {
    const { store } = setup(); store.transitionRun('run-1', 'RUNNING');
    store.addStep({ stepId: 'step-1', runId: 'run-1', kind: 'python', required: true, inputHash: 'b'.repeat(64), status: 'PENDING', dependencies: [] });
    expect(() => store.transitionRun('run-1', 'SUCCEEDED')).toThrow('incomplete');
    const attempt = store.createAttempt('run-1', 'step-1', 'c'.repeat(64));
    expect(() => store.createAttempt('run-1', 'step-1', 'c'.repeat(64))).toThrow('active');
    store.transitionAttempt(attempt.attemptId, 'DISPATCHING');
    store.transitionAttempt(attempt.attemptId, 'RUNNING', { executionId: 'exec-1', sandboxId: 'box-1', workDir: '/work' });
    store.commitResult(attempt.attemptId, [], { stdout: 'ok', stderr: '', exitCode: 0 });
    store.transitionRun('run-1', 'SUCCEEDED');
    expect(() => store.transitionRun('run-1', 'RUNNING')).toThrow();
  });
  it('keeps unknown attempts unresolved and checkpoint stores budget references only', () => {
    const { store } = setup(); store.transitionRun('run-1', 'RUNNING');
    store.addStep({ stepId: 'step-1', runId: 'run-1', kind: 'python', required: true, inputHash: 'b'.repeat(64), status: 'PENDING', dependencies: [] });
    const a = store.createAttempt('run-1', 'step-1', 'c'.repeat(64));
    store.transitionAttempt(a.attemptId, 'DISPATCHING'); store.transitionAttempt(a.attemptId, 'UNKNOWN');
    expect(() => store.createAttempt('run-1', 'step-1', 'c'.repeat(64))).toThrow('unresolved');
    store.savePolicyState('run-1', { stage: 'conserve', notices: ['65%'] });
    const checkpoint = store.saveCheckpoint('run-1');
    expect(checkpoint.budgetScopeKey).toBe('scope-1');
    expect(checkpoint).not.toHaveProperty('usedTokens');
    expect(store.latestCheckpoint('run-1')?.policyState).toEqual({ stage: 'conserve', notices: ['65%'] });
  });
  it('deduplicates stable events and commands, rejects changed payloads', () => {
    const { store } = setup();
    store.appendEvent('run-1', 'custom', { x: 1 }, 'event-fixed');
    store.appendEvent('run-1', 'custom', { x: 1 }, 'event-fixed');
    expect(store.eventsAfter('run-1')).toHaveLength(2);
    expect(() => store.appendEvent('run-1', 'custom', { x: 2 }, 'event-fixed')).toThrow('reused');
    store.recordCommand('run-1', 'cmd-1', 'cancel', 'hash-1', { accepted: true });
    expect(store.commandResult('run-1', 'cmd-1', 'cancel', 'hash-1')).toEqual({ accepted: true });
    expect(() => store.commandResult('run-1', 'cmd-1', 'cancel', 'hash-2')).toThrow('reused');
  });
  it('pages ordered durable events from a cursor and reads the tail without loading payloads', () => {
    const { store } = setup();
    for (let i = 0; i < 70; i++) store.appendEvent('run-1', 'page-probe', { i });
    expect(store.latestEventSeq('run-1')).toBe(71);
    expect(store.latestEventSeq('missing')).toBe(0);
    const first = store.eventsAfter('run-1', 0, 64);
    expect(first).toHaveLength(64);
    const rest = store.eventsAfter('run-1', first.at(-1)!.eventSeq, 64);
    expect(rest.map(e => e.eventSeq)).toEqual([65, 66, 67, 68, 69, 70, 71]);
    for (const limit of [0, -1, 1.5, 1001]) expect(() => store.eventsAfter('run-1', 0, limit)).toThrow('page size');
    expect(() => store.eventsAfter('run-1', -1, 64)).toThrow('cursor');
  });
  it('rejects unreadable writer locks rather than guessing they are stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-lock-')); directories.push(dir);
    writeFileSync(join(dir, 'writer.lock'), 'broken');
    expect(() => new RuntimeStore(dir)).toThrow('unreadable');
  });
  it('rejects a second OS process and recovers after a real writer process exits', () => {
    const { directory, store } = setup();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/storage/index.ts')).href;
    const code = `import {RuntimeStore} from ${JSON.stringify(moduleUrl)}; try { const s=new RuntimeStore(process.argv[1]); process.exit(0); } catch(e) { if(e.code==='WRITER_BUSY') process.exit(23); throw e; }`;
    const busy = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, directory], { encoding: 'utf8' });
    expect(busy.status, busy.stderr).toBe(23);
    store.close();
    const abandoned = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, directory], { encoding: 'utf8' });
    expect(abandoned.status, abandoned.stderr).toBe(0);
    const recovered = new RuntimeStore(directory); stores.push(recovered);
    expect(recovered.getRun('run-1').runId).toBe('run-1');
  });
  it('persists command intent and commits result with state transition atomically', () => {
    const { store } = setup();
    store.transitionRun('run-1', 'RUNNING'); store.transitionRun('run-1', 'PAUSED_BUDGET');
    store.beginCommand('run-1', 'resume-1', 'resume', 'hash');
    expect(store.commandResult('run-1', 'resume-1', 'resume', 'hash')).toBeUndefined();
    expect(() => store.beginCommand('run-1', 'resume-1', 'resume', 'different')).toThrow('reused');
    const result = store.completeCommandTransition('run-1', 'resume-1', 'resume', 'hash', 'RUNNING', 2);
    expect(store.commandResult('run-1', 'resume-1', 'resume', 'hash')).toEqual(result);
    expect(store.completeCommandTransition('run-1', 'resume-1', 'resume', 'hash', 'RUNNING', 2)).toEqual(result);
  });
  it('rejects future schema without leaving a writer lock behind', () => {
    const { store, directory } = setup(); store.close();
    const raw = new DatabaseSync(join(directory, 'runtime.sqlite'));
    raw.exec('PRAGMA user_version=99'); raw.close();
    expect(() => new RuntimeStore(directory)).toThrow('newer');
    const fix = new DatabaseSync(join(directory, 'runtime.sqlite'));
    fix.exec('PRAGMA user_version=1'); fix.close();
    const reopened = new RuntimeStore(directory); stores.push(reopened);
    expect(reopened.getRun('run-1').status).toBe('CREATED');
  });
  it('rolls back a partially applied schema migration when a DDL statement fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-migration-')); directories.push(directory);
    const raw = new DatabaseSync(join(directory, 'runtime.sqlite'));
    raw.exec('CREATE TABLE conflict(x); CREATE INDEX steps ON conflict(x)');
    raw.close();

    expect(() => new RuntimeStore(directory)).toThrow('already an index named steps');
    const failed = new DatabaseSync(join(directory, 'runtime.sqlite'));
    expect((failed.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0);
    expect(failed.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='runs'").get()).toBeUndefined();
    failed.close();

    const repair = new DatabaseSync(join(directory, 'runtime.sqlite'));
    repair.exec('DROP INDEX steps'); repair.close();
    const migrated = new RuntimeStore(directory); stores.push(migrated);
    expect(migrated).toBeInstanceOf(RuntimeStore);
    const verified = new DatabaseSync(join(directory, 'runtime.sqlite'));
    expect((verified.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    verified.close();
  });
});
