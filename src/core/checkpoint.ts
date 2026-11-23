import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '../config.js';
import { RuntimeError, RuntimeIdentitySchema, type RunRecord, type RuntimeIdentity } from '../contracts/runtime.js';
import type { RuntimeStore } from '../storage/index.js';

/** Sorted object keys make equivalent normalized configuration hash identically. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint the actual source/build tree and dependency manifest, once per service start. */
export function runtimeCodeHash(root = fileURLToPath(new URL('../', import.meta.url))): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  visit(root);
  const digest = createHash('sha256');
  for (const file of files.sort()) {
    digest.update(relative(root, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
  }
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    digest.update(name).update('\0').update(readFileSync(join(root, '..', name))).update('\0');
  }
  return digest.digest('hex');
}

export function runtimeIdentity(config: RuntimeConfig, codeHash: string): RuntimeIdentity {
  return { schemaVersion: 1, codeHash, configHash: createHash('sha256').update(canonical(config)).digest('hex') };
}

/** Check before remote inspection or new dispatch; never backfill an unknown historical identity. */
export function assertCheckpointCompatible(store: RuntimeStore, run: RunRecord, identity: RuntimeIdentity): void {
  const bound = RuntimeIdentitySchema.safeParse(store.getComponentState(run.runId, 'runtime', 'identity'));
  if (!bound.success || bound.data.codeHash !== identity.codeHash || bound.data.configHash !== identity.configHash) {
    throw new RuntimeError('VERSION_MISMATCH', 'Run code or configuration differs from this runtime; explicit migration is required');
  }
  const checkpoint = store.latestCheckpoint(run.runId);
  if (!checkpoint) return;
  if (checkpoint.runId !== run.runId || checkpoint.inputHash !== run.inputHash || checkpoint.policyVersion !== run.policyVersion
    || checkpoint.budgetScopeKey !== run.budgetScopeKey || checkpoint.revision > run.revision
    || checkpoint.lastEventSeq > store.latestEventSeq(run.runId)
    || checkpoint.runtimeIdentity?.codeHash !== identity.codeHash || checkpoint.runtimeIdentity.configHash !== identity.configHash) {
    throw new RuntimeError('VERSION_MISMATCH', 'Checkpoint identity or execution cursor is incompatible');
  }
  for (const step of checkpoint.steps) {
    const current = store.getStep(step.stepId);
    if (current?.runId !== run.runId || current.inputHash !== step.inputHash) throw new RuntimeError('VERSION_MISMATCH', 'Checkpoint step inputs changed');
  }
  for (const attempt of checkpoint.attempts) {
    const current = store.listAttempts(run.runId).find(a => a.attemptId === attempt.attemptId);
    if (!current || current.stepId !== attempt.stepId || current.codeHash !== attempt.codeHash) throw new RuntimeError('VERSION_MISMATCH', 'Checkpoint attempt code changed');
  }
  const artifacts = new Map(store.listArtifacts(run.runId).map(a => [a.artifactId, a]));
  for (const artifact of checkpoint.artifacts) {
    const current = artifacts.get(artifact.artifactId);
    if (!current || canonical(current) !== canonical(artifact)) throw new RuntimeError('ARTIFACT_INVALID', 'Checkpoint artifact reference changed or is missing');
  }
}
