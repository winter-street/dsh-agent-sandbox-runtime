import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import type { ArtifactRecord } from '../../src/contracts/runtime.js';

const created: string[] = [];
async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-artifacts-'));
  created.push(path);
  return path;
}
afterEach(async () => {
  for (const path of created.splice(0)) {
    const target = resolve(path);
    if (dirname(target) !== resolve(tmpdir()) || !target.slice(dirname(target).length + 1).startsWith('agent-artifacts-')) throw new Error('Refusing unexpected test cleanup target');
    await rm(target, { recursive: true, force: true });
  }
});
const output = (path = 'stats.json', text = '{"sum":10}') => ({ path, content: Buffer.from(text) });
function publicationPath(root: string, record: ArtifactRecord): string {
  return join(root, 'runs', record.runId, 'attempts', record.attemptId, 'files', ...record.path.split('/'));
}

describe('ArtifactStore on real local filesystem', () => {
  it('publishes files and manifest atomically and reads only matching records', async () => {
    const root = join(await temp(), 'store');
    const store = new ArtifactStore(root);
    const records = await store.publish('run-1', 'attempt-1', [output(), output('nested/chart.svg', '<svg/>')]);
    expect(records).toHaveLength(2);
    const record = records.find((item) => item.path === 'stats.json')!;
    expect(record.sha256).toBe(createHash('sha256').update('{"sum":10}').digest('hex'));
    expect(record.size).toBe(10);
    expect(Buffer.from(await store.read(record)).toString()).toBe('{"sum":10}');
    await expect(store.verify(records)).resolves.toBeUndefined();
    expect((await store.list()).published[0]?.artifacts).toEqual(records);
    expect(await readdir(join(root, '.staging'))).toEqual([]);
    const manifest = JSON.parse(await readFile(join(root, 'runs/run-1/attempts/attempt-1/manifest.json'), 'utf8')) as { schemaVersion: number };
    expect(manifest.schemaVersion).toBe(1);
    await expect(store.read({ ...record, artifactId: 'forged-id' })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('preserves IDs on identical republish and rejects conflicting content', async () => {
    const root = join(await temp(), 'store');
    const original = await new ArtifactStore(root).publish('run-1', 'attempt-1', [output('b.txt', 'b'), output('a.txt', 'a')]);
    const reopened = new ArtifactStore(root);
    expect(await reopened.publish('run-1', 'attempt-1', [output('a.txt', 'a'), output('b.txt', 'b')])).toEqual(original);
    await expect(reopened.publish('run-1', 'attempt-1', [output('a.txt', 'different')])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(Buffer.from(await reopened.read(original[0]!)).toString()).toBe('a');
  });

  it('concurrent identical publishers observe one authoritative manifest', async () => {
    const root = join(await temp(), 'store');
    const [left, right] = await Promise.all([
      new ArtifactStore(root).publish('run-1', 'attempt-1', [output()]),
      new ArtifactStore(root).publish('run-1', 'attempt-1', [output()]),
    ]);
    expect(left).toEqual(right);
    expect((await new ArtifactStore(root).list()).published).toHaveLength(1);
  });

  it('concurrent conflicting publishers cannot overwrite the winner', async () => {
    const root = join(await temp(), 'store');
    const results = await Promise.allSettled([
      new ArtifactStore(root).publish('run-1', 'attempt-1', [output('a', 'left')]),
      new ArtifactStore(root).publish('run-1', 'attempt-1', [output('a', 'right')]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ code: 'CONFLICT' });
    expect((await new ArtifactStore(root).list()).published).toHaveLength(1);
  });

  it.each(['../escape', '/absolute', 'a\\b', 'a:b', 'CON', 'nul.txt', 'COM1.csv', 'LPT².txt', 'trailing.', 'space ', 'a//b', 'a/../b', 'bad?.txt', 'cafe\u0301.txt'])('rejects unsafe cross-platform filename %s', async (path) => {
    const root = join(await temp(), 'store');
    await expect(new ArtifactStore(root).publish('run-1', 'attempt-1', [output(path)])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('rejects case aliases, file-directory conflicts, and Windows reserved owner IDs', async () => {
    const store = new ArtifactStore(join(await temp(), 'store'));
    await expect(store.publish('run-1', 'attempt-1', [output('A.txt'), output('a.txt')])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    await expect(store.publish('run-1', 'attempt-1', [output('a'), output('a/b')])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    await expect(store.publish('CON', 'attempt-1', [output()])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('enforces count and cumulative size before publishing', async () => {
    const store = new ArtifactStore(join(await temp(), 'store'), { maxFiles: 2, maxBytes: 3 });
    await expect(store.publish('run-1', 'attempt-1', [output('a', 'aa'), output('b', 'bb')])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    await expect(store.publish('run-1', 'attempt-1', [output('a', ''), output('b', ''), output('c', '')])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect((await store.list()).published).toEqual([]);
    expect(await store.publish('run-1', 'attempt-1', [output('zero', '')])).toHaveLength(1);
  });

  it('leaves interrupted staging visible without publishing or deleting it', async () => {
    const root = join(await temp(), 'store');
    const crashing = new ArtifactStore(root, { beforePublish: () => { throw new Error('injected crash before directory rename'); } });
    await expect(crashing.publish('run-1', 'attempt-1', [output()])).rejects.toThrow('injected crash');
    const reopened = new ArtifactStore(root);
    const inventory = await reopened.reconcile([]);
    expect(inventory.published).toEqual([]);
    expect(inventory.staging).toHaveLength(1);
    const records = await reopened.publish('run-1', 'attempt-1', [output()]);
    const after = await reopened.reconcile([]);
    expect(after.unreferenced).toEqual(records);
    expect(after.staging).toEqual(inventory.staging);
    expect((await reopened.reconcile(records)).unreferenced).toEqual([]);
  });

  it('recognizes a committed but unreferenced attempt after process restart', async () => {
    const root = join(await temp(), 'store');
    const records = await new ArtifactStore(root).publish('run-1', 'attempt-1', [output()]);
    const reopened = new ArtifactStore(root);
    expect((await reopened.reconcile([])).unreferenced).toEqual(records);
    expect((await reopened.reconcile(records)).unreferenced).toEqual([]);
    expect(await reopened.publish('run-1', 'attempt-1', [output()])).toEqual(records);
  });

  it('cleans only resolved-attempt staging without touching publications or overlapping run names', async () => {
    const root = join(await temp(), 'store');
    const crashing = new ArtifactStore(root, { beforePublish: () => { throw new Error('staging interrupted'); } });
    for (const [runId, attemptId] of [['run', 'attempt'], ['run', 'pending'], ['run--attempt', 'other']]) {
      await expect(crashing.publish(runId!, attemptId!, [output()])).rejects.toThrow('interrupted');
    }
    const reopened = new ArtifactStore(root);
    const records = await reopened.publish('run', 'attempt', [output()]);
    expect(await reopened.cleanupStaging('run', ['attempt'])).toHaveLength(1);
    const remaining = await reopened.list();
    expect(remaining.staging).toHaveLength(2);
    expect(remaining.staging.some(s => s.startsWith('run--pending--'))).toBe(true);
    expect(remaining.staging.some(s => s.startsWith('run--attempt--other--'))).toBe(true);
    expect(remaining.published[0]?.artifacts).toEqual(records);
    expect(await reopened.cleanupStaging('run', ['attempt'])).toEqual([]);
  });

  it('refuses a staging junction instead of recursively touching its target', async () => {
    const base = await temp(); const root = join(base, 'store'); const outside = join(base, 'outside');
    await mkdir(join(root, '.staging'), { recursive: true }); await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'keep');
    const name = 'run--attempt--11111111-1111-1111-1111-111111111111';
    await symlink(outside, join(root, '.staging', name), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new ArtifactStore(root).cleanupStaging('run', ['attempt'])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('detects missing files and checksum changes rather than returning stale success', async () => {
    const root = join(await temp(), 'store');
    const store = new ArtifactStore(root);
    const records = await store.publish('run-1', 'attempt-1', [output('a', 'one'), output('b', 'two')]);
    await writeFile(publicationPath(root, records[0]!), 'bad');
    await expect(store.read(records[0]!)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    await rm(publicationPath(root, records[1]!));
    await expect(store.verify(records)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect((await store.list()).invalid).toHaveLength(1);
  });

  it('rejects directory symlinks and junctions without following them', async () => {
    const base = await temp();
    const root = join(base, 'store');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await mkdir(root);
    await symlink(outside, join(root, 'runs'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new ArtifactStore(root).publish('run-1', 'attempt-1', [output()])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a root reached through a linked ancestor', async () => {
    const base = await temp();
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new ArtifactStore(join(base, 'linked', 'store')).publish('run-1', 'attempt-1', [output()])).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a swapped linked output directory during verification', async () => {
    const base = await temp();
    const root = join(base, 'store');
    const store = new ArtifactStore(root);
    const records = await store.publish('run-1', 'attempt-1', [output('nested/a', 'good')]);
    const nested = join(root, 'runs/run-1/attempts/attempt-1/files/nested');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'a'), 'good');
    await rm(join(nested, 'a'));
    await rmdir(nested);
    await symlink(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(store.read(records[0]!)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });

  it('does not accept a changed or forged manifest', async () => {
    const root = join(await temp(), 'store');
    const store = new ArtifactStore(root);
    const records = await store.publish('run-1', 'attempt-1', [output()]);
    const path = join(root, 'runs/run-1/attempts/attempt-1/manifest.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 2, runId: 'run-1', attemptId: 'attempt-1', artifacts: records }));
    await expect(store.read(records[0]!)).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  });
});
