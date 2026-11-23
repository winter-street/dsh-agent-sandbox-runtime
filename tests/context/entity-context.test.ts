import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/index.js';
import { EntityIndex, type EntityFact, type EntityEvidence } from '../../src/context/entities.js';
import { createRuntimeEntityEvidence, retrieveEntityContext, type EntityInputDocument } from '../../src/context/entity-context.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { jsonHash } from '../../src/tools/registry.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanups.splice(0).reverse()) dispose(); });
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'entity-context-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let store = new RuntimeStore(join(directory, 'runtime')); cleanups.push(() => store.close());
  for (const runId of ['a', 'b']) {
    store.createRun({ runId, rootSessionId: runId, budgetScopeKey: runId,
      task: 'Find relevant device evidence.', deadline: Date.now() + 60000, policyVersion: 'budget-policy-v1', inputHash: 'a'.repeat(64) });
    store.transitionRun(runId, 'RUNNING');
  }
  const artifacts = new ArtifactStore(join(directory, 'artifacts'));
  const documents = new Map<string, EntityInputDocument>([['a/input.json', { version: 'v1', content: Buffer.from('{"rows":[{"id":"device-7","alerts":3}]}') }]]);
  const evidence = () => createRuntimeEntityEvidence({ store, artifacts, input: (runId, id) => documents.get(`${runId}/${id}`) });
  const index = () => new EntityIndex(store, evidence());
  index().setInputVersion('a', 'v1'); index().setInputVersion('b', 'v1');
  const ref: EntityEvidence = { kind: 'input', id: 'input.json', version: 'v1', contentHash: sha(documents.get('a/input.json')!.content), locator: '#/rows/0' };
  const fact: EntityFact = { runId: 'a', entityId: 'device-7', type: 'device', label: 'Charger Seven', attributes: { alerts: 3 },
    inputVersion: 'v1', evidence: [ref], extraction: { kind: 'deterministic' } };
  return { directory, artifacts, documents, evidence, index, ref, fact, store: () => store,
    reopen() { store.close(); store = new RuntimeStore(join(directory, 'runtime')); } };
}

