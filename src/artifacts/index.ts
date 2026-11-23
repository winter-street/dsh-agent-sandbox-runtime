import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { IdSchema, RuntimeError } from '../contracts/runtime.js';
import type { ArtifactRecord } from '../contracts/runtime.js';
import type { SandboxOutput } from '../contracts/sandbox.js';

export interface ArtifactStoreOptions {
  maxFiles?: number;
  maxBytes?: number;
  /** Fault injection seam: invoked after durable staging, before atomic directory publication. */
  beforePublish?: (stagingDirectory: string) => void | Promise<void>;
}
interface Manifest { schemaVersion: 1; runId: string; attemptId: string; artifacts: ArtifactRecord[] }
export interface ArtifactInventory {
  published: { runId: string; attemptId: string; artifacts: ArtifactRecord[] }[];
  staging: string[];
  invalid: { path: string; reason: string }[];
}
export interface ArtifactReconciliation extends ArtifactInventory { unreferenced: ArtifactRecord[] }

const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|clock\$|conin\$|conout\$)(?:\.|$)/i;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const invalid = (message: string) => new RuntimeError('ARTIFACT_INVALID', message, { phase: 'artifacts', retryable: false });
const isMissing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function id(value: string): string {
  if (!IdSchema.safeParse(value).success || reservedWindowsName.test(value)) throw invalid('Invalid artifact owner identifier');
  return value;
}
function safePath(value: string): string {
  if (!value || value.length > 512 || value !== value.normalize('NFC') || /[\\\x00-\x1f<>:"|?*]/.test(value)) throw invalid('Invalid artifact relative path');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 120 || /[ .]$/.test(part) || reservedWindowsName.test(part))) {
    throw invalid('Artifact path contains an unsafe component');
  }
  return value;
}
function assertPathsUnique(paths: string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = safePath(path).toLowerCase();
    if (seen.has(key)) throw invalid('Duplicate or case-colliding artifact path');
    seen.add(key);
  }
  for (const key of seen) {
    const parts = key.split('/');
    for (let n = 1; n < parts.length; n++) if (seen.has(parts.slice(0, n).join('/'))) throw invalid('Artifact file conflicts with directory');
  }
}

/** Application-owned filesystem store. Publication does not create a database reference. */
export class ArtifactStore {
  readonly rootDir: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(rootDir: string, private readonly options: ArtifactStoreOptions = {}) {
    this.rootDir = resolve(rootDir);
    this.maxFiles = options.maxFiles ?? 100;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (![this.maxFiles, this.maxBytes].every((n) => Number.isSafeInteger(n) && n > 0)) throw invalid('Artifact limits must be positive integers');
    if (this.rootDir === parse(this.rootDir).root) throw invalid('Artifact root must be a dedicated directory');
  }

  private owned(...parts: string[]): string {
    const target = resolve(this.rootDir, ...parts);
    if (!target.startsWith(this.rootDir + sep)) throw invalid('Artifact path escapes root');
    return target;
  }

  /** Reject existing symlinks/junctions at every component before reading or writing. */
  private async directory(target: string, create = false): Promise<void> {
    const absolute = resolve(target);
    const anchor = parse(absolute).root;
    let current = anchor;
    for (const part of absolute.slice(anchor.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (!create || !isMissing(error)) throw error;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (creationError) {
          if (!(creationError instanceof Error && 'code' in creationError && creationError.code === 'EEXIST')) throw creationError;
        }
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw invalid('Artifact directory contains a link or non-directory component');
    }
  }

  private finalDir(runId: string, attemptId: string): string {
    return this.owned('runs', id(runId), 'attempts', id(attemptId));
  }

  private async writeExclusive(path: string, content: Uint8Array): Promise<void> {
    await this.directory(dirname(path), true);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
  }

  private async syncDirectory(path: string): Promise<void> {
    // Windows does not expose directory fsync through this Node API. File fsync
    // and atomic rename still protect process-crash publication; no power-loss
    // durability is claimed for that platform.
    if (process.platform === 'win32') return;
    const handle = await open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async boundedRead(path: string, limit: number): Promise<Buffer> {
    try {
      await this.directory(dirname(path));
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile() || before.size > limit) throw invalid('Artifact is not a bounded regular file');
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(path, flags);
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.size > limit || actual.ino !== before.ino || actual.dev !== before.dev) throw invalid('Artifact changed while opening');
        const data = Buffer.alloc(Math.min(limit, actual.size) + 1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset > limit || offset !== actual.size) throw invalid('Artifact size changed during read');
        return data.subarray(0, offset);
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw invalid(isMissing(error) ? 'Artifact file or directory is missing' : 'Artifact could not be read safely');
    }
  }

