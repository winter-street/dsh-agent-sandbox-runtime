import { z } from 'zod';
import type { RuntimeStore } from '../storage/index.js';
import type { JsonValue } from '../tools/registry.js';
import { canonicalJson, jsonHash } from '../tools/registry.js';

const evidenceSchema = z.strictObject({
  kind: z.enum(['artifact', 'input', 'event']), id: z.string().min(1),
  version: z.string().min(1), locator: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EntityEvidence = z.infer<typeof evidenceSchema>;
export interface EntityFact {
  runId: string;
  entityId: string;
  type: string;
  label: string;
  attributes: Record<string, JsonValue>;
  inputVersion: string;
  evidence: EntityEvidence[];
  extraction: { kind: 'deterministic' } | { kind: 'model'; ledgerEventId: string; budgetScopeKey: string };
}
const factSchema = z.strictObject({
  runId: z.string().min(1), entityId: z.string().min(1), type: z.string().min(1), label: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()), inputVersion: z.string().min(1), evidence: z.array(evidenceSchema).min(1),
  extraction: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('deterministic') }),
    z.strictObject({ kind: z.literal('model'), ledgerEventId: z.string().min(1), budgetScopeKey: z.string().min(1) })]),
});
export interface EntityHit { fact: EntityFact; score: number }
export interface EntityQuery { inputVersion: string; terms?: string[]; types?: string[]; limit?: number }
const indexSchema = z.strictObject({ schemaVersion: z.literal(1), inputVersion: z.string().min(1), generation: z.int().nonnegative() });
interface StoredFact { schemaVersion: 1; fact: EntityFact; factHash: string; generation: number }

/** Evidence validation is owned by the composition root (artifact store, input map or event log). */
export interface EntityEvidenceValidator {
  verify(runId: string, evidence: EntityEvidence): boolean;
  /** Production retrieval rechecks stored artifact bytes, not only their manifest identity. */
  verifyContent?(runId: string, evidence: EntityEvidence): Promise<boolean>;
  verifyModelReceipt?(runId: string, budgetScopeKey: string, eventId: string): boolean;
}

export class EntityIndex {
  constructor(private readonly store: RuntimeStore, private readonly evidence: EntityEvidenceValidator) {}

  setInputVersion(runId: string, inputVersion: string): void {
    if (!inputVersion) throw new TypeError('Entity index requires an input version');
    this.store.transaction(() => {
      this.store.getRun(runId);
      const oldValue = this.store.getComponentState<unknown>(runId, 'entity-index', 'version');
      const old = oldValue === undefined ? undefined : indexSchema.parse(oldValue);
      if (old?.inputVersion === inputVersion) return;
      const next = { schemaVersion: 1 as const, inputVersion, generation: (old?.generation ?? 0) + 1 };
      this.store.setComponentState(runId, 'entity-index', 'version', next);
      this.store.appendEvent(runId, 'entity.input-version', next);
    });
  }

  put(fact: EntityFact): void {
    factSchema.parse(fact);
    if (!fact.entityId || !fact.type || !fact.label || !fact.inputVersion || fact.evidence.length === 0) throw new TypeError('Entity facts require identity, input version and evidence');
    canonicalJson(fact.attributes);
    for (const ref of fact.evidence) {
      evidenceSchema.parse(ref);
      if (!this.evidence.verify(fact.runId, ref)) throw new Error('Entity evidence is absent, stale or belongs to another run');
    }
    this.store.transaction(() => {
      const run = this.store.getRun(fact.runId);
      if (fact.extraction.kind === 'model' && (fact.extraction.budgetScopeKey !== run.budgetScopeKey
        || !this.evidence.verifyModelReceipt?.(fact.runId, fact.extraction.budgetScopeKey, fact.extraction.ledgerEventId))) {
        throw new Error('Model-extracted entities require a verified owning-budget settlement');
      }
      const meta = indexSchema.parse(this.store.getComponentState(fact.runId, 'entity-index', 'version'));
      if (meta.inputVersion !== fact.inputVersion) throw new Error('Entity input version is not current');
      const key = jsonHash([meta.generation, fact.entityId]);
      const value: StoredFact = { schemaVersion: 1, fact: structuredClone(fact), factHash: jsonHash(fact), generation: meta.generation };
      const old = this.store.getComponentState<StoredFact>(fact.runId, 'entities', key);
      if (old?.factHash === value.factHash) return;
      this.store.setComponentState(fact.runId, 'entities', key, value);
      this.store.appendEvent(fact.runId, 'entity.upserted', { entityId: fact.entityId, inputVersion: fact.inputVersion, generation: meta.generation, evidence: fact.evidence });
    });
  }

  query(runId: string, request: EntityQuery): EntityHit[] {
    this.store.getRun(runId);
    const meta = indexSchema.parse(this.store.getComponentState(runId, 'entity-index', 'version'));
    if (request.inputVersion !== meta.inputVersion) throw new Error('Entity query input version is stale');
    const limit = request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Entity query limit must be 1..100');
    const terms = (request.terms ?? []).map(term => term.trim().toLocaleLowerCase('en-US')).filter(Boolean);
    return this.store.listComponentState<StoredFact>(runId, 'entities')
      .map(record => {
        factSchema.parse(record.fact);
        if (record.schemaVersion !== 1 || !record.fact || jsonHash(record.fact) !== record.factHash) throw new Error('Entity index integrity mismatch');
        return record;
      })
      .filter(record => record.schemaVersion === 1 && record.generation === meta.generation && record.fact.runId === runId && record.fact.inputVersion === request.inputVersion)
      .filter(record => !request.types?.length || request.types.includes(record.fact.type))
      .filter(record => record.fact.evidence.every(ref => this.evidence.verify(runId, ref)))
      .filter(record => record.fact.extraction.kind === 'deterministic' || !!this.evidence.verifyModelReceipt?.(runId,
        record.fact.extraction.budgetScopeKey, record.fact.extraction.ledgerEventId))
      .map(({ fact }) => {
        const text = canonicalJson([fact.label, fact.type, fact.attributes]).toLocaleLowerCase('en-US');
        return { fact, score: terms.reduce((sum, term) => sum + Number(text.includes(term)), 0) };
      })
      .filter(hit => terms.length === 0 || hit.score > 0)
      .sort((a, b) => b.score - a.score || a.fact.entityId.localeCompare(b.fact.entityId))
      .slice(0, limit).map(hit => structuredClone(hit));
  }

  /** Use for model-facing recall so metadata-only artifact checks cannot authorize stale bytes. */
  async queryVerified(runId: string, request: EntityQuery): Promise<EntityHit[]> {
    if (!this.evidence.verifyContent) throw new Error('Verified entity recall requires a content verifier');
    const before = indexSchema.parse(this.store.getComponentState(runId, 'entity-index', 'version'));
    const hits = this.query(runId, request);
    const checks = await Promise.all(hits.map(async hit => (await Promise.all(hit.fact.evidence.map(ref => this.evidence.verifyContent!(runId, ref)))).every(Boolean)));
    const after = indexSchema.parse(this.store.getComponentState(runId, 'entity-index', 'version'));
    if (jsonHash(before) !== jsonHash(after)) throw new Error('Entity input version changed during recall');
    const current = new Map(this.query(runId, request).map(hit => [hit.fact.entityId, jsonHash(hit.fact)]));
    return hits.filter((hit, index) => checks[index] && current.get(hit.fact.entityId) === jsonHash(hit.fact));
  }
}
