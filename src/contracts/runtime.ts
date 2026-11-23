import { z } from 'zod';

export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const RunStatusSchema = z.enum(['CREATED', 'RUNNING', 'PAUSING', 'PAUSED_USER', 'PAUSED_BUDGET', 'PAUSED_APPROVAL', 'PAUSED_ACCOUNTING', 'RECOVERY_REQUIRED', 'CANCELLING', 'CANCELLED', 'SUCCEEDED', 'COMPLETED_PARTIAL', 'FAILED']);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const AttemptStatusSchema = z.enum(['CREATED', 'DISPATCHING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNKNOWN']);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
export type ErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_TRANSITION' | 'INVALID_INPUT' | 'WRITER_BUSY' | 'BUDGET_UNAVAILABLE' | 'USAGE_UNKNOWN' | 'POLICY_TOOL_BLOCKED' | 'APPROVAL_REQUIRED' | 'EXECUTION_TIMEOUT' | 'CANCEL_UNCONFIRMED' | 'ARTIFACT_INVALID' | 'VERSION_MISMATCH' | 'EXECUTION_UNKNOWN' | 'SANDBOX_CREATE_FAILED' | 'SANDBOX_UNAVAILABLE' | 'INFRASTRUCTURE_UNAVAILABLE';

/** Sanitized, durable failure evidence. Never store provider credentials or raw requests here. */
export interface FailureEvidence {
  code: string;
  phase: string;
  retryable: boolean;
  message: string;
  observedAt: number;
  causeRef?: string;
}

export class RuntimeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: { phase?: string; retryable?: boolean; userAction?: string; causeRef?: string } = {},
  ) { super(message); this.name = 'RuntimeError'; }
}

export const RunInputSchema = z.strictObject({
  runId: IdSchema,
  rootSessionId: z.string().min(1).max(512),
  budgetScopeKey: z.string().min(1).max(512),
  task: z.string().min(1).max(100_000),
  deadline: z.number().int().positive(),
  policyVersion: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RunInput = z.infer<typeof RunInputSchema>;
export interface RunRecord extends RunInput {
  status: RunStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  outcome: string | null;
}
export interface StepRecord {
  stepId: string;
  runId: string;
  kind: 'python' | 'tool' | 'model' | 'review';
  required: boolean;
  inputHash: string;
  status: StepStatus;
  dependencies: string[];
  /** Trusted host acceptance obligation; model arguments cannot select it. */
  obligationId?: string;
  /** Explicit failed steps this execution proposes to repair. History remains intact. */
  repairOf?: string[];
}
export interface AttemptRecord {
  attemptId: string;
  stepId: string;
  runId: string;
  attemptNo: number;
  dispatchIntentId: string;
  sandboxId: string | null;
  executionId: string | null;
  workDir: string | null;
  codeHash: string;
  status: AttemptStatus;
  errorCode: string | null;
  /** The adapter explicitly proved that the sandbox create request was not sent. */
  sandboxCreateEvidence?: 'adapter-confirmed-unsent-v1';
  failure?: FailureEvidence;
  startedAt: number;
  finishedAt: number | null;
}
export interface ArtifactRecord {
  artifactId: string;
  runId: string;
  attemptId: string;
  path: string;
  size: number;
  sha256: string;
}
export interface RuntimeEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  eventSeq: number;
  type: string;
  timestamp: number;
  payload: unknown;
}
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RuntimeIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1), codeHash: HashSchema, configHash: HashSchema,
});
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;
export const CheckpointSchema = z.strictObject({
  schemaVersion: z.literal(2), checkpointId: IdSchema, runId: IdSchema,
  revision: z.number().int().nonnegative(), inputHash: HashSchema,
  policyVersion: z.string().min(1), budgetScopeKey: z.string().min(1).max(512),
  runtimeIdentity: RuntimeIdentitySchema.nullable(),
  lastEventSeq: z.number().int().nonnegative(),
  steps: z.array(z.strictObject({ stepId: IdSchema, inputHash: HashSchema })),
  attempts: z.array(z.strictObject({ attemptId: IdSchema, stepId: IdSchema, codeHash: HashSchema })),
  artifacts: z.array(z.strictObject({
    artifactId: IdSchema, runId: IdSchema, attemptId: IdSchema, path: z.string().min(1).max(512),
    size: z.number().int().nonnegative(), sha256: HashSchema,
  })),
  policyState: z.unknown(),
}).superRefine((checkpoint, ctx) => {
  for (const [key, ids] of [
    ['steps', checkpoint.steps.map(s => s.stepId)],
    ['attempts', checkpoint.attempts.map(a => a.attemptId)],
    ['artifacts', checkpoint.artifacts.map(a => a.artifactId)],
  ] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: [key], message: 'Duplicate checkpoint identity' });
  }
  if (checkpoint.artifacts.some(a => a.runId !== checkpoint.runId)) {
    ctx.addIssue({ code: 'custom', path: ['artifacts'], message: 'Checkpoint artifact belongs to another run' });
  }
});
export type CheckpointRecord = z.infer<typeof CheckpointSchema>;

export const TERMINAL_RUN_STATES: ReadonlySet<RunStatus> = new Set(['SUCCEEDED', 'COMPLETED_PARTIAL', 'FAILED', 'CANCELLED']);
const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  CREATED: ['RUNNING', 'CANCELLING', 'FAILED'],
  RUNNING: ['PAUSING', 'PAUSED_BUDGET', 'PAUSED_APPROVAL', 'PAUSED_ACCOUNTING', 'RECOVERY_REQUIRED', 'CANCELLING', 'SUCCEEDED', 'COMPLETED_PARTIAL', 'FAILED'],
  PAUSING: ['PAUSED_USER', 'PAUSED_ACCOUNTING', 'RECOVERY_REQUIRED', 'CANCELLING', 'FAILED'],
  PAUSED_USER: ['RUNNING', 'CANCELLING', 'FAILED'],
  PAUSED_BUDGET: ['RUNNING', 'CANCELLING', 'COMPLETED_PARTIAL', 'FAILED', 'RECOVERY_REQUIRED'],
  PAUSED_APPROVAL: ['RUNNING', 'CANCELLING', 'COMPLETED_PARTIAL', 'FAILED', 'RECOVERY_REQUIRED'],
  PAUSED_ACCOUNTING: ['RUNNING', 'CANCELLING', 'COMPLETED_PARTIAL', 'FAILED', 'RECOVERY_REQUIRED'],
  RECOVERY_REQUIRED: ['RUNNING', 'CANCELLING', 'PAUSED_ACCOUNTING', 'PAUSED_BUDGET', 'FAILED', 'COMPLETED_PARTIAL'],
  CANCELLING: ['CANCELLED', 'RECOVERY_REQUIRED'],
  CANCELLED: [], SUCCEEDED: [], COMPLETED_PARTIAL: [], FAILED: [],
};
const attemptTransitions: Record<AttemptStatus, readonly AttemptStatus[]> = {
  CREATED: ['DISPATCHING', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  DISPATCHING: ['RUNNING', 'FAILED', 'UNKNOWN'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNKNOWN'],
  UNKNOWN: ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'],
  SUCCEEDED: [], FAILED: [], TIMED_OUT: [], CANCELLED: [],
};
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!runTransitions[from].includes(to)) throw new RuntimeError('INVALID_TRANSITION', `${from} -> ${to} is not allowed`);
}
export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (!attemptTransitions[from].includes(to)) throw new RuntimeError('INVALID_TRANSITION', `${from} -> ${to} is not allowed`);
}