  private validateRecord(value: unknown, runId: string, attemptId: string): ArtifactRecord {
    if (!value || typeof value !== 'object') throw invalid('Invalid artifact record');
    const item = value as Partial<ArtifactRecord>;
    if (typeof item.artifactId !== 'string' || typeof item.path !== 'string' || typeof item.size !== 'number'
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > this.maxBytes
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || item.runId !== runId || item.attemptId !== attemptId) throw invalid('Invalid artifact record fields');
    id(item.artifactId);
    safePath(item.path);
    return { artifactId: item.artifactId, runId, attemptId, path: item.path, size: item.size, sha256: item.sha256 };
  }

  private async manifest(runId: string, attemptId: string): Promise<Manifest> {
    const raw = await this.boundedRead(join(this.finalDir(runId, attemptId), 'manifest.json'), Math.max(65_536, this.maxFiles * 1024));
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); } catch { throw invalid('Artifact manifest is not valid JSON'); }
    if (!value || typeof value !== 'object') throw invalid('Invalid artifact manifest');
    const item = value as Partial<Manifest>;
    if (item.schemaVersion !== 1 || item.runId !== runId || item.attemptId !== attemptId || !Array.isArray(item.artifacts) || item.artifacts.length > this.maxFiles) throw invalid('Invalid artifact manifest fields');
    const artifacts = item.artifacts.map((record) => this.validateRecord(record, runId, attemptId));
    assertPathsUnique(artifacts.map((record) => record.path));
    if (new Set(artifacts.map((record) => record.artifactId)).size !== artifacts.length || artifacts.reduce((sum, record) => sum + record.size, 0) > this.maxBytes) throw invalid('Artifact manifest exceeds limits or repeats IDs');
    return { schemaVersion: 1, runId, attemptId, artifacts };
  }

  async publish(runId: string, attemptId: string, outputs: SandboxOutput[]): Promise<ArtifactRecord[]> {
    id(runId); id(attemptId);
    if (outputs.length > this.maxFiles) throw invalid('Too many artifact files');
    assertPathsUnique(outputs.map((output) => output.path));
    let total = 0;
    const snapshots = outputs.map((output) => {
      if (!(output.content instanceof Uint8Array)) throw invalid('Artifact content must be bytes');
      total += output.content.byteLength;
      if (!Number.isSafeInteger(total) || total > this.maxBytes) throw invalid('Artifacts exceed byte limit');
      return { path: output.path, content: Buffer.from(output.content) };
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const expected = snapshots.map((output) => ({ path: output.path, size: output.content.byteLength, sha256: sha256(output.content) }));
    const existing = async (): Promise<ArtifactRecord[]> => {
      const manifest = await this.manifest(runId, attemptId);
      const comparable = manifest.artifacts.map(({ path, size, sha256: hash }) => ({ path, size, sha256: hash })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
      if (JSON.stringify(comparable) !== JSON.stringify(expected)) throw new RuntimeError('CONFLICT', 'Attempt already published different artifacts', { phase: 'artifacts', retryable: false });
      await this.verify(manifest.artifacts);
      return manifest.artifacts;
    };
    const final = this.finalDir(runId, attemptId);
    try { await lstat(final); return await existing(); }
    catch (error) { if (!isMissing(error)) throw error; }
    const stage = this.owned('.staging', `${runId}--${attemptId}--${randomUUID()}`);
    await this.directory(join(stage, 'files'), true);
    const records: ArtifactRecord[] = [];
    for (const output of snapshots) {
      const record = { artifactId: randomUUID(), runId, attemptId, path: output.path, size: output.content.byteLength, sha256: sha256(output.content) };
      await this.writeExclusive(join(stage, 'files', ...output.path.split('/')), output.content);
      records.push(record);
    }
    const manifest: Manifest = { schemaVersion: 1, runId, attemptId, artifacts: records };
    await this.writeExclusive(join(stage, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
    await this.syncDirectory(join(stage, 'files'));
    await this.syncDirectory(stage);
    await this.options.beforePublish?.(stage);
    await this.directory(stage);
    await this.directory(dirname(final), true);
    try { await rename(stage, final); }
    catch (error) {
      try { await lstat(final); } catch { throw error; }
      // Another publisher may have committed. Its manifest decides idempotency.
      return existing();
    }
    await this.syncDirectory(dirname(final));
    await this.verify(records);
    return records;
  }

  async read(record: ArtifactRecord): Promise<Uint8Array> {
    const checked = this.validateRecord(record, id(record.runId), id(record.attemptId));
    const manifest = await this.manifest(checked.runId, checked.attemptId);
    const match = manifest.artifacts.find((item) => item.artifactId === checked.artifactId);
    if (!match || JSON.stringify(match) !== JSON.stringify(checked)) throw invalid('Record does not match the published manifest');
    const data = await this.boundedRead(join(this.finalDir(checked.runId, checked.attemptId), 'files', ...checked.path.split('/')), checked.size);
    if (data.length !== checked.size || sha256(data) !== checked.sha256) throw invalid('Artifact size or checksum mismatch');
    return data;
  }

  async verify(records: ArtifactRecord[]): Promise<void> {
    for (const record of records) await this.read(record);
  }

  /** Inspect orphaned staging/publications without deleting or publishing anything. */
  async list(): Promise<ArtifactInventory> {
    const inventory: ArtifactInventory = { published: [], staging: [], invalid: [] };
    const directories = async (path: string): Promise<string[]> => {
      try {
        await this.directory(path);
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((entry) => entry.name).sort();
      } catch (error) {
        if (isMissing(error)) return [];
        inventory.invalid.push({ path, reason: error instanceof Error ? error.message : 'Unreadable directory' });
        return [];
      }
    };
    inventory.staging = await directories(this.owned('.staging'));
    for (const runId of await directories(this.owned('runs'))) {
      try { id(runId); }
      catch { inventory.invalid.push({ path: runId, reason: 'Invalid run directory name' }); continue; }
      for (const attemptId of await directories(this.owned('runs', runId, 'attempts'))) {
        try {
          id(attemptId);
          const manifest = await this.manifest(runId, attemptId);
          await this.verify(manifest.artifacts);
          inventory.published.push({ runId, attemptId, artifacts: manifest.artifacts });
        } catch (error) {
          inventory.invalid.push({ path: `${runId}/${attemptId}`, reason: error instanceof Error ? error.message : 'Invalid publication' });
        }
      }
    }
    return inventory;
  }

  async reconcile(referenced: readonly ArtifactRecord[]): Promise<ArtifactReconciliation> {
    const inventory = await this.list();
    const keys = new Set(referenced.map((record) => `${record.runId}/${record.attemptId}/${record.artifactId}`));
    return { ...inventory, unreferenced: inventory.published.flatMap((item) => item.artifacts).filter((record) => !keys.has(`${record.runId}/${record.attemptId}/${record.artifactId}`)) };
  }

  /** Only resolved attempts may discard unpublished staging; publications remain available for reconciliation. */
  async cleanupStaging(runId: string, resolvedAttemptIds: readonly string[]): Promise<string[]> {
    id(runId);
    const prefixes = resolvedAttemptIds.map(attemptId => `${runId}--${id(attemptId)}--`);
    const staging = this.owned('.staging');
    try { await this.directory(staging); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const removed: string[] = [];
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (!prefixes.some(prefix => entry.name.startsWith(prefix)
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.name.slice(prefix.length)))) continue;
      const target = this.owned('.staging', entry.name);
      // Verify the final absolute target and every directory component before recursive removal.
      await this.directory(target);
      await rm(target, { recursive: true, force: false });
      removed.push(entry.name);
    }
    return removed;
  }
}