describe('production entity evidence and request-scoped recall', () => {
  it('resolves actual input JSON pointers and rejects bad hashes, missing locators, wrong versions and foreign ownership', async () => {
    const t = setup(); const verifier = t.evidence();
    expect(await verifier.resolve('a', t.ref)).toEqual({ value: { id: 'device-7', alerts: 3 } });
    for (const patch of [{ contentHash: 'b'.repeat(64) }, { locator: '#/rows/9' }, { locator: '#/rows/~2' },
      { locator: '#/rows/length' }, { locator: '#/rows/01' }, { locator: '#/rows/%ZZ' }, { version: 'v2' }]) {
      const ref = { ...t.ref, ...patch };
      expect(await verifier.resolve('a', ref)).toBeUndefined();
      expect(() => t.index().put({ ...t.fact, evidence: [ref] })).toThrow(/evidence/);
    }
    expect(await verifier.resolve('a', { ...t.ref, locator: '#%2Frows%2F0' })).toEqual({ value: { id: 'device-7', alerts: 3 } });
    expect(await verifier.resolve('b', t.ref)).toBeUndefined();
    expect(() => t.index().put({ ...t.fact, runId: 'b' })).toThrow(/evidence/);
  });
  it('resolves committed event payloads with exact sequence/hash and returns no data from another run', async () => {
    const t = setup(); const event = t.store().appendEvent('a', 'schema.checked', { device: { id: 'device-7', valid: true } });
    const ref: EntityEvidence = { kind: 'event', id: event.eventId, version: String(event.eventSeq), locator: '#/device', contentHash: jsonHash(event.payload) };
    expect(await t.evidence().resolve('a', ref)).toEqual({ value: { id: 'device-7', valid: true } });
    expect(await t.evidence().resolve('b', ref)).toBeUndefined();
    expect(await t.evidence().resolve('a', { ...ref, version: '9999' })).toBeUndefined();
    expect(await t.evidence().resolve('a', { ...ref, contentHash: 'c'.repeat(64) })).toBeUndefined();
  });
  it('reads only committed artifact bytes and rejects actual disk corruption during verified recall', async () => {
    const t = setup(); const store = t.store();
    store.addStep({ runId: 'a', stepId: 'step', kind: 'python', required: true, status: 'PENDING', dependencies: [], inputHash: 'a'.repeat(64) });
    const attempt = store.createAttempt('a', 'step', 'a'.repeat(64));
    store.transitionAttempt(attempt.attemptId, 'DISPATCHING'); store.transitionAttempt(attempt.attemptId, 'RUNNING');
    const records = await t.artifacts.publish('a', attempt.attemptId, [{ path: 'result.json', content: Buffer.from('{"alerts":3}') }]);
    const record = records[0]!; const ref: EntityEvidence = { kind: 'artifact', id: record.artifactId, version: attempt.attemptId, locator: '#/alerts', contentHash: record.sha256 };
    expect(await t.evidence().resolve('a', ref)).toBeUndefined();
    store.commitResult(attempt.attemptId, records, { stdout: '', stderr: '', exitCode: 0 });
    expect(await t.evidence().resolve('a', ref)).toEqual({ value: 3 });
    expect(await t.evidence().resolve('b', ref)).toBeUndefined();
    const index = t.index(); index.put({ ...t.fact, evidence: [ref] });
    expect(await index.queryVerified('a', { inputVersion: 'v1' })).toHaveLength(1);
    writeFileSync(join(t.artifacts.rootDir, 'runs', 'a', 'attempts', attempt.attemptId, 'files', 'result.json'), '{"alerts":9}');
    expect(await index.queryVerified('a', { inputVersion: 'v1' })).toEqual([]);
  });
  it('reopens verified entities, scopes recall per step, and invalidates old generation when input changes', async () => {
    const t = setup(); t.index().put(t.fact); t.reopen();
    const request = { runId: 'a', scopeKey: 'a', sessionId: 'a', role: 'reviewer' as const, callId: 'review', input: {} };
    const options = { index: t.index(), query: () => ({ inputVersion: 'v1', terms: ['charger'], limit: 1 }) };
    const entries = await retrieveEntityContext(options, request);
    expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ layer: 'entities' });
    expect(entries[0]!.text).toContain(t.ref.contentHash); expect(entries[0]!.text).toContain('#/rows/0');
    expect(await retrieveEntityContext(options, { ...request, runId: 'b' })).toEqual([]);
    t.documents.set('a/input.json', { version: 'v2', content: Buffer.from('{"rows":[]}') }); t.index().setInputVersion('a', 'v2');
    await expect(retrieveEntityContext(options, request)).rejects.toThrow(/stale/);
    expect(await retrieveEntityContext({ ...options, query: () => ({ inputVersion: 'v2' }) }, request)).toEqual([]);
  });
  it('rejects tampered fact hashes and cannot use a metadata-only verifier in model-facing recall', async () => {
    const t = setup(); const index = t.index(); index.put(t.fact);
    const key = jsonHash([1, t.fact.entityId]);
    const record = t.store().getComponentState<{ fact: EntityFact }>('a', 'entities', key)!;
    record.fact.attributes.alerts = 999; t.store().setComponentState('a', 'entities', key, record);
    expect(() => index.query('a', { inputVersion: 'v1' })).toThrow(/integrity/);
    await expect(new EntityIndex(t.store(), { verify: () => true }).queryVerified('a', { inputVersion: 'v1' })).rejects.toThrow(/content verifier/);
  });
  it('rejects input-generation changes during asynchronous content verification', async () => {
    const t = setup(); t.index().put(t.fact);
    const index = new EntityIndex(t.store(), { verify: () => true, verifyContent: async () => { t.index().setInputVersion('a', 'v2'); return true; } });
    await expect(index.queryVerified('a', { inputVersion: 'v1' })).rejects.toThrow(/changed during recall/);
  });
});
