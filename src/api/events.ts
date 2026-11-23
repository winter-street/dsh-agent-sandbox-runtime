import { createHash } from 'node:crypto';
import { RunStatusSchema, type RuntimeEvent } from '../contracts/runtime.js';

export const MAX_EVENT_FRAME_BYTES = 128 * 1024;
export const MAX_EVENT_BYTES_PER_FLUSH = 256 * 1024;
export const DEFAULT_EVENT_RATE_LIMIT_BYTES = 512 * 1024;
export const DEFAULT_EVENT_RATE_LIMIT_WINDOW_MS = 1000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown, max = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function identifier(value: unknown): string | undefined {
  const candidate = string(value, 128);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(candidate) ? candidate : undefined;
}

function boolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

function hashSummary(value: unknown): { present: boolean; bytes: number; sha256?: string } {
  if (value === undefined) return { present: false, bytes: 0 };
  let encoded: string;
  try { encoded = JSON.stringify(value) ?? 'null'; } catch { encoded = '[unserializable]'; }
  return { present: true, bytes: Buffer.byteLength(encoded), sha256: createHash('sha256').update(encoded).digest('hex') };
}

function stringList(value: unknown, maxItems = 100): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(item => identifier(item)).filter((item): item is string => item !== undefined).slice(0, maxItems);
  return values.length === value.length ? values : undefined;
}

function safeEvidence(value: unknown): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = hashSummary(value);
  const version = number(source.version);
  if (version !== undefined) result.version = version;
  for (const key of ['bindingHash', 'dependenciesHash', 'validatorVersion', 'branchId'] as const) {
    const value = identifier(source[key]);
    if (value !== undefined) result[key] = value;
  }
  const artifacts = stringList(source.artifactIds);
  if (artifacts !== undefined) result.artifactIds = artifacts;
  return result;
}

function projectApproval(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['approvalId', 'toolCallId', 'argumentsHash', 'decisionId'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['status'] as const) {
    const item = string(value[key], 32); if (item !== undefined && /^(pending|approved|rejected|consumed|expired)$/.test(item)) result[key] = item;
  }
  for (const key of ['createdAt', 'expiresAt', 'decidedAt', 'consumedAt'] as const) {
    const item = number(value[key]); if (item !== undefined) result[key] = item;
  }
  result.reasonPresent = typeof value.reason === 'string' && value.reason.length > 0;
  result.reasonBytes = typeof value.reason === 'string' ? Buffer.byteLength(value.reason) : 0;
  return result;
}

function projectLimits(value: unknown): Record<string, unknown> | undefined {
  const source = record(value); const result: Record<string, unknown> = {};
  const maxModelConcurrency = number(source.maxModelConcurrency);
  if (maxModelConcurrency !== undefined) result.maxModelConcurrency = maxModelConcurrency;
  const allowOptionalWork = boolean(source.allowOptionalWork);
  if (allowOptionalWork !== undefined) result.allowOptionalWork = allowOptionalWork;
  const allowNewAgents = boolean(source.allowNewAgents);
  if (allowNewAgents !== undefined) result.allowNewAgents = allowNewAgents;
  const outputTokenCap = number(source.outputTokenCap);
  if (outputTokenCap !== undefined) result.outputTokenCap = outputTokenCap;
  return Object.keys(result).length ? result : undefined;
}

function projectPolicyReason(value: unknown): Record<string, unknown> | undefined {
  const source = record(value); const code = identifier(source.code);
  if (!code) return undefined;
  const result: Record<string, unknown> = { code };
  const hard = boolean(source.hard); if (hard !== undefined) result.hard = hard;
  return result;
}

