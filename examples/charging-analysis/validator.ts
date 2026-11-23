import type { ArtifactRecord, RunRecord } from '../../src/contracts/runtime.js';

type ReadArtifact = (artifact: ArtifactRecord) => Promise<Uint8Array>;
type Validation = { passed: boolean; evidence: unknown };

/** Structural acceptance for the runnable example; semantic answers remain separately verified. */
export default async function validate(_run: RunRecord, records: ArtifactRecord[], read: ReadArtifact): Promise<Validation> {
  const byPath = new Map(records.map(record => [record.path, record]));
  const statistics = byPath.get('statistics.json');
  const report = byPath.get('report.md');
  const chart = records.find(record => /^(?:chart\.(?:png|svg|html)|charts\/.+\.(?:png|svg|html))$/i.test(record.path));
  if (!statistics || !report || !chart) {
    return { passed: false, evidence: { validator: 'charging-analysis-structure-v1', missing: [
      !statistics ? 'statistics.json' : null, !report ? 'report.md' : null, !chart ? 'chart' : null,
    ].filter((value): value is string => value !== null) } };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(await read(statistics)).toString('utf8')); }
  catch { return { passed: false, evidence: { validator: 'charging-analysis-structure-v1', error: 'statistics.json is not valid JSON' } }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { passed: false, evidence: { validator: 'charging-analysis-structure-v1', error: 'statistics.json must be an object' } };
  }
  const required = ['total_alerts', 'confirmed', 'rejected', 'pending', 'false_positive_rate', 'devices', 'time_bands', 'severity'];
  const missing = required.filter(key => !Object.hasOwn(parsed, key));
  if (missing.length) return { passed: false, evidence: { validator: 'charging-analysis-structure-v1', missing } };
  return { passed: true, evidence: { validator: 'charging-analysis-structure-v1', artifactPaths: records.map(record => record.path).sort(), semanticChecks: 'run examples/charging-analysis/verify.py separately' } };
}
