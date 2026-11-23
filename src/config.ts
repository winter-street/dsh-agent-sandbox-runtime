import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const RuntimeConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dataDir: z.string().min(1).default('.runtime'),
  sandbox: z.strictObject({
    image: z.string().min(1),
    cpu: z.number().positive().max(8).default(1),
    memoryMiB: z.number().int().min(128).max(16384).default(512),
    ttlSeconds: z.number().int().min(60).max(3600).default(600),
    commandTimeoutMs: z.number().int().min(100).max(300_000).default(60_000),
    maxLogBytes: z.number().int().positive().max(10_000_000).default(128_000),
    maxOutputBytes: z.number().int().positive().max(100_000_000).default(10_000_000),
    maxOutputFiles: z.number().int().positive().max(100).default(20),
    network: z.strictObject({
      defaultAction: z.literal('deny'),
      allowHosts: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/i)).default([]),
    }).default({ defaultAction: 'deny', allowHosts: [] }),
  }),
  policy: z.strictObject({
    mode: z.enum(['observe', 'enforce']).default('observe'),
    noticeRatio: z.number().min(0).max(1).default(0.5),
    conserveRatio: z.number().min(0).max(1).default(0.65),
    focusRatio: z.number().min(0).max(1).default(0.8),
    finalizeRatio: z.number().min(0).max(1).default(0.95),
    hysteresis: z.number().positive().max(0.2).default(0.05),
    finalizeShare: z.number().min(0).max(0.25).default(0.05),
    maxModelConcurrency: z.number().int().min(1).max(8).default(2),
  }).default({
    mode: 'observe', noticeRatio: 0.5, conserveRatio: 0.65, focusRatio: 0.8,
    finalizeRatio: 0.95, hysteresis: 0.05, finalizeShare: 0.05, maxModelConcurrency: 2,
  }),
}).superRefine((config, ctx) => {
  const p = config.policy;
  if (!(p.noticeRatio < p.conserveRatio && p.conserveRatio < p.focusRatio && p.focusRatio < p.finalizeRatio)) {
    ctx.addIssue({ code: 'custom', path: ['policy'], message: 'Policy thresholds must increase strictly.' });
  }
  if (config.sandbox.commandTimeoutMs >= config.sandbox.ttlSeconds * 1000) {
    ctx.addIssue({ code: 'custom', path: ['sandbox'], message: 'Command timeout must be shorter than sandbox TTL.' });
  }
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export function loadConfig(path: string): RuntimeConfig {
  return RuntimeConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
