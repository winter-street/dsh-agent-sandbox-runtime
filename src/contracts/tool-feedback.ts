import { z } from 'zod';
import { IdSchema } from './runtime.js';

export const ToolDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(1), stepId: IdSchema,
  execution: z.enum(['succeeded', 'failed']), validation: z.enum(['passed', 'failed', 'unavailable']),
  problems: z.array(z.string().max(256)).max(8),
  priorArtifacts: z.array(z.strictObject({ artifactId: IdSchema, inputPath: z.string().max(640) })).max(8),
  omittedArtifactCount: z.int().nonnegative(),
  repairableStepIds: z.array(IdSchema).max(8), omittedRepairCount: z.int().nonnegative(),
  repairedStepIds: z.array(IdSchema).max(8),
  guidance: z.string().max(1024),
});
export type ToolDiagnostics = z.infer<typeof ToolDiagnosticsSchema>;

/** Expose only bounded diagnostic fields, never the validator's complete evidence or expected answer. */
export function validationProblems(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const value = evidence as Record<string, unknown>;
  const items = Array.isArray(value.problems) ? value.problems : Array.isArray(value.missing) ? value.missing : typeof value.error === 'string' ? [value.error] : [];
  return items.filter((item): item is string => typeof item === 'string').slice(0, 8).map(item => item.slice(0, 256));
}
