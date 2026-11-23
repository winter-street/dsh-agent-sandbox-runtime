import { createHash } from 'node:crypto';
import type { ArtifactStore } from '../artifacts/index.js';
import type { RuntimeStore } from '../storage/index.js';
import type { RoleRequest } from '../workflow/serial.js';
import { canonicalJson, jsonHash, type JsonValue } from '../tools/registry.js';
import type { TextContextEntry } from './assembler.js';
import { EntityIndex, type EntityEvidence, type EntityEvidenceValidator, type EntityQuery } from './entities.js';

export interface EntityInputDocument { version: string; content: Uint8Array }
export interface EntityRecallOptions {
  index: EntityIndex;
  /** Trusted step selection. Never derive trusted layers, privileges or run ownership from model text. */
  query(request: Readonly<RoleRequest>): EntityQuery | undefined | Promise<EntityQuery | undefined>;
}
const hashBytes = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** Locator is a JSON Pointer fragment: # selects the document, #/rows/0 selects one value. */
function select(value: JsonValue, locator: string): { value: JsonValue } | undefined {
  if (!locator.startsWith('#')) return undefined;
  let pointer: string;
  try { pointer = decodeURIComponent(locator.slice(1)); } catch { return undefined; }
  if (!pointer) return { value };
  if (!pointer.startsWith('/')) return undefined;
  let selected: JsonValue = value;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(raw)) return undefined;
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, part)) return undefined;
    if (Array.isArray(selected) && !/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
    selected = (selected as Record<string, JsonValue>)[part]!;
  }
  return { value: selected };
}

/** Raw input/artifact bytes use SHA256; event payloads use canonical JSON SHA256. No model calls. */
export function createRuntimeEntityEvidence(options: {
  store: RuntimeStore;
  artifacts: ArtifactStore;
  input(runId: string, id: string): EntityInputDocument | undefined;
}): EntityEvidenceValidator & { resolve(runId: string, ref: EntityEvidence): Promise<{ value: JsonValue } | undefined> } {
  function metadata(runId: string, ref: EntityEvidence): boolean {
    options.store.getRun(runId);
    if (!['input', 'artifact', 'event'].includes(ref.kind) || typeof ref.locator !== 'string' || !ref.locator
      || typeof ref.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.contentHash)) return false;
    if (ref.kind === 'input') {
      const input = options.input(runId, ref.id);
      if (!input || input.version !== ref.version || hashBytes(input.content) !== ref.contentHash) return false;
      try { return !!select(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.content)) as JsonValue, ref.locator); } catch { return false; }
    }
    if (ref.kind === 'event') {
      const event = options.store.eventsAfter(runId).find(item => item.eventId === ref.id);
      return !!event && String(event.eventSeq) === ref.version && jsonHash(event.payload) === ref.contentHash
        && !!select(event.payload as JsonValue, ref.locator);
    }
    const record = options.store.listArtifacts(runId).find(item => item.artifactId === ref.id);
    return !!record && record.runId === runId && record.attemptId === ref.version && record.sha256 === ref.contentHash;
  }
  async function resolve(runId: string, ref: EntityEvidence): Promise<{ value: JsonValue } | undefined> {
    if (!metadata(runId, ref)) return undefined;
    if (ref.kind === 'event') {
      const event = options.store.eventsAfter(runId).find(item => item.eventId === ref.id)!;
      return select(event.payload as JsonValue, ref.locator);
    }
    try {
      const bytes = ref.kind === 'input' ? options.input(runId, ref.id)?.content
        : await options.artifacts.read(options.store.listArtifacts(runId).find(item => item.artifactId === ref.id)!);
      if (!bytes || hashBytes(bytes) !== ref.contentHash || !metadata(runId, ref)) return undefined;
      return select(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue, ref.locator);
    } catch { return undefined; }
  }
  return { verify: metadata, verifyContent: async (runId, ref) => !!await resolve(runId, ref), resolve };
}

/** Request-scoped recall is never persisted as trusted instructions or summarized historical truth. */
export async function retrieveEntityContext(options: EntityRecallOptions, request: RoleRequest): Promise<TextContextEntry[]> {
  const query = await options.query(Object.freeze({ ...request }));
  if (!query) return [];
  const hits = await options.index.queryVerified(request.runId, query);
  return hits.map(({ fact }) => ({ id: `entity-recall-${jsonHash([request.runId, fact.entityId, fact.inputVersion])}`, revision: 1,
    layer: 'entities', text: canonicalJson({ kind: 'untrusted-entity-recall', entityId: fact.entityId, type: fact.type,
      label: fact.label, attributes: fact.attributes, inputVersion: fact.inputVersion, evidence: fact.evidence }),
    sourceRefs: fact.evidence.map(ref => `entity-source:${canonicalJson(ref)}`) }));
}