function projectPolicyNotification(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['key', 'stage', 'mode'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  const pressure = number(value.pressure); if (pressure !== undefined) result.pressure = pressure;
  return result;
}

function projectPolicy(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['phase', 'stage', 'mode', 'disposition'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['allowed', 'requiresReestimate'] as const) {
    const item = boolean(value[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['limits', 'proposedLimits'] as const) {
    const item = projectLimits(value[key]); if (item !== undefined) result[key] = item;
  }
  const pressure = record(value.pressure); const pressureProjection: Record<string, unknown> = {};
  for (const key of ['used', 'reserved', 'total'] as const) {
    const item = number(pressure[key]); if (item !== undefined) pressureProjection[key] = item;
  }
  if (Object.keys(pressureProjection).length) result.pressure = pressureProjection;
  if (Array.isArray(value.reasons)) result.reasons = value.reasons.map(projectPolicyReason).filter((item): item is Record<string, unknown> => item !== undefined);
  return result;
}

function projectResourcePolicy(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['stateKey', 'telemetry', 'affects'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['maxNewConcurrency', 'proposedConcurrency'] as const) {
    const item = number(value[key]); if (item !== undefined) result[key] = item;
  }
  if (Array.isArray(value.reasons)) {
    result.reasonCodes = value.reasons
      .map(item => identifier(item))
      .filter((item): item is string => item !== undefined && /^RESOURCE_[A-Z0-9_]+$/.test(item));
  }
  return result;
}

function projectGraph(value: Record<string, unknown>, type: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['graphId'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  const revision = number(value.revision); if (revision !== undefined) result.revision = revision;
  const detail = record(value.detail);
  if (type === 'graph.snapshot') {
    const complete = boolean(detail.complete); if (complete !== undefined) result.complete = complete;
    const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts.map(item => identifier(record(item).artifactId)).filter((item): item is string => item !== undefined) : undefined;
    if (artifacts !== undefined) result.artifactIds = artifacts;
  }
  if (type === 'graph.reconciled' || type === 'graph.reconciliation_claimed') result.evidence = hashSummary(detail.evidence);
  const nodeId = identifier(detail.nodeId); if (nodeId !== undefined) result.nodeId = nodeId;
  return result;
}

function projectValidation(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['stepId', 'attemptId', 'replacementId', 'obligationId'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['passed'] as const) {
    const item = boolean(value[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['execution'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  for (const key of ['repairOf', 'repairedStepIds', 'repairableStepIds', 'artifactIds'] as const) {
    const item = stringList(value[key]); if (item !== undefined) result[key] = item;
  }
  if (Object.hasOwn(value, 'evidence')) result.evidence = safeEvidence(value.evidence);
  return result;
}

function projectFailure(value: unknown): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  for (const key of ['code', 'phase'] as const) {
    const item = identifier(source[key]); if (item !== undefined) result[key] = item;
  }
  const retryable = boolean(source.retryable); if (retryable !== undefined) result.retryable = retryable;
  const observedAt = number(source.observedAt); if (observedAt !== undefined) result.observedAt = observedAt;
  result.messagePresent = typeof source.message === 'string' && source.message.length > 0;
  result.messageBytes = typeof source.message === 'string' ? Buffer.byteLength(source.message) : 0;
  result.causeRefPresent = typeof source.causeRef === 'string' && source.causeRef.length > 0;
  return result;
}

function projectAttempt(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['attemptId', 'stepId', 'sandboxId', 'executionId', 'errorCode'] as const) {
    const item = identifier(value[key]); if (item !== undefined) result[key] = item;
  }
  if (value.sandboxCreateEvidence === 'adapter-confirmed-unsent-v1') result.sandboxCreateEvidence = value.sandboxCreateEvidence;
  if (Object.hasOwn(value, 'failure')) result.failure = projectFailure(value.failure);
  return result;
}

function project(event: RuntimeEvent): unknown {
  const value = record(event.payload);
  if (event.type === 'context.initialized' || event.type === 'context.replaced'
    || event.type === 'context.summary-state' || event.type === 'context.summarized') {
    const result: Record<string, unknown> = {};
    for (const key of ['version', 'attemptsTotal'] as const) {
      const item = value[key];
      if (typeof item === 'number' && Number.isSafeInteger(item) && item >= (key === 'version' ? 1 : 0)) result[key] = item;
    }
    return result;
  }
  if (event.type === 'finalization.report_intent') {
    const estimatedTokens = value.estimatedTokens;
    return typeof estimatedTokens === 'number' && Number.isSafeInteger(estimatedTokens) && estimatedTokens >= 0
      ? { estimatedTokens } : {};
  }
  if (event.type === 'finalization.report_outcome') {
    const result: Record<string, unknown> = {};
    const reasons = ['disabled', 'zero-allocation', 'request-too-large', 'unknown-usage', 'previous-attempt',
      'unverified-accounting', 'model-error', 'generated', 'run-not-active'];
    if (typeof value.reason === 'string' && reasons.includes(value.reason)) result.reason = value.reason;
    for (const key of ['enhanced', 'complete'] as const) {
      const item = boolean(value[key]); if (item !== undefined) result[key] = item;
    }
    return result;
  }
  if (event.type === 'policy.changed') {
    const result: Record<string, unknown> = {};
    for (const key of ['policyVersion', 'rulesFingerprint'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    const stages = ['normal', 'notice', 'conserve', 'focus', 'finalize'];
    if (typeof value.stage === 'string' && stages.includes(value.stage)) result.stage = value.stage;
    if (Array.isArray(value.notifiedStages) && value.notifiedStages.every(item => typeof item === 'string' && stages.includes(item))) {
      result.notifiedStages = value.notifiedStages;
    }
    for (const key of ['schemaVersion', 'lastTransitionStep', 'lastTransitionSettlement', 'lastStepBoundary', 'lastSettlementBoundary', 'evaluationCount'] as const) {
      const item = number(value[key]); if (item !== undefined) result[key] = item;
    }
    const finalized = boolean(value.finalized); if (finalized !== undefined) result.finalized = finalized;
    result.reasonPresent = typeof value.lastOperatorReason === 'string' && value.lastOperatorReason.length > 0;
    result.reasonBytes = typeof value.lastOperatorReason === 'string' ? Buffer.byteLength(value.lastOperatorReason) : 0;
    return result;
  }
  if (event.type.startsWith('run.') && RunStatusSchema.safeParse(event.type.slice(4).toUpperCase()).success && event.type !== 'run.created') {
    const result: Record<string, unknown> = {};
    const from = RunStatusSchema.safeParse(value.from); if (from.success) result.from = from.data;
    const revision = number(value.revision); if (revision !== undefined) result.revision = revision;
    result.outcomePresent = typeof value.outcome === 'string' && value.outcome.length > 0;
    result.outcomeBytes = typeof value.outcome === 'string' ? Buffer.byteLength(value.outcome) : 0;
    return result;
  }
  if (event.type === 'retry.dispatch_intent' || event.type === 'retry.classified') {
    const result: Record<string, unknown> = {};
    if (Object.hasOwn(value, 'key')) result.key = hashSummary(value.key);
    for (const key of ['version', 'attempts', 'nextAt'] as const) {
      const item = number(value[key]); if (item !== undefined) result[key] = item;
    }
    if (value.phase === 'idle' || value.phase === 'pending' || value.phase === 'failed') result.phase = value.phase;
    const failures = ['invalid-input', 'transient-unsent', 'transient-idempotent', 'budget', 'cancelled', 'unknown', 'permanent'];
    if (value.lastFailure === null || typeof value.lastFailure === 'string' && failures.includes(value.lastFailure)) result.lastFailure = value.lastFailure;
    const retryable = boolean(value.retryable); if (retryable !== undefined) result.retryable = retryable;
    return result;
  }
  if (event.type === 'retry.execution_classified' || event.type === 'retry.execution_committed') {
    const result: Record<string, unknown> = {};
    for (const key of ['stepId', 'attemptId'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    if (event.type === 'retry.execution_classified' && value.attemptId === null) result.attemptId = null;
    for (const key of ['dispatchNo', 'attemptNo'] as const) {
      const item = value[key];
      if (typeof item === 'number' && Number.isSafeInteger(item) && item > 0) result[key] = item;
    }
    if (event.type === 'retry.execution_classified') {
      const failures = ['invalid-input', 'transient-unsent', 'transient-idempotent', 'budget', 'cancelled', 'unknown', 'permanent'];
      if (typeof value.failure === 'string' && failures.includes(value.failure)) result.failure = value.failure;
      const retryable = boolean(value.retryable); if (retryable !== undefined) result.retryable = retryable;
    }
    return result;
  }
  if (event.type === 'retry.execution_intent') {
    const result: Record<string, unknown> = {};
    const stepId = identifier(value.stepId); if (stepId !== undefined) result.stepId = stepId;
    for (const key of ['dispatchNo', 'attemptNo'] as const) {
      const item = number(value[key]); if (item !== undefined) result[key] = item;
    }
    if (Object.hasOwn(value, 'binding')) result.binding = hashSummary(value.binding);
    return result;
  }
  if (event.type === 'budget.receipt') {
    const result: Record<string, unknown> = {};
    for (const key of ['receiptEventId', 'reservationId', 'modelCallId'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    if (typeof value.ledgerSeq === 'number' && Number.isSafeInteger(value.ledgerSeq) && value.ledgerSeq > 0) {
      result.ledgerSeq = value.ledgerSeq;
    }
    const types = ['start', 'end', 'open', 'sample', 'unmetered', 'adjust', 'reset', 'allocate',
      'reserve', 'dispatch', 'settle', 'release-unsent', 'unknown'];
    if (typeof value.eventType === 'string' && types.includes(value.eventType)) result.eventType = value.eventType;
    return result;
  }
  if (event.type === 'workflow.role_dispatch_intent' || event.type === 'workflow.role_not_dispatched'
    || event.type === 'workflow.role_completed') {
    const result: Record<string, unknown> = {};
    if (typeof value.role === 'string' && ['planner', 'executor', 'reviewer'].includes(value.role)) result.role = value.role;
    for (const key of ['callId', 'sessionId', 'modelCallId', 'receiptId'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    return result;
  }
  if (event.type === 'session.bound') {
    const result: Record<string, unknown> = {};
    const sessionId = identifier(value.sessionId); if (sessionId !== undefined) result.sessionId = sessionId;
    if (value.purpose === 'work' || value.purpose === 'finalize') result.purpose = value.purpose;
    if (value.intent === 'work' || value.intent === 'summary' || value.intent === 'final-report') result.intent = value.intent;
    return result;
  }
  if (event.type === 'branch.child_intent') {
    const result: Record<string, unknown> = {};
    for (const key of ['branchId', 'childRunId', 'dispatchId'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    return result;
  }
  if (event.type === 'workflow.executor_step_linked') {
    const result: Record<string, unknown> = {};
    for (const key of ['callId', 'modelCallId', 'receiptId', 'stepId'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    return result;
  }
  if (event.type === 'entity.upserted' || event.type === 'entity.input-version') {
    const result: Record<string, unknown> = {};
    for (const key of ['entityId', 'inputVersion'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    for (const key of ['schemaVersion', 'generation'] as const) {
      const item = number(value[key]); if (item !== undefined) result[key] = item;
    }
    if (Object.hasOwn(value, 'evidence')) result.evidence = hashSummary(value.evidence);
    return result;
  }
  if (event.type === 'sandbox.failure') return projectFailure(value);
  if (/^attempt\.(created|dispatching|running|succeeded|failed|timed_out|cancelled|unknown)$/.test(event.type)) return projectAttempt(value);
  if (event.type === 'run.pause_requested' || event.type === 'step.optional') {
    const stepId = identifier(value.stepId);
    return { ...(stepId !== undefined ? { stepId } : {}),
      reasonPresent: typeof value.reason === 'string' && value.reason.length > 0,
      reasonBytes: typeof value.reason === 'string' ? Buffer.byteLength(value.reason) : 0 };
  }
  if (event.type === 'tool.finished') {
    const result: Record<string, unknown> = {};
    for (const key of ['attemptId', 'stepId', 'executionId'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    const exitCode = number(value.exitCode); if (exitCode !== undefined) result.exitCode = exitCode;
    const artifacts = stringList(value.artifacts); if (artifacts !== undefined) result.artifacts = artifacts;
    result.stdoutBytes = typeof value.stdout === 'string' ? Buffer.byteLength(value.stdout) : 0;
    result.stderrBytes = typeof value.stderr === 'string' ? Buffer.byteLength(value.stderr) : 0;
    return result;
  }
  if (event.type === 'tool.claimed') {
    const result: Record<string, unknown> = {};
    for (const key of ['callId', 'toolName'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    if (value.location === 'sandbox' || value.location === 'host' || value.location === 'mcp-host') result.location = value.location;
    return result;
  }
  if (event.type === 'tool.completed') {
    const result: Record<string, unknown> = {};
    for (const key of ['callId', 'toolName'] as const) {
      const item = identifier(value[key]); if (item !== undefined) result[key] = item;
    }
    if (value.location === 'sandbox' || value.location === 'host' || value.location === 'mcp-host') result.location = value.location;
    const ok = boolean(value.ok); if (ok !== undefined) result.ok = ok;
    if (ok === false) {
      const source = record(value.error); const error: Record<string, unknown> = {};
      const code = identifier(source.code); if (code !== undefined) error.code = code;
      const retryable = boolean(source.retryable); if (retryable !== undefined) error.retryable = retryable;
      result.error = error;
    }
    return result;
  }
  if (event.type === 'validation.completed' || event.type === 'repair.validated' || event.type === 'tool.validation') return projectValidation(value);
  if (event.type === 'approval.requested' || event.type === 'approval.approved' || event.type === 'approval.rejected' || event.type === 'approval.consumed') return projectApproval(value);
  if (event.type === 'policy.decision') return projectPolicy(value);
  if (event.type === 'policy.triggered' || event.type === 'tool.policy-notice') return projectPolicyNotification(value);
  if (event.type === 'tool.policy-admission') {
    const result: Record<string, unknown> = {};
    for (const key of ['callId', 'toolName', 'reason'] as const) { const item = identifier(value[key]); if (item !== undefined) result[key] = item; }
    const allowed = boolean(value.allowed); if (allowed !== undefined) result.allowed = allowed;
    return result;
  }
  if (event.type === 'tool.policy-outcome') {
    const result: Record<string, unknown> = {};
    for (const key of ['callId', 'progressVersion'] as const) { const item = identifier(value[key]); if (item !== undefined) result[key] = item; }
    const ok = boolean(value.ok); if (ok !== undefined) result.ok = ok;
    return result;
  }
  if (event.type === 'resource.policy_decision') return projectResourcePolicy(value);
  if (event.type === 'graph.claimed' || event.type === 'graph.released' || event.type === 'graph.reconciliation_claimed'
    || event.type === 'graph.reconciled' || event.type === 'graph.snapshot' || event.type === 'branch.merge_invalid') return projectGraph(value, event.type);
  return event.payload;
}

export function eventFrame(event: RuntimeEvent): { frame: string; bytes: number } {
  const type = /^[A-Za-z0-9_.:-]{1,128}$/.test(event.type) ? event.type : 'message';
  const prefix = `id: ${event.eventSeq}\nevent: ${type}\ndata: `;
  const frame = prefix + JSON.stringify({ ...event, payload: project(event) }) + '\n\n';
  const bytes = Buffer.byteLength(frame);
  if (bytes <= MAX_EVENT_FRAME_BYTES) return { frame, bytes };
  // Keep a replayable ID for the omitted payload; never skip or split its sequence.
  const omitted = prefix + JSON.stringify({ ...event, type: event.type.slice(0, 128), payload: { omitted: true, reason: 'EVENT_FRAME_TOO_LARGE' } }) + '\n\n';
  return { frame: omitted, bytes: Buffer.byteLength(omitted) };
}
